import { describe, expect, it } from "vitest";
import { defineModule, isOptionalKey, ModuleDefinitionError, moduleState, normalizeRequiredKeys } from "../src/index.js";
import { baseDef } from "./fixtures.js";

describe("requiredKeys", () => {
  it("is left out of the manifest when a module declares none", () => {
    expect("requiredKeys" in defineModule(baseDef()).manifest).toBe(false);
    expect("requiredKeys" in defineModule(baseDef({ requiredKeys: [] })).manifest).toBe(false);
  });

  it("is copied into the manifest with shared and metered filled in", () => {
    const mod = defineModule(
      baseDef({
        requiredKeys: [
          { name: "SCRAPECREATORS_API_KEY", description: "ScrapeCreators API key", shared: true, metered: true },
          { name: "WEBHOOK_SECRET", description: "Signs webhooks" },
        ],
      }),
    );
    expect(mod.manifest.requiredKeys).toEqual([
      { name: "SCRAPECREATORS_API_KEY", description: "ScrapeCreators API key", shared: true, metered: true },
      { name: "WEBHOOK_SECRET", description: "Signs webhooks", shared: false, metered: false },
    ]);
    expect(Object.isFrozen(mod.manifest.requiredKeys)).toBe(true);
  });

  it.each([
    [[{ name: "lower_case", description: "x" }], /UPPER_SNAKE_CASE/],
    [[{ name: "1KEY", description: "x" }], /UPPER_SNAKE_CASE/],
    [[{ name: "KEY", description: " " }], /needs a description/],
    [[{ name: "KEY", description: "x", optional: "yes" as never }], /optional must be a boolean/],
    [
      [
        { name: "KEY", description: "x" },
        { name: "KEY", description: "y" },
      ],
      /duplicate required key "KEY"/,
    ],
  ])("rejects bad declarations (%#)", (requiredKeys, message) => {
    expect(() => defineModule(baseDef({ requiredKeys }))).toThrow(ModuleDefinitionError);
    expect(() => defineModule(baseDef({ requiredKeys }))).toThrow(message);
  });

  it("normalizeRequiredKeys does not keep unknown fields", () => {
    const [key] = normalizeRequiredKeys([{ name: "A", description: "a", value: "sk-secret" } as never]);
    expect(key).toEqual({ name: "A", description: "a", shared: false, metered: false });
  });
});

describe("optional keys", () => {
  it("keeps optional: true in the manifest and leaves it out otherwise", () => {
    const mod = defineModule(
      baseDef({
        requiredKeys: [
          { name: "MAIN_API_KEY", description: "Main key" },
          { name: "WEBHOOK_SECRET", description: "Signs webhooks", optional: true },
          { name: "OTHER_KEY", description: "Other", optional: false },
        ],
      }),
    );
    expect(mod.manifest.requiredKeys).toEqual([
      { name: "MAIN_API_KEY", description: "Main key", shared: false, metered: false },
      { name: "WEBHOOK_SECRET", description: "Signs webhooks", shared: false, metered: false, optional: true },
      { name: "OTHER_KEY", description: "Other", shared: false, metered: false },
    ]);
    expect("optional" in mod.manifest.requiredKeys![0]!).toBe(false);
    expect(isOptionalKey(mod.manifest.requiredKeys![1]!)).toBe(true);
    expect(isOptionalKey(mod.manifest.requiredKeys![2]!)).toBe(false);
  });

  it("moduleState never counts an unset optional key as missing", () => {
    expect(
      moduleState([
        { name: "A", set: true },
        { name: "B", set: false, optional: true },
      ]),
    ).toEqual({ state: "ready", missing: [] });
    expect(
      moduleState([
        { name: "A", set: false },
        { name: "B", set: false, optional: true },
      ]),
    ).toEqual({ state: "needs-setup", missing: ["A"] });
    expect(moduleState([])).toEqual({ state: "ready", missing: [] });
  });
});
