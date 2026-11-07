/**
 * Agent runs inside Cloudflare Workflow steps.
 *
 * A capability core mints for an agent or Workflow run lasts 15 minutes by
 * default, never more than an hour. A Workflow can run much longer (a sweep
 * with retries, a `step.sleep`), so every step gets a fresh capability from
 * core first: {@link agentStep} calls core's `AgentRuns.refresh` with the
 * scope core started the run with, inside the step, and hands the step a
 * context that carries the new capability.
 *
 * Core refreshes only runs it started, for the same tenant, module and agent,
 * and only within a grace window (at most 24 hours) after the run started.
 * The run start is signed into the capability by core; nothing the module
 * sends can move it.
 *
 * Workflows persist step outputs and errors, and show them in the dashboard
 * and `instance.status()`. So a capability must never be a step's result or
 * part of a thrown error: agentStep refuses a result that contains one and
 * strips capabilities from error messages. Keep the scope core started the
 * run with in the Workflow params, where core put it, and never log it.
 *
 * ```ts
 * export class Sweep extends WorkflowEntrypoint<Env, { scope: SerializedAgentScope }> {
 *   async run(event: WorkflowEvent<{ scope: SerializedAgentScope }>, step: WorkflowStep) {
 *     const run = { scope: event.payload.scope, core: this.env.AGENT_RUNS };
 *     const changed = await agentStep(step, "poll", run, async (ctx) => poll(this.env, ctx.tenant.id));
 *     await step.sleep("cool down", "2 hours");
 *     await agentStep(step, "propose", run, (ctx) => this.env.INBOX.post(callbackContext(ctx), ...));
 *   }
 * }
 * ```
 *
 * The SDK has no runtime dependency on Workflows: `step` is anything with
 * the `do(name, config, callback)` shape of `WorkflowStep`.
 */
import type { Entitlements, Tenant } from "./context.js";
import { entitlementsFrom } from "./context.js";
import { callbackContext, holdCapability, type CallbackContext } from "./capability.js";
import type { SerializedAgentScope } from "./agents.js";

/** Core's `AgentRuns` entrypoint, as a module's service binding sees it. */
export interface AgentRunRefresher {
  /** Re-mint the run's capability. Core verifies the one in `ctx` (even if expired) and refuses other tenants, modules and old runs. */
  refresh(ctx: CallbackContext): Promise<SerializedAgentScope>;
}

/** The run a Workflow is doing: the scope core started it with and the binding to refresh through. */
export interface WorkflowAgentRun {
  /** The scope core passed in the Workflow params. Never log it, never return it from a step. */
  readonly scope: SerializedAgentScope;
  readonly core: AgentRunRefresher;
}

/** What a step receives: the tenant, with a fresh capability held off the object. Pass it to {@link callbackContext}. */
export interface AgentStepContext {
  readonly tenant: Tenant;
  readonly entitlements: Entitlements;
}

/** The parts of a Workflow step's config agentStep passes through. */
export interface AgentStepConfig {
  readonly retries?: {
    readonly limit: number;
    readonly delay: string | number;
    readonly backoff?: "constant" | "linear" | "exponential";
  };
  readonly timeout?: string | number;
}

/** The shape of Cloudflare's `WorkflowStep.do` that agentStep needs. */
export interface WorkflowStepLike {
  do<T>(name: string, config: AgentStepConfig, callback: () => Promise<T>): Promise<T>;
}

const CAPABILITY_PREFIX = "pcap1.";
const CAPABILITY_TEXT = /pcap1\.[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)?/g;
const REDACTED_CAPABILITY = "[capability]";
/** Deeper than this, a value is refused rather than scanned. */
const MAX_DEPTH = 64;

/** Thrown inside the scan when a value can't be checked completely. */
class Unscannable extends Error {}

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");

function bytesText(v: ArrayBuffer | ArrayBufferView): string {
  const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return `${latin1.decode(bytes)}\n${utf8.decode(bytes)}`;
}

