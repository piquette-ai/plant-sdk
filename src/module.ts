/**
 * PlantModule: the Worker entrypoint the router calls over a service binding.
 *
 * Contexts cross RPC as {@link SerializedPlantContext} (plain data) and are
 * turned back into a {@link PlantContext} inside the module.
 *
 * Key values travel as a separate, optional last argument (`keys`), never
 * inside the context. The module keeps only the names its manifest declares
 * and exposes them through `moduleKeys(ctx)` (see module-keys.ts).
 */
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { runAgentEvent, runAgentTick, type AgentTick, type SerializedAgentScope } from "./agents.js";
import { createPlantContext, type SerializedPlantContext } from "./context.js";
import type { DefinedModule } from "./define.js";
import type { PlantEvent } from "./extensions.js";
import type { McpExtensionDescriptor, McpInvocation, McpInvocationResult } from "./mcp-extension.js";
import type { ModuleManifest } from "./manifest.js";
import { privacyContextFor } from "./subjects.js";
import { createModuleKeys, guardKeys, scrubKeyValues, withModuleKeys, type KeyValues, type ModuleKeys } from "./module-keys.js";
import type {
  DataSubject,
  DeletionProof,
  PrivacyExport,
  PrivacyFindResult,
  PrivacyHandlers,
  PrivacyVerifyResult,
} from "./privacy.js";

/** The privacy contract as the router calls it over RPC. */
export interface PrivacyRpc {
  find(subject: DataSubject, ctx: SerializedPlantContext, keys?: KeyValues): Promise<PrivacyFindResult>;
  export(subject: DataSubject, ctx: SerializedPlantContext, keys?: KeyValues): Promise<PrivacyExport>;
  delete(subject: DataSubject, ctx: SerializedPlantContext, keys?: KeyValues): Promise<DeletionProof>;
  verify(subject: DataSubject, ctx: SerializedPlantContext, keys?: KeyValues): Promise<PrivacyVerifyResult>;
}

/**
 * The RPC surface every module Worker exposes. Most modules don't subclass
 * this by hand: `export default moduleEntrypoint(defineModule({...}))`.
 */
export abstract class PlantModule<Env = unknown> extends WorkerEntrypoint<Env> {
  abstract manifest(): ModuleManifest | Promise<ModuleManifest>;
  abstract handle(request: Request, ctx: SerializedPlantContext, keys?: KeyValues): Promise<Response>;
  privacy?(): PrivacyRpc;
  /** The module's MCP extension: plain data that core registers. */
  mcp?(): McpExtensionDescriptor;
  /**
   * Call one of the module's MCP tools, resources or prompts. Names and URIs
   * are module-relative (core strips its prefixes). Write tools need the
   * approved `draftId`.
   */
  mcpInvoke?(invocation: McpInvocation, ctx: SerializedPlantContext, keys?: KeyValues): Promise<McpInvocationResult>;
  /**
   * Deliver an event to the module's onEvent and to every agent that listens
   * for it. `agentScopes` are core-minted agent scopes, one per listening
   * agent (core mints these when it delivers the event): an agent that has one
   * acts as its agent principal (it can post to the inbox), otherwise it gets
   * the delivery's own context.
   */
  onEvent?(
    event: PlantEvent,
    ctx: SerializedPlantContext,
    keys?: KeyValues,
    agentScopes?: Readonly<Record<string, SerializedAgentScope>>,
  ): Promise<void>;
  /** Run one schedule tick of one agent for one tenant. Exists only when an agent has a schedule. */
  onAgentTick?(agent: string, tick: AgentTick, scope: SerializedAgentScope, keys?: KeyValues): Promise<void>;
}

