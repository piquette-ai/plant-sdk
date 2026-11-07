/**
 * The MCP extension: the tools, resources and prompts a module adds to the
 * plant's MCP server.
 *
 * Core collects every module's extension into one plant MCP server. It adds
 * the `<moduleId>__` prefix (double underscore; some MCP clients, such as the
 * Anthropic API, reject `.` in tool names) to tool and prompt names and the
 * `plant://<moduleId>/` prefix to resource URIs, so modules declare bare,
 * module-relative names. Core reads the {@link McpExtensionDescriptor} over
 * Workers RPC (plain data) and calls back through `PlantModule.mcpInvoke`.
 *
 * Schemas are zod v4 schemas (`zod` or `zod/mini`), converted to JSON Schema
 * (draft 2020-12) once, at definition time.
 */
import {
  safeParseAsync,
  toJSONSchema,
  type $ZodType,
  type input as ZodInput,
  type output as ZodOutput,
} from "zod/v4/core";
import type { PlantContext } from "./context.js";
import type { JsonSchema } from "./manifest.js";

/**
 * Tool, prompt and resource names: lowercase snake_case, at most 61
 * characters, with no `.` and no `__`, because core adds the `<moduleId>__`
 * prefix. 61 is what is left of the 64-character wire-name limit
 * (`MCP_WIRE_NAME_MAX`, see mcp-wire.ts) after the shortest module id and
 * `__`. The real budget is `62 - moduleId.length`: `defineModule` and core's
 * registry check the full `<moduleId>__<name>`.
 */
export const MCP_NAME = /^[a-z][a-z0-9_]{0,60}$/;

/** The separator core puts between the module id and a tool or prompt name. */
export const MCP_NAMESPACE_SEPARATOR = "__";

/** The URI scheme core puts in front of module-relative resource URIs. */
export const MCP_RESOURCE_SCHEME = "plant";

/** Entitlement keys, e.g. `consent.pro`. */
const ENTITLEMENT_KEY = /^[a-z0-9][a-z0-9_.:-]*$/;
/** A positive decimal amount, e.g. `0.01`. */
const AMOUNT = /^(0|[1-9]\d*)(\.\d{1,18})?$/;
const TEMPLATE_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROMPT_PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// ---------------------------------------------------------------------------
// Descriptor: what crosses Workers RPC. Plain, structured-clone-safe data.
// ---------------------------------------------------------------------------

/**
 * An x402 price for one call, declared only. The plant enforces it later.
 * `amount` is a positive decimal string in `currency`.
 */
export interface McpPrice {
  readonly amount: string;
  readonly currency: "USD";
}

export interface McpToolDescriptor {
  /** Module-relative; core exposes it as `<moduleId>__<name>`. */
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /** JSON Schema (draft 2020-12) of the input, `type: "object"`. */
  readonly inputSchema: JsonSchema;
  /** JSON Schema of the structured output, when the tool declares one. */
  readonly outputSchema?: JsonSchema;
  /**
   * Write tools are draft-first: core turns a call into a draft, and only
   * after a person approves it calls {@link McpToolInvocation} with the
   * `draftId`. Agents can never approve their own drafts.
   */
  readonly write: boolean;
  /** Entitlement key the tenant needs to see and call this tool. */
  readonly requires?: string;
  readonly price?: McpPrice;
}

export interface McpResourceDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /**
   * Module-relative URI template, e.g. `receipts/{id}`. Core exposes it as
   * `plant://<moduleId>/receipts/{id}`. Each `{var}` matches one path segment.
   * Params are percent-decoded and are always a single safe path segment: never
   * empty, `.` or `..`, and never containing `/`, `\`, NUL or other control
   * characters. URIs whose params fail that check are `not_found`.
   */
  readonly uriTemplate: string;
  readonly mimeType?: string;
  readonly requires?: string;
}

export interface McpPromptArgumentDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly required: boolean;
}

