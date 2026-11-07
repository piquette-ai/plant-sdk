import { describe, expect, it } from "vitest";
import { createPlantContext, entitlementsFrom, serializePlantContext } from "../src/index.js";
import { appCtx, publicCtx } from "./fixtures.js";

describe("createPlantContext", () => {
  it("hydrates entitlements into has()", () => {
    const ctx = createPlantContext(appCtx);
    expect(ctx.entitlements.has("consent.pro")).toBe(true);
    expect(ctx.entitlements.has("ads.pro")).toBe(false);
    expect(ctx.tenant.parentId).toBe("t_root");
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it("allows a null principal on public routes", () => {
    expect(createPlantContext(publicCtx).principal).toBeNull();
  });

  it("requires a principal on the app surface", () => {
    expect(() => createPlantContext({ ...appCtx, principal: null })).toThrow(/requires a principal/);
  });

  it("rejects unknown surfaces and bad base paths", () => {
    expect(() => createPlantContext({ ...appCtx, surface: "admin" as never })).toThrow(/surface/);
    expect(() => createPlantContext({ ...appCtx, basePath: "/consent/" })).toThrow(/basePath/);
    expect(() => createPlantContext({ ...appCtx, basePath: "consent" })).toThrow(/basePath/);
    expect(createPlantContext({ ...appCtx, basePath: "" }).basePath).toBe("");
  });

  it("round-trips through serializePlantContext", () => {
    const wire = serializePlantContext(createPlantContext(appCtx));
    expect(wire).toEqual({ ...appCtx, entitlements: ["consent.basic", "consent.pro"] });
    expect(() => structuredClone(wire)).not.toThrow();
  });

  it("needs explicit keys for custom Entitlements", () => {
    const ctx = { ...createPlantContext(appCtx), entitlements: { has: () => true } };
    expect(() => serializePlantContext(ctx)).toThrow(/entitlementKeys/);
    expect(serializePlantContext(ctx, ["x.y"]).entitlements).toEqual(["x.y"]);
  });

  it("entitlementsFrom de-duplicates keys", () => {
    expect(entitlementsFrom(["b", "a", "b"]).keys()).toEqual(["a", "b"]);
  });
});
