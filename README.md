# @piquette/plant-sdk

The public SDK for building **plant modules**: microfrontend Workers that plug into a piquette plant running on your own Cloudflare account.

A module declares its routes, MCP tools, agents, events, privacy handlers and required keys in one `defineModule()`. The plant handles sign-in, tenancy, branding, licensing, drafts and the agent runtime.

MIT licensed. Copyright (c) 2026 iamfiscus LLC.

## Install

```sh
npm install @piquette/plant-sdk zod
npm install -D @cloudflare/workers-types
```

`zod` (v4) is a peer dependency. `@cloudflare/workers-types` is an optional peer, needed for type checking a Worker. The package is ESM only and targets Cloudflare Workers.

Pin an exact version (`"@piquette/plant-sdk": "0.1.0"`): a module declares the core versions it works with in `coreRange`, and the plant checks that range before mounting it.

## Example

[`examples/hello-module`](examples/hello-module) is a complete module built only on this package: app routes and a public prefix, an MCP read tool and a draft-first write tool, a scheduled agent, privacy handlers with deletion proofs, and tests that run it as its own Worker in local workerd through the SDK's mock router. Start there.

## Usage

A module is a Worker with no public routes. The plant's router reaches it over a service binding and passes a `PlantContext` (tenant, principal, brand, entitlements, basePath, surface).

```ts
import { defineMcpExtension, defineModule, moduleEntrypoint } from "@piquette/plant-sdk";
import * as z from "zod";

const consent = defineModule<Env>({
  id: "consent",
  name: "Consent",
  version: "0.1.0",
  coreRange: "^0.1.0", // core versions this module works with (skew check)
  nav: [{ label: "Receipts", path: "/receipts" }],
  publicPrefixes: ["/api/consent"],
  requires: ["consent.basic"],
  events: { emits: ["consent.recorded"], listens: ["dsar.requested"] },
  handle: (request, ctx, env) => new Response(`Hello ${ctx.tenant.hostname}`),
  onEvent: async (event, ctx, env) => {},
  privacy: { find, export: exportData, delete: deleteData, verify },
  mcp, // from defineMcpExtension, below
});

export default moduleEntrypoint(consent);
```

`moduleEntrypoint` returns a `PlantModule` (a `WorkerEntrypoint`) with the RPC methods `manifest()`, `handle(request, ctx)`, and, only when defined, `privacy()`, `mcp()`, `mcpInvoke(invocation, ctx)` and `onEvent(event, ctx)`. Contexts cross RPC as `SerializedPlantContext` (entitlements as a key list) and are rebuilt with `createPlantContext`.

## Member roles

On `/app` routes the router puts the signed-in person's role in the tenant on `ctx.principal.role`: `viewer < member < admin < owner`. It comes from the plant's tenant membership and is signed into the context's capability, so core sees the same role. Other surfaces (public, mcp, events) carry no role, and agents have their own principal kind with no role.

The router already refuses a request below the default rule (GET, HEAD and OPTIONS need viewer; every other method needs member) or below a matching `roleRules` entry in the manifest. Check again in the module on every mutating route:

```ts
import { defineModule, requireRole, RoleError, roleResponse } from "@piquette/plant-sdk";

const ads = defineModule<Env>({
  // ...
  roleRules: [{ prefix: "/settings", minRole: "admin" }], // longest prefix wins; `methods` optional
  handle: async (request, ctx, env) => {
    if (request.method === "POST") {
      const denied = roleResponse(ctx, "member"); // a JSON 403, or null
      if (denied) return denied;
    }
    // or: requireRole(ctx, "member") throws a RoleError; return err.response()
    return new Response("ok");
  },
});
```

