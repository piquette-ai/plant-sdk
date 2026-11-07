/**
 * Member roles in a module's own routes.
 *
 * The router resolves the signed-in person's role in the tenant (viewer <
 * member < admin < owner) and puts it on `ctx.principal.role` for surface
 * "app", signed into the context's capability. The router already applies a
 * default (safe methods need viewer, everything else member) and any
 * {@link RoleRule}s the manifest declares. Call {@link requireRole} on every
 * mutating route anyway: it is the module's own check, and it keeps working
 * when a route is reached some other way.
 *
 * Agents have their own principal kind and no role, so requireRole refuses
 * them. Agent writes go through drafts, which a person with a role approves.
 */
import { isMemberRole, type MemberRole, type PlantContext } from "./context.js";

const RANK: Readonly<Record<MemberRole, number>> = Object.freeze({ viewer: 1, member: 2, admin: 3, owner: 4 });

/** Whether `role` is at least `min`. `null`, `undefined` and unknown values never are. */
export function roleAtLeast(role: MemberRole | null | undefined, min: MemberRole): boolean {
  if (!isMemberRole(min)) throw new TypeError(`roleAtLeast: unknown role "${String(min)}"`);
  return isMemberRole(role) && RANK[role] >= RANK[min];
}

/** The signed-in person's role in this tenant, or `null` (public route, no role, an agent). */
export function roleOf(ctx: Pick<PlantContext, "principal">): MemberRole | null {
  const p = ctx.principal as { role?: unknown; kind?: unknown } | null;
  if (p === null || typeof p !== "object" || p.kind === "agent") return null;
  return isMemberRole(p.role) ? p.role : null;
}

/** Whether the signed-in person's role is at least `min`. */
export function hasRole(ctx: Pick<PlantContext, "principal">, min: MemberRole): boolean {
  return roleAtLeast(roleOf(ctx), min);
}

/** Thrown by {@link requireRole}. `status` is always 403. */
export class RoleError extends Error {
  override readonly name = "RoleError";
  readonly status = 403;
  readonly code = "insufficient_role";
  constructor(
    readonly required: MemberRole,
    readonly actual: MemberRole | null,
  ) {
    super(`insufficient_role: this needs role "${required}" or higher`);
  }

  /** A JSON 403 response for this refusal. It never names the person. */
  response(): Response {
    return Response.json({ error: this.code, required: this.required }, { status: 403 });
  }
}

/**
 * Refuse the request unless the signed-in person's role is at least `min`.
 * Throws {@link RoleError}; catch it and return `err.response()`, or use
 * {@link roleResponse} to get the 403 without a throw.
 *
 * ```ts
 * if (request.method === "POST") requireRole(ctx, "member");
 * ```
 */
export function requireRole(ctx: Pick<PlantContext, "principal">, min: MemberRole): MemberRole {
  const actual = roleOf(ctx);
  if (!roleAtLeast(actual, min)) throw new RoleError(min, actual);
  return actual!;
}

/** `null` when the person's role is at least `min`, else a 403 response. */
export function roleResponse(ctx: Pick<PlantContext, "principal">, min: MemberRole): Response | null {
  try {
    requireRole(ctx, min);
    return null;
  } catch (err) {
    if (err instanceof RoleError) return err.response();
    throw err;
  }
}

/**
 * A manifest rule: requests under `prefix` (relative to basePath, at a
 * segment boundary; the longest match wins) need at least `minRole`. The
 * router enforces it before calling the module. Without a matching rule,
 * GET, HEAD and OPTIONS need viewer and every other method needs member.
 */
export interface RoleRule {
  /** Starts with "/". */
  readonly prefix: string;
  /** Applies to these methods only (upper case); all methods when left out. */
  readonly methods?: readonly string[];
  readonly minRole: MemberRole;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

function prefixMatches(rest: string, prefix: string): boolean {
  if (prefix === "/") return true;
  if (prefix.endsWith("/")) return rest.startsWith(prefix);
  return rest === prefix || rest.startsWith(`${prefix}/`);
}

/**
 * The role a request to a module path needs: the longest matching
 * {@link RoleRule} (at a segment boundary, for this method), else viewer for
 * GET, HEAD and OPTIONS and member for everything else. `rest` is the path
 * relative to basePath. This is the rule the router and the harness apply.
 */
export function requiredRoleFor(method: string, rest: string, rules: readonly RoleRule[] = []): MemberRole {
  const m = method.toUpperCase();
  let best: RoleRule | undefined;
  for (const rule of rules) {
    if (!rule.prefix.startsWith("/") || !prefixMatches(rest, rule.prefix)) continue;
    if (rule.methods && !rule.methods.some((x) => x.toUpperCase() === m)) continue;
    if (!best || rule.prefix.length > best.prefix.length) best = rule;
  }
  return best?.minRole ?? (SAFE_METHODS.has(m) ? "viewer" : "member");
}
