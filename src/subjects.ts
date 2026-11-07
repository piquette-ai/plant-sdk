/**
 * Subject hashing for privacy handlers: `ctx.subjects`.
 *
 * Deletion proofs record the subject as a keyed hash (see privacy.ts). The
 * key is per tenant and lives in the plant's core. A CryptoKey can't cross
 * Workers RPC, and a module should never hold one anyway, so a module asks
 * core to do the hashing:
 *
 * ```ts
 * privacy: {
 *   async delete(subject, ctx, env) {
 *     const n = await deleteRows(env, ctx, subject);
 *     return ctx.subjects.deletionProof(subject, { deleted: [{ type: "consent.receipt", count: n }] });
 *   },
 * }
 * ```
 *
 * `ctx.subjects` calls core's Privacy entrypoint through the module's
 * service binding `PLANT_PRIVACY`
 * (`{ service: <core>, entrypoint: "Privacy", props: { moduleId } }`), passing
 * the request's {@link callbackContext}. Core verifies the context
 * capability, takes the tenant from it, derives the tenant's key and returns
 * only the hash or the proof. No key material reaches the module.
 *
 * For tests there is an in-process path ({@link localPrivacyService}) and a
 * mock core Worker ({@link MockCorePrivacy}); the harness uses them.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { callbackContext, capabilityOf, holdCapability, type CallbackContext, type ContextCapability } from "./capability.js";
import type { PlantContext } from "./context.js";
import {
  createDeletionProof,
  hashSubject,
  normalizeSubject,
  type DataSubject,
  type DeletionProof,
  type SubjectKey,
} from "./privacy.js";

/** The env name of the module's service binding to core's Privacy entrypoint. */
export const PRIVACY_BINDING = "PLANT_PRIVACY";

/** What a module tells core about a deletion. Core fills in the module, tenant and subject hash. */
export interface DeletionProofDetails {
  /** How many records of each type were deleted. */
  readonly deleted: ReadonlyArray<{ readonly type: string; readonly count: number }>;
  /** The DSAR request this deletion answers, when there is one. */
  readonly requestId?: string;
  /** Defaults to now. */
  readonly deletedAt?: Date;
}

/**
 * Core's Privacy entrypoint, as a module reaches it over `env.PLANT_PRIVACY`.
 * The module and tenant come from the binding and the capability, never from
 * the arguments.
 */
export interface PrivacyService {
  hashSubject(ctx: CallbackContext, subject: DataSubject): Promise<string>;
  createDeletionProof(ctx: CallbackContext, subject: DataSubject, details: DeletionProofDetails): Promise<DeletionProof>;
}

/** Hashing for the current request's tenant. Holds no key. */
export interface Subjects {
  /** The subject's keyed hash in this tenant (hex HMAC-SHA-256). */
  hash(subject: DataSubject): Promise<string>;
  /** A {@link DeletionProof} for this module, tenant and subject. */
  deletionProof(subject: DataSubject, details: DeletionProofDetails): Promise<DeletionProof>;
}

/** The context a privacy handler gets: a PlantContext plus {@link Subjects}. */
export interface PrivacyContext extends PlantContext {
  readonly subjects: Subjects;
}

/** {@link Subjects} that call `service` with the context's capability. */
export function subjectsVia(service: PrivacyService, ctx: PlantContext): Subjects {
  return Object.freeze({
    hash: async (subject: DataSubject) => service.hashSubject(callbackContext(ctx), subject),
    deletionProof: async (subject: DataSubject, details: DeletionProofDetails) =>
      service.createDeletionProof(callbackContext(ctx), subject, details),
  });
}

function missingBinding(): never {
  throw new TypeError(
    `ctx.subjects: this module has no ${PRIVACY_BINDING} binding. Bind core's Privacy entrypoint as ` +
      `{ "binding": "${PRIVACY_BINDING}", "service": "<core>", "entrypoint": "Privacy" }`,
  );
}

/**
 * The PrivacyContext for a request: `ctx` plus `subjects` through the env's
 * {@link PRIVACY_BINDING}. A missing binding fails only when `subjects` is used.
 */
export function privacyContextFor(ctx: PlantContext, env: unknown): PrivacyContext {
  const service = (env as Record<string, unknown> | null | undefined)?.[PRIVACY_BINDING] as PrivacyService | undefined;
  const subjects: Subjects = service
    ? subjectsVia(service, ctx)
    : Object.freeze({ hash: async () => missingBinding(), deletionProof: async () => missingBinding() });
  return withSubjects(ctx, subjects);
}

/**
 * `ctx` with `subjects` added: a new frozen object that keeps the context's
 * capability. Module keys are attached per object, so attach them (with
 * withModuleKeys) to the result, not to `ctx`.
 */
