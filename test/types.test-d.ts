import type { WorkerEntrypoint } from "cloudflare:workers";
import { describe, expectTypeOf, it } from "vitest";
import * as z from "zod";
import {
  type KeyValues,
  createDeletionProof,
  defineMcpExtension,
  defineModule,
  hashSubject,
  moduleEntrypoint,
  type Actor,
  type AgentManifestEntry,
  type AgentPrincipal,
  type DefinedModule,
  type DeletionProof,
  type Entitlements,
  type McpExtension,
  type McpExtensionDescriptor,
  type McpInvocation,
  type McpInvocationResult,
  type ModuleManifest,
  type PlantContext,
  type PlantModule,
  type PrivacyHandlers,
  type Proposal,
  type MemberRole,
  type Principal,
  type SubjectKey,
  type Surface,
} from "../src/index.js";

describe("contract types", () => {
  it("PlantContext has the documented shape", () => {
    expectTypeOf<PlantContext["tenant"]>().toEqualTypeOf<{
      readonly id: string;
      readonly hostname: string;
      readonly parentId?: string;
    }>();
    expectTypeOf<PlantContext["principal"]>().toEqualTypeOf<Principal | null>();
    expectTypeOf<Principal["groups"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Principal["role"]>().toEqualTypeOf<MemberRole | undefined>();
    expectTypeOf<MemberRole>().toEqualTypeOf<"owner" | "admin" | "member" | "viewer">();
    expectTypeOf<PlantContext["entitlements"]>().toEqualTypeOf<Entitlements>();
    expectTypeOf<Entitlements["has"]>().toEqualTypeOf<(key: string) => boolean>();
    expectTypeOf<PlantContext["basePath"]>().toEqualTypeOf<string>();
    expectTypeOf<Surface>().toEqualTypeOf<"app" | "public" | "mcp">();
  });

  it("ModuleManifest has the documented keys", () => {
    expectTypeOf<keyof ModuleManifest>().toEqualTypeOf<
      "id" | "name" | "version" | "coreRange" | "nav" | "publicPrefixes" | "requires" | "settings" | "events" | "requiredKeys" | "agents" | "roleRules"
    >();
    expectTypeOf<ModuleManifest["events"]>().toEqualTypeOf<{
      readonly emits: readonly string[];
      readonly listens: readonly string[];
    }>();
  });

  it("PrivacyHandlers.delete returns a DeletionProof", () => {
    expectTypeOf<keyof PrivacyHandlers>().toEqualTypeOf<"find" | "export" | "delete" | "verify">();
    expectTypeOf<ReturnType<PrivacyHandlers["delete"]>>().toEqualTypeOf<Promise<DeletionProof>>();
  });

  it("subject hashing requires a key", () => {
    expectTypeOf(hashSubject).parameters.toEqualTypeOf<[subject: { readonly email?: string; readonly userId?: string; readonly identifiers?: Readonly<Record<string, string>> }, subjectKey: SubjectKey]>();
    expectTypeOf<SubjectKey>().toEqualTypeOf<CryptoKey | ArrayBuffer>();
    // @ts-expect-error a subject key is required
    void hashSubject({ email: "a@b.c" });
    // @ts-expect-error a string is not a key
    void hashSubject({ email: "a@b.c" }, "secret");
    // @ts-expect-error createDeletionProof needs subjectKey
    void createDeletionProof({ moduleId: "m", tenantId: "t", subject: { userId: "u" }, deleted: [] });
    expectTypeOf<DeletionProof["subjectHashAlgorithm"]>().toEqualTypeOf<"HMAC-SHA-256">();
  });

  it("defineModule threads Env through handlers", () => {
    type Env = { DB: D1Database };
    const mod = defineModule<Env>({
      id: "consent",
      name: "Consent",
      version: "0.1.0",
      coreRange: "^0.1.0",
      handle: (_req, ctx, env) => {
        expectTypeOf(env).toEqualTypeOf<Env>();
        expectTypeOf(ctx).toEqualTypeOf<PlantContext>();
        return new Response();
      },
    });
    expectTypeOf(mod).toEqualTypeOf<DefinedModule<Env>>();
    expectTypeOf(mod.manifest).toEqualTypeOf<ModuleManifest>();
  });

  it("rejects definitions missing required fields", () => {
    // @ts-expect-error coreRange is required
    defineModule({ id: "x", name: "X", version: "0.1.0", handle: () => new Response() });
    // @ts-expect-error handle must return a Response
    defineModule({ id: "x", name: "X", version: "0.1.0", coreRange: "^0.1.0", handle: () => "nope" });
  });

  it("PlantModule is a WorkerEntrypoint with the RPC methods", () => {
    expectTypeOf<PlantModule>().toMatchTypeOf<WorkerEntrypoint<unknown>>();
    expectTypeOf<PlantModule["manifest"]>().returns.toEqualTypeOf<ModuleManifest | Promise<ModuleManifest>>();
    expectTypeOf<PlantModule["handle"]>().returns.toEqualTypeOf<Promise<Response>>();
    expectTypeOf<PlantModule["privacy"]>().toBeNullable();
    expectTypeOf<PlantModule["mcp"]>().toBeNullable();
    expectTypeOf<NonNullable<PlantModule["mcp"]>>().returns.toEqualTypeOf<McpExtensionDescriptor>();
    expectTypeOf<PlantModule["mcpInvoke"]>().toBeNullable();
    expectTypeOf<NonNullable<PlantModule["mcpInvoke"]>>().parameters.toMatchTypeOf<[McpInvocation, unknown, KeyValues?]>();
    expectTypeOf<NonNullable<PlantModule["mcpInvoke"]>>().returns.toEqualTypeOf<Promise<McpInvocationResult>>();
    expectTypeOf<PlantModule["onEvent"]>().toBeNullable();
    const Entry = moduleEntrypoint(defineModule({ id: "x", name: "X", version: "0.1.0", coreRange: "^0.1.0", handle: () => new Response() }));
    expectTypeOf<InstanceType<typeof Entry>>().toMatchTypeOf<PlantModule<unknown>>();
  });

  it("defineMcpExtension infers tool input from zod and threads Env", () => {
    type Env = { DB: D1Database };
    const ext = defineMcpExtension<Env>()({
      tools: {
        list: {
          description: "d",
          input: z.object({ limit: z.number().default(10), q: z.string().optional() }),
          run: (input, ctx, env, call) => {
            expectTypeOf(input).toEqualTypeOf<{ limit: number; q?: string | undefined }>();
            expectTypeOf(ctx).toEqualTypeOf<PlantContext>();
            expectTypeOf(env).toEqualTypeOf<Env>();
            expectTypeOf(call.draftId).toEqualTypeOf<string | undefined>();
            return [];
          },
        },
      },
      prompts: { p: { template: "x" } },
    });
    expectTypeOf(ext).toEqualTypeOf<McpExtension<Env>>();
    defineModule<Env>({ id: "x", name: "X", version: "0.1.0", coreRange: "^0.1.0", handle: () => new Response(), mcp: ext });

    defineMcpExtension({
      // @ts-expect-error run's input is typed from the schema
      tools: { t: { description: "d", input: z.object({ s: z.string() }), run: (input: { s: number }) => input } },
    });
    // @ts-expect-error a hand-written object is not an McpExtension
    defineModule({ id: "x", name: "X", version: "0.1.0", coreRange: "^0.1.0", handle: () => new Response(), mcp: { descriptor: { tools: [], resources: [], prompts: [] }, invoke: async () => ({ ok: true, kind: "tool", output: 1 }) } });
  });

  it("agent conventions have the documented shape", () => {
    expectTypeOf<AgentPrincipal>().toEqualTypeOf<{
      readonly kind: "agent";
      readonly module: string;
      readonly agent: string;
      readonly tenantId: string;
    }>();
    expectTypeOf<Actor>().toEqualTypeOf<Principal | AgentPrincipal>();
    expectTypeOf<ModuleManifest["agents"]>().toEqualTypeOf<readonly AgentManifestEntry[] | undefined>();
    expectTypeOf<keyof Proposal>().toEqualTypeOf<
      "title" | "body" | "evidence" | "suggestedToolCall" | "severity" | "dedupeKey"
    >();
    expectTypeOf<Proposal["severity"]>().toEqualTypeOf<"info" | "low" | "medium" | "high" | "critical">();
    expectTypeOf<PlantModule["onAgentTick"]>().toBeNullable();
    // @ts-expect-error a schedule needs a cron string
    defineModule({ id: "x", name: "X", version: "0.1.0", coreRange: "^0.1.0", handle: () => new Response(), agents: [{ name: "a", schedule: 5 }] });
  });
});
