/**
 * Agents: the conventions for proactive agents inside a module.
 *
 * The SDK only carries types and plain helpers. The agent runtime (Flue,
 * Durable Objects, Workflows) is a dependency of the module, never of the SDK.
 *
 * The conventions:
 * - Every conversation id is tenant-scoped: `<tenantId>.<rest>`.
 * - Scheduled work gets a new conversation per run, `<tenantId>.sweep-<YYYY-MM-DD>`
 *   (UTC), seeded with {@link AgentInitialData}. Durable facts live in the
 *   module's own tenant-scoped tables, not in the transcript.
 * - Events go to one conversation per tenant per UTC day,
 *   `<tenantId>.events-<YYYY-MM-DD>`.
 * - Only the tenant's interactive inbox thread has a fixed id, `<tenantId>.inbox`.
 * - Every dispatch carries an idempotency key scoped to tenant, module and
 *   agent: the event id for events, the scheduled time for ticks. Redelivery
 *   then converges on the first submission, and no other tenant or module can
 *   collide with it.
 * - Agents act as an {@link AgentPrincipal}, which audits and entitlements can
 *   tell apart from a person.
 */
import type { Entitlements, Principal, Tenant } from "./context.js";
import { entitlementsFrom } from "./context.js";
import { holdCapability, type ContextCapability } from "./capability.js";
import type { PlantEvent } from "./extensions.js";
import { withModuleKeys, type ModuleKeys } from "./module-keys.js";

// ─── Manifest ────────────────────────────────────────────────────────────────

/** One agent as declared in {@link defineModule}'s `agents` list. */
export interface AgentSpec {
  /** Lowercase slug, unique within the module, e.g. `tracker`. */
  readonly name: string;
  readonly description?: string;
  /**
   * A five-field cron pattern, in UTC (Cloudflare Cron Triggers have no time
   * zones), e.g. `0 6 * * *`. Each fire becomes one {@link AgentTick}.
   */
  readonly schedule?: string;
  /**
   * `"tenant"` reads `schedule` in each tenant's own time zone instead of UTC,
   * e.g. `0 6 * * MON-FRI` is 06:00 on weekdays where the tenant is. Core then
   * fires a quarter-hourly check cron and starts the tick for each tenant whose
   * local time matches. The minute must be one
   * number, and days of the week must be names (`MON`, `MON-FRI`), so the
   * pattern can't be misread. Default `"utc"`.
   */
  readonly timeZone?: AgentTimeZone;
  /** Event types delivered to this agent's `onEvent`, e.g. `ads.campaign-changed`. */
  readonly listens?: readonly string[];
}

/** Which clock an agent's schedule is read in. */
export type AgentTimeZone = "utc" | "tenant";

/** An agent as the manifest carries it: plain data, lists always set. */
export interface AgentManifestEntry {
  readonly name: string;
  readonly description?: string;
  readonly schedule?: string;
  /** Present only when the schedule is in the tenant's time zone. */
  readonly timeZone?: "tenant";
  readonly listens: readonly string[];
}

// ─── Principal ───────────────────────────────────────────────────────────────

/**
 * Who is acting when an agent acts. `kind: "agent"` is what tells it apart
 * from a person ({@link Principal}) in audits and entitlement checks.
 */
export interface AgentPrincipal {
  readonly kind: "agent";
  /** The id of the module the agent belongs to. */
  readonly module: string;
  /** The agent's name within the module. */
  readonly agent: string;
  readonly tenantId: string;
}

/** Anyone who can act in a plant: a signed-in person or a module's agent. */
export type Actor = Principal | AgentPrincipal;

export function agentPrincipal(module: string, agent: string, tenantId: string): AgentPrincipal {
  checkTenantId(tenantId);
  if (!SLUG.test(module)) throw new TypeError(`agentPrincipal: module "${module}" is not a module id`);
  if (!SLUG.test(agent)) throw new TypeError(`agentPrincipal: agent "${agent}" is not an agent name`);
  return Object.freeze({ kind: "agent", module, agent, tenantId });
}

export function isAgentPrincipal(actor: Actor | null | undefined): actor is AgentPrincipal {
  return !!actor && (actor as Partial<AgentPrincipal>).kind === "agent";
}

/**
 * A stable string for audit logs: `agent:<module>/<agent>` for agents,
 * `person:<email>` for people. The two can never collide.
 */
export function actorId(actor: Actor): string {
  return isAgentPrincipal(actor) ? `agent:${actor.module}/${actor.agent}` : `person:${actor.email}`;
}

