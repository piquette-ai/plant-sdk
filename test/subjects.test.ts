import { describe, expect, it, vi } from "vitest";
import {
  assertDataSubject,
  assertDeletionProofDetails,
  callbackContext,
  createModuleHarness,
  createPlantContext,
  defineModule,
  hashSubject,
  localPrivacyService,
  localSubjects,
  MockCorePrivacy,
  moduleEntrypoint,
  moduleKeys,
  PRIVACY_BINDING,
  privacyContextFor,
  type CallbackContext,
  type ContextCapability,
  type DataSubject,
  type DeletionProofDetails,
  type PrivacyService,
} from "../src/index.js";
import { harnessCapability } from "../src/subjects.js";
import { appCtx, baseDef } from "./fixtures.js";

// Test-only key material, not a secret.
const subjectKey = new TextEncoder().encode("subjects-unit-test-subject-key-0123456789").buffer as ArrayBuffer;
const KEY_HEX = [...new Uint8Array(subjectKey)].map((b) => b.toString(16).padStart(2, "0")).join("");
const capability = "pcap1.opaque.value" as ContextCapability;
const execCtx = {} as ExecutionContext;

function privacyModule(checkKeys = true) {
  return defineModule(
    baseDef({
      requiredKeys: [{ name: "API_KEY", description: "x" }],
      privacy: {
        find: async (s, ctx) => ({ records: [{ type: "h", id: await ctx.subjects.hash(s) }] }),
        export: async () => ({ format: "json", records: [] }),
        delete: async (s, ctx) => {
          if (checkKeys) moduleKeys(ctx).getOrThrow("API_KEY"); // keys still reach privacy handlers
          return ctx.subjects.deletionProof(s, { deleted: [{ type: "consent.receipt", count: 2 }], requestId: "dsar_1" });
        },
        verify: async () => ({ clean: true, remaining: [], checkedAt: new Date(0).toISOString() }),
      },
    }),
  );
}

describe("ctx.subjects in a module Worker", () => {
  it("calls core's Privacy entrypoint with the callback context, never a key", async () => {
    const calls: unknown[][] = [];
    const service: PrivacyService = {
      hashSubject: vi.fn(async (...args) => {
        calls.push(args);
        return "hash-from-core";
      }),
      createDeletionProof: vi.fn(async (ctx: CallbackContext, _s: DataSubject, d: DeletionProofDetails) => {
        calls.push([ctx, _s, d]);
        return {
          moduleId: "consent",
          tenantId: ctx.tenant.id,
          subjectHash: "hash-from-core",
          subjectHashAlgorithm: "HMAC-SHA-256" as const,
          deleted: [...d.deleted],
          deletedAt: new Date(0).toISOString(),
        };
      }),
    };
    const env = { [PRIVACY_BINDING]: service };
    const privacy = new (moduleEntrypoint(privacyModule()))(execCtx, env).privacy!();
    const ctx = { ...appCtx, capability };

    expect((await privacy.find({ email: "a@b.c" }, ctx)).records[0]?.id).toBe("hash-from-core");
    const proof = await privacy.delete({ email: "a@b.c" }, ctx, { API_KEY: "secret-value" });
    expect(proof).toMatchObject({ tenantId: "t_1", deleted: [{ type: "consent.receipt", count: 2 }] });

    expect(calls[0]).toEqual([{ tenant: { id: "t_1" }, capability }, { email: "a@b.c" }]);
    expect(calls[1]).toEqual([
      { tenant: { id: "t_1" }, capability },
      { email: "a@b.c" },
      { deleted: [{ type: "consent.receipt", count: 2 }], requestId: "dsar_1" },
    ]);
    // Only the callback context, the subject and the counts cross to core.
    expect(JSON.stringify(calls)).not.toContain("secret-value");
  });

  it("fails clearly when the module has no PLANT_PRIVACY binding, and only when used", async () => {
    const privacy = new (moduleEntrypoint(privacyModule()))(execCtx, {}).privacy!();
    const ctx = { ...appCtx, capability };
    expect((await privacy.verify({ email: "a@b.c" }, ctx)).clean).toBe(true);
    await expect(privacy.find({ email: "a@b.c" }, ctx)).rejects.toThrow(/PLANT_PRIVACY/);
  });

  it("refuses to call core from a context without a capability", async () => {
    const service = { hashSubject: vi.fn(), createDeletionProof: vi.fn() } as unknown as PrivacyService;
    const pctx = privacyContextFor(createPlantContext(appCtx), { [PRIVACY_BINDING]: service });
    await expect(pctx.subjects.hash({ email: "a@b.c" })).rejects.toThrow(/no capability/);
    expect(service.hashSubject).not.toHaveBeenCalled();
  });

  it("keeps the capability off the privacy context's properties", () => {
    const pctx = privacyContextFor(createPlantContext({ ...appCtx, capability }), {});
    expect(JSON.stringify(pctx)).not.toContain("pcap1");
    expect(callbackContext(pctx).capability).toBe(capability);
  });
});

