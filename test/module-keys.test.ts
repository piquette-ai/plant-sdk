import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";
import {
  actorId,
  createAgentHarness,
  createModuleKeys,
  createPlantContext,
  defineMcpExtension,
  defineModule,
  moduleEntrypoint,
  moduleKeys,
  serializePlantContext,
  withModuleKeys,
  type AgentContext,
  type ModuleDefinition,
  type PlantContext,
} from "../src/index.js";
import { scrubError, scrubKeyValues, UNSERIALIZABLE } from "../src/module-keys.js";
import { appCtx, baseDef } from "./fixtures.js";

const execCtx = {} as ExecutionContext;
const OWN = "fake-own-key-0123456789abcdef";
const SHARED = "fake-shared-ai-key-fedcba9876543210";
const OTHER = "fake-other-module-key-42";

const requiredKeys = [
  { name: "CONSENT_API_KEY", description: "Consent backend key" },
  { name: "AI_KEY", description: "Plant AI key", shared: true },
];

/** Everything the router would hand over, including a key this module never declared. */
const routerKeys = { CONSENT_API_KEY: OWN, AI_KEY: SHARED, OTHER_MODULE_KEY: OTHER };

function def(overrides: Partial<ModuleDefinition> = {}): ModuleDefinition {
  return baseDef({ requiredKeys, ...overrides });
}

function leaks(text: string): boolean {
  return [OWN, SHARED, OTHER].some((v) => text.includes(v));
}

