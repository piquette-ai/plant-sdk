// The hello module, driven through the SDK's mock router over a real
// service binding in local workerd.
import { env } from "cloudflare:test";
import {
  agentPrincipal,
  createModuleHarness,
  HARNESS_GATE_HEADER,
  HARNESS_PRINCIPAL,
  MODULE_STATE_HEADER,
  type ModuleHarnessOptions,
  type ModuleRpcTarget,
} from "@piquette/plant-sdk";
import { describe, expect, it } from "vitest";

function hexToBytes(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes.buffer;
}

const subjectKey = hexToBytes(env.TEST_SUBJECT_KEY);
const binding = env.HELLO as unknown as ModuleRpcTarget;
let tenantSeq = 0;

/** A fresh tenant per test, so tests don't see each other's KV data. */
function plant(overrides: Partial<ModuleHarnessOptions> = {}) {
  const n = ++tenantSeq;
  return createModuleHarness(binding, {
    tenant: { id: `t_${n}`, hostname: `t${n}.example.com` },
    entitlements: ["hello.basic"],
    keys: { HELLO_API_KEY: "test-value" },
    subjectKey,
    ...overrides,
  });
}

async function sign(p: ReturnType<typeof plant>, email: string, message: string) {
  const res = await p.fetch("/public/guestbook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, message }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("hello module over a service binding", () => {
  it("serves the manifest over RPC", async () => {
    const m = await plant().manifest();
    expect(m).toMatchObject({ id: "hello", publicPrefixes: ["/public"], requires: ["hello.basic"] });
    expect(m.requiredKeys?.map((k) => k.name)).toEqual(["HELLO_API_KEY"]);
  });

  it("serves the app route to the signed-in person, branded", async () => {
    const res = await plant().fetch("/");
    expect(res.status).toBe(200);
    expect(res.headers.get(HARNESS_GATE_HEADER)).toBeNull();
    const html = await res.text();
    expect(html).toContain(`Hello, ${HARNESS_PRINCIPAL.email}`);
    expect(html).toContain("--plant-primary: #2563eb;");
    expect(html).toContain("<title>Test Plant</title>");
  });

  it("keeps the app route behind Access and the public route open", async () => {
    const anon = plant({ principal: null });
    const denied = await anon.fetch("/");
    expect(denied.status).toBe(401);
    expect(denied.headers.get(HARNESS_GATE_HEADER)).toBe("access");

    const res = await anon.fetch("/public/hello");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Hello from Test Plant", hostname: expect.stringMatching(/\.example\.com$/), surface: "public" });
  });

  it("accepts guestbook posts on the public route", async () => {
    const p = plant({ principal: null });
    await sign(p, "Guest@Example.com", "hi there");
    const bad = await p.fetch("/public/guestbook", { method: "POST", body: "{}" });
    expect(bad.status).toBe(400);
  });

  it("lists MCP tools by wire name and calls the read tool", async () => {
    const p = plant();
    const tools = await p.mcp.listTools();
    expect(tools.map((t) => t.name)).toEqual(["hello__list_entries", "hello__add_entry"]);
    expect(tools.find((t) => t.name === "hello__add_entry")?.write).toBe(true);

    await sign(p, "a@example.com", "first");
    const result = await p.mcp.callTool("hello__list_entries", { limit: 10 });
    expect(result).toMatchObject({ ok: true, kind: "tool", output: { entries: [{ message: "first" }] } });
    // No emails leak through the read tool.
    expect(JSON.stringify(result)).not.toContain("a@example.com");

    expect(await p.mcp.callTool("hello.list_entries")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await p.mcp.callTool("hello__list_entries", { limit: 0 })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("runs the write tool only from an approved draft", async () => {
    const p = plant();
    const input = { email: "b@example.com", message: "via mcp" };
    expect(await p.mcp.callTool("hello__add_entry", input)).toMatchObject({ ok: false, error: { code: "draft_required" } });

    const greeter = agentPrincipal("hello", "greeter", "t_x");
    const draft = await p.mcp.createDraft("hello__add_entry", input, { createdBy: greeter });
    const approved = await p.mcp.approveDraft(draft.id);
    expect(approved).toMatchObject({ ok: true, kind: "tool", output: { draftId: draft.id } });

    const listed = await p.mcp.callTool("hello__list_entries", {});
    expect(listed).toMatchObject({ ok: true, output: { entries: [{ message: "via mcp" }] } });
  });

  it("finds and deletes a subject's data with a verifiable deletion proof", async () => {
    const p = plant();
    await sign(p, "Dana@Example.com", "one");
    await sign(p, "dana@example.com", "two");
    await sign(p, "other@example.com", "three");
    const subject = { email: "dana@example.com" };

    const found = await p.privacy.find(subject);
    expect(found.records).toHaveLength(2);
    expect(found.records.every((r) => r.type === "hello.guestbook_entry")).toBe(true);
    expect((await p.privacy.export(subject)).records.map((r) => (r.data as { message: string }).message).sort()).toEqual([
      "one",
      "two",
    ]);

    // ctx.subjects in the module asks (mock) core over PLANT_PRIVACY for the proof.
    const proof = await p.privacy.delete(subject);
    const tenantId = (await p.context("app")).tenant.id;
    expect(proof).toMatchObject({ moduleId: "hello", tenantId, subjectHashAlgorithm: "HMAC-SHA-256", deleted: [{ count: 2 }] });
    expect(JSON.stringify(proof)).not.toContain("dana");
    expect(await p.privacy.verifyProof(proof, subject)).toBe(true);
    expect(await p.privacy.verifyProof(proof, { email: "other@example.com" })).toBe(false);

    expect(await p.privacy.find(subject)).toEqual({ records: [] });
    expect((await p.privacy.verify(subject)).clean).toBe(true);
    expect((await p.privacy.find({ email: "other@example.com" })).records).toHaveLength(1);
  });

  it("is needs-setup until its required key is set", async () => {
    const p = plant({ keys: {} });
    expect(await p.keyStatus()).toMatchObject({ state: "needs-setup", missing: ["HELLO_API_KEY"] });

    const res = await p.fetch("/");
    expect(res.status).toBe(503);
    expect(res.headers.get(MODULE_STATE_HEADER)).toBe("needs-setup");
    const body = (await res.json()) as { missing: { name: string }[] };
    expect(body.missing.map((k) => k.name)).toEqual(["HELLO_API_KEY"]);
    expect(JSON.stringify(body)).not.toContain("test-value");
    expect(await (await p.fetch("/public/hello")).json()).toEqual({ error: "unavailable" });
    expect(await p.mcp.listTools()).toEqual([]);
    expect(await p.mcp.callTool("hello__list_entries", {})).toMatchObject({ ok: false, error: { code: "not_found" } });

    p.setKey("HELLO_API_KEY", "now-set");
    expect((await p.fetch("/")).status).toBe(200);
    expect(await p.mcp.listTools()).toHaveLength(2);
  });

  it("fires the tidy agent's schedule over RPC", async () => {
    const p = plant();
    expect(await p.tickAgent("tidy", { scheduledAt: "2026-11-04T06:00:00Z" })).toEqual({
      cron: "0 6 * * *",
      scheduledAt: "2026-11-04T06:00:00.000Z",
    });
    expect(await (await p.fetch("/")).text()).toContain("Last tidied 2026-11-04T06:00:00.000Z.");
  });

  it("refuses a tenant without the module's entitlement", async () => {
    const p = plant({ entitlements: [] });
    expect((await p.fetch("/")).status).toBe(403);
    expect(await p.mcp.listTools()).toEqual([]);
  });
});
