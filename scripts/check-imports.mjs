#!/usr/bin/env node
// Fails when the public SDK, or the example module built on it, imports
// anything it shouldn't.
//
// Usage: node scripts/check-imports.mjs            (checks the targets below)
//        node scripts/check-imports.mjs <dir>...   (checks other package dirs,
//                                                   used by the checker's tests)
//
// Runtime files (src/ and dist/, including .d.ts) may import only:
//   - relative paths that stay inside the package directory
//   - `node:*` and `cloudflare:*` built-ins
//   - `zod` (and its subpaths)
//   - `@piquette/plant-sdk` (the SDK itself)
// Everything else in the package (tests, configs) may also import packages
// declared in its own package.json, but never another `@piquette/*` package.
// package.json may not depend on any `@piquette/*` package other than the SDK.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SDK = "@piquette/plant-sdk";
const EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".wrangler", ".git", "examples", "scripts"]);
const BUILTIN = /^(node|cloudflare):/;
const PIQUETTE_SCOPE = /^@piquette\//;
const RUNTIME_ALLOWED = new Set(["zod", SDK]);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TARGETS = [repoRoot, join(repoRoot, "examples", "hello-module")];

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.test(entry)) out.push(full);
  }
  return out;
}

export function checkPackage(pkgDirArg) {
  const pkgDir = resolve(pkgDirArg);
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const declared = new Set(
    ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"].flatMap((f) =>
      Object.keys(pkg[f] ?? {}),
    ),
  );
  const violations = [];

  for (const name of declared) {
    if (PIQUETTE_SCOPE.test(name) && name !== SDK) {
      violations.push(`package.json: depends on private package "${name}"`);
    }
  }

  for (const file of walk(pkgDir)) {
    const rel = relative(pkgDir, file);
    const runtime = rel.startsWith(`src${sep}`) || rel.startsWith(`dist${sep}`);
    const info = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    const specifiers = [
      ...info.importedFiles.map((f) => f.fileName),
      ...info.referencedFiles.map((f) => f.fileName),
      ...info.typeReferenceDirectives.map((f) => f.fileName),
    ];
    for (const spec of specifiers) {
      if (BUILTIN.test(spec)) continue;
      if (spec.startsWith("/")) {
        violations.push(`${rel}: absolute import "${spec}"`);
        continue;
      }
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (target !== pkgDir && !target.startsWith(pkgDir + sep)) {
          violations.push(`${rel}: "${spec}" reaches outside the package`);
        }
        continue;
      }
      const name = packageName(spec);
      if (PIQUETTE_SCOPE.test(name) && name !== SDK) {
        violations.push(`${rel}: imports private package "${spec}"`);
      } else if (runtime && !RUNTIME_ALLOWED.has(name)) {
        violations.push(`${rel}: "${spec}" is not allowed at runtime (only relative, node:*, cloudflare:*, zod, ${SDK})`);
      } else if (!runtime && name !== SDK && !declared.has(name)) {
        violations.push(`${rel}: "${spec}" is not declared in package.json`);
      }
    }
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dirs = args.length > 0 ? args : DEFAULT_TARGETS;
  let failed = false;
  for (const dir of dirs) {
    if (!existsSync(join(dir, "package.json"))) {
      console.error(`${dir}: no package.json`);
      failed = true;
      continue;
    }
    const label = relative(process.cwd(), dir) || ".";
    const violations = checkPackage(dir);
    if (violations.length > 0) {
      failed = true;
      console.error(`${label}: ${violations.length} forbidden import(s)`);
      for (const v of violations) console.error(`  - ${v}`);
    } else {
      console.log(`${label}: ok, no private imports`);
    }
  }
  process.exit(failed ? 1 : 0);
}