describe("module keys over RPC", () => {
  it("returns undefined for an unset optional key and delivers it once set", async () => {
    const seen: { value: string | undefined; has: boolean }[] = [];
    const mod = defineModule(
      def({
        requiredKeys: [...requiredKeys, { name: "WEBHOOK_SECRET", description: "Signs webhooks", optional: true }],
        handle: (_r, ctx) => {
          const k = moduleKeys(ctx);
          seen.push({ value: k.get("WEBHOOK_SECRET"), has: k.has("WEBHOOK_SECRET") });
          return new Response("ok");
        },
      }),
    );
    const worker = new (moduleEntrypoint(mod))(execCtx, {});
    const req = () => new Request("https://acme.example.com/consent");
    await worker.handle(req(), appCtx, { CONSENT_API_KEY: OWN, AI_KEY: SHARED });
    await worker.handle(req(), appCtx, { CONSENT_API_KEY: OWN, AI_KEY: SHARED, WEBHOOK_SECRET: "whsec-123456" });
    expect(seen).toEqual([
      { value: undefined, has: false },
      { value: "whsec-123456", has: true },
    ]);
  });

  it("lets a handler read its declared keys at request time", async () => {
    const mod = defineModule(
      def({ handle: (_r, ctx) => new Response(moduleKeys(ctx).getOrThrow("CONSENT_API_KEY").slice(-4)) }),
    );
    const worker = new (moduleEntrypoint(mod))(execCtx, {});
    const req = () => new Request("https://acme.example.com/consent");
    expect(await (await worker.handle(req(), appCtx, { CONSENT_API_KEY: "key-one-1111" })).text()).toBe("1111");
    // A rotated key is used on the next request, with no redeploy.
    expect(await (await worker.handle(req(), appCtx, { CONSENT_API_KEY: "key-two-2222" })).text()).toBe("2222");
  });

  it("only gives a module the keys its manifest declares, own and shared", async () => {
    let seen: { names: string[]; own?: string; shared?: string; other?: unknown } | undefined;
    const mod = defineModule(
      def({
        handle: (_r, ctx) => {
          const k = moduleKeys(ctx);
          let other: unknown;
          try {
            other = k.get("OTHER_MODULE_KEY");
          } catch (err) {
            other = err;
          }
          seen = { names: k.names(), own: k.get("CONSENT_API_KEY"), shared: k.get("AI_KEY"), other };
          return new Response("ok");
        },
      }),
    );
    const worker = new (moduleEntrypoint(mod))(execCtx, {});
    await worker.handle(new Request("https://acme.example.com/consent"), appCtx, routerKeys);
    expect(seen?.names).toEqual(["AI_KEY", "CONSENT_API_KEY"]);
    expect(seen?.own).toBe(OWN);
    expect(seen?.shared).toBe(SHARED);
    expect(seen?.other).toBeInstanceOf(TypeError);
    expect(String((seen?.other as Error).message)).toMatch(/not declared/);
  });

  it("works without keys: declared keys read as unset", async () => {
    const mod = defineModule(
      def({
        handle: (_r, ctx) => {
          const k = moduleKeys(ctx);
          return new Response(`${k.has("CONSENT_API_KEY")} ${String(k.get("CONSENT_API_KEY"))}`);
        },
      }),
    );
    const worker = new (moduleEntrypoint(mod))(execCtx, {});
    expect(await (await worker.handle(new Request("https://a.example.com/"), appCtx)).text()).toBe("false undefined");
  });

  it("a module without requiredKeys gets no keys at all", async () => {
    const mod = defineModule(baseDef({ handle: (_r, ctx) => new Response(JSON.stringify(moduleKeys(ctx).names())) }));
    const worker = new (moduleEntrypoint(mod))(execCtx, {});
    expect(await (await worker.handle(new Request("https://a.example.com/"), appCtx, routerKeys)).text()).toBe("[]");
  });

  it("delivers keys to privacy handlers, onEvent and agents", async () => {
    const got: string[] = [];
    const mod = defineModule(
      def({
        privacy: {
          find: async (_s, ctx) => (got.push(`find:${moduleKeys(ctx).getOrThrow("AI_KEY")}`), { records: [] }),
          export: async () => ({ format: "json", records: [] }),
          delete: async () => {
            throw new Error("unused");
          },
          verify: async () => ({ clean: true, remaining: [], checkedAt: new Date(0).toISOString() }),
        },
        events: { listens: ["dsar.requested"] },
        onEvent: (_e, ctx) => void got.push(`event:${moduleKeys(ctx).getOrThrow("CONSENT_API_KEY")}`),
        agents: [
          {
            name: "tracker",
            schedule: "0 6 * * *",
            listens: ["dsar.requested"],
            onSchedule: (_t, ctx) => void got.push(`tick:${moduleKeys(ctx).getOrThrow("AI_KEY")}`),
            onEvent: (_e, ctx) => void got.push(`agent-event:${moduleKeys(ctx).getOrThrow("AI_KEY")}`),
          },
        ],
      }),
    );
    const worker = new (moduleEntrypoint(mod))(execCtx, {});
    await worker.privacy!().find({ email: "a@b.c" }, appCtx, routerKeys);
    const event = {
      id: "e1",
      type: "dsar.requested",
      tenantId: "t_1",
      source: "dsar",
      occurredAt: new Date(0).toISOString(),
      data: {},
    };
    await worker.onEvent!(event, appCtx, routerKeys);
    await worker.onAgentTick!(
      "tracker",
      { cron: "0 6 * * *", scheduledAt: "2026-11-04T06:00:00.000Z" },
      { tenant: appCtx.tenant, entitlements: [] },
      routerKeys,
    );
    expect(got.sort()).toEqual([`agent-event:${SHARED}`, `event:${OWN}`, `find:${SHARED}`, `tick:${SHARED}`]);
  });
});

