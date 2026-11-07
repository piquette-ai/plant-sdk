import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";
import {
  BRAND_FIELD_PATHS,
  brandLockCovers,
  isBrandFieldPath,
  PLANT_CSS_VARS,
  toCssVars,
  type Brand,
  type BrandLock,
} from "../src/index.js";
import { brand } from "./fixtures.js";

describe("toCssVars", () => {
  it("renders every --plant-* variable", () => {
    expect(toCssVars(brand)).toMatchInlineSnapshot(`
      ":root {
        --plant-primary: #0b5fff;
        --plant-accent: #ff7a00;
        --plant-bg: #ffffff;
        --plant-fg: #111827;
        --plant-muted: #6b7280;
        --plant-font: "Inter", system-ui, sans-serif;
      }
      "
    `);
  });

  it("leaves out --plant-font when the brand has no font, and takes a selector", () => {
    const { font: _font, ...noFont } = brand;
    expect(toCssVars(noFont, { selector: '[data-tenant="t_1"]' })).toMatchInlineSnapshot(`
      "[data-tenant="t_1"] {
        --plant-primary: #0b5fff;
        --plant-accent: #ff7a00;
        --plant-bg: #ffffff;
        --plant-fg: #111827;
        --plant-muted: #6b7280;
      }
      "
    `);
  });

  it("accepts functional and named colours and quoted font names", () => {
    const css = toCssVars({
      ...brand,
      colors: { primary: "oklch(62% 0.2 255)", accent: "rgb(255 122 0 / 90%)", bg: "white", fg: "#000", muted: "hsl(220 9% 46%)" },
      font: `'IBM Plex Sans', "Helvetica Neue", Sans-Serif`,
    });
    expect(css).toContain("--plant-primary: oklch(62% 0.2 255);");
    expect(css).toContain("--plant-accent: rgb(255 122 0 / 90%);");
    expect(css).toContain(`--plant-font: "IBM Plex Sans", "Helvetica Neue", sans-serif;`);
  });

  it("renders --plant-on-primary and --plant-danger when the brand sets them", () => {
    const css = toCssVars({ ...brand, colors: { ...brand.colors, onPrimary: "#ffffff", danger: "rgb(185 28 28)" } });
    expect(css).toContain("  --plant-muted: #6b7280;\n  --plant-on-primary: #ffffff;\n  --plant-danger: rgb(185 28 28);\n  --plant-font:");
    // Brands from before these colours existed render exactly as they did.
    expect(toCssVars(brand)).not.toMatch(/on-primary|danger/);
  });

  it("emits only the canonical variables: no other styling surface", () => {
    const extra = {
      ...brand,
      colors: { ...brand.colors, onPrimary: "#fff", danger: "#b91c1c" },
      tokens: { "color-primary": "red" },
      css: "body{display:none}",
    } as Brand;
    const names = [...toCssVars(extra).matchAll(/(--[a-z-]+):/g)].map((m) => m[1]);
    expect(names).toEqual(Object.values(PLANT_CSS_VARS));
    expect(PLANT_CSS_VARS).toMatchInlineSnapshot(`
      {
        "accent": "--plant-accent",
        "bg": "--plant-bg",
        "danger": "--plant-danger",
        "fg": "--plant-fg",
        "font": "--plant-font",
        "muted": "--plant-muted",
        "onPrimary": "--plant-on-primary",
        "primary": "--plant-primary",
      }
    `);
    expect(Object.isFrozen(PLANT_CSS_VARS)).toBe(true);
  });

  it("rejects values that could break out of the declaration", () => {
    const bad = (colors: Partial<Brand["colors"]>) => () => toCssVars({ ...brand, colors: { ...brand.colors, ...colors } });
    expect(bad({ primary: "red; } body { display: none" })).toThrow(/colors.primary/);
    expect(bad({ bg: "</style><script>alert(1)</script>" })).toThrow(/colors.bg/);
    expect(bad({ fg: "url(https://evil.example/x)" })).toThrow(/colors.fg/);
    expect(bad({ muted: "var(--other)" })).toThrow(/colors.muted/);
    expect(bad({ accent: "" })).toThrow(/colors.accent/);
    expect(bad({ onPrimary: "red; } body { display: none" })).toThrow(/colors.onPrimary/);
    expect(bad({ danger: "url(https://evil.example/x)" })).toThrow(/colors.danger/);
    expect(() => toCssVars({ ...brand, font: `Inter"; } * { color: red` })).toThrow(/font/);
    expect(() => toCssVars({ ...brand, font: "Inter, , serif" })).toThrow(/font/);
    expect(() => toCssVars(brand, { selector: ":root{}body" })).toThrow(/selector/);
  });
});

describe("BrandLock", () => {
  it("lists every lockable path", () => {
    expect(BRAND_FIELD_PATHS).toMatchInlineSnapshot(`
      [
        "name",
        "logoUrl",
        "faviconUrl",
        "colors",
        "colors.primary",
        "colors.accent",
        "colors.bg",
        "colors.fg",
        "colors.muted",
        "colors.onPrimary",
        "colors.danger",
        "font",
        "supportEmail",
        "emailFromName",
        "poweredBy",
      ]
    `);
    expect(isBrandFieldPath("colors.primary")).toBe(true);
    expect(isBrandFieldPath("tokens")).toBe(false);
    expect(isBrandFieldPath(42)).toBe(false);
  });

  it("expresses a franchisor's locks for its franchisees", () => {
    // The franchisor keeps its logo, palette and badge; each franchisee sets
    // its own name and support contact.
    const franchisor: BrandLock = ["logoUrl", "faviconUrl", "colors", "poweredBy"];
    expect(brandLockCovers(franchisor, "colors.primary")).toBe(true);
    expect(brandLockCovers(franchisor, "poweredBy")).toBe(true);
    expect(brandLockCovers(franchisor, "name")).toBe(false);
    expect(brandLockCovers(franchisor, "supportEmail")).toBe(false);

    const accentOnly: BrandLock = ["colors.accent"];
    expect(brandLockCovers(accentOnly, "colors.accent")).toBe(true);
    expect(brandLockCovers(accentOnly, "colors.primary")).toBe(false);
    expect(brandLockCovers(accentOnly, "colors")).toBe(false);
    // The optional colours lock with the rest of the palette.
    expect(brandLockCovers(franchisor, "colors.onPrimary")).toBe(true);
    expect(brandLockCovers(franchisor, "colors.danger")).toBe(true);
  });
});

describe("exports", () => {
  it("exposes the brand runtime API from the package entry", () => {
    expect(typeof sdk.toCssVars).toBe("function");
    expect(typeof sdk.brandLockCovers).toBe("function");
    expect(sdk.PLANT_CSS_VARS.primary).toBe("--plant-primary");
    expect(sdk.BRAND_COLOR_KEYS).toEqual(["primary", "accent", "bg", "fg", "muted", "onPrimary", "danger"]);
  });
});
