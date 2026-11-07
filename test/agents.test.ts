import { describe, expect, it, vi } from "vitest";
import {
  actorId,
  agentConversationId,
  agentPrincipal,
  conversationBelongsTo,
  conversationTenant,
  createAgentHarness,
  defineModule,
  eventIdempotencyKey,
  eventsConversationId,
  inboxConversationId,
  isAgentPrincipal,
  isCronPattern,
  moduleEntrypoint,
  ModuleDefinitionError,
  scheduleIdempotencyKey,
  sweepConversationId,
  validateProposal,
  type AgentContext,
  type AgentDefinition,
  type ModuleDefinition,
  type PlantEvent,
  type Proposal,
} from "../src/index.js";
import { appCtx, baseDef } from "./fixtures.js";

/** A stand-in for Flue's dispatch(): records what the module would send. */
interface DispatchArgs {
  id: string;
  idempotencyKey: string;
  initialData: unknown;
  message: { kind: "signal"; type: string; body: string };
}
type Env = { dispatch: (args: DispatchArgs) => Promise<{ submissionId: string }> };

function fakeEnv(): Env & { sent: DispatchArgs[] } {
  const sent: DispatchArgs[] = [];
  return {
    sent,
    dispatch: async (args) => {
      sent.push(args);
      return { submissionId: `sub_${args.idempotencyKey}` };
    },
  };
}

const tracker: AgentDefinition<Env> = {
  name: "tracker",
  description: "Watches competitor ads",
  schedule: "0 6 * * *",
  listens: ["ads.campaign-changed"],
  onSchedule: (tick, ctx, env) =>
    env.dispatch({
      id: ctx.conversationId,
      idempotencyKey: ctx.idempotencyKey,
      initialData: ctx.initialData,
      message: { kind: "signal", type: "schedule", body: `sweep at ${tick.scheduledAt}` },
    }),
  onEvent: (event, ctx, env) =>
    env.dispatch({
      id: ctx.conversationId,
      idempotencyKey: ctx.idempotencyKey,
      initialData: ctx.initialData,
      message: { kind: "signal", type: event.type, body: JSON.stringify(event.data) },
    }),
};

const adsDef = (): ModuleDefinition<Env> => ({ ...baseDef({ id: "ads", name: "Ads" }), agents: [tracker] });

describe("conversation ids", () => {
  it("are tenant-scoped, per run for schedules and per day for events", () => {
    expect(sweepConversationId("t_1", "2026-11-04T06:00:00Z")).toBe("t_1.sweep-2026-11-04");
    expect(eventsConversationId("t_1", new Date("2026-11-04T23:59:59Z"))).toBe("t_1.events-2026-11-04");
    expect(inboxConversationId("t_1")).toBe("t_1.inbox");
    expect(agentConversationId("acme", "custom-1")).toBe("acme.custom-1");
  });

  it("refuse tenant ids that could break out of the prefix", () => {
    expect(() => agentConversationId("a.b", "inbox")).toThrow(/tenant id/);
    expect(() => agentConversationId("", "inbox")).toThrow(/tenant id/);
    expect(() => agentConversationId("t_1", "x.y")).toThrow(/conversation id part/);
    expect(() => sweepConversationId("t_1", "not a date")).toThrow(/not a date/);
  });

  it("tell which tenant a conversation belongs to", () => {
    expect(conversationTenant("t_1.sweep-2026-11-04")).toBe("t_1");
    expect(conversationTenant("nodot")).toBeNull();
    expect(conversationTenant(".inbox")).toBeNull();
    expect(conversationBelongsTo("t_1.inbox", "t_1")).toBe(true);
    expect(conversationBelongsTo("t_2.inbox", "t_1")).toBe(false);
    expect(conversationBelongsTo("t_1", "t_1")).toBe(false);
  });

  it("idempotency keys are deterministic and scoped to tenant, module and agent", () => {
    expect(scheduleIdempotencyKey("t_1", "ads", "tracker", "2026-11-04T06:00:00Z")).toBe(
      "schedule:t_1:ads/tracker:2026-11-04T06:00:00.000Z",
    );
    expect(eventIdempotencyKey("t_1", "ads", "tracker", { id: "evt_9" })).toBe("event:t_1:ads/tracker:evt_9");
    expect(() => eventIdempotencyKey("t_1", "ads", "tracker", { id: "" })).toThrow(/event id/);
  });

  it("idempotency keys never collide across tenants or modules at the same moment", () => {
    const at = "2026-11-04T06:00:00Z";
    const event = { id: "evt_1" };
    const schedule = [
      scheduleIdempotencyKey("t_1", "ads", "tracker", at),
      scheduleIdempotencyKey("t_2", "ads", "tracker", at),
      scheduleIdempotencyKey("t_1", "funnels", "tracker", at),
    ];
    const events = [
      eventIdempotencyKey("t_1", "ads", "tracker", event),
      eventIdempotencyKey("t_2", "ads", "tracker", event),
      eventIdempotencyKey("t_1", "funnels", "tracker", event),
    ];
    expect(new Set(schedule).size).toBe(3);
    expect(new Set(events).size).toBe(3);
  });

  it("idempotency keys validate their scope", () => {
    const at = "2026-11-04T06:00:00Z";
    expect(() => scheduleIdempotencyKey("t.1", "ads", "tracker", at)).toThrow(/tenant id/);
    expect(() => scheduleIdempotencyKey("", "ads", "tracker", at)).toThrow(/tenant id/);
    expect(() => scheduleIdempotencyKey("t_1", "Ads", "tracker", at)).toThrow(/module id/);
    expect(() => eventIdempotencyKey("t_1", "ads", "", { id: "e" })).toThrow(/agent/);
    expect(() => eventIdempotencyKey("t_1", "a/b", "tracker", { id: "e" })).toThrow(/module id/);
  });
});