export function withSubjects(ctx: PlantContext, subjects: Subjects): PrivacyContext {
  const out: PrivacyContext = Object.freeze({
    tenant: ctx.tenant,
    principal: ctx.principal,
    brand: ctx.brand,
    entitlements: ctx.entitlements,
    basePath: ctx.basePath,
    surface: ctx.surface,
    subjects,
  });
  holdCapability(out, capabilityOf(ctx));
  return out;
}

// ─── Input checks (shared with core) ────────────────────────────────────────

/** Bounds on what a module can ask core to hash. */
export const SUBJECT_LIMITS = Object.freeze({
  /** Length of the normalized subject, in characters. */
  normalizedLength: 4096,
  /** Entries in `identifiers`. */
  identifiers: 32,
  /** Entries in a deletion proof's `deleted`. */
  deletedTypes: 256,
  /** Length of a record type or a requestId. */
  label: 256,
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Throw a TypeError unless `subject` is a well-formed {@link DataSubject}
 * within {@link SUBJECT_LIMITS}. Messages never contain the subject.
 */
export function assertDataSubject(subject: unknown): asserts subject is DataSubject {
  if (!isRecord(subject)) throw new TypeError("subject must be an object");
  for (const k of Object.keys(subject)) {
    if (k !== "email" && k !== "userId" && k !== "identifiers") throw new TypeError("subject has an unknown field");
  }
  if (subject.email !== undefined && typeof subject.email !== "string") throw new TypeError("subject.email must be a string");
  if (subject.userId !== undefined && typeof subject.userId !== "string") throw new TypeError("subject.userId must be a string");
  if (subject.identifiers !== undefined) {
    if (!isRecord(subject.identifiers)) throw new TypeError("subject.identifiers must be an object of strings");
    const entries = Object.entries(subject.identifiers);
    if (entries.length > SUBJECT_LIMITS.identifiers) throw new TypeError("subject has too many identifiers");
    if (entries.some(([, v]) => typeof v !== "string")) throw new TypeError("subject.identifiers must be an object of strings");
  }
  if (normalizeSubject(subject as DataSubject).length > SUBJECT_LIMITS.normalizedLength) {
    throw new TypeError("subject is too long");
  }
}

/** Throw a TypeError unless `details` is well-formed {@link DeletionProofDetails}. */
export function assertDeletionProofDetails(details: unknown): asserts details is DeletionProofDetails {
  if (!isRecord(details)) throw new TypeError("deletion details must be an object");
  const { deleted, requestId, deletedAt } = details;
  if (!Array.isArray(deleted) || deleted.length > SUBJECT_LIMITS.deletedTypes) {
    throw new TypeError(`deleted must be an array of at most ${SUBJECT_LIMITS.deletedTypes} entries`);
  }
  for (const d of deleted) {
    if (!isRecord(d) || typeof d.type !== "string" || d.type === "" || d.type.length > SUBJECT_LIMITS.label) {
      throw new TypeError("each deleted entry needs a record type");
    }
    if (!Number.isSafeInteger(d.count) || (d.count as number) < 0) {
      throw new TypeError("each deleted count must be a non-negative integer");
    }
  }
  if (requestId !== undefined && (typeof requestId !== "string" || requestId === "" || requestId.length > SUBJECT_LIMITS.label)) {
    throw new TypeError("requestId must be a non-empty string");
  }
  if (deletedAt !== undefined && !(deletedAt instanceof Date && !Number.isNaN(deletedAt.getTime()))) {
    throw new TypeError("deletedAt must be a valid Date");
  }
}

/** A deletion proof from checked inputs. `moduleId` and `tenantId` must come from trusted sources. */
export function deletionProofFor(
  moduleId: string,
  tenantId: string,
  subject: DataSubject,
  details: DeletionProofDetails,
  subjectKey: SubjectKey,
): Promise<DeletionProof> {
  return createDeletionProof({
    moduleId,
    tenantId,
    subject,
    subjectKey,
    deleted: details.deleted,
    ...(details.requestId !== undefined ? { requestId: details.requestId } : {}),
    ...(details.deletedAt !== undefined ? { deletedAt: details.deletedAt } : {}),
  });
}

// ─── In-process path ────────────────────────────────────────────────────────

/**
 * {@link Subjects} that hash in-process with a key the caller holds. For core
 * (which derives the tenant's key itself) and for tests. Never give a module
 * Worker a subject key; it uses `ctx.subjects` over RPC.
 */
export function localSubjects(options: {
  readonly moduleId: string;
  readonly tenantId: string;
  readonly subjectKey: SubjectKey;
}): Subjects {
  const { moduleId, tenantId, subjectKey } = options;
  return Object.freeze({
    async hash(subject: DataSubject) {
      assertDataSubject(subject);
      return hashSubject(subject, subjectKey);
    },
    async deletionProof(subject: DataSubject, details: DeletionProofDetails) {
      assertDataSubject(subject);
      assertDeletionProofDetails(details);
      return deletionProofFor(moduleId, tenantId, subject, details, subjectKey);
    },
  });
}

// ─── Test stand-ins for core (harness) ──────────────────────────────────────
//
// The harness plays the router, so it puts a stand-in capability on every
// context it builds. It has no MAC: it only names the tenant and module, so
// the mock core below can apply the same tenant and module checks real core
// does. Real core verifies a core-signed capability and rejects these.

const HARNESS_CAPABILITY_PREFIX = "pcap-harness1.";

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return undefined;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/** @internal The harness's unsigned stand-in capability. Test-only; real core rejects it. */
export function harnessCapability(tenantId: string, moduleId: string): ContextCapability {
  return (HARNESS_CAPABILITY_PREFIX + b64url(JSON.stringify(["plant-harness-capability", tenantId, moduleId]))) as ContextCapability;
}

/**
 * What the mock core checks before it hashes: a harness capability for this
 * module that names the tenant the context names. Returns that tenant.
 */
function harnessTenant(ctx: unknown, moduleId: string | undefined): string {
  const c = isRecord(ctx) ? ctx : {};
  const cap = c.capability;
  if (typeof moduleId !== "string" || moduleId === "") throw new Error("mock core: the binding has no moduleId prop");
  if (typeof cap !== "string" || !cap.startsWith(HARNESS_CAPABILITY_PREFIX)) {
    throw new Error("context capability refused (missing): pass callbackContext(ctx)");
  }
  let claims: unknown;
  try {
    claims = JSON.parse(unb64url(cap.slice(HARNESS_CAPABILITY_PREFIX.length)) ?? "null");
  } catch {
    claims = null;
  }
  if (!Array.isArray(claims) || claims.length !== 3 || claims[0] !== "plant-harness-capability") {
    throw new Error("context capability refused (malformed)");
  }
  const [, tenantId, capModule] = claims as [string, unknown, unknown];
  if (capModule !== moduleId) throw new Error("context capability refused (wrong-module)");
  const tenant = isRecord(c.tenant) ? c.tenant.id : undefined;
  if (typeof tenantId !== "string" || tenant !== tenantId) {
    throw new Error("context capability refused (tenant-mismatch)");
  }
  return tenantId;
}

/**
 * An in-process stand-in for core's Privacy entrypoint, for tests: it checks
 * the harness's capability (module and tenant) and hashes with `subjectKey`.
 * The harness gives in-process modules one of these as `env.PLANT_PRIVACY`.
 */
export function localPrivacyService(options: { readonly moduleId: string; readonly subjectKey: SubjectKey }): PrivacyService {
  const { moduleId, subjectKey } = options;
  return Object.freeze({
    async hashSubject(ctx: CallbackContext, subject: DataSubject) {
      const tenantId = harnessTenant(ctx, moduleId);
      return localSubjects({ moduleId, tenantId, subjectKey }).hash(subject);
    },
    async createDeletionProof(ctx: CallbackContext, subject: DataSubject, details: DeletionProofDetails) {
      const tenantId = harnessTenant(ctx, moduleId);
      return localSubjects({ moduleId, tenantId, subjectKey }).deletionProof(subject, details);
    },
  });
}

/** The env binding {@link MockCorePrivacy} reads its test key from: hex, at least 32 bytes. */
export const MOCK_SUBJECT_KEY_ENV = "PLANT_TEST_SUBJECT_KEY";

function hexKey(hex: unknown): ArrayBuffer {
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2}){32,}$/i.test(hex)) {
    throw new Error(`mock core: ${MOCK_SUBJECT_KEY_ENV} must be at least 32 bytes of hex`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes.buffer;
}

/**
 * A mock of core's Privacy entrypoint, for a module's tests in Miniflare or
 * vitest-pool-workers. Run it as its own Worker with a throwaway hex key in
 * `PLANT_TEST_SUBJECT_KEY`, and bind it to the module as
 * `PLANT_PRIVACY: { name: "<mock core>", entrypoint: "MockCorePrivacy", props: { moduleId } }`.
 * It accepts only the harness's unsigned capabilities, so it is test tooling:
 * never deploy it.
 */
export class MockCorePrivacy extends WorkerEntrypoint<Record<string, unknown>, { moduleId?: string }> implements PrivacyService {
  #service(): PrivacyService {
    const moduleId = (this.ctx as { props?: { moduleId?: unknown } }).props?.moduleId;
    if (typeof moduleId !== "string" || moduleId === "") throw new Error("mock core: the binding has no moduleId prop");
    return localPrivacyService({ moduleId, subjectKey: hexKey(this.env[MOCK_SUBJECT_KEY_ENV]) });
  }
  async hashSubject(ctx: CallbackContext, subject: DataSubject): Promise<string> {
    return this.#service().hashSubject(ctx, subject);
  }
  async createDeletionProof(ctx: CallbackContext, subject: DataSubject, details: DeletionProofDetails): Promise<DeletionProof> {
    return this.#service().createDeletionProof(ctx, subject, details);
  }
}
