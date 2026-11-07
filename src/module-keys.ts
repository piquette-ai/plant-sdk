/**
 * Module keys at request time: the values of the required keys a module
 * declares (see keys.ts), as the router hands them over.
 *
 * The router resolves a module's keys per request and passes them as a
 * separate RPC argument (`keys`), never as part of SerializedPlantContext.
 * Inside the module, PlantModule keeps only the names the manifest declares
 * (its own keys plus the shared keys it declared) and ties them to the
 * request's context. A handler reads them with {@link moduleKeys}:
 *
 * ```ts
 * handle: async (req, ctx, env) => {
 *   const apiKey = moduleKeys(ctx).getOrThrow("SCRAPECREATORS_API_KEY");
 *   ...
 * }
 * ```
 *
 * The values never live on the context object, so serializing, logging or
 * structured-cloning a context can't leak them. A {@link ModuleKeys} object
 * holds no values of its own either: it prints and serializes as its key
 * names. Errors thrown out of a module entry point and MCP results are
 * scrubbed of key values before they leave the module.
 */
import type { RequiredKey } from "./keys.js";
import type { ModuleManifest } from "./manifest.js";

/** Key values by name, as the router sends them over RPC. */
export type KeyValues = Readonly<Record<string, string>>;

/** What a scrubbed key value is replaced with. */
export const REDACTED = (name: string) => `[redacted:${name}]`;

/** Values shorter than this aren't scrubbed: they'd match ordinary text. */
const MIN_SCRUB_LENGTH = 6;

interface KeyData {
  readonly declared: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
}

// Values live here, not on the ModuleKeys objects, so nothing that walks an
// object (JSON, console, util.inspect, structuredClone) can reach them.
const DATA = new WeakMap<ModuleKeys, KeyData>();
const BY_CONTEXT = new WeakMap<object, ModuleKeys>();

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

function data(keys: ModuleKeys): KeyData {
  const d = DATA.get(keys);
  if (!d) throw new TypeError("ModuleKeys: not created by createModuleKeys");
  return d;
}

/** The keys one module can read on one request. Holds no values itself. */
export class ModuleKeys {
  private constructor() {}

  /** @internal Use {@link createModuleKeys}. */
  static create(declared: ReadonlySet<string>, values: ReadonlyMap<string, string>): ModuleKeys {
    const keys = new ModuleKeys();
    DATA.set(keys, Object.freeze({ declared, values }));
    return Object.freeze(keys);
  }

  /**
   * The value of a declared key, or `undefined` when it isn't set. Throws a
   * TypeError for a name the manifest doesn't declare.
   */
  get(name: string): string | undefined {
    const d = data(this);
    if (!d.declared.has(name)) {
      throw new TypeError(`key "${name}" is not declared in this module's requiredKeys`);
    }
    return d.values.get(name);
  }

  /** Like {@link get}, but throws when the key isn't set. The error names the key, never a value. */
  getOrThrow(name: string): string {
    const value = this.get(name);
    if (value === undefined) throw new Error(`required key "${name}" is not set`);
    return value;
  }

  /** True when the key is declared and set. */
  has(name: string): boolean {
    const d = data(this);
    return d.declared.has(name) && d.values.has(name);
  }

  /** The names of the declared keys that are set, sorted. Never values. */
  names(): string[] {
    return [...data(this).values.keys()].sort();
  }

  toJSON(): { readonly keys: string[] } {
    return { keys: this.names() };
  }

  toString(): string {
    return `ModuleKeys(${this.names().join(", ")})`;
  }

  [INSPECT](): string {
    return this.toString();
  }
}

function declaredNames(declared: ModuleManifest | readonly (RequiredKey | string)[]): Set<string> {
  const list = Array.isArray(declared) ? declared : ((declared as ModuleManifest).requiredKeys ?? []);
  return new Set(list.map((k) => (typeof k === "string" ? k : k.name)));
}

export interface CreateModuleKeysOptions {
  /**
   * Throw on a value whose name isn't declared, instead of dropping it.
   * The test harnesses use it so a fake key with a typo fails loudly.
   */
  readonly strict?: boolean;
}

/**
 * Build the keys a module may read: only names in `declared` (a manifest,
 * or its required keys), and only string values. Anything else in `values`
 * is dropped, or rejected with `strict`.
 */
export function createModuleKeys(
  declared: ModuleManifest | readonly (RequiredKey | string)[],
  values: KeyValues | null | undefined,
  options: CreateModuleKeysOptions = {},
): ModuleKeys {
  const names = declaredNames(declared);
  const kept = new Map<string, string>();
  if (values && typeof values === "object") {
    for (const [name, value] of Object.entries(values)) {
      if (!names.has(name)) {
        if (options.strict) throw new TypeError(`key "${name}" is not declared in this module's requiredKeys`);
        continue;
      }
      if (typeof value !== "string" || value === "") {
        if (options.strict) throw new TypeError(`key "${name}" must be a non-empty string`);
        continue;
      }
      kept.set(name, value);
    }
  }
  return ModuleKeys.create(names, kept);
}

/**
 * Tie keys to a context (a PlantContext or an AgentContext) and return the
 * same context. PlantModule and the harnesses do this; in a unit test that
 * calls a handler directly, use it to inject fake keys.
 */
export function withModuleKeys<C extends object>(ctx: C, keys: ModuleKeys): C {
  data(keys);
  BY_CONTEXT.set(ctx, keys);
  return ctx;
}