export interface McpPromptDescriptor {
  /** Module-relative; core exposes it as `<moduleId>__<name>`. */
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments: readonly McpPromptArgumentDescriptor[];
  readonly requires?: string;
}

/** Everything core needs to register a module's MCP extension. */
export interface McpExtensionDescriptor {
  readonly tools: readonly McpToolDescriptor[];
  readonly resources: readonly McpResourceDescriptor[];
  readonly prompts: readonly McpPromptDescriptor[];
}

// ---------------------------------------------------------------------------
// Invocations and results (also plain data over RPC).
// ---------------------------------------------------------------------------

export interface McpToolInvocation {
  readonly kind: "tool";
  /** Module-relative tool name (core strips the `<moduleId>__` prefix). */
  readonly name: string;
  readonly input: unknown;
  /** Required for write tools: the approved draft this call executes. */
  readonly draftId?: string;
}

export interface McpResourceInvocation {
  readonly kind: "resource";
  /** Module-relative URI, e.g. `receipts/r_1` (core strips `plant://<moduleId>/`). */
  readonly uri: string;
}

export interface McpPromptInvocation {
  readonly kind: "prompt";
  readonly name: string;
  readonly arguments?: Readonly<Record<string, string>>;
}

export type McpInvocation = McpToolInvocation | McpResourceInvocation | McpPromptInvocation;

export type McpResourceContents =
  | { readonly uri: string; readonly mimeType?: string; readonly text: string }
  | { readonly uri: string; readonly mimeType?: string; readonly blob: string };

export interface McpPromptMessage {
  readonly role: "user" | "assistant";
  readonly content: { readonly type: "text"; readonly text: string };
}

export type McpInvocationErrorCode =
  | "not_found"
  | "forbidden"
  | "draft_required"
  | "invalid_input"
  | "invalid_output";

export interface McpInvocationError {
  readonly code: McpInvocationErrorCode;
  readonly message: string;
  /** Validation problems, for `invalid_input` and `invalid_output`. */
  readonly issues?: ReadonlyArray<{ readonly path: readonly (string | number)[]; readonly message: string }>;
}

/**
 * The result of {@link McpExtension.invoke}. Expected failures (unknown name,
 * missing entitlement, missing draft, invalid input or output) come back as
 * `ok: false` so they survive RPC intact. Exceptions thrown by a module's own
 * `run`, `read` or `render` propagate to the caller.
 */
export type McpInvocationResult =
  | { readonly ok: true; readonly kind: "tool"; readonly output: unknown }
  | { readonly ok: true; readonly kind: "resource"; readonly contents: readonly McpResourceContents[] }
  | {
      readonly ok: true;
      readonly kind: "prompt";
      readonly description?: string;
      readonly messages: readonly McpPromptMessage[];
    }
  | { readonly ok: false; readonly error: McpInvocationError };

// ---------------------------------------------------------------------------
// Definitions: what a module author writes.
// ---------------------------------------------------------------------------

/** Extra information about a tool call. */
export interface McpToolCall {
  /** The approved draft being executed. Always set for write tools. */
  readonly draftId?: string;
}

type ToolResult<Output> = [Output] extends [$ZodType] ? ZodInput<Output> : unknown;

export interface McpToolDefinition<
  Input extends $ZodType = $ZodType,
  Output extends $ZodType | undefined = $ZodType | undefined,
  Env = unknown,
> {
  readonly title?: string;
  readonly description: string;
  /** zod schema of the input. Must convert to a JSON Schema `object`. */
  readonly input: Input;
  /** zod schema of the structured output. Must convert to a JSON Schema `object`. */
  readonly output?: Output;
  /** Write tools are draft-first. Defaults to `false`. */
  readonly write?: boolean;
  /** Entitlement key needed to call this tool. */
  readonly requires?: string;
  /** x402 price per call, declared only. `currency` defaults to `USD`. */
  readonly price?: { readonly amount: string; readonly currency?: "USD" };
  /** Called with input already parsed by `input`. */
  run(
    input: ZodOutput<Input>,
    ctx: PlantContext,
    env: Env,
    call: McpToolCall,
  ): ToolResult<Output> | Promise<ToolResult<Output>>;
}

