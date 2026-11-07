import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/check-imports.mjs", import.meta.url));
const dirs: string[] = [];

function fixture(files: Record<string, string>, pkg: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "plant-sdk-imports-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", ...pkg }));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

function check(dir: string) {
  const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("check-imports", () => {
  it("passes the SDK and the example as they are", () => {
    const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("allows relative, built-in, zod and SDK imports at runtime", () => {
    const dir = fixture({
      "src/a.ts": `import "./b.js"; import "node:url"; import "cloudflare:workers"; import * as z from "zod"; import "zod/v4/core"; import "@piquette/plant-sdk";`,
      "src/b.ts": "export {};",
    });
    expect(check(dir).status).toBe(0);
  });

  it("refuses private @piquette packages anywhere", () => {
    const dir = fixture({ "test/a.test.ts": `import "@piquette/plant-internal";` }, { devDependencies: { "@piquette/plant-internal": "0.1.0" } });
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`imports private package "@piquette/plant-internal"`);
    expect(r.out).toContain(`depends on private package "@piquette/plant-internal"`);
  });

  it("refuses other packages in src and dist, even when declared", () => {
    const dir = fixture(
      { "src/a.ts": `import "hono";`, "dist/a.d.ts": `export * from "hono";` },
      { dependencies: { hono: "4.0.0" } },
    );
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`src/a.ts: "hono" is not allowed at runtime`);
    expect(r.out).toContain(`dist/a.d.ts: "hono" is not allowed at runtime`);
  });

  it("refuses imports that leave the package, absolute paths and undeclared test deps", () => {
    const dir = fixture({
      "src/a.ts": `import "../../private/src/index.js";`,
      "src/b.ts": `import "/home/someone/x.js";`,
      "test/a.test.ts": `import "left-pad";`,
    });
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("reaches outside the package");
    expect(r.out).toContain("absolute import");
    expect(r.out).toContain(`"left-pad" is not declared in package.json`);
  });
});
