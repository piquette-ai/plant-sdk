/**
 * Context capabilities: proof, minted by core, of which tenant a module is
 * acting for.
 *
 * Every context the router (or core, for agent and Workflow runs) hands a
 * module carries an opaque `capability`. When the module calls back into
 * core (emit an event, call another module's MCP tool, touch drafts or the
 * inbox, read a key), it passes the capability back untouched. Core checks
 * it and takes the tenant from it, so a module can only act for the tenant
 * of the request it is serving.
 *
 * To a module the capability is an opaque string: don't parse it, store it,
 * forward it to anyone but core, or log it. It expires after a few minutes.
 *
 * Inside a module the capability is kept off the PlantContext and
 * AgentContext objects (in a WeakMap), so logging a context never prints it.
 * Use {@link callbackContext} to build what you pass back to core.
 */
import type { Tenant } from "./context.js";

declare const capabilityBrand: unique symbol;

/** An opaque, core-minted capability. Pass it back to core untouched. */
export type ContextCapability = string & { readonly [capabilityBrand]: true };

/**
 * What a module passes to a core entrypoint as its context: the tenant it
 * believes it is serving plus the capability that proves it.
 */
export interface CallbackContext {
  readonly tenant: Pick<Tenant, "id">;
  readonly capability: ContextCapability;
}

const held = new WeakMap<object, ContextCapability>();

/**
 * Attach a capability to a context object without making it a property, so
 * it is never enumerated, serialized or logged with the object. SDK-internal;
 * modules don't need it.
 */
export function holdCapability(target: object, capability: ContextCapability | undefined): void {
  if (typeof capability === "string" && capability.length > 0) held.set(target, capability);
}

/** The capability a context was created with, or `undefined` when it has none. */
export function capabilityOf(ctx: object): ContextCapability | undefined {
  const own = held.get(ctx);
  if (own) return own;
  const field = (ctx as { capability?: unknown }).capability;
  return typeof field === "string" && field.length > 0 ? (field as ContextCapability) : undefined;
}

/**
 * The context to pass back to core from a PlantContext, an AgentContext or
 * their serialized forms. Throws when the context has no capability (for
 * example one built by hand in a test), because core would reject it anyway.
 */
export function callbackContext(ctx: { readonly tenant: Pick<Tenant, "id"> }): CallbackContext {
  const capability = capabilityOf(ctx);
  if (!capability) {
    throw new TypeError("callbackContext: this context has no capability; only contexts from the plant can call core");
  }
  return Object.freeze({ tenant: Object.freeze({ id: ctx.tenant.id }), capability });
}

/** A copy of a serialized context without its capability, safe to log. */
export function redactContext<T extends { readonly capability?: unknown }>(ctx: T): Omit<T, "capability"> {
  const { capability: _drop, ...rest } = ctx;
  return rest;
}