/**
 * The keys for the request a context belongs to. Throws when the context
 * didn't come through PlantModule or a harness (see {@link withModuleKeys}).
 */
export function moduleKeys(ctx: object): ModuleKeys {
  const keys = BY_CONTEXT.get(ctx);
  if (!keys) {
    throw new Error("moduleKeys: this context has no keys (in a unit test, attach fake keys with withModuleKeys)");
  }
  return keys;
}

// ─── Scrubbing (used by PlantModule) ────────────────────────────────────────
//
// Scrubbing fails closed: the result is always a fresh copy built from
// strings, arrays, plain objects, Maps, Sets, Dates and plain Errors. Nothing
// of the input is passed through by reference, so no object can smuggle a
// value past the scrubber.

/** What a value the scrubber can't copy safely (functions, binary data) becomes. */
export const UNSERIALIZABLE = "[unserializable]";

type Pairs = readonly [string, string][];

function scrubbable(keys: ModuleKeys): [string, string][] {
  return [...data(keys).values]
    .filter(([, v]) => v.length >= MIN_SCRUB_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);
}

function scrubString(s: string, pairs: Pairs): string {
  let out = s;
  for (const [name, value] of pairs) if (out.includes(value)) out = out.split(value).join(REDACTED(name));
  return out;
}

const ERROR_FIELDS = new Set(["name", "message", "stack", "cause", "errors"]);

/** Copy own enumerable string-keyed properties of `from`, scrubbed, onto `to`. */
function copyProps(from: object, to: Record<string, unknown>, pairs: Pairs, seen: WeakMap<object, unknown>, skip?: ReadonlySet<string>) {
  for (const k of Object.keys(from)) {
    if (skip?.has(k)) continue;
    let v: unknown;
    try {
      v = (from as Record<string, unknown>)[k];
    } catch {
      v = UNSERIALIZABLE;
    }
    Object.defineProperty(to, scrubString(k, pairs), {
      value: scrubDeep(v, pairs, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

/** A fresh Error with only the scrubbed name, message, stack, cause (and AggregateError members) plus scrubbed own enumerable properties. */
function scrubErrorDeep(e: Error, pairs: Pairs, seen: WeakMap<object, unknown>): Error {
  const read = (k: string): unknown => {
    try {
      return (e as unknown as Record<string, unknown>)[k];
    } catch {
      return undefined;
    }
  };
  const message = scrubString(String(read("message") ?? ""), pairs);
  const copy: Error = e instanceof AggregateError ? new AggregateError([], message) : new Error(message);
  seen.set(e, copy);
  Object.defineProperty(copy, "name", { value: scrubString(String(read("name") ?? "Error"), pairs), writable: true, configurable: true });
  const stack = read("stack");
  if (typeof stack === "string") {
    Object.defineProperty(copy, "stack", { value: scrubString(stack, pairs), writable: true, configurable: true });
  } else {
    delete (copy as { stack?: string }).stack;
  }
  if ("cause" in e) {
    Object.defineProperty(copy, "cause", { value: scrubDeep(read("cause"), pairs, seen), writable: true, configurable: true });
  }
  if (e instanceof AggregateError) {
    const errors = read("errors");
    Object.defineProperty(copy, "errors", {
      value: Array.isArray(errors) ? errors.map((x) => scrubDeep(x, pairs, seen)) : [],
      writable: true,
      configurable: true,
    });
  }
  copyProps(e, copy as unknown as Record<string, unknown>, pairs, seen, ERROR_FIELDS);
  return copy;
}

function scrubDeep(value: unknown, pairs: Pairs, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return scrubString(value, pairs);
  if (typeof value === "function") return UNSERIALIZABLE;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);

  if (value instanceof Error) return scrubErrorDeep(value, pairs, seen);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) out.push(scrubDeep(value[i], pairs, seen));
    return out;
  }
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    seen.set(value, out);
    for (const [k, v] of value) out.set(scrubDeep(k, pairs, seen), scrubDeep(v, pairs, seen));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set<unknown>();
    seen.set(value, out);
    for (const v of value) out.add(scrubDeep(v, pairs, seen));
    return out;
  }
  if (value instanceof Date) {
    const out = new Date(value.getTime());
    seen.set(value, out);
    return out;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof WeakMap || value instanceof WeakSet || value instanceof Promise) {
    seen.set(value, UNSERIALIZABLE);
    return UNSERIALIZABLE;
  }
  // Plain objects, class instances and anything else: a plain copy of the
  // own enumerable properties, scrubbed. Never the original.
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  copyProps(value, out, pairs, seen);
  return out;
}

/**
 * A scrubbed copy of `value` with every key value redacted. The copy holds
 * only fresh strings, arrays, plain objects, Maps, Sets, Dates and Errors.
 * @internal
 */
export function scrubKeyValues<T>(keys: ModuleKeys, value: T): T {
  const pairs = scrubbable(keys);
  return pairs.length === 0 ? value : (scrubDeep(value, pairs, new WeakMap()) as T);
}

/**
 * A thrown value with every key value redacted. Errors come back as fresh
 * Errors carrying only the scrubbed name, message, stack, cause and own
 * enumerable properties. @internal
 */
export function scrubError(keys: ModuleKeys, err: unknown): unknown {
  const pairs = scrubbable(keys);
  return pairs.length === 0 ? err : scrubDeep(err, pairs, new WeakMap());
}

/** Run a module entry point, scrubbing key values from anything it throws. @internal */
export async function guardKeys<T>(keys: ModuleKeys, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw scrubError(keys, err);
  }
}