describe("AgentPrincipal", () => {
  it("is distinguishable from a person", () => {
    const agent = agentPrincipal("ads", "tracker", "t_1");
    expect(agent).toEqual({ kind: "agent", module: "ads", agent: "tracker", tenantId: "t_1" });
    expect(Object.isFrozen(agent)).toBe(true);
    expect(isAgentPrincipal(agent)).toBe(true);
    expect(isAgentPrincipal(appCtx.principal)).toBe(false);
    expect(isAgentPrincipal(null)).toBe(false);
    expect(actorId(agent)).toBe("agent:ads/tracker");
    expect(actorId(appCtx.principal!)).toBe("person:ops@acme.example.com");
  });

  it("validates its parts", () => {
    expect(() => agentPrincipal("Ads", "tracker", "t_1")).toThrow(/module/);
    expect(() => agentPrincipal("ads", "", "t_1")).toThrow(/agent/);
    expect(() => agentPrincipal("ads", "tracker", "t.1")).toThrow(/tenant/);
  });
});

describe("Proposal", () => {
  const ok: Proposal = {
    title: "Acme launched a TikTok campaign",
    body: "Three new creatives since yesterday.",
    evidence: [{ url: "https://r2.example.com/reports/acme.json", label: "Sweep report" }],
    suggestedToolCall: { tool: "ads__create_counter_campaign", input: { competitor: "acme" } },
    severity: "medium",
    dedupeKey: "competitor-change:acme|tiktok:v2",
  };

  it("accepts a well-formed proposal unchanged", () => {
    expect(validateProposal(ok)).toBe(ok);
    expect(validateProposal({ title: "t", body: "", evidence: [], severity: "info" })).toBeTruthy();
    expect(validateProposal({ ...ok, suggestedToolCall: { tool: "pause_campaign", input: {} } })).toBeTruthy();
    expect(validateProposal({ ...ok, suggestedToolCall: { tool: "dsar-v2__delete_subject", input: {} } })).toBeTruthy();
  });

  it.each<[string, Partial<Proposal>, RegExp]>([
    ["empty title", { title: " " }, /title/],
    ["long title", { title: "x".repeat(201) }, /title/],
    ["unknown severity", { severity: "urgent" as never }, /severity/],
    ["non-URL evidence", { evidence: [{ url: "acme" }] }, /not a URL/],
    ["javascript: evidence", { evidence: [{ url: "javascript:alert(1)" }] }, /http/],
    ["bad tool name", { suggestedToolCall: { tool: "Ads.Pause", input: {} } }, /suggested tool/],
    ["dot-namespaced tool", { suggestedToolCall: { tool: "ads.pause_campaign", input: {} } }, /<moduleId>__<tool>/],
    ["two separators", { suggestedToolCall: { tool: "ads__pause__now", input: {} } }, /suggested tool/],
    ["triple underscore", { suggestedToolCall: { tool: "ads___pause", input: {} } }, /suggested tool/],
    ["empty dedupeKey", { dedupeKey: "" }, /dedupeKey/],
  ])("rejects %s", (_label, patch, error) => {
    expect(() => validateProposal({ ...ok, ...patch })).toThrow(error);
  });
});