describe("key values never leak", () => {
  async function captureContext(): Promise<PlantContext> {
    let captured: PlantContext | undefined;
    const mod = defineModule(def({ handle: (_r, ctx) => ((captured = ctx), new Response("ok")) }));
    await new (moduleEntrypoint(mod))(execCtx, {}).handle(new Request("https://a.example.com/"), appCtx, routerKeys);
    return captured!;
  }

  it("are not in the serialized, JSON, cloned or inspected context", async () => {
    const ctx = await captureContext();
    expect(moduleKeys(ctx).get("CONSENT_API_KEY")).toBe(OWN);
    const serialized = serializePlantContext(ctx);
    expect(Object.keys(serialized).sort()).toEqual(Object.keys(appCtx).sort());
    expect(leaks(JSON.stringify(serialized))).toBe(false);
    expect(leaks(JSON.stringify(ctx))).toBe(false);
    expect(leaks(JSON.stringify(structuredClone(serialized)))).toBe(false);
    expect(leaks(inspect(ctx, { depth: 10, showHidden: true }))).toBe(false);
  });

  it("are not in the keys object's JSON, string or inspect output", async () => {
    const keys = moduleKeys(await captureContext());
    expect(JSON.parse(JSON.stringify(keys))).toEqual({ keys: ["AI_KEY", "CONSENT_API_KEY"] });
    expect(String(keys)).toBe("ModuleKeys(AI_KEY, CONSENT_API_KEY)");
    expect(leaks(inspect(keys, { depth: 10, showHidden: true }))).toBe(false);
    expect(leaks(JSON.stringify(structuredClone(keys)))).toBe(false);
    expect(leaks(JSON.stringify({ ...keys }))).toBe(false);
  });

  it("are not in console output when a module logs its context or keys", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 10 }))).join(" "));
    });
    try {
      const mod = defineModule(
        def({
          handle: (_r, ctx) => {
            console.log("request", ctx, moduleKeys(ctx), JSON.stringify(ctx), `${moduleKeys(ctx)}`);
            return new Response("ok");
          },
        }),
      );
      await new (moduleEntrypoint(mod))(execCtx, {}).handle(new Request("https://a.example.com/"), appCtx, routerKeys);
    } finally {
      spy.mockRestore();
    }
    expect(lines).toHaveLength(1);
    expect(leaks(lines.join("\n"))).toBe(false);
  });

  it("are scrubbed from errors thrown out of every entry point", async () => {
    const boom = (ctx: object) => {
      const err = new Error(`upstream rejected ${moduleKeys(ctx).get("CONSENT_API_KEY")}`, {
        cause: new Error(`auth ${moduleKeys(ctx).get("AI_KEY")}`),
      });
      throw err;
    };
    const mod = defineModule(
      def({
        handle: (_r, ctx) => boom(ctx),
        privacy: {
          find: async (_s, ctx) => boom(ctx),
          export: async (_s, ctx) => boom(ctx),
          delete: async (_s, ctx) => boom(ctx),
          verify: async (_s, ctx) => boom(ctx),
        },
        events: { listens: ["dsar.requested"] },
        onEvent: (_e, ctx) => boom(ctx),
        agents: [
          {
            name: "tracker",
            schedule: "0 6 * * *",
            listens: ["dsar.requested"],
            onSchedule: (_t, ctx) => boom(ctx),
            onEvent: (_e, ctx) => boom(ctx),
          },
        ],
      }),
    );
    const worker = new (moduleEntrypoint(mod))(execCtx, {});
    const event = { id: "e1", type: "dsar.requested", tenantId: "t_1", source: "dsar", occurredAt: new Date(0).toISOString(), data: {} };
    const calls: Promise<unknown>[] = [
      worker.handle(new Request("https://a.example.com/"), appCtx, routerKeys),
      worker.privacy!().find({ email: "a@b.c" }, appCtx, routerKeys),
      worker.privacy!().delete({ email: "a@b.c" }, appCtx, routerKeys),
      worker.onEvent!(event, appCtx, routerKeys),
      worker.onAgentTick!("tracker", { cron: "0 6 * * *", scheduledAt: "2026-11-04T06:00:00.000Z" }, { tenant: appCtx.tenant, entitlements: [] }, routerKeys),
    ];
    for (const call of calls) {
      const err = await call.then(
        () => expect.unreachable("should throw"),
        (e: unknown) => e,
      );
      const flat = inspect(err, { depth: 10, showHidden: true });
      expect(leaks(flat), flat).toBe(false);
      expect(flat).toContain("[redacted:CONSENT_API_KEY]");
    }
  });

  it("getOrThrow() errors name the key, never a value", () => {
    const keys = createModuleKeys(requiredKeys, { AI_KEY: SHARED });
    expect(() => keys.getOrThrow("CONSENT_API_KEY")).toThrow('required key "CONSENT_API_KEY" is not set');
  });

  it("never reach MCP output, even when a tool returns or throws one", async () => {
    const mod = defineModule(
      def({
        mcp: defineMcpExtension()({
          tools: {
            echo_key: {
              description: "A buggy tool",
              input: z.object({}),
              run: async (_i, ctx) => ({ token: moduleKeys(ctx).getOrThrow("CONSENT_API_KEY"), nested: [`Bearer ${moduleKeys(ctx).getOrThrow("AI_KEY")}`] }),
            },
            throw_key: {
              description: "Another buggy tool",
              input: z.object({}),
              run: async (_i, ctx) => {
                throw new Error(`failed with ${moduleKeys(ctx).getOrThrow("CONSENT_API_KEY")}`);
              },
            },
          },
          resources: {
            config: { uriTemplate: "config", read: (_u, _p, ctx) => `key=${moduleKeys(ctx).getOrThrow("AI_KEY")}` },
          },
        }),
      }),
    );
    const worker = new (moduleEntrypoint(mod))(execCtx, {});
    const mcpCtx = { ...appCtx, surface: "mcp" as const };
    const outputs = await Promise.all([
      worker.mcpInvoke!({ kind: "tool", name: "echo_key", input: {} }, mcpCtx, routerKeys),
      worker.mcpInvoke!({ kind: "tool", name: "throw_key", input: {} }, mcpCtx, routerKeys).catch((e: unknown) => e),
      worker.mcpInvoke!({ kind: "resource", uri: "config" }, mcpCtx, routerKeys),
    ]);
    expect(outputs[0]).toEqual({
      ok: true,
      kind: "tool",
      output: { token: "[redacted:CONSENT_API_KEY]", nested: ["Bearer [redacted:AI_KEY]"] },
    });
    for (const out of outputs) expect(leaks(inspect(out, { depth: 10, showHidden: true }))).toBe(false);
  });
});

