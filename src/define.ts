/** defineModule: one declaration for everything a module adds to a plant. */
import { normalizeAgents, type AgentDefinition, type AgentHandlers } from "./agents.js";
import type { PlantContext } from "./context.js";
import type { PlantEvent } from "./extensions.js";
import { isMcpExtension, MCP_NAME, type McpExtension } from "./mcp-extension.js";
import { MCP_WIRE_NAME_MAX, mcpWireName } from "./mcp-wire.js";
import type { JsonSchema, ModuleEvents, ModuleManifest, NavItem } from "./manifest.js";
import { normalizeRequiredKeys, type RequiredKey } from "./keys.js";
import type { PrivacyHandlers } from "./privacy.js";
import { isMemberRole } from "./context.js";
import type { RoleRule } from "./roles.js";

export type HandleFn<Env = unknown> = (
  request: Request,
  ctx: PlantContext,
  env: Env,
) => Response | Promise<Response>;

export type OnEventFn<Env = unknown> = (
  event: PlantEvent,
  ctx: PlantContext,
  env: Env,
) => void | Promise<void>;

export interface ModuleHandlers<Env = unknown> {
  readonly handle: HandleFn<Env>;
  readonly privacy?: PrivacyHandlers<Env>;
  readonly mcp?: McpExtension<Env>;
  readonly onEvent?: OnEventFn<Env>;
  /** Agent handlers by agent name. */
  readonly agentHandlers?: Readonly<Record<string, AgentHandlers<Env>>>;
}

/** What you pass to {@link defineModule}. Lists default to empty. */
export interface ModuleDefinition<Env = unknown> extends ModuleHandlers<Env> {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly coreRange: string;
  readonly nav?: readonly NavItem[];
  readonly publicPrefixes?: readonly string[];
  readonly requires?: readonly string[];
  readonly settings?: JsonSchema;
  readonly events?: Partial<ModuleEvents>;
  readonly requiredKeys?: readonly RequiredKey[];
  /** Proactive agents: schedules and event listeners (see agents.ts). */
  readonly agents?: readonly AgentDefinition<Env>[];
  /** Minimum member roles by path prefix, enforced by the router (see roles.ts). */
  readonly roleRules?: readonly RoleRule[];
}

export interface DefinedModule<Env = unknown> {
  readonly manifest: ModuleManifest;
  readonly handlers: ModuleHandlers<Env>;
}

/**
 * Module ids: a lowercase slug, at most 63 characters. `-` is allowed (every
 * MCP client accepts it in tool names); `_` is not, so the first `__` in an
 * MCP wire name (`<moduleId>__<tool>`) is always the separator. The id counts
 * against the 64-character wire-name limit, so keep ids short: a module with
 * MCP tools needs `id.length + 2 + name.length <= 64` for every tool and prompt.
 */
export const MODULE_ID = /^[a-z][a-z0-9-]{0,62}$/;
export const TOOL_NAME = MCP_NAME;
export const EVENT_TYPE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9_-]*)+$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
/** Characters allowed in a node-semver range. Not a full parser: a cheap sanity check. */
const SEMVER_RANGE = /^[0-9xX*.^~<>=|\s\-A-Za-z+]+$/;

const EMPTY_SETTINGS: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

export class ModuleDefinitionError extends Error {
  override name = "ModuleDefinitionError";
}

function fail(id: string, message: string): never {
  throw new ModuleDefinitionError(`defineModule(${JSON.stringify(id)}): ${message}`);
}

function checkPath(id: string, what: string, path: string): void {
  if (!path.startsWith("/")) fail(id, `${what} "${path}" must start with "/"`);
}

function checkNav(id: string, items: readonly NavItem[]): void {
  for (const item of items) {
    if (!item.label) fail(id, "nav items need a label");
    checkPath(id, "nav path", item.path);
    if (item.children) checkNav(id, item.children);
  }
}

function unique(id: string, what: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) fail(id, `duplicate ${what} "${v}"`);
    seen.add(v);
  }
}

const HTTP_METHOD = /^[A-Z]+$/;