`requireRole` refuses a viewer below the minimum, a missing role, a public request and an agent. `hasRole`, `roleOf`, `roleAtLeast` and `requiredRoleFor` (the router's own rule) are there for UI decisions, such as hiding a button. They are never a substitute for the check on the POST.

## Calling back into core

Every context the plant gives a module (requests, event deliveries, agent runs) carries an opaque, short-lived `capability` that core minted. When a module calls a core service binding (emit an event, call another module's MCP tool, drafts, the inbox), it passes `callbackContext(ctx)`, which is the tenant plus that capability, unchanged. Core verifies it and acts only for the tenant of the current request:

```ts
await env.EVENTS.emit(callbackContext(ctx), "consent.recorded", { receiptId });
```

The capability is kept off `PlantContext` and `AgentContext` objects, so logging a context never prints it. Don't parse it, store it or log it. Use `redactContext(wire)` before logging a `SerializedPlantContext`.

### Long-running Workflows

An agent run's capability lasts at most an hour. A Workflow core starts gets its scope in the params. Wrap every step that calls core in `agentStep`. Inside the step it asks core's `AgentRuns` binding for a fresh capability, and core refuses other tenants, other modules and runs that started more than 24 hours ago. It then hands the step a context that holds the new capability:

```ts
const run = { scope: event.payload.scope, core: this.env.AGENT_RUNS };
const changed = await agentStep(step, "poll", run, async (ctx) => poll(this.env, ctx.tenant.id));
await step.sleep("cool down", "2 hours");
await agentStep(step, "propose", run, (ctx) => this.env.INBOX.post(callbackContext(ctx), conversationId, text));
```

Workflows persist step results and errors. `agentStep` refuses a result that contains a capability and strips capabilities from errors. Never return a context from a step, and never log `event.payload.scope`.

## MCP extension

```ts
const mcp = defineMcpExtension<Env>()({
  tools: {
    list_receipts: {
      description: "List consent receipts",
      input: z.object({ limit: z.number().int().max(100).default(20) }),
      output: z.object({ receipts: z.array(z.object({ id: z.string() })) }),
      requires: "consent.basic", // entitlement key, checked on every call
      run: async ({ limit }, ctx, env) => ({ receipts: await list(env.DB, ctx.tenant.id, limit) }),
    },
    revoke_receipt: {
      description: "Revoke a receipt",
      input: z.object({ id: z.string() }),
      write: true, // draft-first: runs only with an approved draftId
      price: { amount: "0.01" }, // x402 price in USD, declared only for now
      run: async ({ id }, ctx, env, { draftId }) => ({ revoked: id, draftId }),
    },
  },
  resources: {
    receipt: { uriTemplate: "receipts/{id}", mimeType: "application/json", read: (uri, { id }, ctx, env) => load(id) },
  },
  prompts: {
    summarize: { arguments: { topic: { required: true } }, template: "Summarize {{topic}} for this tenant." },
  },
});
```

- Tool, resource and prompt names are lowercase snake_case, at most 61 characters, with no `.` and no `__`. Core exposes tools and prompts as `<moduleId>__<name>` (double underscore: the model APIs reject `.`), and the **whole wire name is at most 64 characters** (`MCP_WIRE_NAME_MAX`). That is the strictest client limit, OpenAI's function names (`[a-zA-Z0-9_-]`, max 64). The MCP spec and the Anthropic API currently allow 128. The module id counts against the 64, so a module `consent` has 55 characters left for each tool or prompt name; `defineModule` refuses longer ones, and so does core's registry. Module ids may contain `-` but never `_`, so the first `__` is always the separator. `mcpWireName` and `parseMcpWireName` build and split wire names; `mcpDisplayLabel` gives the dotted UI label (`ads.experiment.create`), which is display only.
- Resource URI templates are module-relative (`receipts/{id}`); core exposes them as `plant://<moduleId>/receipts/{id}` (`mcpResourceUri`). Each `{var}` matches one path segment, and resource params are a single safe path segment: after percent-decoding they are never empty, `.` or `..`, and never contain `/`, `\`, NUL or other control characters (so `%2F`, `%5C`, `%2E%2E`, `%00` and malformed `%` escapes are `not_found`). That makes them safe to use in R2 and D1 keys, but still scope keys by tenant.
- Input and output schemas are zod v4 object schemas (`zod` is a peer dependency), converted to JSON Schema draft 2020-12 at definition time. Input is parsed before `run`; output is checked after.
- `mcp()` returns an `McpExtensionDescriptor`: plain, frozen data that crosses Workers RPC. `mcpInvoke({ kind: "tool" | "resource" | "prompt", ... }, ctx)` returns an `McpInvocationResult`. Expected failures (`not_found`, `forbidden`, `draft_required`, `invalid_input`, `invalid_output`) come back as `{ ok: false, error }`; exceptions from your own code propagate.

## Privacy

Privacy deletions return a `DeletionProof`, which stores the subject only as a pseudonymous (keyed) hash: HMAC-SHA-256 under the tenant's subject key. That key lives in the plant's core and never reaches a module (a `CryptoKey` can't cross Workers RPC anyway). Privacy handlers get a `PrivacyContext`, and hash through `ctx.subjects`:

```ts
privacy: {
  async delete(subject, ctx, env) {
    const n = await deleteRows(env, ctx, subject);
    return ctx.subjects.deletionProof(subject, { deleted: [{ type: "consent.receipt", count: n }] });
  },
  async find(subject, ctx, env) {
    const hash = await ctx.subjects.hash(subject); // e.g. to look up rows stored by hash
    ...
  },
}
```

`ctx.subjects` calls core's Privacy entrypoint over the module's service binding `PLANT_PRIVACY` (`{ "binding": "PLANT_PRIVACY", "service": "<core>", "entrypoint": "Privacy" }`; the plant sets `props.moduleId`), passing `callbackContext(ctx)`. Core verifies the context capability, takes the tenant from it and the module from the binding, and returns only the hash or the proof. The hash is pseudonymous, not anonymous: whoever holds the plant's key can recompute it for a known subject.

`hashSubject` and `createDeletionProof` (which take a `subjectKey`) are for core and for tests. For tests the SDK also has an in-process path, `localSubjects({ moduleId, tenantId, subjectKey })`, and two stand-ins for core: `localPrivacyService` (in-process) and `MockCorePrivacy` (a `WorkerEntrypoint` to run as its own Worker in Miniflare, with a throwaway hex key in `PLANT_TEST_SUBJECT_KEY`). Both accept only the harness's unsigned test capabilities, so never deploy them.

`ctx.brand` is the tenant's resolved `Brand` (name, logo and favicon URLs, five colours plus optional `onPrimary` (text on a primary fill) and `danger` (errors), optional font, support email, email sender name, `poweredBy`). Modules style themselves only through the `--plant-*` CSS variables in `PLANT_CSS_VARS` (`--plant-primary`, `--plant-accent`, `--plant-bg`, `--plant-fg`, `--plant-muted`, `--plant-on-primary`, `--plant-danger`, `--plant-font`); `toCssVars(brand)` renders them as a CSS rule, leaving out the optional ones the brand doesn't set, and rejects values that aren't plain colours or font names. A `BrandLock` is the list of field paths (`"colors"`, `"colors.primary"`, `"logoUrl"`, ...) a parent tenant such as a franchisor locks for the tenants below it. Storing brands and resolving the layers is the private core's job.

Modules that need API keys declare them with `requiredKeys: [{ name, description, shared?, metered?, optional? }]` (names are UPPER_SNAKE_CASE). The plant stores the values. A `shared` key, such as an AI key, is set once for the whole plant and handed to every module that declares it. `metered` keys are tracked by the plant's usage caps. While a required key is missing, the plant reports the module as `needs-setup` (`ModuleKeyStatus`): it serves a setup page instead of the module and hides the module's MCP tools. The manifest leaves `requiredKeys` out when a module declares none. The SDK never stores key values.

Mark a key `optional: true` when only one feature needs it (a webhook signing secret, say). An optional key is declared like any other: it is listed in `ModuleKeyStatus.keys` with `optional: true` (so the plant's Keys page shows it) and delivered through `moduleKeys(ctx)` once set. It is never in `missing` and never makes the module `needs-setup`. While it is unset, `moduleKeys(ctx).get(name)` returns `undefined`, so the feature that needs it should answer "not configured" (a 503, for example) instead of calling `getOrThrow`. `moduleState(keys)` is the rule core and the harness share; `isOptionalKey(key)` reads the flag.

At request time the router resolves the module's keys and passes them to `handle`, `privacy().*`, `mcpInvoke`, `onEvent` and `onAgentTick` as a separate optional last argument, `keys`. They are never part of `SerializedPlantContext`. The module keeps only the names its manifest declares (its own keys and the shared keys it declared) and drops everything else. Handlers and agents read them with `moduleKeys(ctx)`: `get(name)` returns the value or `undefined` when the key isn't set, `getOrThrow(name)` throws instead, and both throw for a name the manifest doesn't declare. Because the values are read per request, a rotated key takes effect without a redeploy. The values are never stored on the context, and a `ModuleKeys` object serializes and prints as its key names only. Before anything leaves the module, key values are replaced with `[redacted:NAME]` in errors thrown out of an entry point and in MCP results. In tests, pass `keys` to `createAgentHarness` (or per run). Every name must be declared, so a typo fails. You can also attach fake keys to a hand-built context with `withModuleKeys(ctx, createModuleKeys(manifest, values, { strict: true }))`.

## Local dev and test harness

`createModuleHarness(target, options)` is a mock router for tests. `target` is a module Worker's service binding (in `@cloudflare/vitest-pool-workers` or Miniflare) or a `defineModule()` result run in-process. It builds the `PlantContext` (a fake principal, `HARNESS_BRAND`, the entitlements you pass), picks the app or public surface from `publicPrefixes`, and applies the Access, entitlement and needs-setup gates before calling `handle()`. The fake person's role is `owner` (`HARNESS_ROLE`) unless you pass `role` (per harness or per call; `null` means none). The harness applies the router's role gate (the default rule plus `roleRules`) and answers 403 with `x-plant-harness-gate: role`; pass `enforceRoles: false` to reach the module's own `requireRole` checks. Draft approval and rejection need role member or higher, as in core.

```ts
import { env } from "cloudflare:test";
import { createModuleHarness, type ModuleRpcTarget } from "@piquette/plant-sdk";

const plant = createModuleHarness(env.HELLO as unknown as ModuleRpcTarget, {
  entitlements: ["hello.basic"],
  keys: { HELLO_API_KEY: "test" }, // names only; a missing required (not optional) key means needs-setup
  subjectKey, // the throwaway key the mock core hashes with, to check deletion proofs
});

await plant.fetch("/");             // app route, as HARNESS_PRINCIPAL
await plant.fetch("/public/hello"); // public route, principal null
await plant.mcp.listTools();        // [{ name: "hello__list_entries", ... }]
await plant.mcp.callTool("hello__list_entries", { limit: 10 });
const draft = await plant.mcp.createDraft("hello__add_entry", input, { createdBy: agentPrincipal("hello", "greeter", "t_test") });
await plant.mcp.approveDraft(draft.id); // runs the write tool with draftId
const proof = await plant.privacy.delete({ email: "a@example.com" });
await plant.privacy.verifyProof(proof, { email: "a@example.com" }); // true
```

Every context the harness builds carries an unsigned test capability, so `callbackContext(ctx)` works. With `subjectKey`, an in-process module gets `localPrivacyService` as `env.PLANT_PRIVACY`, so `ctx.subjects` works with no setup. A module Worker needs its `PLANT_PRIVACY` binding pointed at a `MockCorePrivacy` Worker holding the same key ([`examples/hello-module/vitest.config.ts`](examples/hello-module/vitest.config.ts) shows how).

Responses the harness makes up itself (401 Access, 403 entitlements, 503 needs-setup) carry `x-plant-harness-gate`. It has no Access JWTs, stored keys or persistence: core stays the source of truth for those rules. [`examples/hello-module`](examples/hello-module) is a complete module tested this way.

This package must never import a private `@piquette/plant-*` package. CI enforces it with `npm run check:imports`: `src/` and `dist/` may import only relative paths, `node:*`, `cloudflare:*`, `zod` and the SDK itself.

## Agents

A module can declare proactive agents. The SDK carries only the manifest entries, the types and the conventions; the agent runtime (Flue, Durable Objects, Workflows) is the module's own dependency.

```ts
const ads = defineModule<Env>({
  id: "ads",
  // ...
  agents: [
    {
      name: "tracker",
      schedule: "0 6 * * *", // 5-field cron, UTC
      listens: ["ads.campaign-changed"],
      // Keep it thin: start a Workflow, or dispatch.
      onSchedule: (tick, ctx, env) =>
        env.SWEEP.create({ id: `sweep-${ctx.tenant.id}-${ctx.initialData.runId}`, params: ctx.initialData }),
      onEvent: (event, ctx, env) =>
        dispatch(Tracker, {
          id: ctx.conversationId, // `<tenant>.events-<YYYY-MM-DD>`
          idempotencyKey: ctx.idempotencyKey, // `event:<tenant>:<module>/<agent>:<event.id>`
          initialData: ctx.initialData,
          message: { kind: "signal", type: event.type, body: JSON.stringify(event.data) },
        }),
    },
  ],
});
```

The conventions:

- Conversation ids are tenant-scoped, `<tenantId>.<rest>`. Check every id a caller sends with `conversationBelongsTo(id, tenantId)` against the tenant the router resolved.
- Scheduled work gets a new conversation per run, `<tenantId>.sweep-<YYYY-MM-DD>` (`sweepConversationId`), seeded with `ctx.initialData`. Durable facts live in tenant-scoped tables, not in the transcript. Events go to `<tenantId>.events-<YYYY-MM-DD>`. Only the interactive inbox has a fixed id, `<tenantId>.inbox`.
- Every dispatch carries `ctx.idempotencyKey` (`schedule:<tenantId>:<moduleId>/<agent>:<scheduledAt>` or `event:<tenantId>:<moduleId>/<agent>:<event.id>`), so redelivery converges on one submission. The key names the tenant, module and agent, so it never collides across tenants or modules, even where ids are global.
- Agents act as an `AgentPrincipal` (`{ kind: "agent", module, agent, tenantId }`). `isAgentPrincipal` and `actorId` (`agent:<module>/<agent>` vs `person:<email>`) let audits and entitlements tell agents from people.
- Agents propose, people decide: a `Proposal` (title, body, evidence links, an optional `suggestedToolCall` (`<moduleId>__<tool>`, or a bare name for the proposing module's own tool) that runs as a draft, severity, an optional `dedupeKey`) goes to the inbox. Check one with `validateProposal`.

Over RPC, core calls `onAgentTick(agent, tick, scope)` per tenant, and `onEvent` delivers to the module's own handler and to every agent that listens for the type.

Test agents without Workers, cron or an event bus:

```ts
const harness = createAgentHarness(ads, { env: fakeEnv, tenant: { id: "t_1", hostname: "acme.test" } });
const run = await harness.tick("tracker", { scheduledAt: "2026-11-04T06:00:00Z" });
run.context.conversationId; // "t_1.sweep-2026-11-04"
await harness.event("tracker", { id: "evt_1", type: "ads.campaign-changed", data: {} });
```

## Developing this repo

```sh
npm ci
npm run check:imports
npm run typecheck
npm test     # the SDK's unit and type tests, then the example module in local workerd
npm run build
```

Tests run offline. The example's tests use Miniflare with no wrangler config and no account credentials.
