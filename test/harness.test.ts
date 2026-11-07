import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  agentPrincipal,
  createModuleHarness,
  defineMcpExtension,
  defineModule,
  HARNESS_BRAND,
  HARNESS_GATE_HEADER,
  HARNESS_PRINCIPAL,
  HarnessError,
  MCP_WIRE_NAME,
  MCP_WIRE_NAME_MAX,
  mcpDisplayLabel,
  mcpWireName,
  MODULE_STATE_HEADER,
  parseMcpWireName,
  type AgentContext,
  type AgentTick,
  type DataSubject,
  type PlantContext,
} from "../src/index.js";

// Test-only key material, not a secret.
const subjectKey = new TextEncoder().encode("harness-unit-test-subject-key-0123456789").buffer as ArrayBuffer;

type Env = { notes: Map<string, { id: string; email: string; text: string }> };

function notesModule() {
  const env: Env = { notes: new Map() };
  const seen: PlantContext[] = [];
  const agentRuns: { kind: "tick" | "event"; ctx: AgentContext; what: string }[] = [];
  const mcp = defineMcpExtension<Env>()({
    tools: {
      list_notes: {
        description: "List notes",
        input: z.object({}),
        run: (_i, ctx, e) => {
          seen.push(ctx);
          return { notes: [...e.notes.values()].map((n) => n.text) };
        },
      },
      add_note: {
        description: "Add a note",
        input: z.object({ email: z.string(), text: z.string() }),
        write: true,
        run: ({ email, text }, _ctx, e, { draftId }) => {
          const id = `n${e.notes.size + 1}`;
          e.notes.set(id, { id, email, text });
          return { id, draftId };
        },
      },
      pro_tool: { description: "Pro only", input: z.object({}), requires: "notes.pro", run: () => ({}) },
    },
    resources: { note: { uriTemplate: "notes/{id}", read: (_u, { id }, _c, e) => e.notes.get(id!)?.text ?? "" } },
    prompts: { greet: { arguments: { who: { required: true } }, template: "Hi {{who}}" } },
  });
  const forSubject = (s: DataSubject, e: Env) => [...e.notes.values()].filter((n) => n.email === s.email);
  const mod = defineModule<Env>({
    id: "notes",
    name: "Notes",
    version: "0.1.0",
    coreRange: "^0.1.0",
    publicPrefixes: ["/public"],
    requires: ["notes.basic"],
    requiredKeys: [{ name: "NOTES_API_KEY", description: "Test key" }],
    events: { listens: ["dsar.requested"] },
    agents: [
      {
        name: "digest",
        schedule: "0 6 * * *",
        listens: ["notes.flagged"],
        onSchedule: (tick: AgentTick, ctx: AgentContext) => void agentRuns.push({ kind: "tick", ctx, what: tick.scheduledAt }),
        onEvent: (event, ctx) => void agentRuns.push({ kind: "event", ctx, what: event.type }),
      },
    ],
    onEvent: (event, ctx) => {
      seen.push(ctx);
      env.notes.set("evt", { id: "evt", email: "x", text: event.type });
    },
    handle: (req, ctx) => {
      seen.push(ctx);
      return Response.json({ path: new URL(req.url).pathname, surface: ctx.surface, who: ctx.principal?.email ?? null });
    },
    mcp,
    privacy: {
      find: async (s, _c, e) => ({ records: forSubject(s, e).map((n) => ({ type: "notes.note", id: n.id })) }),
      export: async (s, _c, e) => ({ format: "json", records: forSubject(s, e).map((n) => ({ type: "notes.note", id: n.id, data: n })) }),
      delete: async (s, ctx, e) => {
        const gone = forSubject(s, e);
        for (const n of gone) e.notes.delete(n.id);
        return ctx.subjects.deletionProof(s, { deleted: [{ type: "notes.note", count: gone.length }] });
      },
      verify: async (s, _c, e) => ({ clean: forSubject(s, e).length === 0, remaining: [], checkedAt: new Date().toISOString() }),
    },
  });
  return { mod, env, seen, agentRuns };
}

const ready = { entitlements: ["notes.basic"], keys: { NOTES_API_KEY: "test" } };

