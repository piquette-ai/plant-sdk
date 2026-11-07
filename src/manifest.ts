/** ModuleManifest: what a module tells the plant about itself. */
import type { AgentManifestEntry } from "./agents.js";
import type { RequiredKey } from "./keys.js";
import type { RoleRule } from "./roles.js";

/**
 * A JSON Schema document (draft 2020-12). Kept loose on purpose: the SDK only
 * carries the schema; the plant validates settings against it.
 */
export interface JsonSchema {
  readonly $schema?: string;
  readonly type?: string | readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly [keyword: string]: unknown;
}

export interface NavItem {
  readonly label: string;
  /** Relative to the module's basePath; starts with "/". */
  readonly path: string;
  readonly icon?: string;
  /** Entitlement keys needed to show this item. */
  readonly requires?: readonly string[];
  readonly children?: readonly NavItem[];
}

export interface ModuleEvents {
  /** Event types this module emits, e.g. `consent.recorded`. */
  readonly emits: readonly string[];
  /** Event types this module wants delivered to `onEvent`. */
  readonly listens: readonly string[];
}

export interface ModuleManifest {
  /** Lowercase slug, e.g. `consent`. MCP tools are namespaced `<id>__<tool>`. */
  readonly id: string;
  readonly name: string;
  /** This module's own version (semver). */
  readonly version: string;
  /**
   * The semver range of the plant's core this module works with, e.g. `^0.1.0`.
   * The plant refuses to mount a module whose range its core doesn't satisfy
   * (the skew check from piquette-ai/engine#8).
   */
  readonly coreRange: string;
  readonly nav: readonly NavItem[];
  /** Path prefixes (relative to basePath) served without Cloudflare Access. */
  readonly publicPrefixes: readonly string[];
  /** Entitlement keys the module needs at all. */
  readonly requires: readonly string[];
  /** JSON Schema for this module's tenant settings. */
  readonly settings: JsonSchema;
  readonly events: ModuleEvents;
  /**
   * API keys the module needs before it can run (see {@link RequiredKey}).
   * Left out when there are none, so manifests from older modules still fit.
   */
  readonly requiredKeys?: readonly RequiredKey[];
  /**
   * The module's proactive agents: schedules and event listeners (see
   * agents.ts). Left out when there are none, like requiredKeys.
   */
  readonly agents?: readonly AgentManifestEntry[];
  /**
   * Minimum member roles for paths under basePath (see {@link RoleRule}).
   * The router enforces them on /app routes before calling the module.
   * Left out when there are none, like requiredKeys.
   */
  readonly roleRules?: readonly RoleRule[];
}
