/**
 * A local dev and test harness for modules: a mock router.
 *
 * It drives a module the way the plant's router does. It builds the
 * PlantContext (a fake principal, a default brand, the entitlements you
 * choose), decides app or public surface from the manifest's publicPrefixes,
 * applies the Access, entitlement and needs-setup gates, calls `handle()`,
 * lists and calls MCP tools by their wire names (`<moduleId>__<tool>`), runs
 * write tools through a draft and an approval, calls the privacy handlers and
 * checks deletion proofs, delivers events (to `onEvent` and listening agents)
 * and fires agent schedule ticks.
 *
 * The target is either a module Worker reached over a service binding (in
 * `@cloudflare/vitest-pool-workers` or Miniflare, the faithful setup) or a
 * `defineModule()` result run in-process (fast unit tests). In-process calls
 * still pass every context, request and result through `structuredClone`, as
 * Workers RPC would.
 *
 * This is test tooling, not the router: it has no Access JWTs, no stored
 * keys and no persistence. Core stays the source of truth for those rules.
 * To look at one agent run in detail (its context and return value), use
 * `createAgentHarness` from agent-harness.ts.
 */
import {
  actorId,
  isAgentPrincipal,
  runAgentEvent,
  runAgentTick,
  type Actor,
  type AgentTick,
  type SerializedAgentScope,
} from "./agents.js";
import type { Brand } from "./brand.js";
import { createPlantContext, type MemberRole, type Principal, type SerializedPlantContext, type Surface, type Tenant } from "./context.js";
import { requiredRoleFor, roleAtLeast } from "./roles.js";
import type { DefinedModule } from "./define.js";
import type { PlantEvent } from "./extensions.js";
import { isOptionalKey, moduleState, type KeyStatus, type ModuleKeyStatus } from "./keys.js";
import type { ModuleManifest } from "./manifest.js";
import {
  MCP_RESOURCE_SCHEME,
  type McpExtensionDescriptor,
  type McpInvocation,
  type McpInvocationResult,
  type McpPromptDescriptor,
  type McpResourceDescriptor,
  type McpToolDescriptor,
} from "./mcp-extension.js";
import { mcpWireName, parseMcpWireName } from "./mcp-wire.js";
import type { PrivacyRpc } from "./module.js";
import { harnessCapability, localPrivacyService, PRIVACY_BINDING, privacyContextFor } from "./subjects.js";
import {
  hashSubject,
  type DataSubject,
  type DeletionProof,
  type PrivacyExport,
  type PrivacyFindResult,
  type PrivacyVerifyResult,
  type SubjectKey,
} from "./privacy.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** The harness's default tenant. */
export const HARNESS_TENANT: Tenant = Object.freeze({ id: "t_test", hostname: "test.example.com" });

/** The harness's default signed-in person (what Cloudflare Access would vouch for). */
export const HARNESS_PRINCIPAL: Principal = Object.freeze({
  email: "owner@test.example.com",
  groups: Object.freeze(["admins"]),
});

/** The harness's default member role for the signed-in person. */
export const HARNESS_ROLE: MemberRole = "owner";

/** The harness's default brand: a neutral stand-in for core's defaults. */
export const HARNESS_BRAND: Brand = Object.freeze({
  name: "Test Plant",
  logoUrl: "https://test.example.com/logo.svg",
  faviconUrl: "https://test.example.com/favicon.ico",
  colors: Object.freeze({ primary: "#2563eb", accent: "#f59e0b", bg: "#ffffff", fg: "#111827", muted: "#6b7280" }),
  supportEmail: "support@test.example.com",
  emailFromName: "Test Plant",
  poweredBy: true,
});

/** Set on every response the harness makes up itself (never on the module's own responses). */
export const HARNESS_GATE_HEADER = "x-plant-harness-gate";
/** Matches the router: `needs-setup` on responses served instead of a module that needs setup. */
export const MODULE_STATE_HEADER = "x-plant-module-state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What a module Worker exposes over a service binding (see `PlantModule`).
 * Pass the binding itself, e.g. `env.HELLO as unknown as ModuleRpcTarget`;
 * the cast is needed because RPC stub types don't line up with plain
 * interfaces.
 */