function checkRoleRules(id: string, rules: readonly RoleRule[]): RoleRule[] {
  const seen = new Set<string>();
  return rules.map((rule) => {
    checkPath(id, "roleRules prefix", rule.prefix);
    if (!isMemberRole(rule.minRole)) fail(id, `roleRules "${rule.prefix}": unknown minRole "${String(rule.minRole)}"`);
    if (rule.methods !== undefined) {
      if (!Array.isArray(rule.methods) || rule.methods.length === 0) {
        fail(id, `roleRules "${rule.prefix}": methods must be a non-empty list when set`);
      }
      for (const m of rule.methods) {
        if (typeof m !== "string" || !HTTP_METHOD.test(m)) fail(id, `roleRules "${rule.prefix}": method "${String(m)}" must be upper case, e.g. "POST"`);
      }
    }
    const key = `${rule.prefix} ${rule.methods ? [...rule.methods].sort().join(",") : "*"}`;
    if (seen.has(key)) fail(id, `duplicate roleRules entry "${key}"`);
    seen.add(key);
    return { prefix: rule.prefix, ...(rule.methods ? { methods: [...rule.methods] } : {}), minRole: rule.minRole };
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Declare a module: its manifest (nav, public routes, events, settings,
 * entitlements, core range) and its handlers (HTTP, privacy, MCP, events).
 * Validates the declaration and returns a frozen manifest plus the handlers.
 */
export function defineModule<Env = unknown>(def: ModuleDefinition<Env>): DefinedModule<Env> {
  const id = def.id;
  if (!MODULE_ID.test(id)) fail(id, "id must be a lowercase slug (a-z, 0-9, -)");
  if (!def.name?.trim()) fail(id, "name is required");
  if (!SEMVER.test(def.version)) fail(id, `version "${def.version}" is not semver`);
  if (!def.coreRange?.trim() || !SEMVER_RANGE.test(def.coreRange) || !/\d/.test(def.coreRange)) {
    fail(id, `coreRange "${def.coreRange}" is not a semver range`);
  }
  if (typeof def.handle !== "function") fail(id, "handle(request, ctx, env) is required");

  const nav = def.nav ?? [];
  checkNav(id, nav);

  const publicPrefixes = def.publicPrefixes ?? [];
  for (const p of publicPrefixes) checkPath(id, "publicPrefix", p);
  unique(id, "publicPrefix", publicPrefixes);

  const requires = def.requires ?? [];
  unique(id, "entitlement", requires);

  const events: ModuleEvents = { emits: def.events?.emits ?? [], listens: def.events?.listens ?? [] };
  for (const t of [...events.emits, ...events.listens]) {
    if (!EVENT_TYPE.test(t)) fail(id, `event type "${t}" must look like "<module>.<name>"`);
  }
  for (const t of events.emits) {
    if (!t.startsWith(`${id}.`)) fail(id, `emitted event "${t}" must be namespaced "${id}."`);
  }
  unique(id, "emitted event", events.emits);
  unique(id, "listened event", events.listens);
  if (events.listens.length > 0 && typeof def.onEvent !== "function") {
    fail(id, "events.listens is set but onEvent is missing");
  }

  if (def.privacy) {
    for (const m of ["find", "export", "delete", "verify"] as const) {
      if (typeof def.privacy[m] !== "function") fail(id, `privacy.${m} is required`);
    }
  }

  if (def.mcp !== undefined && !isMcpExtension(def.mcp)) {
    fail(id, "mcp must be created with defineMcpExtension()");
  }
  if (def.mcp) {
    const { tools, prompts } = def.mcp.descriptor;
    for (const [what, list] of [["tool", tools], ["prompt", prompts]] as const) {
      for (const { name } of list) {
        try {
          mcpWireName(id, name);
        } catch {
          fail(id, `MCP ${what} "${id}__${name}" is longer than ${MCP_WIRE_NAME_MAX} characters; shorten the ${what} name or the module id`);
        }
      }
    }
  }

  let requiredKeys: RequiredKey[] = [];
  try {
    requiredKeys = normalizeRequiredKeys(def.requiredKeys ?? []);
  } catch (err) {
    fail(id, (err as Error).message);
  }

  const agents = normalizeAgents(def.agents ?? [], EVENT_TYPE, (m) => fail(id, m));

  const roleRules = checkRoleRules(id, def.roleRules ?? []);

  const manifest: ModuleManifest = deepFreeze(
    structuredClone({
      id,
      name: def.name,
      version: def.version,
      coreRange: def.coreRange.trim(),
      nav,
      publicPrefixes,
      requires,
      settings: def.settings ?? EMPTY_SETTINGS,
      events,
      ...(requiredKeys.length > 0 ? { requiredKeys } : {}),
      ...(agents.entries.length > 0 ? { agents: agents.entries } : {}),
      ...(roleRules.length > 0 ? { roleRules } : {}),
    }),
  );

  const handlers: ModuleHandlers<Env> = Object.freeze({
    handle: def.handle,
    ...(def.privacy ? { privacy: def.privacy } : {}),
    ...(def.mcp ? { mcp: def.mcp } : {}),
    ...(def.onEvent ? { onEvent: def.onEvent } : {}),
    ...(agents.entries.length > 0 ? { agentHandlers: Object.freeze(agents.handlers) } : {}),
  });

  return Object.freeze({ manifest, handlers });
}