class PrivacyTarget<Env> extends RpcTarget implements PrivacyRpc {
  readonly #h: PrivacyHandlers<Env>;
  readonly #env: Env;
  readonly #manifest: ModuleManifest;
  constructor(handlers: PrivacyHandlers<Env>, env: Env, manifest: ModuleManifest) {
    super();
    this.#h = handlers;
    this.#env = env;
    this.#manifest = manifest;
  }
  #call<T>(m: keyof PrivacyHandlers<Env>, subject: DataSubject, ctx: SerializedPlantContext, keys?: KeyValues) {
    const k = createModuleKeys(this.#manifest, keys);
    // ctx.subjects hashes through core's Privacy entrypoint (env.PLANT_PRIVACY).
    return guardKeys(k, () => {
      const pctx = withModuleKeys(privacyContextFor(createPlantContext(ctx), this.#env), k);
      return this.#h[m](subject, pctx, this.#env) as Promise<T>;
    });
  }
  find(subject: DataSubject, ctx: SerializedPlantContext, keys?: KeyValues) {
    return this.#call<PrivacyFindResult>("find", subject, ctx, keys);
  }
  export(subject: DataSubject, ctx: SerializedPlantContext, keys?: KeyValues) {
    return this.#call<PrivacyExport>("export", subject, ctx, keys);
  }
  delete(subject: DataSubject, ctx: SerializedPlantContext, keys?: KeyValues) {
    return this.#call<DeletionProof>("delete", subject, ctx, keys);
  }
  verify(subject: DataSubject, ctx: SerializedPlantContext, keys?: KeyValues) {
    return this.#call<PrivacyVerifyResult>("verify", subject, ctx, keys);
  }
}

/** The request's PlantContext, with its keys attached. */
function keyed(ctx: SerializedPlantContext, keys: ModuleKeys) {
  return withModuleKeys(createPlantContext(ctx), keys);
}

/**
 * Build the module's Worker entrypoint class from {@link defineModule}'s
 * result. Optional RPC methods (privacy, mcp/mcpInvoke, onEvent, onAgentTick) exist only when the
 * module defines them, so the router can feature-detect them.
 */
export function moduleEntrypoint<Env = unknown>(
  mod: DefinedModule<Env>,
): new (ctx: ExecutionContext, env: Env) => PlantModule<Env> {
  const { manifest, handlers } = mod;
  const agentEntries = manifest.agents ?? [];
  const agentHost = { moduleId: manifest.id, entries: agentEntries, handlers: handlers.agentHandlers ?? {} };

  class DefinedPlantModule extends PlantModule<Env> {
    manifest(): ModuleManifest {
      return manifest;
    }
    async handle(request: Request, ctx: SerializedPlantContext, keys?: KeyValues): Promise<Response> {
      const k = createModuleKeys(manifest, keys);
      return guardKeys(k, () => handlers.handle(request, keyed(ctx, k), this.env));
    }
    override privacy(): PrivacyRpc {
      return new PrivacyTarget(handlers.privacy!, this.env, manifest);
    }
    override mcp(): McpExtensionDescriptor {
      return handlers.mcp!.descriptor;
    }
    override async mcpInvoke(
      invocation: McpInvocation,
      ctx: SerializedPlantContext,
      keys?: KeyValues,
    ): Promise<McpInvocationResult> {
      const k = createModuleKeys(manifest, keys);
      // Key values never reach MCP output, whatever a tool returns.
      return scrubKeyValues(k, await guardKeys(k, () => handlers.mcp!.invoke(invocation, keyed(ctx, k), this.env)));
    }
    override async onEvent(
      event: PlantEvent,
      ctx: SerializedPlantContext,
      keys?: KeyValues,
      agentScopes?: Readonly<Record<string, SerializedAgentScope>>,
    ): Promise<void> {
      const own = manifest.events.listens.includes(event.type);
      const listeners = agentEntries.filter((a) => a.listens.includes(event.type));
      if (!own && listeners.length === 0) {
        throw new Error(`module "${manifest.id}" does not listen for "${event.type}"`);
      }
      // The delivery's core-minted capability goes on to the agents it runs,
      // unless core minted an agent scope for the agent itself.
      const scope = { tenant: ctx.tenant, entitlements: ctx.entitlements, capability: ctx.capability };
      const scopeFor = (agent: string): SerializedAgentScope => {
        const own = agentScopes?.[agent];
        if (own === undefined) return scope;
        if (own?.tenant?.id !== ctx.tenant.id) throw new Error(`agent scope for "${agent}" is for another tenant`);
        return own;
      };
      const k = createModuleKeys(manifest, keys);
      await guardKeys(k, async () => {
        const results = await Promise.allSettled([
          ...(own ? [(async () => handlers.onEvent!(event, keyed(ctx, k), this.env))()] : []),
          ...listeners.map((a) => (async () => runAgentEvent(agentHost, a.name, event, scopeFor(a.name), this.env, k))()),
        ]);
        const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, `${errors.length} listeners failed for "${event.type}"`);
      });
    }
    override async onAgentTick(agent: string, tick: AgentTick, scope: SerializedAgentScope, keys?: KeyValues): Promise<void> {
      const k = createModuleKeys(manifest, keys);
      await guardKeys(k, () => runAgentTick(agentHost, agent, tick, scope, this.env, k));
    }
  }

  const proto = DefinedPlantModule.prototype as unknown as Record<string, unknown>;
  if (!handlers.privacy) delete proto.privacy;
  if (!handlers.mcp) {
    delete proto.mcp;
    delete proto.mcpInvoke;
  }
  if (!handlers.onEvent && !agentEntries.some((a) => a.listens.length > 0)) delete proto.onEvent;
  if (!agentEntries.some((a) => a.schedule)) delete proto.onAgentTick;

  Object.defineProperty(DefinedPlantModule, "name", { value: `PlantModule(${manifest.id})` });
  return DefinedPlantModule;
}