export interface ModuleRpcTarget {
  manifest(): ModuleManifest | Promise<ModuleManifest>;
  handle(request: Request, ctx: SerializedPlantContext): Promise<Response>;
  privacy?(): PrivacyRpc | Promise<PrivacyRpc>;
  mcp?(): McpExtensionDescriptor | Promise<McpExtensionDescriptor>;
  mcpInvoke?(invocation: McpInvocation, ctx: SerializedPlantContext): Promise<McpInvocationResult>;
  onEvent?(event: PlantEvent, ctx: SerializedPlantContext): Promise<void>;
  onAgentTick?(agent: string, tick: AgentTick, scope: SerializedAgentScope): Promise<void>;
}

export interface ModuleHarnessOptions<Env = unknown> {
  /** The module's env. Used only for in-process targets. */
  readonly env?: Env;
  /** Defaults to {@link HARNESS_TENANT}. */
  readonly tenant?: Tenant;
  /** The signed-in person. Defaults to {@link HARNESS_PRINCIPAL}; `null` means nobody is signed in. */
  readonly principal?: Principal | null;
  /**
   * The signed-in person's member role in the tenant, as the router would
   * resolve it. Defaults to {@link HARNESS_ROLE} (owner); `null` means no
   * role. Set on `ctx.principal.role` for surface "app" only, like the router.
   */
  readonly role?: MemberRole | null;
  /**
   * Apply the router's role gate on app routes (the default rule plus the
   * manifest's roleRules) before calling `handle()`. Defaults to true. Turn
   * it off to test the module's own requireRole checks.
   */
  readonly enforceRoles?: boolean;
  /** Defaults to {@link HARNESS_BRAND}. */
  readonly brand?: Brand;
  /** Entitlement keys the tenant has. Defaults to none. */
  readonly entitlements?: readonly string[];
  /** Where the module is mounted. Defaults to `/<moduleId>`. */
  readonly basePath?: string;
  /**
   * Required keys that are set, by name. Only the names matter: the harness
   * never sends a value anywhere. A module whose required keys aren't all set
   * is `needs-setup`; unset `optional` keys don't count.
   */
  readonly keys?: Readonly<Record<string, string>>;
  /**
   * A test-only subject key: the harness's stand-in for core's per-tenant
   * keys. In-process modules get a mock of core's Privacy entrypoint that
   * hashes with it as `env.PLANT_PRIVACY` (so `ctx.subjects` works), and
   * {@link HarnessPrivacy.verifyProof} checks proofs against it. For a module
   * Worker, bind `PLANT_PRIVACY` to a `MockCorePrivacy` Worker holding the same key.
   */
  readonly subjectKey?: SubjectKey;
}

/** Per-call overrides of the harness's tenant, principal, role and entitlements. */
export interface HarnessCallOptions {
  readonly tenant?: Tenant;
  readonly principal?: Principal | null;
  /** The person's role for this call; `null` means none. */
  readonly role?: MemberRole | null;
  readonly entitlements?: readonly string[];
}

/** A tool as the plant MCP server lists it: `name` is the wire name. */
export interface HarnessTool extends McpToolDescriptor {
  /** The module-relative name, e.g. `list_entries`. */
  readonly toolName: string;
}

export interface HarnessPrompt extends McpPromptDescriptor {
  readonly promptName: string;
}

export interface HarnessResource extends McpResourceDescriptor {
  /** The full URI template, e.g. `plant://hello/entries/{id}`. */
  readonly uri: string;
}

/**
 * A write-tool call waiting for a person to approve it. Same rules as core's
 * drafts flow: a person approves, never an
 * agent and never the creator; a draft runs at most once; a rejected draft
 * never runs. Core also expires drafts after a TTL, which the harness doesn't.
 */
export interface HarnessDraft {
  readonly id: string;
  /** Wire name of the tool. */
  readonly tool: string;
  readonly input: unknown;
  /** Who asked for it, as `actorId` gives it: `person:<email>` or `agent:<module>/<agent>`. */
  readonly createdBy: string;
  readonly status: "pending" | "approved" | "rejected";
}