describe("agent contexts and audit-facing data", () => {
  const mod = defineModule(
    def({
      agents: [
        {
          name: "tracker",
          schedule: "0 6 * * *",
          listens: ["dsar.requested"],
          onSchedule: (_t, ctx) => ({ used: moduleKeys(ctx).getOrThrow("AI_KEY").length }),
          onEvent: (_e, ctx) => moduleKeys(ctx).names(),
        },
      ],
    }),
  );

  it("the harness injects fake keys, and they stay out of the run's context, initial data and actor id", async () => {
    const harness = createAgentHarness(mod, { env: {}, keys: { AI_KEY: SHARED, CONSENT_API_KEY: OWN } });
    const run = await harness.tick("tracker", { scheduledAt: "2026-11-04T06:00:00Z" });
    expect(run.result).toEqual({ used: SHARED.length });
    const audit = JSON.stringify({ context: run.context, actor: actorId(run.context.principal), result: run.result });
    expect(leaks(audit)).toBe(false);
    expect(leaks(inspect(run.context as AgentContext, { depth: 10, showHidden: true }))).toBe(false);

    const ev = await harness.event("tracker", { type: "dsar.requested" }, { keys: { AI_KEY: "fake-ai-key-1" } });
    expect(ev.result).toEqual(["AI_KEY"]);
  });

  it("the harness rejects fake keys the manifest doesn't declare", async () => {
    expect(() => createAgentHarness(mod, { env: {}, keys: { OTHER_MODULE_KEY: OTHER } })).toThrow(/not declared/);
    const harness = createAgentHarness(mod, { env: {} });
    await expect(harness.tick("tracker", { keys: { CONSENT_API_KEYS: "typo-value-x" } })).rejects.toThrow(/not declared/);
  });
});

describe("withModuleKeys and moduleKeys", () => {
  it("lets a unit test call a handler directly with fake keys", () => {
    const ctx = withModuleKeys(createPlantContext(appCtx), createModuleKeys(requiredKeys, { AI_KEY: "fake-ai-key-1" }, { strict: true }));
    expect(moduleKeys(ctx).get("AI_KEY")).toBe("fake-ai-key-1");
  });

  it("throws for a context with no keys attached", () => {
    expect(() => moduleKeys(createPlantContext(appCtx))).toThrow(/no keys/);
  });

  it("drops non-string and empty values, and rejects them when strict", () => {
    const loose = createModuleKeys(requiredKeys, { AI_KEY: 42 as unknown as string, CONSENT_API_KEY: "" });
    expect(loose.names()).toEqual([]);
    expect(() => createModuleKeys(requiredKeys, { AI_KEY: "" }, { strict: true })).toThrow(/non-empty/);
  });
});

