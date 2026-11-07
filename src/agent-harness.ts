/**
 * A test harness for module agents: simulate a schedule tick or an event for
 * one agent, without Workers, cron or an event bus. It runs the same delivery
 * code as PlantModule's `onAgentTick` and `onEvent`.
 */
import type { Tenant } from "./context.js";
import type { DefinedModule } from "./define.js";
import type { PlantEvent } from "./extensions.js";
import { runAgentEvent, runAgentTick, type AgentContext, type SerializedAgentScope } from "./agents.js";
import { createModuleKeys, type KeyValues } from "./module-keys.js";

export interface AgentHarnessOptions<Env> {
  readonly env: Env;
  /** Defaults to `{ id: "t_test", hostname: "test.example.com" }`. */
  readonly tenant?: Tenant;
  readonly entitlements?: readonly string[];
  /**
   * Fake key values, read in handlers with `moduleKeys(ctx)`. Every name
   * must be declared in the module's requiredKeys, or the harness throws.
   */
  readonly keys?: KeyValues;
}

/** Per-run options. `keys` replaces the harness's fake keys for this run. */
interface RunOptions {
  readonly tenant?: Tenant;
  readonly keys?: KeyValues;
}

/** The result of one simulated run. */
export interface AgentRun {
  readonly agent: string;
  /** The context the handler got: principal, conversation id, idempotency key, initial data. */
  readonly context: AgentContext;
  /** Whatever the handler returned, e.g. a dispatch receipt from a fake. */
  readonly result: unknown;
}

/** An event to simulate. Missing fields are filled in. */
export type AgentEventInit<Data = unknown> = Pick<PlantEvent<Data>, "type"> &
  Partial<Omit<PlantEvent<Data>, "type">>;

export interface AgentHarness {
  /** Fire the agent's schedule once. `scheduledAt` defaults to now. */
  tick(agent: string, options?: RunOptions & { readonly scheduledAt?: Date | string }): Promise<AgentRun>;
  /** Deliver one event to the agent. The tenant defaults to the harness tenant. */
  event(agent: string, event: AgentEventInit, options?: RunOptions): Promise<AgentRun>;
}

let eventCounter = 0;

export function createAgentHarness<Env>(mod: DefinedModule<Env>, options: AgentHarnessOptions<Env>): AgentHarness {
  const host = { moduleId: mod.manifest.id, entries: mod.manifest.agents ?? [], handlers: mod.handlers.agentHandlers ?? {} };
  const defaultTenant: Tenant = options.tenant ?? { id: "t_test", hostname: "test.example.com" };
  const scope = (tenant?: Tenant): SerializedAgentScope => ({
    tenant: tenant ?? defaultTenant,
    entitlements: [...(options.entitlements ?? [])],
  });
  const keysFor = (values?: KeyValues) =>
    createModuleKeys(mod.manifest, values ?? options.keys ?? {}, { strict: true });
  keysFor(); // reject undeclared fake keys up front

  return {
    async tick(agent, opts = {}) {
      const entry = (mod.manifest.agents ?? []).find((a) => a.name === agent);
      if (!entry?.schedule) {
        throw new Error(entry ? `agent "${agent}" has no schedule` : `module "${mod.manifest.id}" has no agent "${agent}"`);
      }
      const at = opts.scheduledAt ?? new Date();
      const tick = { cron: entry.schedule, scheduledAt: new Date(at).toISOString() };
      const { context, result } = await runAgentTick(host, agent, tick, scope(opts.tenant), options.env, keysFor(opts.keys));
      return { agent, context, result };
    },

    async event(agent, init, opts = {}) {
      const s = scope(opts.tenant);
      const event: PlantEvent = {
        id: init.id ?? `evt_test_${++eventCounter}`,
        type: init.type,
        tenantId: init.tenantId ?? s.tenant.id,
        source: init.source ?? init.type.split(".")[0]!,
        occurredAt: init.occurredAt ?? new Date().toISOString(),
        data: init.data ?? {},
      };
      const { context, result } = await runAgentEvent(host, agent, event, s, options.env, keysFor(opts.keys));
      return { agent, context, result };
    },
  };
}