describe("in-process path", () => {
  it("localSubjects hashes with the key it was given", async () => {
    const s = localSubjects({ moduleId: "consent", tenantId: "t_1", subjectKey });
    expect(await s.hash({ email: "A@b.c " })).toBe(await hashSubject({ email: "a@b.c" }, subjectKey));
    const proof = await s.deletionProof({ email: "a@b.c" }, { deleted: [{ type: "x", count: 1 }], deletedAt: new Date(0) });
    expect(proof).toMatchObject({ moduleId: "consent", tenantId: "t_1", deletedAt: new Date(0).toISOString() });
  });

  it("localPrivacyService checks the harness capability's module and tenant", async () => {
    const service = localPrivacyService({ moduleId: "consent", subjectKey });
    const ok = { tenant: { id: "t_1" }, capability: harnessCapability("t_1", "consent") };
    expect(await service.hashSubject(ok, { email: "a@b.c" })).toBe(await hashSubject({ email: "a@b.c" }, subjectKey));
    const proof = await service.createDeletionProof(ok, { email: "a@b.c" }, { deleted: [] });
    expect(proof).toMatchObject({ moduleId: "consent", tenantId: "t_1" });

    const crossTenant = { tenant: { id: "t_2" }, capability: harnessCapability("t_1", "consent") };
    await expect(service.hashSubject(crossTenant, { email: "a@b.c" })).rejects.toThrow(/tenant-mismatch/);
    const otherModule = { tenant: { id: "t_1" }, capability: harnessCapability("t_1", "ads") };
    await expect(service.hashSubject(otherModule, { email: "a@b.c" })).rejects.toThrow(/wrong-module/);
    await expect(service.hashSubject({ tenant: { id: "t_1" } } as never, { email: "a@b.c" })).rejects.toThrow(/missing/);
    await expect(service.hashSubject({ tenant: { id: "t_1" }, capability } as never, { email: "a@b.c" })).rejects.toThrow(/missing/);
  });

  it("MockCorePrivacy takes the module from its binding props and the key from its env", async () => {
    const mock = new MockCorePrivacy({ props: { moduleId: "consent" } } as unknown as ExecutionContext, { PLANT_TEST_SUBJECT_KEY: KEY_HEX });
    const ok = { tenant: { id: "t_1" }, capability: harnessCapability("t_1", "consent") };
    expect(await mock.hashSubject(ok, { email: "a@b.c" })).toBe(await hashSubject({ email: "a@b.c" }, subjectKey));
    const noProps = new MockCorePrivacy({} as ExecutionContext, { PLANT_TEST_SUBJECT_KEY: KEY_HEX });
    await expect(noProps.hashSubject(ok, { email: "a@b.c" })).rejects.toThrow(/moduleId/);
    const noKey = new MockCorePrivacy({ props: { moduleId: "consent" } } as unknown as ExecutionContext, {});
    await expect(noKey.hashSubject(ok, { email: "a@b.c" })).rejects.toThrow(/PLANT_TEST_SUBJECT_KEY/);
  });

  it("the harness gives in-process modules a mock core, scoped to the call's tenant", async () => {
    const env = {};
    const plant = createModuleHarness(privacyModule(false), { env, keys: { API_KEY: "x" }, subjectKey });
    const subject = { email: "a@b.c" };
    const other = { id: "t_other", hostname: "o.example.com" };
    const proof = await plant.privacy.delete(subject, { tenant: other });
    expect(proof).toMatchObject({ moduleId: "consent", tenantId: "t_other", requestId: "dsar_1" });
    expect(await plant.privacy.verifyProof(proof, subject, { tenant: other })).toBe(true);
    expect(await plant.privacy.verifyProof(proof, subject)).toBe(false);
    // Without a subjectKey there is no mock core.
    await expect(createModuleHarness(privacyModule(false), { env }).privacy.find(subject)).rejects.toThrow(/PLANT_PRIVACY/);
  });
});

describe("input checks", () => {
  it("accepts well-formed subjects and refuses the rest without echoing them", () => {
    expect(() => assertDataSubject({ email: "a@b.c", identifiers: { phone: "+1555" } })).not.toThrow();
    for (const bad of [null, "a@b.c", [], {}, { email: 1 }, { userId: {} }, { identifiers: { a: 1 } }, { name: "x" }]) {
      expect(() => assertDataSubject(bad)).toThrow(TypeError);
    }
    expect(() => assertDataSubject({ email: "secret@x.y".repeat(1000) })).toThrow(/too long/);
    try {
      assertDataSubject({ email: "secret@x.y".repeat(1000) });
    } catch (err) {
      expect(String(err)).not.toContain("secret@x.y");
    }
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v"]));
    expect(() => assertDataSubject({ identifiers: many })).toThrow(/too many/);
  });

  it("checks deletion details", () => {
    expect(() => assertDeletionProofDetails({ deleted: [{ type: "a", count: 0 }], requestId: "r", deletedAt: new Date() })).not.toThrow();
    for (const bad of [
      null,
      {},
      { deleted: "x" },
      { deleted: [{ type: "", count: 1 }] },
      { deleted: [{ type: "a", count: -1 }] },
      { deleted: [{ type: "a", count: 1.5 }] },
      { deleted: [], requestId: 7 },
      { deleted: [], deletedAt: "2026-01-01" },
      { deleted: [], deletedAt: new Date(NaN) },
      { deleted: Array.from({ length: 300 }, () => ({ type: "a", count: 1 })) },
    ]) {
      expect(() => assertDeletionProofDetails(bad)).toThrow(TypeError);
    }
  });
});