/**
 * First pass: a structural walk over everything Workers RPC and Workflows
 * can serialize (objects, arrays, Map, Set, errors, byte buffers), including
 * keys and class instances' own properties. Fails closed: a value deeper
 * than MAX_DEPTH, or a cycle, is reported as containing a capability.
 * An object seen before, off the current path, has been scanned in full
 * already, so it is skipped.
 */
function walk(value: unknown): boolean {
  const clean = new WeakSet<object>();
  const path = new WeakSet<object>();
  const visit = (v: unknown, depth: number): boolean => {
    if (typeof v === "string") return v.includes(CAPABILITY_PREFIX);
    if (typeof v !== "object" || v === null) return false;
    if (clean.has(v)) return false;
    if (path.has(v)) throw new Unscannable("cycle");
    if (depth > MAX_DEPTH) throw new Unscannable("too deep");
    path.add(v);
    let found = false;
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      found = bytesText(v as ArrayBuffer | ArrayBufferView).includes(CAPABILITY_PREFIX);
    } else if (v instanceof Map) {
      for (const [k, x] of v) if ((found = visit(k, depth + 1) || visit(x, depth + 1))) break;
    } else if (v instanceof Set || Array.isArray(v)) {
      for (const x of v) if ((found = visit(x, depth + 1))) break;
    }
    if (!found && v instanceof Error) {
      found = visit(v.name, depth + 1) || visit(v.message, depth + 1) || visit(v.stack, depth + 1) || visit(v.cause, depth + 1);
    }
    if (!found) {
      for (const k of Reflect.ownKeys(v)) {
        if (typeof k === "string" && k.includes(CAPABILITY_PREFIX)) return (found = true);
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (d && "value" in d && (found = visit(d.value, depth + 1))) break;
      }
    }
    path.delete(v);
    if (!found) clean.add(v);
    return found;
  };
  return visit(value, 0);
}

/**
 * Second pass: what gets persisted. Structured-clone the value (as Workers
 * RPC and Workflows do), serialize the clone to text with Map, Set, errors,
 * byte buffers and bigints spelled out, and look for the capability prefix
 * in that text. Anything that can't be cloned or serialized is refused.
 */
function serializedContains(value: unknown): boolean {
  if (value === undefined) return false;
  const clone = structuredClone(value);
  const text = JSON.stringify(clone, (_key, v: unknown) => {
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Map) return { map: [...v.entries()] };
    if (v instanceof Set) return { set: [...v] };
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return { bytes: bytesText(v as ArrayBuffer | ArrayBufferView) };
    if (v instanceof Error) {
      const own: Record<string, unknown> = {};
      for (const k of Object.keys(v)) own[k] = (v as unknown as Record<string, unknown>)[k];
      return { name: v.name, message: v.message, stack: v.stack, cause: v.cause, own };
    }
    return v;
  });
  return typeof text === "string" && text.includes(CAPABILITY_PREFIX);
}

/**
 * True when a value, or anything inside it, is or contains a capability, or
 * when that can't be ruled out (too deep, cyclic, not serializable). Fails
 * closed: only `false` means the value is safe to persist.
 */
export function containsCapability(value: unknown): boolean {
  try {
    return walk(value) || serializedContains(value);
  } catch {
    return true;
  }
}

/** A copy of `text` with every capability replaced by `[capability]`. */
export function redactCapabilities(text: string): string {
  return text.replace(CAPABILITY_TEXT, REDACTED_CAPABILITY);
}

/** A deep copy with capabilities redacted from every string; too-deep or circular parts are dropped. */
function redactValue(v: unknown, depth = 0, path = new WeakSet<object>()): unknown {
  if (typeof v === "string") return redactCapabilities(v);
  if (typeof v !== "object" || v === null) return typeof v === "function" || typeof v === "symbol" ? undefined : v;
  if (depth > MAX_DEPTH) return "[truncated]";
  if (path.has(v)) return "[circular]";
  path.add(v);
  try {
    if (v instanceof Error) return scrubbedError(v, depth + 1, path);
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return "[bytes]";
    if (v instanceof Map) return [...v].map(([k, x]) => [redactValue(k, depth + 1, path), redactValue(x, depth + 1, path)]);
    if (v instanceof Set || Array.isArray(v)) return [...v].map((x) => redactValue(x, depth + 1, path));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[redactCapabilities(k)] = redactValue((v as Record<string, unknown>)[k], depth + 1, path);
    return out;
  } finally {
    path.delete(v);
  }
}