export interface HarnessMcp {
  /** Tools the tenant can see. Empty while the module needs setup. */
  listTools(options?: HarnessCallOptions): Promise<HarnessTool[]>;
  /**
   * Call a tool by wire name. Write tools without `draftId` come back
   * `draft_required` from the module; use {@link createDraft} and
   * {@link approveDraft}.
   */
  callTool(
    wireName: string,
    input?: unknown,
    options?: HarnessCallOptions & { readonly draftId?: string },
  ): Promise<McpInvocationResult>;
  /** Record a draft for a write tool, as core does when an agent or person calls one. */
  createDraft(wireName: string, input?: unknown, options?: { readonly createdBy?: Actor }): Promise<HarnessDraft>;
  /**
   * A person approves a draft, and the tool runs with its `draftId`. The
   * approver must be a signed-in person (never an agent) other than the
   * draft's creator.
   */
  approveDraft(draftId: string, options?: HarnessCallOptions & { readonly approver?: Principal }): Promise<McpInvocationResult>;
  /** A person rejects a pending draft; it never runs. Agents can't reject. */
  rejectDraft(draftId: string, options?: HarnessCallOptions & { readonly approver?: Principal }): Promise<HarnessDraft>;
  listResources(options?: HarnessCallOptions): Promise<HarnessResource[]>;
  /** Read a resource by its full URI, `plant://<moduleId>/...`. */
  readResource(uri: string, options?: HarnessCallOptions): Promise<McpInvocationResult>;
  listPrompts(options?: HarnessCallOptions): Promise<HarnessPrompt[]>;
  getPrompt(
    wireName: string,
    args?: Readonly<Record<string, string>>,
    options?: HarnessCallOptions,
  ): Promise<McpInvocationResult>;
}

export interface HarnessPrivacy {
  find(subject: DataSubject, options?: HarnessCallOptions): Promise<PrivacyFindResult>;
  export(subject: DataSubject, options?: HarnessCallOptions): Promise<PrivacyExport>;
  delete(subject: DataSubject, options?: HarnessCallOptions): Promise<DeletionProof>;
  verify(subject: DataSubject, options?: HarnessCallOptions): Promise<PrivacyVerifyResult>;
  /**
   * Whether `proof` is this module's proof for `subject` in the tenant: the
   * ids match and `subjectHash` is the HMAC under the harness's `subjectKey`.
   */
  verifyProof(proof: DeletionProof, subject: DataSubject, options?: { readonly tenant?: Tenant }): Promise<boolean>;
}

/** An event to deliver. Missing fields are filled in. */
export type HarnessEventInit<Data = unknown> = Pick<PlantEvent<Data>, "type"> & Partial<Omit<PlantEvent<Data>, "type">>;

