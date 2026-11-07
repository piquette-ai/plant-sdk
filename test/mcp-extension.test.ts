import { describe, expect, it, vi } from "vitest";
import * as z from "zod";
import * as zm from "zod/mini";
import {
  createPlantContext,
  defineMcpExtension,
  defineModule,
  isMcpExtension,
  MCP_NAMESPACE_SEPARATOR,
  McpDefinitionError,
  mcpResourceUri,
  type McpInvocationResult,
} from "../src/index.js";
import { appCtx, baseDef } from "./fixtures.js";

const ctx = createPlantContext({ ...appCtx, surface: "mcp" });
const noEntitlements = createPlantContext({ ...appCtx, surface: "mcp", entitlements: [] });

function errorOf(result: McpInvocationResult) {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result)}`);
  return result.error;
}

describe("defineMcpExtension: schema conversion", () => {
  it("converts zod input and output schemas to JSON Schema", () => {
    const ext = defineMcpExtension({
      tools: {
        list_receipts: {
          title: "List receipts",
          description: "List consent receipts",
          input: z.object({
            limit: z.number().int().min(1).max(100).default(20).describe("Page size"),
            status: z.enum(["granted", "revoked"]).optional(),
          }),
          output: z.object({ receipts: z.array(z.object({ id: z.string() })) }),
          run: async () => ({ receipts: [] }),
        },
      },
    });
    const [tool] = ext.descriptor.tools;
    expect(tool?.inputSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Page size" },
        status: { type: "string", enum: ["granted", "revoked"] },
      },
    });
    // io: "input": a field with a default is optional for the caller.
    expect(tool?.inputSchema.required ?? []).not.toContain("limit");
    expect(tool?.outputSchema).toMatchObject({
      type: "object",
      properties: { receipts: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } } },
      required: ["receipts"],
    });
    expect(tool?.title).toBe("List receipts");
  });

  it("accepts zod/mini schemas", () => {
    const ext = defineMcpExtension({
      tools: { ping: { description: "Ping", input: zm.object({ n: zm.number() }), run: () => "pong" } },
    });
    expect(ext.descriptor.tools[0]?.inputSchema).toMatchObject({ type: "object", properties: { n: { type: "number" } } });
  });

  it("leaves outputSchema out when no output schema is given", () => {
    const ext = defineMcpExtension({ tools: { ping: { description: "Ping", input: z.object({}), run: () => 1 } } });
    expect(ext.descriptor.tools[0]).not.toHaveProperty("outputSchema");
  });

  it.each([
    ["a non-object input", { input: z.string() }, /input must be an object schema/],
    ["a non-object output", { input: z.object({}), output: z.array(z.string()) }, /output must be an object schema/],
    ["an unrepresentable input", { input: z.object({ at: z.date() }) }, /input can't be converted to JSON Schema/],
    [
      "an unrepresentable output",
      { input: z.object({}), output: z.object({ n: z.bigint() }) },
      /output can't be converted to JSON Schema/,
    ],
    ["a missing input", { input: undefined }, /needs an input schema/],
  ])("rejects %s", (_label, schemas, message) => {
    expect(() =>
      defineMcpExtension({ tools: { t: { description: "d", run: () => ({}), ...schemas } as never } }),
    ).toThrow(message);
  });

  it("produces a descriptor that survives structured clone (Workers RPC) and is frozen", () => {
    const ext = defineMcpExtension({
      tools: {
        create_banner: {
          description: "Create a banner",
          input: z.object({ text: z.string().max(200), tags: z.array(z.string()).default([]) }),
          output: z.object({ id: z.string() }),
          write: true,
          requires: "consent.pro",
          price: { amount: "0.01" },
          run: async () => ({ id: "b1" }),
        },
      },
      resources: { receipt: { uriTemplate: "receipts/{id}", mimeType: "application/json", read: () => "{}" } },
      prompts: { summarize: { arguments: { topic: { required: true } }, template: "Summarize {{topic}}" } },
    });
    const cloned = structuredClone(ext.descriptor);
    expect(cloned).toEqual(ext.descriptor);
    expect(JSON.parse(JSON.stringify(ext.descriptor))).toEqual(ext.descriptor);
    expect(Object.isFrozen(ext.descriptor)).toBe(true);
    expect(Object.isFrozen(ext.descriptor.tools[0]?.inputSchema)).toBe(true);
    expect(Object.isFrozen(ext)).toBe(true);
  });
});

describe("defineMcpExtension: naming rules", () => {
  const tool = { description: "d", input: z.object({}), run: () => 1 };

  it.each([
    ["list_receipts", true],
    ["a", true],
    ["a".repeat(61), true],
    ["a".repeat(62), false],
    ["consent.list", false],
    ["consent__list", false],
    ["list__", false],
    ["List", false],
    ["list-receipts", false],
    ["1list", false],
    ["_list", false],
    ["", false],
  ])("tool name %j valid: %s", (name, ok) => {
    const define = () => defineMcpExtension({ tools: { [name]: tool } });
    if (ok) expect(define).not.toThrow();
    else expect(define).toThrow(McpDefinitionError);
  });

  it("explains why a dot is not allowed", () => {
    expect(() => defineMcpExtension({ tools: { "consent.list": tool } })).toThrow(/must not contain "\."/);
    expect(() =>
      defineMcpExtension({ prompts: { "a.b": { template: "x" } } }),
    ).toThrow(/prompt name "a\.b" must not contain "\."/);
    expect(() =>
      defineMcpExtension({ resources: { "a.b": { uriTemplate: "x", read: () => "" } } }),
    ).toThrow(/resource name "a\.b" must not contain "\."/);
  });

  it("refuses the namespace separator \"__\" in names", () => {
    expect(() => defineMcpExtension({ tools: { consent__list: tool } })).toThrow(/must not contain "__"/);
    expect(() => defineMcpExtension({ tools: { a__: tool } })).toThrow(/must not contain "__"/);
    expect(() =>
      defineMcpExtension({ prompts: { a__b: { template: "x" } } }),
    ).toThrow(/prompt name "a__b" must not contain "__"/);
    expect(() =>
      defineMcpExtension({ resources: { a__b: { uriTemplate: "x", read: () => "" } } }),
    ).toThrow(/resource name "a__b" must not contain "__"/);
    expect(() => defineMcpExtension({ tools: { list_all_receipts: tool } })).not.toThrow();
  });

  it("the longest name fits the 64-character wire-name limit with a one-letter module id", () => {
    const longest = "a".repeat(61);
    expect(() => defineMcpExtension({ tools: { [longest]: tool } })).not.toThrow();
    expect(() => defineMcpExtension({ tools: { ["a".repeat(62)]: tool } })).toThrow(/at most 61 characters/);
    expect(`m${MCP_NAMESPACE_SEPARATOR}${longest}`).toHaveLength(64);
  });

  it("requires a description and a run function", () => {
    expect(() => defineMcpExtension({ tools: { t: { ...tool, description: " " } } })).toThrow(/needs a description/);
    expect(() => defineMcpExtension({ tools: { t: { ...tool, run: undefined as never } } })).toThrow(/needs run/);
  });
});

describe("defineMcpExtension: write, requires and price metadata", () => {
  const input = z.object({});

  it("defaults write to false and omits requires and price when not set", () => {
    const ext = defineMcpExtension({ tools: { t: { description: "d", input, run: () => 1 } } });
    expect(ext.descriptor.tools[0]).toEqual({
      name: "t",
      description: "d",
      inputSchema: expect.any(Object),
      write: false,
    });
  });

  it("records write, requires and price, defaulting the currency to USD", () => {
    const ext = defineMcpExtension({
      tools: {
        revoke: {
          description: "Revoke",
          input,
          write: true,
          requires: "consent.pro",
          price: { amount: "0.005" },
          run: () => 1,
        },
      },
    });
    expect(ext.descriptor.tools[0]).toMatchObject({
      write: true,
      requires: "consent.pro",
      price: { amount: "0.005", currency: "USD" },
    });
  });

  it.each([
    ["a zero price", { price: { amount: "0" } }, /positive decimal/],
    ["a negative price", { price: { amount: "-1" } }, /positive decimal/],
    ["a numeric price", { price: { amount: 0.01 as never } }, /positive decimal/],
    ["a dollar-sign price", { price: { amount: "$0.01" } }, /positive decimal/],
    ["a non-USD price", { price: { amount: "1", currency: "EUR" as never } }, /currency must be "USD"/],
    ["a non-boolean write", { write: "yes" as never }, /write must be a boolean/],
    ["a bad entitlement key", { requires: "Consent Pro" }, /not an entitlement key/],
  ])("rejects %s", (_label, extra, message) => {
    expect(() => defineMcpExtension({ tools: { t: { description: "d", input, run: () => 1, ...extra } } })).toThrow(
      message,
    );
  });

  it("refuses a write tool call without an approved draft and passes the draft id to run", async () => {
    const run = vi.fn(async (_i: unknown, _c: unknown, _e: unknown, call: { draftId?: string }) => ({ id: call.draftId }));
    const ext = defineMcpExtension({ tools: { revoke: { description: "Revoke", input, write: true, run } } });
    expect(errorOf(await ext.invoke({ kind: "tool", name: "revoke", input: {} }, ctx, {})).code).toBe("draft_required");
    expect(errorOf(await ext.invoke({ kind: "tool", name: "revoke", input: {}, draftId: "" }, ctx, {})).code).toBe(
      "draft_required",
    );
    expect(run).not.toHaveBeenCalled();
    expect(await ext.invoke({ kind: "tool", name: "revoke", input: {}, draftId: "d_1" }, ctx, {})).toEqual({
      ok: true,
      kind: "tool",
      output: { id: "d_1" },
    });
  });

  it("does not pass a draft id to read tools", async () => {
    const ext = defineMcpExtension({ tools: { t: { description: "d", input, run: (_i, _c, _e, call) => call } } });
    expect(await ext.invoke({ kind: "tool", name: "t", input: {}, draftId: "d_1" }, ctx, {})).toMatchObject({
      output: {},
    });
  });

  it("checks the tool's entitlement before running it", async () => {
    const run = vi.fn(() => 1);
    const ext = defineMcpExtension({ tools: { t: { description: "d", input, requires: "consent.pro", run } } });
    const err = errorOf(await ext.invoke({ kind: "tool", name: "t", input: {} }, noEntitlements, {}));
    expect(err).toEqual({ code: "forbidden", message: 'tool "t" requires entitlement "consent.pro"' });
    expect(run).not.toHaveBeenCalled();
    expect(await ext.invoke({ kind: "tool", name: "t", input: {} }, ctx, {})).toMatchObject({ ok: true });
  });
});

describe("defineMcpExtension: invoking tools", () => {
  const ext = defineMcpExtension<{ PREFIX: string }>()({
    tools: {
      greet: {
        description: "Greet",
        input: z.object({ name: z.string().min(1), times: z.number().int().default(1) }),
        output: z.object({ text: z.string() }),
        run: ({ name, times }, c, env) => ({ text: `${env.PREFIX} ${name} x${times} @${c.tenant.id}` }),
      },
      broken: {
        description: "Returns the wrong shape",
        input: z.object({}),
        output: z.object({ n: z.number() }),
        run: () => ({ n: "nope" }) as never,
      },
      boom: { description: "Throws", input: z.object({}), run: () => Promise.reject(new Error("boom")) },
    },
  });
  const env = { PREFIX: "hi" };

  it("parses input (applying defaults) and validates output", async () => {
    expect(await ext.invoke({ kind: "tool", name: "greet", input: { name: "Ada" } }, ctx, env)).toEqual({
      ok: true,
      kind: "tool",
      output: { text: "hi Ada x1 @t_1" },
    });
  });

  it("returns invalid_input with serializable issues", async () => {
    const result = await ext.invoke({ kind: "tool", name: "greet", input: { name: "", times: 1.5 } }, ctx, env);
    const err = errorOf(result);
    expect(err.code).toBe("invalid_input");
    expect(err.issues?.map((i) => i.path)).toEqual([["name"], ["times"]]);
    expect(structuredClone(result)).toEqual(result);
  });

  it("returns invalid_output when run breaks its output schema", async () => {
    const err = errorOf(await ext.invoke({ kind: "tool", name: "broken", input: {} }, ctx, env));
    expect(err.code).toBe("invalid_output");
    expect(err.issues?.[0]?.path).toEqual(["n"]);
  });

  it("returns not_found for unknown tools, including prototype keys", async () => {
    for (const name of ["nope", "__proto__", "constructor", "toString"]) {
      expect(errorOf(await ext.invoke({ kind: "tool", name, input: {} }, ctx, env)).code).toBe("not_found");
    }
    expect(errorOf(await ext.invoke({ kind: "bogus" } as never, ctx, env)).code).toBe("not_found");
  });

  it("lets exceptions from run propagate", async () => {
    await expect(ext.invoke({ kind: "tool", name: "boom", input: {} }, ctx, env)).rejects.toThrow("boom");
  });
});

describe("defineMcpExtension: resources", () => {
  const read = vi.fn((uri: string, params: Readonly<Record<string, string>>) => JSON.stringify({ uri, params }));
  const ext = defineMcpExtension({
    resources: {
      receipt: { uriTemplate: "receipts/{id}", mimeType: "application/json", read },
      policy: {
        title: "Policy",
        description: "The tenant's policy",
        uriTemplate: "policy",
        requires: "consent.pro",
        read: () => [{ text: "# Policy", mimeType: "text/markdown" }, { blob: "AAEC" }],
      },
      version: { uriTemplate: "receipts/{id}/versions/{version}", read: () => "v" },
    },
  });

  it("describes resources with module-relative URI templates", () => {
    expect(ext.descriptor.resources).toEqual([
      { name: "receipt", uriTemplate: "receipts/{id}", mimeType: "application/json" },
      { name: "policy", title: "Policy", description: "The tenant's policy", uriTemplate: "policy", requires: "consent.pro" },
      { name: "version", uriTemplate: "receipts/{id}/versions/{version}" },
    ]);
    expect(mcpResourceUri("consent", "receipts/{id}")).toBe("plant://consent/receipts/{id}");
  });

  it("matches a URI, decodes its params and fills in uri and mimeType", async () => {
    const result = await ext.invoke({ kind: "resource", uri: "receipts/r%201" }, ctx, {});
    expect(result).toEqual({
      ok: true,
      kind: "resource",
      contents: [
        {
          uri: "receipts/r%201",
          mimeType: "application/json",
          text: JSON.stringify({ uri: "receipts/r%201", params: { id: "r 1" } }),
        },
      ],
    });
    expect(await ext.invoke({ kind: "resource", uri: "receipts/r1/versions/3" }, ctx, {})).toMatchObject({
      contents: [{ text: "v" }],
    });
  });

  it("supports several contents, blobs and entitlements", async () => {
    expect(errorOf(await ext.invoke({ kind: "resource", uri: "policy" }, noEntitlements, {})).code).toBe("forbidden");
    expect(await ext.invoke({ kind: "resource", uri: "policy" }, ctx, {})).toEqual({
      ok: true,
      kind: "resource",
      contents: [
        { uri: "policy", mimeType: "text/markdown", text: "# Policy" },
        { uri: "policy", blob: "AAEC" },
      ],
    });
  });

  it.each(["receipts", "receipts/a/b", "plant://consent/receipts/1", "/receipts/1", "receipts/..", "../x", "receipts/%E0%A4%A"])(
    "returns not_found for %j",
    async (uri) => {
      expect(errorOf(await ext.invoke({ kind: "resource", uri }, ctx, {})).code).toBe("not_found");
    },
  );

  it.each([
    ["an encoded slash", "receipts/a%2Fb"],
    ["an encoded traversal", "receipts/%2E%2E"],
    ["an encoded traversal with a slash", "receipts/%2E%2E%2Fsecrets"],
    ["an encoded dot", "receipts/%2e"],
    ["an encoded backslash", "receipts/a%5Cb"],
    ["an encoded NUL", "receipts/a%00"],
    ["an encoded control character", "receipts/a%0Ab"],
    ["an encoded DEL", "receipts/a%7F"],
    ["a malformed escape", "receipts/%E0%A4%A"],
    ["a lone percent", "receipts/%"],
    ["an empty segment", "receipts/"],
    ["an empty segment in the middle", "receipts//versions/1"],
    ["an encoded slash in a later param", "receipts/r1/versions/1%2F2"],
  ])("rejects a param with %s as not_found, without calling read", async (_label, uri) => {
    read.mockClear();
    expect(errorOf(await ext.invoke({ kind: "resource", uri }, ctx, {})).code).toBe("not_found");
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["r_1", "r_1"],
    ["r-1.json", "r-1.json"],
    ["a%20b", "a b"],
    ["caf%C3%A9", "café"],
    ["%E2%9C%93", "✓"],
    ["日本", "日本"],
    ["...", "..."],
    [".hidden", ".hidden"],
  ])("decodes an ordinary param %j to %j", async (segment, decoded) => {
    read.mockClear();
    expect(await ext.invoke({ kind: "resource", uri: `receipts/${segment}` }, ctx, {})).toMatchObject({ ok: true });
    expect(read.mock.calls[0]?.[1]).toEqual({ id: decoded });
    expect(Object.isFrozen(read.mock.calls[0]?.[1])).toBe(true);
  });

  it.each([
    ["a scheme", "plant://consent/x", /no scheme/],
    ["a leading slash", "/x", /must not start/],
    ["a dot-dot segment", "a/../b", /segments/],
    ["a query", "a?b", /must not contain/],
    ["an operator expression", "a/{+path}", /simple \{name\}/],
    ["an unmatched brace", "a/{id", /unmatched/],
    ["a repeated var", "{id}/{id}", /repeats/],
  ])("rejects a template with %s", (_label, uriTemplate, message) => {
    expect(() => defineMcpExtension({ resources: { r: { uriTemplate, read: () => "" } } })).toThrow(message);
  });

  it("rejects overlapping templates", () => {
    expect(() =>
      defineMcpExtension({
        resources: { a: { uriTemplate: "r/{id}", read: () => "" }, b: { uriTemplate: "r/{key}", read: () => "" } },
      }),
    ).toThrow(/overlaps resource "a"/);
  });
});

describe("defineMcpExtension: prompts", () => {
  const ext = defineMcpExtension({
    prompts: {
      summarize: {
        description: "Summarize receipts",
        arguments: { topic: { description: "What to summarize", required: true }, tone: {} },
        template: "Summarize {{ topic }} in a {{tone}} tone.",
      },
      review: {
        render: (args, c) => [
          { role: "user", content: { type: "text", text: `Review for ${c.tenant.id}` } },
          { role: "assistant", content: { type: "text", text: args.note ?? "ok" } },
        ],
        arguments: { note: {} },
        requires: "consent.pro",
      },
    },
  });

  it("describes prompts with their arguments", () => {
    expect(ext.descriptor.prompts).toEqual([
      {
        name: "summarize",
        description: "Summarize receipts",
        arguments: [
          { name: "topic", description: "What to summarize", required: true },
          { name: "tone", required: false },
        ],
      },
      { name: "review", arguments: [{ name: "note", required: false }], requires: "consent.pro" },
    ]);
  });

  it("renders a template into one user message", async () => {
    expect(
      await ext.invoke({ kind: "prompt", name: "summarize", arguments: { topic: "Q3", tone: "dry" } }, ctx, {}),
    ).toEqual({
      ok: true,
      kind: "prompt",
      description: "Summarize receipts",
      messages: [{ role: "user", content: { type: "text", text: "Summarize Q3 in a dry tone." } }],
    });
  });

  it("calls render with the context", async () => {
    expect(await ext.invoke({ kind: "prompt", name: "review" }, ctx, {})).toMatchObject({
      messages: [{ content: { text: "Review for t_1" } }, { role: "assistant", content: { text: "ok" } }],
    });
    expect(errorOf(await ext.invoke({ kind: "prompt", name: "review" }, noEntitlements, {})).code).toBe("forbidden");
  });

  it("validates arguments", async () => {
    const missing = errorOf(await ext.invoke({ kind: "prompt", name: "summarize" }, ctx, {}));
    expect(missing).toMatchObject({ code: "invalid_input", issues: [{ path: ["topic"], message: "required" }] });
    const extra = errorOf(
      await ext.invoke({ kind: "prompt", name: "summarize", arguments: { topic: "x", other: "y" } }, ctx, {}),
    );
    expect(extra.issues).toEqual([{ path: ["other"], message: "unknown argument" }]);
    const nonString = errorOf(
      await ext.invoke({ kind: "prompt", name: "summarize", arguments: { topic: 1 as never } }, ctx, {}),
    );
    expect(nonString.issues).toEqual([{ path: ["topic"], message: "must be a string" }]);
    expect(errorOf(await ext.invoke({ kind: "prompt", name: "nope" }, ctx, {})).code).toBe("not_found");
  });

  it.each([
    ["no template or render", {}, /exactly one of template or render/],
    ["both template and render", { template: "x", render: () => "x" }, /exactly one/],
    ["an undeclared placeholder", { template: "Hi {{name}}" }, /undeclared \{\{name\}\}/],
    ["a bad argument name", { template: "x", arguments: { "a-b": {} } }, /must be an identifier/],
  ])("rejects a prompt with %s", (_label, prompt, message) => {
    expect(() => defineMcpExtension({ prompts: { p: prompt as never } })).toThrow(message);
  });
});

describe("defineModule integration", () => {
  it("accepts an extension from defineMcpExtension and rejects anything else", () => {
    const mcp = defineMcpExtension({});
    expect(isMcpExtension(mcp)).toBe(true);
    expect(isMcpExtension({ ...mcp })).toBe(false);
    expect(mcp.descriptor).toEqual({ tools: [], resources: [], prompts: [] });
    expect(defineModule(baseDef({ mcp })).handlers.mcp).toBe(mcp);
    expect(() => defineModule(baseDef({ mcp: { ...mcp } }))).toThrow(/defineMcpExtension/);
  });
});