describe("mcp wire names", () => {
  it("joins with a double underscore and splits back", () => {
    expect(mcpWireName("ads", "experiment_create")).toBe("ads__experiment_create");
    expect(parseMcpWireName("ads__experiment_create")).toEqual({ moduleId: "ads", name: "experiment_create" });
    expect(parseMcpWireName("ads.experiment_create")).toBeUndefined();
    expect(parseMcpWireName("__x")).toBeUndefined();
    expect(() => mcpWireName("ads", "a.b")).toThrow(TypeError);
    expect(() => mcpWireName("ads", "b".repeat(62))).toThrow(/invalid name/);
    expect(() => mcpWireName("ads", "a__b")).toThrow(/invalid name/);
    expect(() => mcpWireName("a_b", "x")).toThrow(/invalid module id/);
  });

  it("caps the whole wire name at 64 characters, the strictest client limit", () => {
    expect(MCP_WIRE_NAME_MAX).toBe(64);
    const fits = mcpWireName("a".repeat(31), "b".repeat(31));
    expect(fits).toHaveLength(64);
    expect(fits).toMatch(MCP_WIRE_NAME);
    expect(fits).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(parseMcpWireName(fits)).toEqual({ moduleId: "a".repeat(31), name: "b".repeat(31) });
    expect(() => mcpWireName("a".repeat(31), "b".repeat(32))).toThrow(/longer than 64/);
    expect(parseMcpWireName(`${"a".repeat(31)}__${"b".repeat(32)}`)).toBeUndefined();
    expect(() => mcpWireName("m", "b".repeat(61))).not.toThrow();
  });

  it("splits on the first double underscore; module ids may contain '-'", () => {
    expect(parseMcpWireName("ad-tracker__list_ads")).toEqual({ moduleId: "ad-tracker", name: "list_ads" });
    expect(parseMcpWireName("ads__a__b")).toBeUndefined();
    expect(parseMcpWireName("ads___b")).toBeUndefined();
  });

  it("builds dotted display labels that are never wire names", () => {
    expect(mcpDisplayLabel("ads", "experiment_create")).toBe("ads.experiment.create");
    expect(parseMcpWireName(mcpDisplayLabel("ads", "experiment_create"))).toBeUndefined();
  });
});

