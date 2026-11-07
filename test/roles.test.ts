import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  defineMcpExtension,
  createModuleHarness,
  createPlantContext,
  defineModule,
  HARNESS_GATE_HEADER,
  HARNESS_ROLE,
  hasRole,
  MEMBER_ROLES,
  ModuleDefinitionError,
  requiredRoleFor,
  requireRole,
  RoleError,
  roleAtLeast,
  roleOf,
  roleResponse,
  serializePlantContext,
  type MemberRole,
  type PlantContext,
} from "../src/index.js";
import { appCtx, baseDef } from "./fixtures.js";

const withRole = (role: MemberRole | undefined, surface: "app" | "mcp" = "app") =>
  createPlantContext({ ...appCtx, surface, principal: { ...appCtx.principal!, ...(role ? { role } : {}) } });

describe("roles", () => {
  it("ranks viewer < member < admin < owner", () => {
    expect(MEMBER_ROLES).toEqual(["viewer", "member", "admin", "owner"]);
    expect(roleAtLeast("member", "member")).toBe(true);
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("viewer", "member")).toBe(false);
    expect(roleAtLeast(null, "viewer")).toBe(false);
    expect(roleAtLeast("root" as MemberRole, "viewer")).toBe(false);
    expect(() => roleAtLeast("member", "root" as MemberRole)).toThrow(TypeError);
  });

  it("requireRole refuses a viewer, a missing role, nobody and an agent with a 403", async () => {
    expect(requireRole(withRole("member"), "member")).toBe("member");
    expect(hasRole(withRole("admin"), "member")).toBe(true);
    for (const ctx of [
      withRole("viewer"),
      withRole(undefined),
      createPlantContext({ ...appCtx, principal: null, surface: "public" }),
      { principal: { kind: "agent", module: "consent", agent: "a", tenantId: "t_1" } } as unknown as PlantContext,
      { principal: { kind: "agent", role: "owner" } } as unknown as PlantContext,
    ]) {
      expect(() => requireRole(ctx, "member")).toThrow(RoleError);
      const res = roleResponse(ctx, "member")!;
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "insufficient_role", required: "member" });
    }
    expect(roleResponse(withRole("owner"), "admin")).toBeNull();
    try {
      requireRole(withRole("viewer"), "member");
    } catch (err) {
      expect(err).toBeInstanceOf(RoleError);
      expect((err as RoleError).status).toBe(403);
      expect((err as RoleError).actual).toBe("viewer");
      expect((err as Error).message).not.toContain("ops@acme");
    }
  });

  it("createPlantContext keeps the role only on surface app, and rejects unknown roles", () => {
    expect(roleOf(withRole("admin"))).toBe("admin");
    expect(withRole("admin", "mcp").principal).toEqual({ email: "ops@acme.example.com", groups: ["admins"] });
    expect(roleOf(withRole("admin", "mcp"))).toBeNull();
    expect(() => withRole("root" as MemberRole)).toThrow(/unknown role/);
    // Round trip keeps it.
    expect(serializePlantContext(withRole("member")).principal?.role).toBe("member");
  });

  it("requiredRoleFor: default by method, longest prefix wins at a segment boundary", () => {
    const rules = [
      { prefix: "/settings", minRole: "admin" as const },
      { prefix: "/settings/billing", methods: ["POST"], minRole: "owner" as const },
      { prefix: "/feedback", methods: ["POST"], minRole: "viewer" as const },
    ];
    expect(requiredRoleFor("GET", "/")).toBe("viewer");
    expect(requiredRoleFor("post", "/")).toBe("member");
    expect(requiredRoleFor("DELETE", "/x")).toBe("member");
    expect(requiredRoleFor("GET", "/settings", rules)).toBe("admin");
    expect(requiredRoleFor("GET", "/settingsx", rules)).toBe("viewer");
    expect(requiredRoleFor("POST", "/settings/billing/card", rules)).toBe("owner");
    expect(requiredRoleFor("GET", "/settings/billing", rules)).toBe("admin");
    expect(requiredRoleFor("POST", "/feedback", rules)).toBe("viewer");
  });

  it("defineModule validates roleRules and puts them in the manifest", () => {
    const m = defineModule(baseDef({ roleRules: [{ prefix: "/settings", methods: ["POST"], minRole: "admin" }] }));
    expect(m.manifest.roleRules).toEqual([{ prefix: "/settings", methods: ["POST"], minRole: "admin" }]);
    expect(defineModule(baseDef()).manifest).not.toHaveProperty("roleRules");
    const bad = [
      [{ prefix: "settings", minRole: "admin" }],
      [{ prefix: "/s", minRole: "root" }],
      [{ prefix: "/s", methods: ["post"], minRole: "admin" }],
      [{ prefix: "/s", methods: [], minRole: "admin" }],
      [
        { prefix: "/s", minRole: "admin" },
        { prefix: "/s", minRole: "owner" },
      ],
    ];
    for (const roleRules of bad) {
      expect(() => defineModule(baseDef({ roleRules: roleRules as never }))).toThrow(ModuleDefinitionError);
    }
  });
});