// ─── Conversation ids and idempotency keys ───────────────────────────────────

const SLUG = /^[a-z][a-z0-9-]{0,62}$/;
/** Tenant ids end up as the prefix of a conversation id, so they can't contain `.`. */
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const CONVERSATION_REST = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function checkTenantId(tenantId: string): void {
  if (!TENANT_ID.test(tenantId)) {
    throw new TypeError(`tenant id "${tenantId}" must be 1-63 letters, digits, "_" or "-" (no ".")`);
  }
}

/** The UTC date of a moment, `YYYY-MM-DD`. */
export function utcDate(at: Date | string | number): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) throw new TypeError(`not a date: ${String(at)}`);
  return d.toISOString().slice(0, 10);
}

/** A tenant-scoped conversation id, `<tenantId>.<rest>`. */
export function agentConversationId(tenantId: string, rest: string): string {
  checkTenantId(tenantId);
  if (!CONVERSATION_REST.test(rest)) {
    throw new TypeError(`conversation id part "${rest}" must be 1-128 letters, digits, "_" or "-"`);
  }
  return `${tenantId}.${rest}`;
}

/** The per-run conversation for scheduled work: `<tenantId>.sweep-<YYYY-MM-DD>` (UTC). */
export function sweepConversationId(tenantId: string, at: Date | string | number): string {
  return agentConversationId(tenantId, `sweep-${utcDate(at)}`);
}

/** The per-day conversation for events: `<tenantId>.events-<YYYY-MM-DD>` (UTC). */
export function eventsConversationId(tenantId: string, at: Date | string | number): string {
  return agentConversationId(tenantId, `events-${utcDate(at)}`);
}

/** The tenant's interactive inbox thread, the one fixed id: `<tenantId>.inbox`. */
export function inboxConversationId(tenantId: string): string {
  return agentConversationId(tenantId, "inbox");
}

/** The tenant a conversation id belongs to, or `null` when it isn't tenant-scoped. */
export function conversationTenant(conversationId: string): string | null {
  const dot = conversationId.indexOf(".");
  if (dot <= 0) return null;
  const tenantId = conversationId.slice(0, dot);
  const rest = conversationId.slice(dot + 1);
  return TENANT_ID.test(tenantId) && CONVERSATION_REST.test(rest) ? tenantId : null;
}

/**
 * True when the conversation belongs to `tenantId`. Check every conversation
 * id a caller sends against the tenant the router resolved, never against a
 * tenant named in a request body.
 */
export function conversationBelongsTo(conversationId: string, tenantId: string): boolean {
  return conversationTenant(conversationId) === tenantId;
}

function checkKeyScope(tenantId: string, moduleId: string, agent: string): void {
  checkTenantId(tenantId);
  if (!SLUG.test(moduleId)) throw new TypeError(`module id "${moduleId}" is not a module id`);
  if (!SLUG.test(agent)) throw new TypeError(`agent "${agent}" is not an agent name`);
}

/**
 * The idempotency key for a schedule tick:
 * `schedule:<tenantId>:<moduleId>/<agent>:<scheduledAt>`. It names the tenant,
 * module and agent, so it is unique across the whole plant, even where ids
 * are global (e.g. Workflow instance ids).
 */
export function scheduleIdempotencyKey(
  tenantId: string,
  moduleId: string,
  agent: string,
  scheduledAt: Date | string | number,
): string {
  checkKeyScope(tenantId, moduleId, agent);
  const d = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(d.getTime())) throw new TypeError(`not a date: ${String(scheduledAt)}`);
  return `schedule:${tenantId}:${moduleId}/${agent}:${d.toISOString()}`;
}

/**
 * The idempotency key for an event delivery:
 * `event:<tenantId>:<moduleId>/<agent>:<event.id>`. Unique across the plant.
 */
export function eventIdempotencyKey(
  tenantId: string,
  moduleId: string,
  agent: string,
  event: Pick<PlantEvent, "id">,
): string {
  checkKeyScope(tenantId, moduleId, agent);
  if (!event.id) throw new TypeError("event id is required for an idempotency key");
  return `event:${tenantId}:${moduleId}/${agent}:${event.id}`;
}

// ─── Run context ─────────────────────────────────────────────────────────────

/** One fire of an agent's schedule. Plain data, so it crosses Workers RPC. */
export interface AgentTick {
  /** The cron pattern that fired, e.g. `0 6 * * *`. */
  readonly cron: string;
  /** When the fire was scheduled, ISO 8601 (UTC). */
  readonly scheduledAt: string;
}