describe("the scrubber fails closed", () => {
  const keys = createModuleKeys(requiredKeys, { CONSENT_API_KEY: OWN, AI_KEY: SHARED });
  const deep = (v: unknown) => inspect(v, { depth: 20, showHidden: true });
  const R = "[redacted:CONSENT_API_KEY]";

  it("scrubs a repeated reference on every visit", () => {
    const obj = { token: OWN };
    const out = scrubKeyValues(keys, { a: obj, b: obj, list: [obj, obj] });
    expect(out).toEqual({ a: { token: R }, b: { token: R }, list: [{ token: R }, { token: R }] });
    expect(out.a).not.toBe(obj);
    expect(leaks(deep(out))).toBe(false);
  });

  it("scrubs a cycle and keeps its shape", () => {
    const obj: Record<string, unknown> = { token: OWN };
    obj.self = obj;
    const arr: unknown[] = [SHARED];
    arr.push(arr);
    const out = scrubKeyValues(keys, { obj, arr }) as { obj: Record<string, unknown>; arr: unknown[] };
    expect(out.obj.token).toBe(R);
    expect(out.obj.self).toBe(out.obj);
    expect(out.arr[0]).toBe("[redacted:AI_KEY]");
    expect(out.arr[1]).toBe(out.arr);
    expect(leaks(deep(out))).toBe(false);
  });

  it("scrubs Maps, Sets and class instances, and never passes them through", () => {
    class Holder {
      token = OWN;
      nested = { auth: `Bearer ${SHARED}` };
    }
    const map = new Map<unknown, unknown>([[OWN, { v: SHARED }], ["k", OWN]]);
    const set = new Set([OWN, SHARED, "plain"]);
    const holder = new Holder();
    const bytes = new TextEncoder().encode(OWN);
    const out = scrubKeyValues(keys, { map, set, holder, bytes, fn: () => OWN, at: new Date(0) });
    expect(out.map).not.toBe(map);
    expect(out.map).toEqual(new Map<unknown, unknown>([[R, { v: "[redacted:AI_KEY]" }], ["k", R]]));
    expect(out.set).toEqual(new Set([R, "[redacted:AI_KEY]", "plain"]));
    expect(out.holder).not.toBe(holder);
    expect(out.holder).toEqual({ token: R, nested: { auth: "Bearer [redacted:AI_KEY]" } });
    expect(out.bytes).toBe(UNSERIALIZABLE);
    expect(out.fn).toBe(UNSERIALIZABLE);
    expect(out.at).toEqual(new Date(0));
    expect(leaks(deep(out))).toBe(false);
  });

  it("throws a fresh Error with custom properties scrubbed", () => {
    const original = Object.assign(new Error(`bad ${OWN}`, { cause: { token: SHARED } }), {
      token: OWN,
      response: { headers: new Map([["authorization", `Bearer ${SHARED}`]]) },
    });
    original.name = "UpstreamError";
    const out = scrubError(keys, original) as Error & Record<string, unknown>;
    expect(out).not.toBe(original);
    expect(out).toBeInstanceOf(Error);
    expect(out.name).toBe("UpstreamError");
    expect(out.message).toBe(`bad ${R}`);
    expect(out.token).toBe(R);
    expect(out.cause).toEqual({ token: "[redacted:AI_KEY]" });
    expect(leaks(deep(out))).toBe(false);
    expect(leaks(String(out.stack))).toBe(false);
  });

  it("scrubs errors in a cycle and AggregateError members", () => {
    const inner = Object.assign(new Error("inner"), { secret: SHARED });
    const outer = new AggregateError([inner, OWN], `two failed ${OWN}`);
    (inner as Error & { cause?: unknown }).cause = outer;
    const out = scrubError(keys, outer) as AggregateError;
    expect(out).toBeInstanceOf(AggregateError);
    expect(out.errors[1]).toBe(R);
    expect((out.errors[0] as Error & { cause?: unknown }).cause).toBe(out);
    expect(leaks(deep(out))).toBe(false);
  });

  it("end to end: a handler error with a custom property holding a key comes out redacted", async () => {
    const mod = defineModule(
      def({
        handle: (_r, ctx) => {
          const shared = { key: moduleKeys(ctx).getOrThrow("CONSENT_API_KEY") };
          throw Object.assign(new Error("upstream failed"), { request: shared, again: shared });
        },
      }),
    );
    const err = (await new (moduleEntrypoint(mod))(execCtx, {})
      .handle(new Request("https://a.example.com/"), appCtx, routerKeys)
      .then(
        () => expect.unreachable("should throw"),
        (e: unknown) => e,
      )) as Error & Record<string, unknown>;
    expect(err.request).toEqual({ key: R });
    expect(err.again).toEqual({ key: R });
    expect(leaks(deep(err))).toBe(false);
  });
});