describe("harness roles", () => {
  function boardModule() {
    const seen: PlantContext[] = [];
    const mod = defineModule(
      baseDef({
        id: "board",
        roleRules: [
          { prefix: "/settings", minRole: "admin" },
          { prefix: "/vote", methods: ["POST"], minRole: "viewer" },
        ],
        handle: (request, ctx) => {
          seen.push(ctx);
          if (request.method === "POST") {
            const denied = roleResponse(ctx, "member");
            if (denied) return denied;
          }
          return Response.json({ role: roleOf(ctx) });
        },
      }),
    );
    return { mod, seen };
  }

  it("gives the module the role on app routes (owner by default)", async () => {
    const { mod, seen } = boardModule();
    const plant = createModuleHarness(mod);
    expect(HARNESS_ROLE).toBe("owner");
    expect(await (await plant.fetch("/")).json()).toEqual({ role: "owner" });
    expect(seen[0]!.principal?.role).toBe("owner");
    const viewer = await plant.fetch("/", {}, { role: "viewer" });
    expect(await viewer.json()).toEqual({ role: "viewer" });
    expect((await plant.context("mcp")).principal).not.toHaveProperty("role");
    // A role on a principal passed in is replaced by the harness's role.
    const ctx = await plant.context("app", { principal: { email: "x@y.z", groups: [], role: "owner" }, role: "viewer" });
    expect(ctx.principal?.role).toBe("viewer");
  });

  it("requireRole refuses a viewer on a mutating route (the module's own check)", async () => {
    const { mod } = boardModule();
    const plant = createModuleHarness(mod, { role: "viewer", enforceRoles: false });
    const res = await plant.fetch("/items", { method: "POST" });
    expect(res.status).toBe(403);
    expect(res.headers.get(HARNESS_GATE_HEADER)).toBeNull(); // the module answered, not the harness
    expect(await res.json()).toEqual({ error: "insufficient_role", required: "member" });
    expect((await plant.fetch("/items", { method: "POST" }, { role: "member" })).status).toBe(200);
    expect((await plant.fetch("/items")).status).toBe(200); // GET is fine for a viewer
    expect((await plant.fetch("/items", { method: "POST" }, { role: null })).status).toBe(403);
  });

  it("applies the router's role gate with the manifest's roleRules", async () => {
    const { mod, seen } = boardModule();
    const plant = createModuleHarness(mod, { role: "viewer" });
    const post = await plant.fetch("/items", { method: "POST" });
    expect(post.status).toBe(403);
    expect(post.headers.get(HARNESS_GATE_HEADER)).toBe("role");
    expect(await post.json()).toEqual({ error: "insufficient_role", required: "member" });
    expect(seen).toHaveLength(0);
    expect((await plant.fetch("/settings", {}, { role: "member" })).status).toBe(403);
    expect((await plant.fetch("/settings", {}, { role: "admin" })).status).toBe(200);
    // The manifest lets a viewer reach POST /vote; the module's own check still refuses.
    const vote = await plant.fetch("/vote", { method: "POST" });
    expect(vote.status).toBe(403);
    expect(vote.headers.get(HARNESS_GATE_HEADER)).toBeNull();
  });

  it("draft approval and rejection need role member or higher", async () => {
    const mcp = defineMcpExtension()({
      tools: { put: { description: "Write", input: z.object({}), write: true, run: () => ({ done: true }) } },
    });
    const plant = createModuleHarness(defineModule(baseDef({ id: "board", mcp })));
    const approver = { email: "boss@acme.example.com", groups: [] };
    const d1 = await plant.mcp.createDraft("board__put");
    await expect(plant.mcp.approveDraft(d1.id, { approver, role: "viewer" })).rejects.toThrow(/insufficient_role/);
    await expect(plant.mcp.rejectDraft(d1.id, { approver, role: "viewer" })).rejects.toThrow(/insufficient_role/);
    expect((await plant.mcp.approveDraft(d1.id, { approver, role: "member" })).ok).toBe(true);
  });
});