/** What a resource's `read` may return; the SDK fills in `uri` and `mimeType`. */
export type McpResourceReadResult =
  | string
  | { readonly text: string; readonly mimeType?: string }
  | { readonly blob: string; readonly mimeType?: string };

export interface McpResourceDefinition<Env = unknown> {
  readonly title?: string;
  readonly description?: string;
  /** Module-relative URI template, e.g. `receipts/{id}`. See {@link McpResourceDescriptor}. */
  readonly uriTemplate: string;
  readonly mimeType?: string;
  readonly requires?: string;
  read(
    uri: string,
    params: Readonly<Record<string, string>>,
    ctx: PlantContext,
    env: Env,
  ): McpResourceReadResult | readonly McpResourceReadResult[] | Promise<McpResourceReadResult | readonly McpResourceReadResult[]>;
}

export interface McpPromptArgumentDefinition {
  readonly description?: string;
  readonly required?: boolean;
}

interface McpPromptBase {
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: Readonly<Record<string, McpPromptArgumentDefinition>>;
  readonly requires?: string;
}

/**
 * A named prompt template. Either `template`, a string with `{{arg}}`
 * placeholders that becomes one user message, or `render`, which returns a
 * string or a list of messages.
 */
export type McpPromptDefinition<Env = unknown> =
  | (McpPromptBase & { readonly template: string; readonly render?: undefined })
  | (McpPromptBase & {
      readonly template?: undefined;
      render(
        args: Readonly<Record<string, string>>,
        ctx: PlantContext,
        env: Env,
      ): string | readonly McpPromptMessage[] | Promise<string | readonly McpPromptMessage[]>;
    });

/**
 * Tools keyed by name. Each tool's `run` input type is inferred from its own
 * `input` schema. The return type is checked at runtime against `output`.
 */
export type McpToolDefinitions<Inputs, Env> = {
  readonly [K in keyof Inputs]: McpToolDefinition<Inputs[K] & $ZodType, $ZodType | undefined, Env>;
};

export interface McpExtensionDefinition<Env = unknown, Inputs = Record<string, $ZodType>> {
  readonly tools?: McpToolDefinitions<Inputs, Env>;
  readonly resources?: Readonly<Record<string, McpResourceDefinition<Env>>>;
  readonly prompts?: Readonly<Record<string, McpPromptDefinition<Env>>>;
}

declare const brand: unique symbol;

/** A validated MCP extension, from {@link defineMcpExtension}. */
export interface McpExtension<Env = unknown> {
  readonly descriptor: McpExtensionDescriptor;
  invoke(invocation: McpInvocation, ctx: PlantContext, env: Env): Promise<McpInvocationResult>;
  readonly [brand]: true;
}

export class McpDefinitionError extends Error {
  override name = "McpDefinitionError";
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const EXTENSIONS = new WeakSet<object>();

/** True when `value` came from {@link defineMcpExtension}. */
export function isMcpExtension(value: unknown): value is McpExtension<never> {
  return typeof value === "object" && value !== null && EXTENSIONS.has(value);
}

function fail(message: string): never {
  throw new McpDefinitionError(`defineMcpExtension: ${message}`);
}

function checkName(what: string, name: string): void {
  if (name.includes(".")) {
    fail(`${what} name "${name}" must not contain "." (core adds the "<moduleId>__" prefix)`);
  }
  if (name.includes(MCP_NAMESPACE_SEPARATOR)) {
    fail(`${what} name "${name}" must not contain "__" (core adds the "<moduleId>__" prefix)`);
  }
  if (!MCP_NAME.test(name)) fail(`${what} name "${name}" must be lowercase snake_case, at most 61 characters`);
}

function checkRequires(what: string, requires: string | undefined): void {
  if (requires !== undefined && !ENTITLEMENT_KEY.test(requires)) {
    fail(`${what} requires "${requires}" is not an entitlement key`);
  }
}

function objectSchema(what: string, schema: $ZodType, io: "input" | "output"): JsonSchema {
  let json: Record<string, unknown>;
  try {
    json = toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "throw" }) as Record<string, unknown>;
  } catch (err) {
    fail(`${what} can't be converted to JSON Schema: ${(err as Error).message}`);
  }
  if (json.type !== "object") fail(`${what} must be an object schema (z.object(...))`);
  // Round-trip through JSON so the descriptor is plain, cloneable data.
  return JSON.parse(JSON.stringify(json)) as JsonSchema;
}