/**
 * What a run is seeded with: pass it as the conversation's initial data when
 * dispatching (Flue: `dispatch(Agent, { id, idempotencyKey, initialData, ... })`).
 */
export interface AgentInitialData {
  readonly tenantId: string;
  readonly module: string;
  readonly agent: string;
  /** The conversation id without the tenant prefix, e.g. `sweep-2026-11-04`. */
  readonly runId: string;
  readonly trigger: "schedule" | "event";
  /** Schedule runs: the tick's scheduled time. */
  readonly scheduledAt?: string;
  /** Event runs: the event that opened the run. */
  readonly eventId?: string;
  readonly eventType?: string;
}

/** The tenant an agent runs for, as the plant sends it over RPC. */
export interface SerializedAgentScope {
  readonly tenant: Tenant;
  /** Entitlement keys, as in SerializedPlantContext. */
  readonly entitlements: readonly string[];
  /**
   * Core-minted proof of the tenant and agent this run is for (see
   * capability.ts). Opaque: pass it back to core untouched, never log it.
   */
  readonly capability?: ContextCapability;
}

/** What an agent handler receives: who it acts as and the conventions for this run. */
export interface AgentContext {
  readonly tenant: Tenant;
  readonly entitlements: Entitlements;
  readonly principal: AgentPrincipal;
  /** The conversation to dispatch to, following the conventions above. */
  readonly conversationId: string;
  /**
   * Pass as the dispatch idempotency key. It names the tenant, module and
   * agent, so it never collides with another tenant's or module's run.
   */
  readonly idempotencyKey: string;
  readonly initialData: AgentInitialData;
}

export type AgentScheduleFn<Env = unknown> = (
  tick: AgentTick,
  ctx: AgentContext,
  env: Env,
) => unknown | Promise<unknown>;

export type AgentEventFn<Env = unknown> = (
  event: PlantEvent,
  ctx: AgentContext,
  env: Env,
) => unknown | Promise<unknown>;

export interface AgentHandlers<Env = unknown> {
  /** Required when `schedule` is set. Keep it thin: dispatch, or start a Workflow. */
  readonly onSchedule?: AgentScheduleFn<Env>;
  /** Required when `listens` is set. */
  readonly onEvent?: AgentEventFn<Env>;
}

/** An agent in {@link defineModule}'s `agents` list: its manifest entry plus handlers. */
export interface AgentDefinition<Env = unknown> extends AgentSpec, AgentHandlers<Env> {}

function scopeOf(scope: SerializedAgentScope): { tenant: Tenant; entitlements: Entitlements } {
  checkTenantId(scope.tenant.id);
  return { tenant: scope.tenant, entitlements: entitlementsFrom(scope.entitlements) };
}

/** The context for one schedule tick. */
export function createAgentScheduleContext(
  moduleId: string,
  agent: string,
  tick: AgentTick,
  scope: SerializedAgentScope,
): AgentContext {
  const { tenant, entitlements } = scopeOf(scope);
  const scheduledAt = new Date(tick.scheduledAt).toISOString();
  const conversationId = sweepConversationId(tenant.id, scheduledAt);
  const ctx: AgentContext = Object.freeze({
    tenant,
    entitlements,
    principal: agentPrincipal(moduleId, agent, tenant.id),
    conversationId,
    idempotencyKey: scheduleIdempotencyKey(tenant.id, moduleId, agent, scheduledAt),
    initialData: Object.freeze({
      tenantId: tenant.id,
      module: moduleId,
      agent,
      runId: conversationId.slice(tenant.id.length + 1),
      trigger: "schedule",
      scheduledAt,
    }),
  });
  holdCapability(ctx, scope.capability);
  return ctx;
}

/** The context for one event delivery. The event must belong to the scope's tenant. */
export function createAgentEventContext(
  moduleId: string,
  agent: string,
  event: PlantEvent,
  scope: SerializedAgentScope,
): AgentContext {
  const { tenant, entitlements } = scopeOf(scope);
  if (event.tenantId !== tenant.id) {
    throw new Error(`event "${event.id}" belongs to another tenant`);
  }
  const conversationId = eventsConversationId(tenant.id, event.occurredAt);
  const ctx: AgentContext = Object.freeze({
    tenant,
    entitlements,
    principal: agentPrincipal(moduleId, agent, tenant.id),
    conversationId,
    idempotencyKey: eventIdempotencyKey(tenant.id, moduleId, agent, event),
    initialData: Object.freeze({
      tenantId: tenant.id,
      module: moduleId,
      agent,
      runId: conversationId.slice(tenant.id.length + 1),
      trigger: "event",
      eventId: event.id,
      eventType: event.type,
    }),
  });
  holdCapability(ctx, scope.capability);
  return ctx;
}

