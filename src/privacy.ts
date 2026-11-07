/**
 * The privacy contract: every module that stores personal data can find,
 * export, delete and verify the deletion of a data subject's records.
 */
import type { PrivacyContext } from "./subjects.js";

/** The person a privacy request is about. At least one identifier is set. */
export interface DataSubject {
  readonly email?: string;
  readonly userId?: string;
  /** Other identifiers, e.g. `{ phone: "+15555550100" }`. */
  readonly identifiers?: Readonly<Record<string, string>>;
}

/** A pointer to one stored record about the subject. */
export interface PrivacyRecordRef {
  /** Record type, e.g. `consent.receipt`. */
  readonly type: string;
  readonly id: string;
  /** Where it lives, e.g. `d1:consent`, `r2:uploads`. */
  readonly location?: string;
}

export interface PrivacyFindResult {
  readonly records: readonly PrivacyRecordRef[];
}

export interface PrivacyExport {
  readonly format: "json";
  readonly records: ReadonlyArray<PrivacyRecordRef & { readonly data: unknown }>;
}

/**
 * Evidence that a module deleted a subject's data. The subject is recorded
 * only as a pseudonymous (keyed) HMAC-SHA-256 hash. This is not anonymous:
 * whoever holds the plant's subject key can recompute it for a known subject,
 * and that is how a DSAR is matched to its proof.
 */
export interface DeletionProof {
  readonly moduleId: string;
  readonly tenantId: string;
  /**
   * Pseudonymous (keyed) hash of the subject: hex HMAC-SHA-256 of the
   * normalized subject under the plant's subject key (see {@link hashSubject}).
   */
  readonly subjectHash: string;
  readonly subjectHashAlgorithm: "HMAC-SHA-256";
  /** How many records of each type were deleted. */
  readonly deleted: ReadonlyArray<{ readonly type: string; readonly count: number }>;
  /** ISO 8601 timestamp. */
  readonly deletedAt: string;
  /** The DSAR request this deletion answers, when there is one. */
  readonly requestId?: string;
}

export interface PrivacyVerifyResult {
  /** True when no records about the subject remain. */
  readonly clean: boolean;
  readonly remaining: readonly PrivacyRecordRef[];
  /** ISO 8601 timestamp. */
  readonly checkedAt: string;
}

/**
 * A module's privacy handlers. `ctx` is a {@link PrivacyContext}: use
 * `ctx.subjects` to hash subjects and build deletion proofs through core.
 */
export interface PrivacyHandlers<Env = unknown> {
  find(subject: DataSubject, ctx: PrivacyContext, env: Env): Promise<PrivacyFindResult>;
  export(subject: DataSubject, ctx: PrivacyContext, env: Env): Promise<PrivacyExport>;
  delete(subject: DataSubject, ctx: PrivacyContext, env: Env): Promise<DeletionProof>;
  verify(subject: DataSubject, ctx: PrivacyContext, env: Env): Promise<PrivacyVerifyResult>;
}

/** The canonical string form of a subject: sorted keys, trimmed, emails lowercased. */
export function normalizeSubject(subject: DataSubject): string {
  const parts: [string, string][] = [];
  if (subject.email !== undefined) parts.push(["email", subject.email.trim().toLowerCase()]);
  if (subject.userId !== undefined) parts.push(["userId", subject.userId.trim()]);
  for (const [k, v] of Object.entries(subject.identifiers ?? {})) parts.push([`id:${k}`, v.trim()]);
  if (parts.length === 0) throw new TypeError("DataSubject needs at least one identifier");
  parts.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(parts);
}

/**
 * The secret key used to pseudonymize subjects. Held by the private core, per
 * tenant, and never sent to a module Worker: modules hash through
 * `ctx.subjects` (see subjects.ts). The SDK never generates, stores or
 * defaults one. Either an HMAC-SHA-256 CryptoKey with the "sign" usage, or at
 * least 32 bytes of raw key material.
 */
export type SubjectKey = CryptoKey | ArrayBuffer;

/** Raw subject keys shorter than this are refused. */
export const MIN_SUBJECT_KEY_BYTES = 32;

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

async function importSubjectKey(subjectKey: SubjectKey): Promise<CryptoKey> {
  if (isArrayBuffer(subjectKey)) {
    if (subjectKey.byteLength < MIN_SUBJECT_KEY_BYTES) {
      throw new TypeError(`subjectKey must be at least ${MIN_SUBJECT_KEY_BYTES} bytes`);
    }
    return crypto.subtle.importKey("raw", subjectKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }
  const alg = (subjectKey as Partial<CryptoKey> | null | undefined)?.algorithm as
    | { name?: string; hash?: { name?: string } }
    | undefined;
  if (!alg) throw new TypeError("subjectKey is required: a CryptoKey or an ArrayBuffer");
  if (alg.name !== "HMAC" || alg.hash?.name !== "SHA-256" || !subjectKey.usages.includes("sign")) {
    throw new TypeError('subjectKey must be an HMAC SHA-256 CryptoKey with the "sign" usage');
  }
  return subjectKey;
}

/**
 * Pseudonymous (keyed) hash of a subject: hex HMAC-SHA-256 of
 * {@link normalizeSubject} under `subjectKey`, through Web Crypto (Workers and
 * Node 20+). Emails and phone numbers are low-entropy, so an unkeyed hash
 * would be reversible by dictionary attack; without the key it isn't.
 */
export async function hashSubject(subject: DataSubject, subjectKey: SubjectKey): Promise<string> {
  const key = await importSubjectKey(subjectKey);
  const bytes = new TextEncoder().encode(normalizeSubject(subject));
  const mac = await crypto.subtle.sign("HMAC", key, bytes);
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface DeletionProofInput {
  readonly moduleId: string;
  readonly tenantId: string;
  readonly subject: DataSubject;
  /** The plant's subject key (see {@link SubjectKey}). Required. */
  readonly subjectKey: SubjectKey;
  readonly deleted: ReadonlyArray<{ readonly type: string; readonly count: number }>;
  readonly requestId?: string;
  /** Defaults to now. */
  readonly deletedAt?: Date;
}

/** Build a DeletionProof. The subject is kept only as a pseudonymous (keyed) hash. */
export async function createDeletionProof(input: DeletionProofInput): Promise<DeletionProof> {
  for (const d of input.deleted) {
    if (!Number.isInteger(d.count) || d.count < 0) {
      throw new TypeError(`DeletionProof: count for "${d.type}" must be a non-negative integer`);
    }
  }
  return {
    moduleId: input.moduleId,
    tenantId: input.tenantId,
    subjectHash: await hashSubject(input.subject, input.subjectKey),
    subjectHashAlgorithm: "HMAC-SHA-256",
    deleted: input.deleted.map((d) => ({ type: d.type, count: d.count })),
    deletedAt: (input.deletedAt ?? new Date()).toISOString(),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  };
}