describe("defineModule agents", () => {
  it("puts plain agent entries in the manifest and keeps handlers out of it", () => {
    const mod = defineModule(adsDef());
    expect(mod.manifest.agents).toEqual([
      { name: "tracker", description: "Watches competitor ads", schedule: "0 6 * * *", listens: ["ads.campaign-changed"] },
    ]);
    expect(Object.isFrozen(mod.manifest.agents?.[0])).toBe(true);
    expect(() => structuredClone(mod.manifest)).not.toThrow();
    expect(typeof mod.handlers.agentHandlers?.tracker?.onSchedule).toBe("function");
  });

  it("defaults to no agents", () => {
    const mod = defineModule(baseDef());
    expect(mod.manifest.agents).toBeUndefined();
    expect(mod.handlers.agentHandlers).toBeUndefined();
  });

  it.each<[string, AgentDefinition[], RegExp]>([
    ["bad name", [{ name: "Tracker" }], /lowercase slug/],
    ["duplicate", [{ name: "a" }, { name: "a" }], /duplicate agent/],
    ["bad cron", [{ name: "a", schedule: "daily", onSchedule: () => {} }], /cron/],
    ["schedule without handler", [{ name: "a", schedule: "0 6 * * *" }], /onSchedule/],
    ["bad event type", [{ name: "a", listens: ["changed"], onEvent: () => {} }], /event type/],
    ["listens without handler", [{ name: "a", listens: ["ads.changed"] }], /onEvent/],
  ])("rejects %s", (_label, agents, error) => {
    expect(() => defineModule(baseDef({ agents }))).toThrow(ModuleDefinitionError);
    expect(() => defineModule(baseDef({ agents }))).toThrow(error);
  });

  it("checks cron patterns cheaply", () => {
    expect(isCronPattern("*/30 * * * *")).toBe(true);
    expect(isCronPattern("0 6 * * MON-FRI")).toBe(true);
    expect(isCronPattern("0 6 * *")).toBe(false);
  });
});

describe("agent harness", () => {
  it("simulates a schedule tick with the per-run conventions", async () => {
    const env = fakeEnv();
    const harness = createAgentHarness(defineModule(adsDef()), {
      env,
      tenant: { id: "t_1", hostname: "acme.example.com" },
      entitlements: ["ads.pro"],
    });
    const run = await harness.tick("tracker", { scheduledAt: "2026-11-04T06:00:00Z" });
    expect(run.result).toEqual({ submissionId: "sub_schedule:t_1:ads/tracker:2026-11-04T06:00:00.000Z" });
    expect(run.context.principal).toEqual({ kind: "agent", module: "ads", agent: "tracker", tenantId: "t_1" });
    expect(run.context.entitlements.has("ads.pro")).toBe(true);
    expect(env.sent).toEqual([
      {
        id: "t_1.sweep-2026-11-04",
        idempotencyKey: "schedule:t_1:ads/tracker:2026-11-04T06:00:00.000Z",
        initialData: {
          tenantId: "t_1",
          module: "ads",
          agent: "tracker",
          runId: "sweep-2026-11-04",
          trigger: "schedule",
          scheduledAt: "2026-11-04T06:00:00.000Z",
        },
        message: { kind: "signal", type: "schedule", body: "sweep at 2026-11-04T06:00:00.000Z" },
      },
    ]);
  });

  it("simulates an event; a redelivery carries the same idempotency key", async () => {
    const env = fakeEnv();
    const harness = createAgentHarness(defineModule(adsDef()), { env });
    const event = { id: "evt_1", type: "ads.campaign-changed", occurredAt: "2026-11-04T10:00:00Z", data: { n: 1 } };
    const first = await harness.event("tracker", event);
    const again = await harness.event("tracker", event);
    expect(first.context.conversationId).toBe("t_test.events-2026-11-04");
    expect(first.context.idempotencyKey).toBe("event:t_test:ads/tracker:evt_1");
    expect(again.context.idempotencyKey).toBe(first.context.idempotencyKey);
    expect(first.context.initialData).toMatchObject({ trigger: "event", eventId: "evt_1", eventType: "ads.campaign-changed" });
    expect(env.sent[0]?.message.body).toBe('{"n":1}');
  });

  it("refuses events for another tenant, unknown agents and unlistened types", async () => {
    const harness = createAgentHarness(defineModule(adsDef()), { env: fakeEnv() });
    await expect(harness.event("tracker", { type: "ads.campaign-changed", tenantId: "t_other" })).rejects.toThrow(/another tenant/);
    await expect(harness.event("tracker", { type: "ads.other" })).rejects.toThrow(/does not listen/);
    await expect(harness.tick("nope")).rejects.toThrow(/no agent "nope"/);
    const noSchedule = createAgentHarness(
      defineModule(baseDef({ agents: [{ name: "inbox", listens: ["ads.x"], onEvent: () => {} }] })),
      { env: {} },
    );
    await expect(noSchedule.tick("inbox")).rejects.toThrow(/no schedule/);
  });
});