// ─── Validation and dispatch (used by defineModule, PlantModule and the harness)

const CRON_FIELD = /^[0-9A-Za-z*,/-]+$/;

/** A cheap sanity check of a five-field cron pattern. Cloudflare validates it fully on deploy. */
export function isCronPattern(pattern: string): boolean {
  const fields = pattern.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f));
}

/** @internal */
export function normalizeAgents<Env>(
  defs: readonly AgentDefinition<Env>[],
  eventType: RegExp,
  fail: (message: string) => never,
): { entries: AgentManifestEntry[]; handlers: Record<string, AgentHandlers<Env>> } {
  const entries: AgentManifestEntry[] = [];
  const handlers: Record<string, AgentHandlers<Env>> = Object.create(null);
  for (const def of defs) {
    const name = def.name;
    if (!SLUG.test(name)) fail(`agent name "${name}" must be a lowercase slug (a-z, 0-9, -)`);
    if (name in handlers) fail(`duplicate agent "${name}"`);
    const listens = [...(def.listens ?? [])];
    if (def.schedule !== undefined) {
      if (!isCronPattern(def.schedule)) fail(`agent "${name}" schedule "${def.schedule}" is not a 5-field cron pattern`);
      if (typeof def.onSchedule !== "function") fail(`agent "${name}" has a schedule but no onSchedule`);
    }
    if (def.timeZone !== undefined) {
      if (def.timeZone !== "utc" && def.timeZone !== "tenant") fail(`agent "${name}" timeZone must be "utc" or "tenant"`);
      if (def.timeZone === "tenant" && def.schedule === undefined) fail(`agent "${name}" has a timeZone but no schedule`);
    }
    const seen = new Set<string>();
    for (const t of listens) {
      if (!eventType.test(t)) fail(`agent "${name}" event type "${t}" must look like "<module>.<name>"`);
      if (seen.has(t)) fail(`agent "${name}" listens for "${t}" twice`);
      seen.add(t);
    }
    if (listens.length > 0 && typeof def.onEvent !== "function") {
      fail(`agent "${name}" listens for events but has no onEvent`);
    }
    entries.push({
      name,
      ...(def.description !== undefined ? { description: def.description } : {}),
      ...(def.schedule !== undefined ? { schedule: def.schedule.trim() } : {}),
      ...(def.timeZone === "tenant" ? { timeZone: "tenant" as const } : {}),
      listens,
    });
    handlers[name] = Object.freeze({
      ...(def.onSchedule ? { onSchedule: def.onSchedule } : {}),
      ...(def.onEvent ? { onEvent: def.onEvent } : {}),
    });
  }
  return { entries, handlers };
}

/** The parts of a defined module that agent delivery needs. @internal */
export interface AgentHost<Env> {
  readonly moduleId: string;
  readonly entries: readonly AgentManifestEntry[];
  readonly handlers: Readonly<Record<string, AgentHandlers<Env>>>;
}

function entryOf<Env>(host: AgentHost<Env>, agent: string): AgentManifestEntry {
  const entry = host.entries.find((e) => e.name === agent);
  if (!entry) throw new Error(`module "${host.moduleId}" has no agent "${agent}"`);
  return entry;
}

/** Run one schedule tick for one agent. @internal */
export async function runAgentTick<Env>(
  host: AgentHost<Env>,
  agent: string,
  tick: AgentTick,
  scope: SerializedAgentScope,
  env: Env,
  keys?: ModuleKeys,
): Promise<{ context: AgentContext; result: unknown }> {
  const entry = entryOf(host, agent);
  if (!entry.schedule) throw new Error(`agent "${agent}" has no schedule`);
  if (tick.cron.trim() !== entry.schedule) {
    throw new Error(`agent "${agent}" is scheduled "${entry.schedule}", not "${tick.cron}"`);
  }
  const context = createAgentScheduleContext(host.moduleId, agent, tick, scope);
  if (keys) withModuleKeys(context, keys);
  const result = await host.handlers[agent]!.onSchedule!(tick, context, env);
  return { context, result };
}

