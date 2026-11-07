import { describe, expect, it } from "vitest";
import { createDeletionProof, hashSubject, normalizeSubject } from "../src/index.js";

// Test-only keys. Real keys come from the private core, per plant or tenant.
const keyA = new Uint8Array(32).fill(0xa1).buffer;
const keyB = new Uint8Array(32).fill(0xb2).buffer;

describe("privacy helpers", () => {
  it("normalizes subjects independent of key order and email case", () => {
    expect(normalizeSubject({ email: " Jane@Example.com ", userId: "u1" })).toBe(
      normalizeSubject({ userId: "u1", email: "jane@example.com" }),
    );
    expect(() => normalizeSubject({})).toThrow(/at least one identifier/);
  });

  it("is stable for the same subject and key", async () => {
    const h = await hashSubject({ email: "jane@example.com" }, keyA);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashSubject({ email: "JANE@example.com" }, keyA)).toBe(h);
    expect(await hashSubject({ email: "jane@example.com" }, keyA.slice(0))).toBe(h);
    expect(await hashSubject({ email: "john@example.com" }, keyA)).not.toBe(h);
  });

  it("gives different hashes for the same subject under different keys", async () => {
    const subject = { email: "jane@example.com" };
    expect(await hashSubject(subject, keyA)).not.toBe(await hashSubject(subject, keyB));
  });

  it("is a keyed HMAC, not a plain SHA-256 of the subject", async () => {
    const subject = { email: "jane@example.com" };
    const plain = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeSubject(subject))),
    );
    const plainHex = [...plain].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await hashSubject(subject, keyA)).not.toBe(plainHex);

    const key = await crypto.subtle.importKey("raw", keyA, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(normalizeSubject(subject))));
    expect(await hashSubject(subject, keyA)).toBe([...mac].map((b) => b.toString(16).padStart(2, "0")).join(""));
  });

  it("accepts an HMAC SHA-256 CryptoKey and matches the raw form", async () => {
    const key = await crypto.subtle.importKey("raw", keyA, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    expect(await hashSubject({ userId: "u1" }, key)).toBe(await hashSubject({ userId: "u1" }, keyA));
  });

  it("refuses missing, short or wrong-kind keys at runtime", async () => {
    const subject = { userId: "u1" };
    await expect(hashSubject(subject, undefined as never)).rejects.toThrow(/subjectKey is required/);
    await expect(hashSubject(subject, null as never)).rejects.toThrow(/subjectKey is required/);
    await expect(hashSubject(subject, new ArrayBuffer(16))).rejects.toThrow(/at least 32 bytes/);
    const sha512 = await crypto.subtle.importKey("raw", keyA, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
    await expect(hashSubject(subject, sha512)).rejects.toThrow(/HMAC SHA-256/);
    const verifyOnly = await crypto.subtle.importKey("raw", keyA, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    await expect(hashSubject(subject, verifyOnly)).rejects.toThrow(/sign/);
  });

  it("builds a DeletionProof with a keyed subject hash and no personal data", async () => {
    const subject = { email: "jane@example.com", identifiers: { phone: "+15555550100" } };
    const proof = await createDeletionProof({
      moduleId: "consent",
      tenantId: "t_1",
      subject,
      subjectKey: keyA,
      deleted: [{ type: "consent.receipt", count: 3 }],
      requestId: "dsar_9",
      deletedAt: new Date("2026-11-03T00:00:00Z"),
    });
    expect(proof).toEqual({
      moduleId: "consent",
      tenantId: "t_1",
      subjectHash: await hashSubject({ identifiers: { phone: "+15555550100" }, email: "jane@example.com" }, keyA),
      subjectHashAlgorithm: "HMAC-SHA-256",
      deleted: [{ type: "consent.receipt", count: 3 }],
      deletedAt: "2026-11-03T00:00:00.000Z",
      requestId: "dsar_9",
    });
    expect(JSON.stringify(proof)).not.toContain("jane");
    expect(JSON.stringify(proof)).not.toContain("5555");

    const other = await createDeletionProof({ moduleId: "consent", tenantId: "t_1", subject, subjectKey: keyB, deleted: [] });
    expect(other.subjectHash).not.toBe(proof.subjectHash);
  });

  it("rejects bad counts", async () => {
    await expect(
      createDeletionProof({
        moduleId: "m",
        tenantId: "t",
        subject: { userId: "u" },
        subjectKey: keyA,
        deleted: [{ type: "x", count: -1 }],
      }),
    ).rejects.toThrow(/non-negative/);
  });
});