export interface ModuleHarness {
  manifest(): Promise<ModuleManifest>;
  /** The context the router would send for `surface`. */
  context(surface: Surface, options?: HarnessCallOptions): Promise<SerializedPlantContext>;
  /** The module's required-key status, from the harness's `keys`. */
  keyStatus(): Promise<ModuleKeyStatus>;
  setKey(name: string, value: string): void;
  unsetKey(name: string): void;
  /**
   * Send a request through the mock router. `path` is module-relative
   * (`/`, `/public/hello`); the module receives the full URL under basePath.
   * Responses the harness makes up itself carry {@link HARNESS_GATE_HEADER}.
   */
  fetch(path: string, init?: RequestInit, options?: HarnessCallOptions): Promise<Response>;
  readonly mcp: HarnessMcp;
  readonly privacy: HarnessPrivacy;
  /**
   * Deliver an event to the module's `onEvent` and every agent that listens
   * for it. Throws if nothing in the module listens for it.
   */
  emit(event: HarnessEventInit, options?: HarnessCallOptions): Promise<PlantEvent>;
  /** Fire one schedule tick of an agent, as the plant's cron would. `scheduledAt` defaults to now. */
  tickAgent(agent: string, options?: HarnessCallOptions & { readonly scheduledAt?: Date | string }): Promise<AgentTick>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class HarnessError extends Error {
  override name = "HarnessError";
}

const clone = <T>(value: T): T => structuredClone(value);

/** In-process adapter: the same RPC surface as `moduleEntrypoint`, without Workers. */
function inProcess<Env>(mod: DefinedModule<Env>, env: Env): ModuleRpcTarget {
  const { manifest, handlers } = mod;
  const target: ModuleRpcTarget = {
    manifest: () => clone(manifest),
    async handle(request, ctx) {
      const res = await handlers.handle(request, createPlantContext(clone(ctx)), env);
      // Bodies cross RPC as streams; buffer so the module's Response can't be reused.
      return new Response(await res.arrayBuffer(), { status: res.status, statusText: res.statusText, headers: res.headers });
    },
  };
  if (handlers.privacy) {
    const p = handlers.privacy;
    const pctx = (c: SerializedPlantContext) => privacyContextFor(createPlantContext(clone(c)), env);
    target.privacy = () => ({
      find: async (s, c) => clone(await p.find(clone(s), pctx(c), env)),
      export: async (s, c) => clone(await p.export(clone(s), pctx(c), env)),
      delete: async (s, c) => clone(await p.delete(clone(s), pctx(c), env)),
      verify: async (s, c) => clone(await p.verify(clone(s), pctx(c), env)),
    });
  }
  if (handlers.mcp) {
    const m = handlers.mcp;
    target.mcp = () => clone(m.descriptor);
    target.mcpInvoke = async (inv, ctx) => clone(await m.invoke(clone(inv), createPlantContext(clone(ctx)), env));
  }
  // Same delivery as moduleEntrypoint: the module's own onEvent plus listening agents.
  const agents = manifest.agents ?? [];
  const host = { moduleId: manifest.id, entries: agents, handlers: handlers.agentHandlers ?? {} };
  if (handlers.onEvent || agents.some((a) => a.listens.length > 0)) {
    target.onEvent = async (event, ctx) => {
      const own = manifest.events.listens.includes(event.type);
      const listeners = agents.filter((a) => a.listens.includes(event.type));
      if (!own && listeners.length === 0) throw new Error(`module "${manifest.id}" does not listen for "${event.type}"`);
      const scope = { tenant: ctx.tenant, entitlements: ctx.entitlements };
      const results = await Promise.allSettled([
        ...(own ? [handlers.onEvent!(clone(event), createPlantContext(clone(ctx)), env)] : []),
        ...listeners.map((a) => runAgentEvent(host, a.name, clone(event), clone(scope), env)),
      ]);
      const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, `${errors.length} listeners failed for "${event.type}"`);
    };
  }
  if (agents.some((a) => a.schedule)) {
    target.onAgentTick = async (agent, tick, scope) => {
      await runAgentTick(host, agent, clone(tick), clone(scope), env);
    };
  }
  return target;
}

function isDefinedModule(target: unknown): target is DefinedModule<never> {
  // RPC stubs answer every property with a callable stub, so `typeof` tells them apart.
  const t = target as { manifest?: unknown; handlers?: unknown };
  return typeof t.manifest === "object" && t.manifest !== null && typeof t.handlers === "object";
}

/** Over RPC a missing optional method throws on call; turn that into `undefined`. */
async function optional<T>(target: ModuleRpcTarget, method: keyof ModuleRpcTarget, call: () => T | Promise<T>): Promise<T | undefined> {
  if (typeof target[method] !== "function") return undefined;
  try {
    return await call();
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/does not (implement|have)|not a function|no such method|is not implemented/i.test(msg)) return undefined;
    throw err;
  }
}

function gateResponse(status: number, reason: string, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", [HARNESS_GATE_HEADER]: reason, ...extra },
  });
}

function isPublicPath(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => {
    const base = p.endsWith("/") ? p.slice(0, -1) : p;
    return path === base || path.startsWith(`${base}/`) || (p.endsWith("/") && path.startsWith(p));
  });
}

let draftCounter = 0;

/**
 * The in-process module's env, with a mock of core's Privacy entrypoint as
 * `PLANT_PRIVACY` when the harness has a subjectKey and the env has none.
 */
