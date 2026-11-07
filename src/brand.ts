/**
 * Brand: the white-label surface of a plant.
 *
 * This file only defines shapes and the CSS variable contract. Storing brands
 * and resolving the layers (core defaults, then plant config, then parent
 * tenants, then the tenant itself, honouring locks) is the private core's job.
 *
 * plant-ui styles itself only through the `--plant-*` variables listed in
 * {@link PLANT_CSS_VARS}. There is no other styling surface: no free-form
 * tokens, no raw CSS.
 */

/**
 * The brand colours: five required, two optional. Values are CSS colours
 * (hex, rgb(), hsl(), oklch(), ...).
 */
export interface BrandColors {
  readonly primary: string;
  readonly accent: string;
  /** Page background. */
  readonly bg: string;
  /** Default text colour. */
  readonly fg: string;
  /** Secondary text, borders and quiet surfaces. */
  readonly muted: string;
  /**
   * Text and icons on a `primary` fill, e.g. filled buttons. Optional: when
   * absent, plant-ui falls back to `bg`. Core resolution fills it in with
   * whichever of `fg` and `bg` contrasts better with `primary`.
   */
  readonly onPrimary?: string;
  /**
   * Errors and destructive actions, e.g. invalid inputs. Optional: when
   * absent, plant-ui falls back to `fg`. Core resolution defaults it to a red
   * that is readable on `bg`.
   */
  readonly danger?: string;
}

/**
 * The resolved brand for a tenant. Every field except `font` is always
 * present, because core defaults fill the bottom layer. The optional colours
 * (`colors.onPrimary`, `colors.danger`) are filled in by core resolution too,
 * but a hand-built Brand may leave them out.
 */
export interface Brand {
  /** Display name, e.g. in the dashboard header and email footers. */
  readonly name: string;
  readonly logoUrl: string;
  readonly faviconUrl: string;
  readonly colors: BrandColors;
  /**
   * A CSS font-family list, e.g. `Inter, system-ui, sans-serif`. When absent,
   * plant-ui uses its own default stack.
   */
  readonly font?: string;
  readonly supportEmail: string;
  /** The display name on outgoing email, e.g. `Acme Support`. */
  readonly emailFromName: string;
  /** Whether to show "Powered by piquette". */
  readonly poweredBy: boolean;
}

/** Every top-level Brand field. */
export type BrandField = keyof Brand;

/** A single brand colour path, e.g. `colors.primary`. */
export type BrandColorPath = `colors.${keyof BrandColors}`;

/**
 * A path into {@link Brand} that a parent tenant can lock. `colors` locks
 * every colour; `colors.primary` locks just one.
 */
export type BrandFieldPath = BrandField | BrandColorPath;

/**
 * The fields a parent tenant locks for the tenants below it. A franchisor
 * that sets `["logoUrl", "colors", "poweredBy"]` keeps its logo, palette and
 * badge on every franchisee, while each franchisee still sets its own name,
 * support email and so on. Locks from several ancestors add up; core decides
 * how they combine when it resolves a brand.
 */
export type BrandLock = readonly BrandFieldPath[];

const REQUIRED_COLOR_KEYS = ["primary", "accent", "bg", "fg", "muted"] as const satisfies readonly (keyof BrandColors)[];
const OPTIONAL_COLOR_KEYS = ["onPrimary", "danger"] as const satisfies readonly (keyof BrandColors)[];
const COLOR_KEYS = [...REQUIRED_COLOR_KEYS, ...OPTIONAL_COLOR_KEYS] as const;

/** Every {@link BrandColors} key, required ones first, in a stable order. */
export const BRAND_COLOR_KEYS: readonly (keyof BrandColors)[] = Object.freeze([...COLOR_KEYS]);

/** Every valid {@link BrandFieldPath}, in a stable order. */
export const BRAND_FIELD_PATHS: readonly BrandFieldPath[] = Object.freeze([
  "name",
  "logoUrl",
  "faviconUrl",
  "colors",
  ...COLOR_KEYS.map((k) => `colors.${k}` as const),
  "font",
  "supportEmail",
  "emailFromName",
  "poweredBy",
]);

