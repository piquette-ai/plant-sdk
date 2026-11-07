/**
 * MCP wire names: how core exposes a module's tools and prompts on the plant
 * MCP server.
 *
 * Modules declare bare names (`list_entries`). Core exposes them as
 * `<moduleId>__<name>` (double underscore), e.g. `hello__list_entries`. Not
 * `<moduleId>.<name>`: the MCP spec allows `.`, but the model APIs that
 * plant tools end up in don't. Dotted forms such as `ads.experiment.create`
 * are display labels only ({@link mcpDisplayLabel}); they are never parsed.
 *
 * Tool-name limits, checked 2026-11-04 against the official docs:
 * - MCP spec 2025-11-25 (server/tools, "Tool Names"): SHOULD be 1-128
 *   characters of `A-Za-z0-9_-.`.
 * - Anthropic Messages API (platform.claude.com, "Define tools"):
 *   `^[a-zA-Z0-9_-]{1,128}$`. Older docs said `{1,64}`.
 * - OpenAI function tools (openai/openai-openapi, FunctionObject.name):
 *   `a-z, A-Z, 0-9, underscores and dashes, with a maximum length of 64`.
 *
 * The strictest real limit is OpenAI's 64 characters over `[a-zA-Z0-9_-]`,
 * so the whole wire name is at most {@link MCP_WIRE_NAME_MAX} = 64. Module
 * ids may contain `-` (every client accepts it) but never `_`, so the first
 * `__` in a wire name is always the separator.
 */
import { MCP_NAME, MCP_NAMESPACE_SEPARATOR } from "./mcp-extension.js";

/** Between the module id and the module-relative name (same as {@link MCP_NAMESPACE_SEPARATOR}). */
export const MCP_WIRE_SEPARATOR = MCP_NAMESPACE_SEPARATOR;

/**
 * The longest wire name, `<moduleId>__<name>` in full: 64 characters, the
 * strictest limit among MCP clients (OpenAI function names). The module id
 * and the `__` count against it, so a module id of `n` characters leaves
 * `62 - n` for each tool or prompt name. Keep module ids short.
 */
export const MCP_WIRE_NAME_MAX = 64;

/** Every wire name matches this: the character set all clients accept, at most 64 long. */
export const MCP_WIRE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

const WIRE_MODULE_ID = /^[a-z][a-z0-9-]{0,62}$/;

/** `<moduleId>__<name>`. Throws a TypeError when the result isn't a valid wire name. */
export function mcpWireName(moduleId: string, name: string): string {
  if (!WIRE_MODULE_ID.test(moduleId)) throw new TypeError(`mcpWireName: invalid module id "${moduleId}"`);
  if (!MCP_NAME.test(name) || name.includes(MCP_WIRE_SEPARATOR)) {
    throw new TypeError(`mcpWireName: invalid name "${name}"`);
  }
  const wire = `${moduleId}${MCP_WIRE_SEPARATOR}${name}`;
  if (wire.length > MCP_WIRE_NAME_MAX) {
    throw new TypeError(`mcpWireName: "${wire}" is longer than ${MCP_WIRE_NAME_MAX} characters`);
  }
  return wire;
}

/**
 * Split a wire name back into module id and name, on the first `__`, or
 * `undefined` when it isn't one (too long, no separator, or a part that
 * isn't a valid module id or name).
 */
export function parseMcpWireName(wire: string): { readonly moduleId: string; readonly name: string } | undefined {
  if (typeof wire !== "string" || wire.length > MCP_WIRE_NAME_MAX) return undefined;
  const at = wire.indexOf(MCP_WIRE_SEPARATOR);
  if (at <= 0) return undefined;
  const moduleId = wire.slice(0, at);
  const name = wire.slice(at + MCP_WIRE_SEPARATOR.length);
  if (!WIRE_MODULE_ID.test(moduleId) || !MCP_NAME.test(name) || name.includes(MCP_WIRE_SEPARATOR)) return undefined;
  return { moduleId, name };
}

/**
 * A dotted label for UIs, e.g. `ads.experiment.create` for module `ads` and
 * tool `experiment_create`. Display only: never send it to an MCP client and
 * never parse it (it is ambiguous). The wire name is {@link mcpWireName}.
 */
export function mcpDisplayLabel(moduleId: string, name: string): string {
  return [moduleId, ...name.split("_").filter((p) => p !== "")].join(".");
}