function checkPrice(what: string, price: McpToolDefinition["price"]): McpPrice | undefined {
  if (price === undefined) return undefined;
  const currency = price.currency ?? "USD";
  if (currency !== "USD") fail(`${what} price currency must be "USD"`);
  if (typeof price.amount !== "string" || !AMOUNT.test(price.amount) || !/[1-9]/.test(price.amount)) {
    fail(`${what} price amount "${String(price.amount)}" must be a positive decimal string, e.g. "0.01"`);
  }
  return { amount: price.amount, currency };
}

interface CompiledTemplate {
  readonly regex: RegExp;
  readonly vars: readonly string[];
}

function checkRelativeUri(uri: string): string | undefined {
  if (uri === "") return "is empty";
  if (uri.includes(":")) return "must be module-relative (no scheme)";
  if (uri.startsWith("/")) return 'must not start with "/"';
  if (/[?#\s\\]/.test(uri)) return "must not contain ?, #, \\ or whitespace";
  if (uri.split("/").some((s) => s === "" || s === "." || s === "..")) return "must not have empty, . or .. segments";
  return undefined;
}

function compileTemplate(what: string, template: string): CompiledTemplate {
  const problem = checkRelativeUri(template.replace(/\{[^}]*\}/g, "x"));
  if (problem) fail(`${what} uriTemplate "${template}" ${problem}`);
  const vars: string[] = [];
  let pattern = "";
  let rest = template;
  while (rest.length > 0) {
    const open = rest.indexOf("{");
    const literal = open === -1 ? rest : rest.slice(0, open);
    if (literal.includes("}")) fail(`${what} uriTemplate "${template}" has an unmatched "}"`);
    pattern += literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (open === -1) break;
    const close = rest.indexOf("}", open);
    if (close === -1) fail(`${what} uriTemplate "${template}" has an unmatched "{"`);
    const name = rest.slice(open + 1, close);
    if (!TEMPLATE_VAR.test(name)) {
      fail(`${what} uriTemplate "${template}": only simple {name} expressions are supported`);
    }
    if (vars.includes(name)) fail(`${what} uriTemplate "${template}" repeats {${name}}`);
    vars.push(name);
    pattern += "([^/]+)";
    rest = rest.slice(close + 1);
  }
  return { regex: new RegExp(`^${pattern}$`), vars };
}

/** Decoded params that could escape a path segment: separators, NUL and other control characters. */
const UNSAFE_PARAM = /[\/\\\p{Cc}]/u;

/**
 * Decode a template match into params. Each param must stay a single safe
 * path segment after decoding, because modules build R2 and D1 keys from
 * them: `%2F`, `%5C`, `%2E%2E`, `%00` and malformed escapes are refused.
 */
function decodeParams(vars: readonly string[], match: RegExpExecArray): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  for (const [i, v] of vars.entries()) {
    let value: string;
    try {
      value = decodeURIComponent(match[i + 1]!);
    } catch {
      return undefined;
    }
    if (value === "" || value === "." || value === ".." || UNSAFE_PARAM.test(value)) return undefined;
    params[v] = value;
  }
  return Object.freeze(params);
}

