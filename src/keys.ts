/**
 * Required keys: the API keys and secrets a module needs before it can run.
 *
 * A module declares them in its manifest. The plant stores the values (never
 * the SDK) and reports a module whose required keys are missing as
 * `needs-setup`: the router serves a setup page instead of the module and
 * hides its MCP tools until the keys are set. Nothing in this file carries a
 * key value.
 *
 * A key marked `optional` is declared the same way (it shows on the plant's
 * Keys page and is delivered through `moduleKeys(ctx)` once set) but never
 * puts the module in `needs-setup`. Use it for a key only one feature needs;
 * that feature checks `moduleKeys(ctx).get(name)`, which is `undefined`
 * while the key is unset.
 */

export interface RequiredKey {
  /** UPPER_SNAKE_CASE, e.g. `SCRAPECREATORS_API_KEY`. */
  readonly name: string;
  /** Shown on the setup page: what the key is and where to get one. */
  readonly description: string;
  /**
   * Set once at the plant level and handed to every module that declares
   * the same name (an AI key, for example). Defaults to false: the key
   * belongs to this module alone.
   */
  readonly shared?: boolean;
  /** Spending on this key is tracked by the plant's usage caps. */
  readonly metered?: boolean;
  /**
   * The module runs without this key: an unset optional key is not
   * `missing` and never makes the module `needs-setup`. It is still listed
   * in key status and delivered when set. Defaults to false.
   */
  readonly optional?: boolean;
}

/** Whether a module can be served. */
export type ModuleState = "ready" | "needs-setup";

/** The status of one required key. Never includes its value. */
export interface KeyStatus {
  readonly name: string;
  readonly description: string;
  readonly shared: boolean;
  readonly metered: boolean;
  /**
   * True for an optional key (see {@link RequiredKey.optional}). Core and the
   * harness always fill it in; it is typed optional only so status objects
   * built before it existed still type-check.
   */
  readonly optional?: boolean;
  readonly set: boolean;
  /** ISO 8601 time the value was last set, when it is set. */
  readonly updatedAt?: string;
}

/** What `keyStatus(moduleId)` returns. */
export interface ModuleKeyStatus {
  readonly moduleId: string;
  readonly state: ModuleState;
  readonly keys: readonly KeyStatus[];
  /**
   * Names of required (not optional) keys that are not set. Empty when
   * `state` is `ready`.
   */
  readonly missing: readonly string[];
}

export const KEY_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

/**
 * Check a module's required keys and return a normalized copy (`shared` and
 * `metered` filled in; `optional: true` kept, and left out otherwise so a
 * manifest without optional keys is unchanged). Throws a TypeError naming
 * the problem.
 */
export function normalizeRequiredKeys(keys: readonly RequiredKey[]): RequiredKey[] {
  const seen = new Set<string>();
  return keys.map((key) => {
    if (typeof key?.name !== "string" || !KEY_NAME.test(key.name)) {
      throw new TypeError(`required key "${String(key?.name)}" must be UPPER_SNAKE_CASE`);
    }
    if (seen.has(key.name)) throw new TypeError(`duplicate required key "${key.name}"`);
    seen.add(key.name);
    if (typeof key.description !== "string" || !key.description.trim()) {
      throw new TypeError(`required key "${key.name}" needs a description`);
    }
    if (key.optional !== undefined && typeof key.optional !== "boolean") {
      throw new TypeError(`required key "${key.name}": optional must be a boolean`);
    }
    return {
      name: key.name,
      description: key.description,
      shared: key.shared === true,
      metered: key.metered === true,
      ...(key.optional === true ? { optional: true } : {}),
    };
  });
}

/** True when a declared key (or its status) is optional. */
export function isOptionalKey(key: Pick<RequiredKey, "optional">): boolean {
  return key.optional === true;
}

/**
 * Whether a module is ready, and which required keys are missing, from the
 * status of each declared key. Unset optional keys are never missing. Core's
 * KeyStore and the harness both use this, so the rule lives in one place.
 */
export function moduleState(keys: readonly Pick<KeyStatus, "name" | "set" | "optional">[]): {
  readonly state: ModuleState;
  readonly missing: string[];
} {
  const missing = keys.filter((k) => !k.set && !isOptionalKey(k)).map((k) => k.name);
  return { state: missing.length === 0 ? "ready" : "needs-setup", missing };
}
