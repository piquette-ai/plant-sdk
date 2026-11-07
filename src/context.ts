/**
 * PlantContext: what the router tells a module about the current request.
 *
 * Modules have no public routes. The router reaches them only through service
 * bindings, so a module can trust the context it receives.
 */

import type { Brand } from "./brand.js";
import { capabilityOf, holdCapability, type ContextCapability } from "./capability.js";

/** Which surface the request came in on. */
export type Surface = "app" | "public" | "mcp";

export interface Tenant {
  readonly id: string;
  readonly hostname: string;
  /** The parent tenant (for example a franchisor), when there is one. */
  readonly parentId?: string;
}

/**
 * A person's role in the request's tenant, lowest first: viewer < member <
 * admin < owner. The router resolves it from tenant membership.
 */
export type MemberRole = "owner" | "admin" | "member" | "viewer";

/** Every role, lowest first. */
export const MEMBER_ROLES: readonly MemberRole[] = Object.freeze(["viewer", "member", "admin", "owner"]);

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === "string" && (MEMBER_ROLES as readonly string[]).includes(value);
}

/** The signed-in person, from the Cloudflare Access JWT. */
export interface Principal {
  readonly email: string;
  readonly groups: readonly string[];
  /**
   * The person's role in this tenant. The router sets it on surface "app"
   * and signs it into the context's capability. Use `requireRole` on
   * mutating routes. Left out on other surfaces (createPlantContext drops it
   * there) and by older routers; requireRole refuses a missing role.
   */
  readonly role?: MemberRole;
}

/** The features this tenant's license unlocks. */
export interface Entitlements {
  has(key: string): boolean;
}

export interface PlantContext {
  readonly tenant: Tenant;
  /** `null` on public routes, where nobody is signed in. */
  readonly principal: Principal | null;
  readonly brand: Brand;
  readonly entitlements: Entitlements;
  /** Where this module is mounted, e.g. `/consent`. No trailing slash. */
  readonly basePath: string;
  readonly surface: Surface;
}

/**
 * PlantContext as it travels over Workers RPC: plain data only. Entitlements
 * are sent as a list of keys and turned back into `has()` by
 * {@link createPlantContext}.
 */
export interface SerializedPlantContext {
  readonly tenant: Tenant;
  readonly principal: Principal | null;
  readonly brand: Brand;
  readonly entitlements: readonly string[];
  readonly basePath: string;
  readonly surface: Surface;
  /**
   * Core's proof of which tenant this request is for (see capability.ts).
   * Opaque: pass it back to core untouched, and never log it. The router
   * always sets it; it is optional only so hand-built test contexts compile.
   */
  readonly capability?: ContextCapability;
}

const SURFACES: readonly Surface[] = ["app", "public", "mcp"];

/** Entitlements backed by a fixed set of keys. */
export function entitlementsFrom(keys: Iterable<string>): Entitlements & { keys(): string[] } {
  const set = new Set(keys);
  return {
    has: (key: string) => set.has(key),
    keys: () => [...set].sort(),
  };
}

/**
 * The principal as the module sees it. A role counts only on surface "app",
 * the one surface where the router signs it; elsewhere it is dropped, so a
 * module never acts on a role nobody vouched for.
 */
function principalFor(data: SerializedPlantContext): Principal | null {
  const p = data.principal;
  if (p === null || p.role === undefined || data.surface === "app") return p;
  const { role: _drop, ...rest } = p;
  return rest;
}

/** Turn the RPC form of a context back into a PlantContext. */
export function createPlantContext(data: SerializedPlantContext): PlantContext {
  if (!SURFACES.includes(data.surface)) {
    throw new TypeError(`PlantContext: unknown surface "${String(data.surface)}"`);
  }
  if (data.surface === "app" && data.principal === null) {
    throw new TypeError(`PlantContext: surface "app" requires a principal`);
  }
  if (data.principal && data.principal.role !== undefined && !isMemberRole(data.principal.role)) {
    throw new TypeError(`PlantContext: unknown role "${String(data.principal.role)}"`);
  }
  if (data.basePath !== "" && (!data.basePath.startsWith("/") || data.basePath.endsWith("/"))) {
    throw new TypeError(`PlantContext: basePath must start with "/" and have no trailing slash`);
  }
  const ctx: PlantContext = Object.freeze({
    tenant: data.tenant,
    principal: principalFor(data),
    brand: data.brand,
    entitlements: entitlementsFrom(data.entitlements),
    basePath: data.basePath,
    surface: data.surface,
  });
  // Kept off the object so logging a PlantContext never prints it.
  holdCapability(ctx, data.capability);
  return ctx;
}

/**
 * Turn a PlantContext into its RPC form. `entitlementKeys` is needed because
 * an Entitlements object can only be asked about one key at a time; contexts
 * built by {@link createPlantContext} carry their keys and don't need it.
 */
export function serializePlantContext(
  ctx: PlantContext,
  entitlementKeys?: readonly string[],
): SerializedPlantContext {
  const own = (ctx.entitlements as Partial<{ keys(): string[] }>).keys;
  const keys = entitlementKeys ?? (typeof own === "function" ? own.call(ctx.entitlements) : undefined);
  if (!keys) {
    throw new TypeError("serializePlantContext: pass entitlementKeys for custom Entitlements");
  }
  const capability = capabilityOf(ctx);
  return {
    tenant: ctx.tenant,
    principal: ctx.principal,
    brand: ctx.brand,
    entitlements: [...keys],
    basePath: ctx.basePath,
    surface: ctx.surface,
    ...(capability ? { capability } : {}),
  };
}