function withMockCore<Env>(mod: DefinedModule<Env>, options: ModuleHarnessOptions<Env>): Env {
  const env = options.env as Env;
  const own = (env as Record<string, unknown> | undefined)?.[PRIVACY_BINDING];
  if (options.subjectKey === undefined || own !== undefined) return env;
  const service = localPrivacyService({ moduleId: mod.manifest.id, subjectKey: options.subjectKey });
  const base = (env ?? {}) as object;
  return new Proxy(base, {
    get: (t, k, r) => (k === PRIVACY_BINDING ? service : Reflect.get(t, k, r)),
    has: (t, k) => k === PRIVACY_BINDING || Reflect.has(t, k),
  }) as Env;
}

/**
 * Create a mock router around one module.
 *
 * ```ts
 * import { env } from "cloudflare:test";
 * const plant = createModuleHarness(env.HELLO as unknown as ModuleRpcTarget, {
 *   entitlements: ["hello.basic"],
 *   keys: { HELLO_API_KEY: "test" },
 *   subjectKey,
 * });
 * const res = await plant.fetch("/");
 * const tools = await plant.mcp.listTools(); // [{ name: "hello__list_entries", ... }]
 * ```
 */
export function createModuleHarness<Env = unknown>(
  target: ModuleRpcTarget | DefinedModule<Env>,
  options: ModuleHarnessOptions<Env> = {},
): ModuleHarness {
  const rpc: ModuleRpcTarget = isDefinedModule(target)
    ? inProcess(target as DefinedModule<Env>, withMockCore(target as DefinedModule<Env>, options))
    : (target as ModuleRpcTarget);
  const keys = new Map(Object.entries(options.keys ?? {}));
  const drafts = new Map<string, HarnessDraft & { status: "pending" | "approved" | "rejected" }>();
  let manifestCache: Promise<ModuleManifest> | undefined;
  let descriptorCache: Promise<McpExtensionDescriptor | undefined> | undefined;

  const manifest = () => (manifestCache ??= Promise.resolve(rpc.manifest()).then(clone));
  const descriptor = () =>
    (descriptorCache ??= optional(rpc, "mcp", () => rpc.mcp!()).then((d) => (d === undefined ? undefined : clone(d))));

  const principalFor = (o: HarnessCallOptions): Principal | null =>
    o.principal !== undefined ? o.principal : options.principal !== undefined ? options.principal : HARNESS_PRINCIPAL;

  const roleFor = (o: HarnessCallOptions): MemberRole | null =>
    o.role !== undefined ? o.role : options.role !== undefined ? options.role : HARNESS_ROLE;

  async function context(surface: Surface, o: HarnessCallOptions = {}): Promise<SerializedPlantContext> {
    const m = await manifest();
    const role = roleFor(o);
    const person = principalFor(o);
    // Like the router: the role it resolved, on surface "app" only. Any role
    // on a principal passed in is replaced.
    const principal =
      person === null
        ? null
        : (({ role: _r, ...rest }) => (surface === "app" && role !== null ? { ...rest, role } : rest))(person);
    const tenant = o.tenant ?? options.tenant ?? HARNESS_TENANT;
    const ctx: SerializedPlantContext = {
      tenant,
      principal: surface === "public" ? null : principal,
      brand: options.brand ?? HARNESS_BRAND,
      entitlements: [...(o.entitlements ?? options.entitlements ?? [])],
      basePath: options.basePath ?? `/${m.id}`,
      surface,
      // The router attaches a core-signed capability (with the role signed in
      // it on "app"). The harness attaches an unsigned stand-in that only its mock core (localPrivacyService,
      // MockCorePrivacy) accepts; real core rejects it.
      capability: harnessCapability(tenant.id, m.id),
    };
    createPlantContext(ctx); // same validation the module will run
    return clone(ctx);
  }

  async function keyStatus(): Promise<ModuleKeyStatus> {
    const m = await manifest();
    const list: KeyStatus[] = (m.requiredKeys ?? []).map((k) => ({
      name: k.name,
      description: k.description,
      shared: k.shared === true,
      metered: k.metered === true,
      optional: isOptionalKey(k),
      set: keys.has(k.name) && keys.get(k.name) !== "",
    }));
    return { moduleId: m.id, ...moduleState(list), keys: list };
  }

  const ready = async () => (await keyStatus()).state === "ready";

  async function missingEntitlements(o: HarnessCallOptions): Promise<string[]> {
    const m = await manifest();
    const have = new Set(o.entitlements ?? options.entitlements ?? []);
    return m.requires.filter((r) => !have.has(r));
  }

  async function entitled(requires: string | undefined, o: HarnessCallOptions): Promise<boolean> {
    return requires === undefined || (o.entitlements ?? options.entitlements ?? []).includes(requires);
  }

  async function mcpCall(invocation: McpInvocation, o: HarnessCallOptions): Promise<McpInvocationResult> {
    if (!(await ready()) || (await missingEntitlements(o)).length > 0) {
      return { ok: false, error: { code: "not_found", message: "module is not available to this tenant" } };
    }
    const ctx = await context("mcp", o);
    const result = await optional(rpc, "mcpInvoke", () => rpc.mcpInvoke!(clone(invocation), ctx));
    if (result === undefined) return { ok: false, error: { code: "not_found", message: "module has no MCP extension" } };
    return clone(result);
  }

  async function resolveTool(wireName: string): Promise<{ name: string; info: McpToolDescriptor } | undefined> {
    const m = await manifest();
    const parsed = parseMcpWireName(wireName);
    if (!parsed || parsed.moduleId !== m.id) return undefined;
    const info = (await descriptor())?.tools.find((t) => t.name === parsed.name);
    return info ? { name: parsed.name, info } : undefined;
  }

  const mcp: HarnessMcp = {
    async listTools(o = {}) {
      const m = await manifest();
      const d = await descriptor();
      if (!d || !(await ready()) || (await missingEntitlements(o)).length > 0) return [];
      const out: HarnessTool[] = [];
      for (const t of d.tools) {
        if (await entitled(t.requires, o)) out.push({ ...t, name: mcpWireName(m.id, t.name), toolName: t.name });
      }
      return out;
    },

    async callTool(wireName, input = {}, o = {}) {
      const tool = await resolveTool(wireName);
      if (!tool) return { ok: false, error: { code: "not_found", message: `unknown MCP tool "${wireName}"` } };
      return mcpCall({ kind: "tool", name: tool.name, input, ...(o.draftId !== undefined ? { draftId: o.draftId } : {}) }, o);
    },

    async createDraft(wireName, input = {}, o = {}) {
      const tool = await resolveTool(wireName);
      if (!tool) throw new HarnessError(`unknown MCP tool "${wireName}"`);
      if (!tool.info.write) throw new HarnessError(`tool "${wireName}" is not a write tool; call it directly`);
      const creator = o.createdBy ?? principalFor({});
      if (!creator) throw new HarnessError("drafts are created by a signed-in person or an agent");
      const draft = {
        id: `draft_test_${++draftCounter}`,
        tool: wireName,
        input: clone(input),
        createdBy: actorId(creator),
        status: "pending" as "pending" | "approved" | "rejected",
      };
      drafts.set(draft.id, draft);
      return clone(draft);
    },

    async approveDraft(draftId, o = {}) {
      const draft = drafts.get(draftId);
      if (!draft) throw new HarnessError(`unknown draft "${draftId}"`);
      if (draft.status !== "pending") throw new HarnessError(`draft "${draftId}" is already ${draft.status}`);
      const approver = o.approver ?? principalFor(o);
      if (!approver || isAgentPrincipal(approver as Actor)) throw new HarnessError("drafts are approved by a signed-in person, never an agent");
      if (actorId(approver) === draft.createdBy) throw new HarnessError("a draft can't be approved by whoever created it");
      if (!roleAtLeast(roleFor(o), "member")) throw new HarnessError("insufficient_role: approving a draft needs role member or higher");
      draft.status = "approved";
      return mcp.callTool(draft.tool, draft.input, { ...o, principal: approver, draftId });
    },

    async rejectDraft(draftId, o = {}) {
      const draft = drafts.get(draftId);
      if (!draft) throw new HarnessError(`unknown draft "${draftId}"`);
      if (draft.status !== "pending") throw new HarnessError(`draft "${draftId}" is already ${draft.status}`);
      const approver = o.approver ?? principalFor(o);
      if (!approver || isAgentPrincipal(approver as Actor)) throw new HarnessError("drafts are rejected by a signed-in person, never an agent");
      if (!roleAtLeast(roleFor(o), "member")) throw new HarnessError("insufficient_role: rejecting a draft needs role member or higher");
      draft.status = "rejected";
      return clone(draft);
    },

    async listResources(o = {}) {
      const m = await manifest();
      const d = await descriptor();
      if (!d || !(await ready()) || (await missingEntitlements(o)).length > 0) return [];
      const out: HarnessResource[] = [];
      for (const r of d.resources) {
        if (await entitled(r.requires, o)) out.push({ ...r, uri: `${MCP_RESOURCE_SCHEME}://${m.id}/${r.uriTemplate}` });
      }
      return out;
    },

    async readResource(uri, o = {}) {
      const m = await manifest();
      const prefix = `${MCP_RESOURCE_SCHEME}://${m.id}/`;
      if (typeof uri !== "string" || !uri.startsWith(prefix)) {
        return { ok: false, error: { code: "not_found", message: `no MCP resource matches "${String(uri)}"` } };
      }
      const result = await mcpCall({ kind: "resource", uri: uri.slice(prefix.length) }, o);
      // Core puts the full URI back on the contents.
      if (result.ok && result.kind === "resource") {
        return { ...result, contents: result.contents.map((c) => ({ ...c, uri: prefix + c.uri })) };
      }
      return result;
    },

    async listPrompts(o = {}) {
      const m = await manifest();
      const d = await descriptor();
      if (!d || !(await ready()) || (await missingEntitlements(o)).length > 0) return [];
      const out: HarnessPrompt[] = [];
      for (const p of d.prompts) {
        if (await entitled(p.requires, o)) out.push({ ...p, name: mcpWireName(m.id, p.name), promptName: p.name });
      }
      return out;
    },

    async getPrompt(wireName, args, o = {}) {
      const m = await manifest();
      const parsed = parseMcpWireName(wireName);
      if (!parsed || parsed.moduleId !== m.id) {
        return { ok: false, error: { code: "not_found", message: `unknown MCP prompt "${wireName}"` } };
      }
      return mcpCall({ kind: "prompt", name: parsed.name, ...(args ? { arguments: args } : {}) }, o);
    },
  };

  async function privacyCall<K extends keyof PrivacyRpc>(
    method: K,
    subject: DataSubject,
    o: HarnessCallOptions,
  ): Promise<Awaited<ReturnType<PrivacyRpc[K]>>> {
    const m = await manifest();
    const ctx = await context("app", o);
    if (ctx.principal === null) throw new HarnessError("privacy requests run as a signed-in person");
    const stub = await optional(rpc, "privacy", () => rpc.privacy!());
    if (!stub) throw new HarnessError(`module "${m.id}" has no privacy handlers`);
    try {
      // Call it as a method: on an RPC stub, `.call` would itself be a remote method name.
      const target = stub as unknown as Record<K, (s: DataSubject, c: SerializedPlantContext) => Promise<Awaited<ReturnType<PrivacyRpc[K]>>>>;
      return clone(await target[method](clone(subject), ctx));
    } finally {
      // Release the RPC stub when the runtime supports explicit disposal.
      const dispose = (Symbol as { readonly dispose?: symbol }).dispose;
      if (dispose) (stub as unknown as Record<symbol, (() => void) | undefined>)[dispose]?.();
    }
  }

  const privacy: HarnessPrivacy = {
    find: (s, o = {}) => privacyCall("find", s, o),
    export: (s, o = {}) => privacyCall("export", s, o),
    delete: (s, o = {}) => privacyCall("delete", s, o),
    verify: (s, o = {}) => privacyCall("verify", s, o),
    async verifyProof(proof, subject, o = {}) {
      if (options.subjectKey === undefined) throw new HarnessError("verifyProof needs the harness's subjectKey option");
      const m = await manifest();
      const tenant = o.tenant ?? options.tenant ?? HARNESS_TENANT;
      if (proof.moduleId !== m.id || proof.tenantId !== tenant.id || proof.subjectHashAlgorithm !== "HMAC-SHA-256") {
        return false;
      }
      return proof.subjectHash === (await hashSubject(subject, options.subjectKey));
    },
  };

  let eventCounter = 0;

  return {
    manifest: async () => clone(await manifest()),
    context,
    keyStatus,
    setKey(name, value) {
      keys.set(name, value);
    },
    unsetKey(name) {
      keys.delete(name);
    },

    async fetch(path, init = {}, o = {}) {
      const m = await manifest();
      if (typeof path !== "string" || !path.startsWith("/")) {
        throw new HarnessError(`fetch: path "${String(path)}" must be module-relative and start with "/"`);
      }
      const rel = new URL(path, "https://harness.invalid").pathname;
      const isPublic = isPublicPath(rel, m.publicPrefixes);
      if (!isPublic && principalFor(o) === null) {
        return gateResponse(401, "access", { error: "unauthenticated", message: "Cloudflare Access: sign in required" });
      }
      const ctx = await context(isPublic ? "public" : "app", o);
      if (!isPublic && options.enforceRoles !== false) {
        const required = requiredRoleFor(init.method ?? "GET", rel, m.roleRules);
        if (!roleAtLeast(roleFor(o), required)) {
          return gateResponse(403, "role", { error: "insufficient_role", required });
        }
      }
      const missing = await missingEntitlements(o);
      if (missing.length > 0) {
        return gateResponse(403, "entitlements", isPublic ? { error: "not_found" } : { error: "not_entitled", missing });
      }
      const status = await keyStatus();
      if (status.state !== "ready") {
        const body = isPublic
          ? { error: "unavailable" }
          : {
              error: "needs-setup",
              moduleId: m.id,
              missing: status.keys
                .filter((k) => status.missing.includes(k.name))
                .map((k) => ({ name: k.name, description: k.description, shared: k.shared })),
            };
        return gateResponse(503, "needs-setup", body, { [MODULE_STATE_HEADER]: "needs-setup", "retry-after": "60" });
      }
      const url = new URL(`${ctx.basePath}${path}`, `https://${ctx.tenant.hostname}`);
      const request = new Request(url, init);
      return rpc.handle(request, ctx);
    },

    mcp,
    privacy,

    async emit(init, o = {}) {
      const m = await manifest();
      const listened = m.events.listens.includes(init.type) || (m.agents ?? []).some((a) => a.listens.includes(init.type));
      if (!listened) throw new HarnessError(`module "${m.id}" does not listen for "${init.type}"`);
      const ctx = await context("app", o);
      const event: PlantEvent = {
        id: init.id ?? `evt_test_${++eventCounter}`,
        type: init.type,
        tenantId: init.tenantId ?? ctx.tenant.id,
        source: init.source ?? init.type.split(".")[0]!,
        occurredAt: init.occurredAt ?? new Date().toISOString(),
        data: init.data ?? {},
      };
      const delivered = await optional(rpc, "onEvent", async () => {
        await rpc.onEvent!(clone(event), ctx);
        return true;
      });
      if (!delivered) throw new HarnessError(`module "${m.id}" has no onEvent handler`);
      return clone(event);
    },

    async tickAgent(agent, o = {}) {
      const m = await manifest();
      const entry = (m.agents ?? []).find((a) => a.name === agent);
      if (!entry) throw new HarnessError(`module "${m.id}" has no agent "${agent}"`);
      if (!entry.schedule) throw new HarnessError(`agent "${agent}" has no schedule`);
      if (!(await ready())) throw new HarnessError(`module "${m.id}" needs setup; the plant doesn't run its agents`);
      const tick: AgentTick = { cron: entry.schedule, scheduledAt: new Date(o.scheduledAt ?? Date.now()).toISOString() };
      const scope: SerializedAgentScope = {
        tenant: o.tenant ?? options.tenant ?? HARNESS_TENANT,
        entitlements: [...(o.entitlements ?? options.entitlements ?? [])],
      };
      const ran = await optional(rpc, "onAgentTick", async () => {
        await rpc.onAgentTick!(agent, tick, scope);
        return true;
      });
      if (!ran) throw new HarnessError(`module "${m.id}" has no onAgentTick`);
      return tick;
    },
  };
}
