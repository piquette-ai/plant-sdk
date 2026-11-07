import { describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { defineMcpExtension, defineModule, moduleEntrypoint, PlantModule, type PlantContext } from "../src/index.js";
import { appCtx, baseDef, publicCtx } from "./fixtures.js";

type Env = { GREETING: string };
const env: Env = { GREETING: "hello" };
const execCtx = {} as ExecutionContext;

describe("moduleEntrypoint", () => {
  it("serves manifest() and handle() with a hydrated context and env", async () => {
    const seen: PlantContext[] = [];
    const mod = defineModule<Env>({
      ...baseDef(),
      handle: (req, ctx, e) => {
        seen.push(ctx);
        return new Response(`${e.GREETING} ${ctx.tenant.id} ${new URL(req.url).pathname}`);
      },
    });
    const Entry = moduleEntrypoint(mod);
    const worker = new Entry(execCtx, env);
    expect(worker).toBeInstanceOf(PlantModule);
    expect(Entry.name).toBe("PlantModule(consent)");
    expect(worker.manifest()).toBe(mod.manifest);

    const res = await worker.handle(new Request("https://acme.example.com/consent/receipts"), appCtx);
    expect(await res.text()).toBe("hello t_1 /consent/receipts");
    expect(seen[0]?.entitlements.has("consent.pro")).toBe(true);
  });

  it("leaves out optional RPC methods the module doesn't define", () => {
    const worker = new (moduleEntrypoint(defineModule(baseDef())))(execCtx, env);
    expect(worker.privacy).toBeUndefined();
    expect(worker.mcp).toBeUndefined();
    expect(worker.onEvent).toBeUndefined();
  });

  it("exposes privacy handlers over RPC", async () => {
    const del = vi.fn(async (_s: unknown, ctx: PlantContext, _env: unknown) => ({
      moduleId: "consent",
      tenantId: ctx.tenant.id,
      subjectHash: "x",
      subjectHashAlgorithm: "HMAC-SHA-256" as const,
      deleted: [],
      deletedAt: new Date(0).toISOString(),
    }));
    const mod = defineModule(
      baseDef({
        privacy: {
          find: async () => ({ records: [{ type: "consent.receipt", id: "r1" }] }),
          export: async () => ({ format: "json", records: [] }),
          delete: del,
          verify: async () => ({ clean: true, remaining: [], checkedAt: new Date(0).toISOString() }),
        },
      }),
    );
    const privacy = new (moduleEntrypoint(mod))(execCtx, env).privacy!();
    expect((await privacy.find({ email: "a@b.c" }, appCtx)).records).toHaveLength(1);
    expect((await privacy.delete({ email: "a@b.c" }, appCtx)).tenantId).toBe("t_1");
    expect(del.mock.calls[0]?.[2]).toBe(env);
    expect((await privacy.verify({ email: "a@b.c" }, appCtx)).clean).toBe(true);
    expect((await privacy.export({ email: "a@b.c" }, appCtx)).format).toBe("json");
  });

  it("serves the MCP descriptor and invokes tools over RPC", async () => {
    const mod = defineModule<Env>({
      ...baseDef(),
      mcp: defineMcpExtension<Env>()({
        tools: {
          list_receipts: {
            description: "List receipts",
            input: z.object({ q: z.number() }),
            run: async (input, ctx, e) => ({ input, surface: ctx.surface, greeting: e.GREETING }),
          },
          revoke: { description: "Revoke", input: z.object({}), write: true, run: async (_i, _c, _e, call) => call.draftId },
        },
      }),
    });
    const worker = new (moduleEntrypoint(mod))(execCtx, env);
    const descriptor = worker.mcp!();
    expect(descriptor).toBe(mod.handlers.mcp!.descriptor);
    expect(structuredClone(descriptor)).toEqual(descriptor);
    expect(descriptor.tools.map((t) => [t.name, t.write])).toEqual([
      ["list_receipts", false],
      ["revoke", true],
    ]);
    const mcpCtx = { ...appCtx, surface: "mcp" as const };
    expect(await worker.mcpInvoke!({ kind: "tool", name: "list_receipts", input: { q: 1 } }, mcpCtx)).toEqual({
      ok: true,
      kind: "tool",
      output: { input: { q: 1 }, surface: "mcp", greeting: "hello" },
    });
    expect(await worker.mcpInvoke!({ kind: "tool", name: "revoke", input: {}, draftId: "d_1" }, mcpCtx)).toEqual({
      ok: true,
      kind: "tool",
      output: "d_1",
    });
    expect(await worker.mcpInvoke!({ kind: "tool", name: "nope", input: {} }, mcpCtx)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("leaves out mcpInvoke without an MCP extension", () => {
    const worker = new (moduleEntrypoint(defineModule(baseDef())))(execCtx, env);
    expect(worker.mcpInvoke).toBeUndefined();
  });

  it("delivers only listened-for events", async () => {
    const onEvent = vi.fn();
    const mod = defineModule(baseDef({ events: { listens: ["dsar.requested"] }, onEvent }));
    const worker = new (moduleEntrypoint(mod))(execCtx, env);
    const event = {
      id: "e1",
      type: "dsar.requested",
      tenantId: "t_1",
      source: "dsar",
      occurredAt: new Date(0).toISOString(),
      data: {},
    };
    await worker.onEvent!(event, publicCtx);
    expect(onEvent).toHaveBeenCalledOnce();
    await expect(worker.onEvent!({ ...event, type: "ads.created" }, publicCtx)).rejects.toThrow(/does not listen/);
  });
});