describe("PlantModule agent RPC", () => {
  const execCtx = {} as ExecutionContext;
  const event: PlantEvent = {
    id: "evt_7",
    type: "ads.campaign-changed",
    tenantId: "t_1",
    source: "ads",
    occurredAt: "2026-11-04T10:00:00Z",
    data: {},
  };

  it("runs onAgentTick and fans events out to listening agents", async () => {
    const env = fakeEnv();
    const worker = new (moduleEntrypoint(defineModule(adsDef())))(execCtx, env);
    await worker.onAgentTick!("tracker", { cron: "0 6 * * *", scheduledAt: "2026-11-04T06:00:00Z" }, {
      tenant: appCtx.tenant,
      entitlements: [],
    });
    await worker.onEvent!(event, appCtx);
    expect(env.sent.map((s) => [s.id, s.idempotencyKey])).toEqual([
      ["t_1.sweep-2026-11-04", "schedule:t_1:ads/tracker:2026-11-04T06:00:00.000Z"],
      ["t_1.events-2026-11-04", "event:t_1:ads/tracker:evt_7"],
    ]);
    await expect(
      worker.onAgentTick!("tracker", { cron: "*/5 * * * *", scheduledAt: "2026-11-04T06:00:00Z" }, {
        tenant: appCtx.tenant,
        entitlements: [],
      }),
    ).rejects.toThrow(/is scheduled/);
  });

  it("delivers to the module's onEvent and its agents together", async () => {
    const onEvent = vi.fn();
    const seen: AgentContext[] = [];
    const mod = defineModule(
      baseDef({
        id: "ads",
        events: { listens: ["ads.campaign-changed"] },
        onEvent,
        agents: [{ name: "a", listens: ["ads.campaign-changed"], onEvent: (_e, ctx) => void seen.push(ctx) }],
      }),
    );
    await new (moduleEntrypoint(mod))(execCtx, {}).onEvent!(event, appCtx);
    expect(onEvent).toHaveBeenCalledOnce();
    expect(seen[0]?.principal.kind).toBe("agent");
  });

  it("exposes onEvent and onAgentTick only when needed", () => {
    const plain = new (moduleEntrypoint(defineModule(baseDef())))(execCtx, {});
    expect(plain.onAgentTick).toBeUndefined();
    expect(plain.onEvent).toBeUndefined();
    const listenOnly = new (moduleEntrypoint(
      defineModule(baseDef({ agents: [{ name: "a", listens: ["ads.x"], onEvent: () => {} }] })),
    ))(execCtx, {});
    expect(listenOnly.onEvent).toBeTypeOf("function");
    expect(listenOnly.onAgentTick).toBeUndefined();
  });
});