function placeholders(template: string): string[] {
  return [...template.matchAll(PROMPT_PLACEHOLDER)].map((m) => m[1]!);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function failure(code: McpInvocationErrorCode, message: string, issues?: McpInvocationError["issues"]): McpInvocationResult {
  return { ok: false, error: { code, message, ...(issues ? { issues } : {}) } };
}

function issuesOf(error: { issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }> }) {
  return error.issues.map((i) => ({
    path: i.path.map((p) => (typeof p === "number" ? p : String(p))),
    message: i.message,
  }));
}

function toContents(uri: string, mimeType: string | undefined, r: McpResourceReadResult): McpResourceContents {
  const item = typeof r === "string" ? { text: r } : r;
  const mt = item.mimeType ?? mimeType;
  const base = { uri, ...(mt !== undefined ? { mimeType: mt } : {}) };
  if ("blob" in item) return { ...base, blob: item.blob };
  return { ...base, text: item.text };
}

function toMessages(rendered: string | readonly McpPromptMessage[]): McpPromptMessage[] {
  if (typeof rendered === "string") return [{ role: "user", content: { type: "text", text: rendered } }];
  return rendered.map((m) => ({ role: m.role, content: { type: "text", text: m.content.text } }));
}

/**
 * Declare a module's MCP tools, resources and prompts. Validates names,
 * converts zod schemas to JSON Schema and returns a frozen extension with a
 * serializable {@link McpExtensionDescriptor} and an `invoke` dispatcher.
 *
 * ```ts
 * const mcp = defineMcpExtension<Env>()({
 *   tools: {
 *     list_receipts: {
 *       description: "List consent receipts",
 *       input: z.object({ limit: z.number().int().max(100).default(20) }),
 *       requires: "consent.basic",
 *       run: async ({ limit }, ctx, env) => listReceipts(env.DB, ctx.tenant.id, limit),
 *     },
 *   },
 * });
 * ```
 *
 * Call it with no arguments first to fix `Env`; tool input types are then
 * inferred from each tool's `input` schema. `defineMcpExtension({...})`
 * directly also works when you don't need a typed `env`.
 */
export function defineMcpExtension<Env = unknown>(): <Inputs extends Record<string, $ZodType> = {}>(
  def: McpExtensionDefinition<Env, Inputs>,
) => McpExtension<Env>;
export function defineMcpExtension<Inputs extends Record<string, $ZodType> = {}>(
  def: McpExtensionDefinition<unknown, Inputs>,
): McpExtension<unknown>;
export function defineMcpExtension(def?: McpExtensionDefinition<unknown, unknown>): unknown {
  if (def === undefined) return (d: McpExtensionDefinition<unknown, unknown>) => build(d);
  return build(def);
}

type AnyTool = McpToolDefinition<$ZodType, $ZodType | undefined, unknown>;
type AnyPrompt = McpPromptDefinition<unknown>;