/** Deliver one event to one agent. @internal */
export async function runAgentEvent<Env>(
  host: AgentHost<Env>,
  agent: string,
  event: PlantEvent,
  scope: SerializedAgentScope,
  env: Env,
  keys?: ModuleKeys,
): Promise<{ context: AgentContext; result: unknown }> {
  const entry = entryOf(host, agent);
  if (!entry.listens.includes(event.type)) {
    throw new Error(`agent "${agent}" does not listen for "${event.type}"`);
  }
  const context = createAgentEventContext(host.moduleId, agent, event, scope);
  if (keys) withModuleKeys(context, keys);
  const result = await host.handlers[agent]!.onEvent!(event, context, env);
  return { context, result };
}

// ─── Proposals ───────────────────────────────────────────────────────────────

/** How much a proposal matters. The inbox sorts on it. */
export type ProposalSeverity = "info" | "low" | "medium" | "high" | "critical";

export const PROPOSAL_SEVERITIES: readonly ProposalSeverity[] = ["info", "low", "medium", "high", "critical"];

/** A link that backs a proposal up, e.g. the changed ad or a report in R2. */
export interface ProposalEvidence {
  readonly url: string;
  readonly label?: string;
}

/**
 * A tool call the agent suggests. Accepting the proposal creates it as a
 * draft, which a person approves before it runs (write tools are draft-first).
 */
export interface SuggestedToolCall {
  /**
   * The plant MCP tool, `<moduleId>__<tool>` (e.g. `ads__pause_campaign`), as
   * core namespaces it. A bare tool name means a tool of the proposing module.
   */
  readonly tool: string;
  readonly input: unknown;
}

/**
 * An inbox item an agent proposes. Agents propose; people decide. Core stores
 * it with the run's {@link AgentPrincipal} as the author.
 */
export interface Proposal {
  readonly title: string;
  /** Markdown. */
  readonly body: string;
  readonly evidence: readonly ProposalEvidence[];
  readonly suggestedToolCall?: SuggestedToolCall;
  readonly severity: ProposalSeverity;
  /**
   * Optional. Proposals with the same key from the same agent and tenant are
   * one inbox item, so a re-run doesn't propose twice. Use the business event,
   * e.g. `competitor-change:acme|tiktok:v2`.
   */
  readonly dedupeKey?: string;
}

export const PROPOSAL_LIMITS = Object.freeze({ title: 200, body: 20_000, evidence: 50, dedupeKey: 200 });

/**
 * `<moduleId>__<tool>` or a bare `<tool>`. Module ids have no `_` and tool
 * names have no `__`, so the first `__` is always the separator.
 */
const PROPOSAL_TOOL = /^(?:[a-z][a-z0-9-]{0,62}__)?[a-z](?:[a-z0-9]|_(?!_)){0,62}$/;

/** Check a proposal before it goes to the inbox. Returns it unchanged, or throws a TypeError. */
export function validateProposal(p: Proposal): Proposal {
  const bad = (m: string): never => {
    throw new TypeError(`Proposal: ${m}`);
  };
  if (typeof p.title !== "string" || !p.title.trim()) bad("title is required");
  if (p.title.length > PROPOSAL_LIMITS.title) bad(`title is longer than ${PROPOSAL_LIMITS.title} characters`);
  if (typeof p.body !== "string") bad("body must be a string");
  if (p.body.length > PROPOSAL_LIMITS.body) bad(`body is longer than ${PROPOSAL_LIMITS.body} characters`);
  if (!PROPOSAL_SEVERITIES.includes(p.severity)) bad(`unknown severity "${String(p.severity)}"`);
  if (!Array.isArray(p.evidence)) bad("evidence must be a list");
  if (p.evidence.length > PROPOSAL_LIMITS.evidence) bad(`more than ${PROPOSAL_LIMITS.evidence} evidence links`);
  for (const e of p.evidence) {
    let url: URL | undefined;
    try {
      url = new URL(e.url);
    } catch {
      bad(`evidence url "${String(e.url)}" is not a URL`);
    }
    if (url!.protocol !== "https:" && url!.protocol !== "http:") bad(`evidence url "${e.url}" must be http(s)`);
  }
  if (p.suggestedToolCall !== undefined && !PROPOSAL_TOOL.test(p.suggestedToolCall.tool)) {
    bad(`suggested tool "${p.suggestedToolCall.tool}" must be "<moduleId>__<tool>" or a tool name`);
  }
  if (p.dedupeKey !== undefined && (!p.dedupeKey || p.dedupeKey.length > PROPOSAL_LIMITS.dedupeKey)) {
    bad(`dedupeKey must be 1-${PROPOSAL_LIMITS.dedupeKey} characters`);
  }
  return p;
}