/** Whether `value` is a valid {@link BrandFieldPath} (for checking stored or untrusted locks). */
export function isBrandFieldPath(value: unknown): value is BrandFieldPath {
  return typeof value === "string" && (BRAND_FIELD_PATHS as readonly string[]).includes(value);
}

/**
 * Whether `lock` covers `path`: either the path itself is locked, or (for a
 * colour) the whole `colors` group is.
 */
export function brandLockCovers(lock: BrandLock, path: BrandFieldPath): boolean {
  if (lock.includes(path)) return true;
  return path.startsWith("colors.") && lock.includes("colors");
}

/**
 * The canonical CSS variable names. This is the complete styling surface of
 * a plant: plant-ui and modules read these and nothing else.
 */
export const PLANT_CSS_VARS = Object.freeze({
  primary: "--plant-primary",
  accent: "--plant-accent",
  bg: "--plant-bg",
  fg: "--plant-fg",
  muted: "--plant-muted",
  onPrimary: "--plant-on-primary",
  danger: "--plant-danger",
  font: "--plant-font",
} as const);

export type PlantCssVar = (typeof PLANT_CSS_VARS)[keyof typeof PLANT_CSS_VARS];

export interface ToCssVarsOptions {
  /** The rule's selector. Default `:root`. */
  readonly selector?: string;
}

// Brand values come from tenant config, so they are checked before they reach
// a stylesheet. None of these allow `;`, `{`, `}`, `<`, `>`, quotes or `\`,
// so a value cannot end its declaration, open a rule or close a <style> tag.
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC_COLOR = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([a-z0-9.,%+\-/\s]*\)$/i;
const NAMED_COLOR = /^[a-z]{3,20}$/i;
const FONT_NAME = /^[a-z0-9][a-z0-9 _-]*$/i;
const GENERIC_FONTS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);
const SELECTOR = /^[^{};<>\\]+$/;

function cssColor(key: keyof BrandColors, value: unknown): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (HEX_COLOR.test(v) || FUNC_COLOR.test(v) || NAMED_COLOR.test(v)) return v;
  throw new TypeError(`toCssVars: colors.${key} is not a valid CSS colour`);
}

function cssFontFamily(value: string): string {
  const families = value.split(",").map((part) => {
    const name = part.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    if (!FONT_NAME.test(name)) {
      throw new TypeError(`toCssVars: font has an invalid family name`);
    }
    return GENERIC_FONTS.has(name.toLowerCase()) ? name.toLowerCase() : `"${name}"`;
  });
  return families.join(", ");
}

/**
 * Render a brand as a CSS rule that sets the `--plant-*` variables. Throws a
 * TypeError if a colour or font isn't a plain, safe CSS value. `--plant-font`,
 * `--plant-on-primary` and `--plant-danger` are left out when the brand
 * doesn't set them, so plant-ui's fallbacks apply.
 */
export function toCssVars(brand: Brand, options: ToCssVarsOptions = {}): string {
  const selector = (options.selector ?? ":root").trim();
  if (!SELECTOR.test(selector)) {
    throw new TypeError("toCssVars: invalid selector");
  }
  const lines = REQUIRED_COLOR_KEYS.map((key) => `  ${PLANT_CSS_VARS[key]}: ${cssColor(key, brand.colors?.[key])};`);
  for (const key of OPTIONAL_COLOR_KEYS) {
    const value = brand.colors?.[key];
    if (value !== undefined) lines.push(`  ${PLANT_CSS_VARS[key]}: ${cssColor(key, value)};`);
  }
  if (brand.font !== undefined && brand.font.trim() !== "") {
    lines.push(`  ${PLANT_CSS_VARS.font}: ${cssFontFamily(brand.font)};`);
  }
  return `${selector} {\n${lines.join("\n")}\n}\n`;
}
