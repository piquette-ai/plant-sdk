import { describe, expect, it } from "vitest";
import * as z from "zod";
import { defineMcpExtension, defineModule, ModuleDefinitionError, type PrivacyHandlers } from "../src/index.js";
import { baseDef } from "./fixtures.js";

describe("defineModule", () => {
  it("fills defaults and returns a frozen manifest plus handlers", () => {
    const def = baseDef();
    const mod = defineModule(def);
    expect(mod.manifest).toEqual({
      id: "consent",
      name: "Consent",
      version: "0.1.0",
      coreRange: "^0.1.0",
      nav: [],
      publicPrefixes: [],
      requires: [],
      settings: { type: "object", properties: {}, additionalProperties: false },
      events: { emits: [], listens: [] },
    });
    expect(mod.handlers.handle).toBe(def.handle);
    expect(mod.handlers.privacy).toBeUndefined();
    expect(Object.isFrozen(mod.manifest)).toBe(true);
    expect(Object.isFrozen(mod.manifest.events.emits)).toBe(true);
  });

  it("copies the manifest so later edits to the input don't leak in", () => {
    const nav = [{ label: "Receipts", path: "/receipts" }];
    const mod = defineModule(baseDef({ nav }));
    nav.push({ label: "Extra", path: "/extra" });
    expect(mod.manifest.nav).toHaveLength(1);
  });

  it("keeps a full declaration", () => {
    const privacy: PrivacyHandlers = {
      find: async () => ({ records: [] }),
      export: async () => ({ format: "json", records: [] }),
      delete: async () => {
        throw new Error("unused");
      },
      verify: async () => ({ clean: true, remaining: [], checkedAt: new Date(0).toISOString() }),
    };
    const mod = defineModule(
      baseDef({
        nav: [{ label: "Consent", path: "/", children: [{ label: "Receipts", path: "/receipts" }] }],
        publicPrefixes: ["/api/consent", "/banner.js"],
        requires: ["consent.basic"],
        settings: { type: "object", properties: { region: { type: "string" } } },
        events: { emits: ["consent.recorded"], listens: ["dsar.requested"] },
        onEvent: () => {},
        privacy,
        mcp: defineMcpExtension({
          tools: { list_receipts: { description: "List receipts", input: z.object({}), run: async () => [] } },
        }),
      }),
    );
    expect(mod.manifest.events.listens).toEqual(["dsar.requested"]);
    expect(mod.handlers.privacy).toBe(privacy);
    expect(mod.handlers.mcp?.descriptor.tools).toHaveLength(1);
  });

  const bad: [string, Parameters<typeof baseDef>[0], RegExp][] = [
    ["uppercase id", { id: "Consent" }, /lowercase slug/],
    ["dotted id", { id: "con.sent" }, /lowercase slug/],
    ["empty name", { name: " " }, /name/],
    ["non-semver version", { version: "1.0" }, /not semver/],
    ["empty coreRange", { coreRange: "" }, /coreRange/],
    ["junk coreRange", { coreRange: "latest" }, /coreRange/],
    ["missing handle", { handle: undefined as never }, /handle/],
    ["nav path without slash", { nav: [{ label: "X", path: "x" }] }, /must start with/],
    ["nested nav path", { nav: [{ label: "X", path: "/", children: [{ label: "Y", path: "y" }] }] }, /must start with/],
    ["publicPrefix without slash", { publicPrefixes: ["api"] }, /must start with/],
    ["duplicate publicPrefix", { publicPrefixes: ["/a", "/a"] }, /duplicate/],
    ["duplicate entitlement", { requires: ["a.b", "a.b"] }, /duplicate/],
    ["bad event type", { events: { emits: ["recorded"] } }, /event type/],
    ["foreign emitted event", { events: { emits: ["ads.created"] } }, /namespaced/],
    ["listens without onEvent", { events: { listens: ["dsar.requested"] } }, /onEvent/],
    ["partial privacy", { privacy: { find: async () => ({ records: [] }) } as never }, /privacy\.export/],
    [
      "hand-written mcp object",
      { mcp: { tools: [{ name: "a", description: "d", inputSchema: {}, handler: async () => 1 }] } as never },
      /defineMcpExtension/,
    ],
  ];

  it.each(bad)("rejects %s", (_label, overrides, message) => {
    expect(() => defineModule(baseDef(overrides))).toThrow(ModuleDefinitionError);
    expect(() => defineModule(baseDef(overrides))).toThrow(message);
  });

  it("refuses MCP tools and prompts whose <moduleId>__<name> is over 64 characters", () => {
    const tool = { description: "d", input: z.object({}), run: () => 1 };
    // "consent" (7) + "__" (2) + 55 = 64: fits.
    const fits = defineMcpExtension({ tools: { ["t".repeat(55)]: tool } });
    expect(() => defineModule(baseDef({ mcp: fits }))).not.toThrow();
    const tooLong = defineMcpExtension({ tools: { ["t".repeat(56)]: tool } });
    expect(() => defineModule(baseDef({ mcp: tooLong }))).toThrow(/MCP tool "consent__t+" is longer than 64 characters/);
    const longPrompt = defineMcpExtension({ prompts: { ["p".repeat(56)]: { template: "x" } } });
    expect(() => defineModule(baseDef({ mcp: longPrompt }))).toThrow(/MCP prompt/);
    // Resource names are never part of a wire name.
    const longResource = defineMcpExtension({ resources: { ["r".repeat(61)]: { uriTemplate: "x", read: () => "" } } });
    expect(() => defineModule(baseDef({ mcp: longResource }))).not.toThrow();
  });

  it("accepts common semver ranges", () => {
    for (const coreRange of ["^0.1.0", "~1.2.3", ">=0.1.0 <0.3.0", "0.1.x", "1.2.3 - 1.4.0", "^1.0.0 || ^2.0.0", "0.2.0-next.1"]) {
      expect(defineModule(baseDef({ coreRange })).manifest.coreRange).toBe(coreRange);
    }
  });
});
