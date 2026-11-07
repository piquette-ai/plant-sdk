import { describe, expectTypeOf, it } from "vitest";
import { toCssVars, type Brand, type BrandFieldPath, type BrandLock, type PlantContext } from "../src/index.js";

describe("brand types", () => {
  it("BrandLock only takes known field paths", () => {
    expectTypeOf<BrandLock>().toEqualTypeOf<readonly BrandFieldPath[]>();
    expectTypeOf<"colors.primary">().toExtend<BrandFieldPath>();
    expectTypeOf<"colors">().toExtend<BrandFieldPath>();
    expectTypeOf<"poweredBy">().toExtend<BrandFieldPath>();
    expectTypeOf<"tokens">().not.toExtend<BrandFieldPath>();
    expectTypeOf<"colors.secondary">().not.toExtend<BrandFieldPath>();
    expectTypeOf<"colors.onPrimary">().toExtend<BrandFieldPath>();
    expectTypeOf<"colors.danger">().toExtend<BrandFieldPath>();
  });

  it("PlantContext carries the Brand, which has no free-form tokens", () => {
    expectTypeOf<PlantContext["brand"]>().toEqualTypeOf<Brand>();
    expectTypeOf<Brand>().not.toHaveProperty("tokens");
    expectTypeOf<Brand["font"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Brand["poweredBy"]>().toEqualTypeOf<boolean>();
    // Additive and optional, so brands from before them still type-check.
    expectTypeOf<Brand["colors"]["onPrimary"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Brand["colors"]["danger"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf(toCssVars).returns.toEqualTypeOf<string>();
  });
});