function build(def: McpExtensionDefinition<unknown, unknown>): McpExtension<unknown> {
  if (typeof def !== "object" || def === null) fail("pass { tools, resources, prompts }");
  const toolDefs = Object.entries((def.tools ?? {}) as Record<string, AnyTool>);
  const resourceDefs = Object.entries(def.resources ?? {});
  const promptDefs = Object.entries((def.prompts ?? {}) as Record<string, AnyPrompt>);

  const tools: McpToolDescriptor[] = [];
  for (const [name, t] of toolDefs) {
    const what = `tool "${name}"`;
    checkName("tool", name);
    if (typeof t.description !== "string" || !t.description.trim()) fail(`${what} needs a description`);
    if (typeof t.run !== "function") fail(`${what} needs run(input, ctx)`);
    if (!t.input || typeof t.input !== "object") fail(`${what} needs an input schema`);
    if (t.write !== undefined && typeof t.write !== "boolean") fail(`${what} write must be a boolean`);
    checkRequires(what, t.requires);
    const price = checkPrice(what, t.price);
    tools.push({
      name,
      ...(t.title !== undefined ? { title: t.title } : {}),
      description: t.description,
      inputSchema: objectSchema(`${what} input`, t.input, "input"),
      ...(t.output !== undefined ? { outputSchema: objectSchema(`${what} output`, t.output, "output") } : {}),
      write: t.write ?? false,
      ...(t.requires !== undefined ? { requires: t.requires } : {}),
      ...(price ? { price } : {}),
    });
  }

  const templates = new Map<string, CompiledTemplate>();
  const resources: McpResourceDescriptor[] = [];
  for (const [name, r] of resourceDefs) {
    const what = `resource "${name}"`;
    checkName("resource", name);
    if (typeof r.read !== "function") fail(`${what} needs read(uri, params, ctx)`);
    if (typeof r.uriTemplate !== "string") fail(`${what} needs a uriTemplate`);
    checkRequires(what, r.requires);
    const compiled = compileTemplate(what, r.uriTemplate);
    for (const [other, c] of templates) {
      if (c.regex.source === compiled.regex.source) {
        fail(`${what} uriTemplate "${r.uriTemplate}" overlaps resource "${other}"`);
      }
    }
    templates.set(name, compiled);
    resources.push({
      name,
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...(r.description !== undefined ? { description: r.description } : {}),
      uriTemplate: r.uriTemplate,
      ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
      ...(r.requires !== undefined ? { requires: r.requires } : {}),
    });
  }

  const prompts: McpPromptDescriptor[] = [];
  for (const [name, p] of promptDefs) {
    const what = `prompt "${name}"`;
    checkName("prompt", name);
    checkRequires(what, p.requires);
    const hasTemplate = typeof p.template === "string";
    const hasRender = typeof p.render === "function";
    if (hasTemplate === hasRender) fail(`${what} needs exactly one of template or render`);
    const args = Object.entries(p.arguments ?? {});
    for (const [arg] of args) {
      if (!TEMPLATE_VAR.test(arg)) fail(`${what} argument "${arg}" must be an identifier`);
    }
    if (hasTemplate) {
      for (const ph of placeholders(p.template!)) {
        if (!(p.arguments && Object.hasOwn(p.arguments, ph))) fail(`${what} template uses undeclared {{${ph}}}`);
      }
    }
    prompts.push({
      name,
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}),
      arguments: args.map(([arg, a]) => ({
        name: arg,
        ...(a.description !== undefined ? { description: a.description } : {}),
        required: a.required ?? false,
      })),
      ...(p.requires !== undefined ? { requires: p.requires } : {}),
    });
  }

  const descriptor: McpExtensionDescriptor = deepFreeze({ tools, resources, prompts });
  const toolMap = new Map(toolDefs);
  const resourceMap = new Map(resourceDefs);
  const promptMap = new Map(promptDefs);
  const toolInfo = new Map(tools.map((t) => [t.name, t]));
  const promptInfo = new Map(prompts.map((p) => [p.name, p]));

  const allowed = (ctx: PlantContext, requires: string | undefined) =>
    requires === undefined || ctx.entitlements.has(requires);

  async function invokeTool(inv: McpToolInvocation, ctx: PlantContext, env: unknown): Promise<McpInvocationResult> {
    const t = toolMap.get(inv.name);
    const info = toolInfo.get(inv.name);
    if (!t || !info) return failure("not_found", `unknown MCP tool "${inv.name}"`);
    if (!allowed(ctx, info.requires)) {
      return failure("forbidden", `tool "${inv.name}" requires entitlement "${info.requires}"`);
    }
    if (info.write && (typeof inv.draftId !== "string" || inv.draftId === "")) {
      return failure("draft_required", `tool "${inv.name}" is a write tool: it runs only from an approved draft`);
    }
    const parsed = await safeParseAsync(t.input, inv.input);
    if (!parsed.success) return failure("invalid_input", `invalid input for tool "${inv.name}"`, issuesOf(parsed.error));
    const call: McpToolCall = info.write ? { draftId: inv.draftId! } : {};
    let output: unknown = await t.run(parsed.data, ctx, env, call);
    if (t.output !== undefined) {
      const out = await safeParseAsync(t.output, output);
      if (!out.success) {
        return failure("invalid_output", `tool "${inv.name}" returned output that doesn't match its schema`, issuesOf(out.error));
      }
      output = out.data;
    }
    return { ok: true, kind: "tool", output };
  }

  async function invokeResource(inv: McpResourceInvocation, ctx: PlantContext, env: unknown): Promise<McpInvocationResult> {
    if (typeof inv.uri !== "string" || checkRelativeUri(inv.uri)) {
      return failure("not_found", `no MCP resource matches "${String(inv.uri)}"`);
    }
    for (const [name, compiled] of templates) {
      const m = compiled.regex.exec(inv.uri);
      if (!m) continue;
      const r = resourceMap.get(name)!;
      const params = decodeParams(compiled.vars, m);
      if (!params) return failure("not_found", `no MCP resource matches "${inv.uri}"`);
      if (!allowed(ctx, r.requires)) return failure("forbidden", `resource "${name}" requires entitlement "${r.requires}"`);
      const read = await r.read(inv.uri, params, ctx, env);
      const list = Array.isArray(read) ? (read as readonly McpResourceReadResult[]) : [read as McpResourceReadResult];
      return { ok: true, kind: "resource", contents: list.map((x) => toContents(inv.uri, r.mimeType, x)) };
    }
    return failure("not_found", `no MCP resource matches "${inv.uri}"`);
  }

  async function invokePrompt(inv: McpPromptInvocation, ctx: PlantContext, env: unknown): Promise<McpInvocationResult> {
    const p = promptMap.get(inv.name);
    const info = promptInfo.get(inv.name);
    if (!p || !info) {
      return failure("not_found", `unknown MCP prompt "${inv.name}"`);
    }
    if (!allowed(ctx, info.requires)) return failure("forbidden", `prompt "${inv.name}" requires entitlement "${info.requires}"`);
    const given = inv.arguments ?? {};
    const issues: { path: string[]; message: string }[] = [];
    const declared = new Set(info.arguments.map((a) => a.name));
    for (const [k, v] of Object.entries(given)) {
      if (!declared.has(k)) issues.push({ path: [k], message: "unknown argument" });
      else if (typeof v !== "string") issues.push({ path: [k], message: "must be a string" });
    }
    for (const a of info.arguments) {
      if (a.required && given[a.name] === undefined) issues.push({ path: [a.name], message: "required" });
    }
    if (issues.length > 0) return failure("invalid_input", `invalid arguments for prompt "${inv.name}"`, issues);
    const args: Readonly<Record<string, string>> = Object.freeze({ ...given });
    const rendered =
      typeof p.template === "string"
        ? p.template.replace(PROMPT_PLACEHOLDER, (_m, k: string) => args[k] ?? "")
        : await p.render!(args, ctx, env);
    return {
      ok: true,
      kind: "prompt",
      ...(info.description !== undefined ? { description: info.description } : {}),
      messages: toMessages(rendered),
    };
  }

  const extension = {
    descriptor,
    async invoke(invocation: McpInvocation, ctx: PlantContext, env: unknown): Promise<McpInvocationResult> {
      switch (invocation?.kind) {
        case "tool":
          return invokeTool(invocation, ctx, env);
        case "resource":
          return invokeResource(invocation, ctx, env);
        case "prompt":
          return invokePrompt(invocation, ctx, env);
        default:
          return failure("not_found", `unknown MCP invocation kind "${String((invocation as { kind?: unknown })?.kind)}"`);
      }
    },
  } as unknown as McpExtension<unknown>;
  EXTENSIONS.add(extension);
  return Object.freeze(extension);
}

/** The full MCP URI core exposes for a module-relative resource URI or template. */
export function mcpResourceUri(moduleId: string, relative: string): string {
  return `${MCP_RESOURCE_SCHEME}://${moduleId}/${relative}`;
}