describe("createModuleHarness (in-process)", () => {
  it("doesn't put a module in needs-setup for an unset optional key", async () => {
    const mod = defineModule({
      id: "hooks",
      name: "Hooks",
      version: "0.1.0",
      coreRange: "^0.1.0",
      requiredKeys: [
        { name: "HOOKS_API_KEY", description: "Main key" },
        { name: "HOOKS_WEBHOOK_SECRET", description: "Signs webhooks", optional: true },
      ],
      handle: () => new Response("ok"),
    });
    const plant = createModuleHarness(mod, { keys: { HOOKS_API_KEY: "test" } });
    const status = await plant.keyStatus();
    expect(status).toMatchObject({ state: "ready", missing: [] });
    expect(status.keys.find((k) => k.name === "HOOKS_WEBHOOK_SECRET")).toMatchObject({ optional: true, set: false });
    expect((await plant.fetch("/")).status).toBe(200);

    // Required keys still gate, and the setup body lists only them.
    plant.unsetKey("HOOKS_API_KEY");
    const setup = await plant.fetch("/");
    expect(setup.status).toBe(503);
    expect(await setup.json()).toEqual({
      error: "needs-setup",
      moduleId: "hooks",
      missing: [{ name: "HOOKS_API_KEY", description: "Main key", shared: false }],
    });

    plant.setKey("HOOKS_API_KEY", "test");
    plant.setKey("HOOKS_WEBHOOK_SECRET", "test");
    expect((await plant.keyStatus()).keys.every((k) => k.set)).toBe(true);
  });

  it("routes app and public paths with the context the router would build", async () => {
    const { mod, env, seen } = notesModule();
    const plant = createModuleHarness(mod, { env, ...ready });

    const app = await plant.fetch("/inbox?x=1");
    expect(await app.json()).toEqual({ path: "/notes/inbox", surface: "app", who: HARNESS_PRINCIPAL.email });
    expect(seen[0]?.brand).toEqual(HARNESS_BRAND);
    expect(seen[0]?.entitlements.has("notes.basic")).toBe(true);

    const pub = await plant.fetch("/public/hi");
    expect(await pub.json()).toEqual({ path: "/notes/public/hi", surface: "public", who: null });
  });

  it("applies the Access, entitlement and needs-setup gates", async () => {
    const { mod, env } = notesModule();
    const anon = createModuleHarness(mod, { env, ...ready, principal: null });
    const denied = await anon.fetch("/");
    expect(denied.status).toBe(401);
    expect(denied.headers.get(HARNESS_GATE_HEADER)).toBe("access");
    expect((await anon.fetch("/public/x")).status).toBe(200);

    const unentitled = createModuleHarness(mod, { env, keys: ready.keys });
    expect((await unentitled.fetch("/")).status).toBe(403);
    expect(await unentitled.mcp.listTools()).toEqual([]);

    const plant = createModuleHarness(mod, { env, entitlements: ready.entitlements });
    expect(await plant.keyStatus()).toMatchObject({ state: "needs-setup", missing: ["NOTES_API_KEY"] });
    const setup = await plant.fetch("/");
    expect(setup.status).toBe(503);
    expect(setup.headers.get(MODULE_STATE_HEADER)).toBe("needs-setup");
    expect(await setup.json()).toMatchObject({ error: "needs-setup", missing: [{ name: "NOTES_API_KEY" }] });
    expect(await (await plant.fetch("/public/x")).json()).toEqual({ error: "unavailable" });
    expect(await plant.mcp.listTools()).toEqual([]);
    expect((await plant.mcp.callTool("notes__list_notes")).ok).toBe(false);

    plant.setKey("NOTES_API_KEY", "now-set");
    expect((await plant.keyStatus()).state).toBe("ready");
    expect((await plant.fetch("/")).status).toBe(200);
  });

  it("lists tools by wire name, hides unentitled ones and runs writes through an approved draft", async () => {
    const { mod, env } = notesModule();
    const plant = createModuleHarness(mod, { env, ...ready });
    const tools = await plant.mcp.listTools();
    expect(tools.map((t) => t.name)).toEqual(["notes__list_notes", "notes__add_note"]);
    expect(tools[1]).toMatchObject({ toolName: "add_note", write: true });
    expect((await plant.mcp.listTools({ entitlements: ["notes.basic", "notes.pro"] })).map((t) => t.name)).toContain(
      "notes__pro_tool",
    );

    expect(await plant.mcp.callTool("notes__list_notes")).toEqual({ ok: true, kind: "tool", output: { notes: [] } });
    expect(await plant.mcp.callTool("notes.list_notes")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await plant.mcp.callTool("other__list_notes")).toMatchObject({ ok: false, error: { code: "not_found" } });

    const input = { email: "a@b.c", text: "hi" };
    expect(await plant.mcp.callTool("notes__add_note", input)).toMatchObject({ ok: false, error: { code: "draft_required" } });
    await expect(plant.mcp.createDraft("notes__list_notes")).rejects.toThrow(HarnessError);
    const helper = agentPrincipal("notes", "helper", "t_test");
    const draft = await plant.mcp.createDraft("notes__add_note", input, { createdBy: helper });
    expect(draft.createdBy).toBe("agent:notes/helper");
    await expect(plant.mcp.approveDraft(draft.id, { approver: helper as never })).rejects.toThrow(/never an agent/);
    expect(draft.status).toBe("pending");
    expect(await plant.mcp.approveDraft(draft.id)).toEqual({ ok: true, kind: "tool", output: { id: "n1", draftId: draft.id } });
    await expect(plant.mcp.approveDraft(draft.id)).rejects.toThrow(/already approved/);

    const own = await plant.mcp.createDraft("notes__add_note", input);
    await expect(plant.mcp.approveDraft(own.id)).rejects.toThrow(/created it/);
    expect(
      await plant.mcp.approveDraft(own.id, { approver: { email: "manager@test.example.com", groups: [] } }),
    ).toMatchObject({ ok: true });

    // Rejected drafts never run, and agents can't reject.
    const nope = await plant.mcp.createDraft("notes__add_note", input, { createdBy: helper });
    await expect(plant.mcp.rejectDraft(nope.id, { approver: helper as never })).rejects.toThrow(/never an agent/);
    expect((await plant.mcp.rejectDraft(nope.id)).status).toBe("rejected");
    await expect(plant.mcp.approveDraft(nope.id)).rejects.toThrow(/already rejected/);
  });

  it("reads resources and prompts by their plant names", async () => {
    const { mod, env } = notesModule();
    env.notes.set("n9", { id: "n9", email: "a@b.c", text: "nine" });
    const plant = createModuleHarness(mod, { env, ...ready });
    expect((await plant.mcp.listResources())[0]?.uri).toBe("plant://notes/notes/{id}");
    expect(await plant.mcp.readResource("plant://notes/notes/n9")).toEqual({
      ok: true,
      kind: "resource",
      contents: [{ uri: "plant://notes/notes/n9", text: "nine" }],
    });
    expect((await plant.mcp.listPrompts())[0]?.name).toBe("notes__greet");
    expect(await plant.mcp.getPrompt("notes__greet", { who: "Jo" })).toMatchObject({
      ok: true,
      messages: [{ role: "user", content: { type: "text", text: "Hi Jo" } }],
    });
  });

  it("runs privacy find, export, delete and verify, and checks the deletion proof", async () => {
    const { mod, env } = notesModule();
    env.notes.set("n1", { id: "n1", email: "a@b.c", text: "x" });
    env.notes.set("n2", { id: "n2", email: "other@b.c", text: "y" });
    const plant = createModuleHarness(mod, { env, ...ready, subjectKey });
    const subject = { email: "a@b.c" };

    expect((await plant.privacy.find(subject)).records).toEqual([{ type: "notes.note", id: "n1" }]);
    expect((await plant.privacy.export(subject)).records).toHaveLength(1);
    const proof = await plant.privacy.delete(subject);
    expect(proof).toMatchObject({ moduleId: "notes", tenantId: "t_test", deleted: [{ type: "notes.note", count: 1 }] });
    expect(JSON.stringify(proof)).not.toContain("a@b.c");
    expect(await plant.privacy.verifyProof(proof, subject)).toBe(true);
    expect(await plant.privacy.verifyProof(proof, { email: "other@b.c" })).toBe(false);
    expect(await plant.privacy.verifyProof(proof, subject, { tenant: { id: "t_other", hostname: "o.example.com" } })).toBe(false);
    expect((await plant.privacy.verify(subject)).clean).toBe(true);
    expect((await plant.privacy.find(subject)).records).toEqual([]);

    await expect(createModuleHarness(mod, { env }).privacy.verifyProof(proof, subject)).rejects.toThrow(/subjectKey/);
  });

  it("delivers events the module listens for", async () => {
    const { mod, env } = notesModule();
    const plant = createModuleHarness(mod, { env, ...ready });
    const event = await plant.emit({ type: "dsar.requested", data: { email: "a@b.c" } });
    expect(event).toMatchObject({ type: "dsar.requested", tenantId: "t_test", source: "dsar" });
    expect(env.notes.get("evt")?.text).toBe("dsar.requested");
    await expect(plant.emit({ type: "other.thing" })).rejects.toThrow(/does not listen/);
  });

  it("delivers events to listening agents and fires agent schedules", async () => {
    const { mod, env, agentRuns } = notesModule();
    const plant = createModuleHarness(mod, { env, ...ready });
    await plant.emit({ type: "notes.flagged" });
    const tick = await plant.tickAgent("digest", { scheduledAt: "2026-11-04T06:00:00Z" });
    expect(tick).toEqual({ cron: "0 6 * * *", scheduledAt: "2026-11-04T06:00:00.000Z" });
    expect(agentRuns.map((r) => [r.kind, r.what])).toEqual([
      ["event", "notes.flagged"],
      ["tick", "2026-11-04T06:00:00.000Z"],
    ]);
    expect(agentRuns[1]?.ctx.principal).toMatchObject({ kind: "agent", module: "notes", agent: "digest", tenantId: "t_test" });
    await expect(plant.tickAgent("nope")).rejects.toThrow(/no agent/);

    const notReady = createModuleHarness(mod, { env, entitlements: ready.entitlements });
    await expect(notReady.tickAgent("digest")).rejects.toThrow(/needs setup/);
  });

  it("reports missing optional capabilities", async () => {
    const mod = defineModule({ id: "bare", name: "Bare", version: "0.1.0", coreRange: "^0.1.0", handle: () => new Response("ok") });
    const plant = createModuleHarness(mod);
    expect(await plant.mcp.listTools()).toEqual([]);
    expect(await plant.mcp.callTool("bare__x")).toMatchObject({ ok: false, error: { code: "not_found" } });
    await expect(plant.privacy.find({ email: "a@b.c" })).rejects.toThrow(/no privacy handlers/);
    expect(await (await plant.fetch("/")).text()).toBe("ok");
  });
});