function scrubbedError(e: Error, depth: number, path: WeakSet<object>): Error {
  const out = new Error(redactCapabilities(String(e.message)));
  out.name = redactCapabilities(String(e.name));
  out.stack = e.stack === undefined ? undefined : redactCapabilities(String(e.stack));
  if (e.cause !== undefined) out.cause = redactValue(e.cause, depth, path);
  for (const k of Object.keys(e)) {
    if (k === "name" || k === "message" || k === "stack" || k === "cause") continue;
    (out as unknown as Record<string, unknown>)[redactCapabilities(k)] = redactValue((e as unknown as Record<string, unknown>)[k], depth, path);
  }
  return out;
}

/**
 * The error to rethrow: name, message, stack, cause and every own enumerable
 * property with capabilities redacted. If anything still looks like one, the
 * error is withheld entirely.
 */
function scrubbed(err: unknown): Error {
  let out: Error;
  try {
    out = err instanceof Error ? scrubbedError(err, 0, new WeakSet()) : new Error(redactCapabilities(String(err)));
  } catch {
    return new Error("agentStep: the step failed; its error was withheld because it could not be redacted");
  }
  if (containsCapability(out)) return new Error("agentStep: the step failed; its error was withheld because it contained a capability");
  return out;
}

/** Refuses a run scope that isn't a core-started run's. */
function checkRun(run: WorkflowAgentRun): void {
  if (!run || typeof run.core?.refresh !== "function") throw new TypeError("agentStep: run.core must be core's AgentRuns binding");
  if (!run.scope || typeof run.scope.tenant?.id !== "string") throw new TypeError("agentStep: run.scope must be the scope core started the run with");
}

/**
 * Run one Workflow step as the agent, with a capability refreshed for it.
 *
 * Inside `step.do(name, ...)` it asks core for a fresh capability, checks
 * core answered for the run's tenant, and calls `fn` with a context that
 * holds the new capability (pass it to {@link callbackContext} to call
 * core). The step's result is what `fn` returns; agentStep throws instead
 * if that result contains a capability, or can't be checked (deeper than 64
 * levels, cyclic, not serializable), so none is ever persisted. Errors are
 * rethrown with capabilities stripped from their name, message, stack,
 * cause and own properties.
 *
 * A refused refresh (another tenant or module, a request context, or a run
 * older than the grace window) throws, and retrying won't help: give long
 * Workflows a retry limit, and stop the run when core refuses.
 */
export async function agentStep<T>(
  step: WorkflowStepLike,
  name: string,
  run: WorkflowAgentRun,
  fn: (ctx: AgentStepContext) => Promise<T>,
  config: AgentStepConfig = {},
): Promise<T> {
  checkRun(run);
  // The step name is persisted too.
  if (typeof name !== "string" || name.includes(CAPABILITY_PREFIX)) throw new TypeError("agentStep: the step name must not contain a capability");
  return step.do(name, config, async () => {
    let result: T;
    try {
      const fresh = await run.core.refresh(callbackContext(run.scope));
      if (fresh?.tenant?.id !== run.scope.tenant.id) {
        throw new Error("agentStep: core refreshed the run for another tenant");
      }
      const ctx: AgentStepContext = Object.freeze({
        tenant: Object.freeze({ ...fresh.tenant }),
        entitlements: entitlementsFrom(fresh.entitlements ?? []),
      });
      holdCapability(ctx, fresh.capability);
      result = await fn(ctx);
    } catch (err) {
      throw scrubbed(err);
    }
    if (containsCapability(result)) {
      throw new Error(
        `agentStep: step "${name}" returned a capability, or a value that can't be checked (too deep, cyclic or not serializable); return plain data only, never a context or a capability`,
      );
    }
    return result;
  });
}
