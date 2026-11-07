import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests run in Node. `cloudflare:workers` only exists inside workerd, so
// it is aliased to a minimal stand-in; the real types come from
// @cloudflare/workers-types during typecheck.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./test/support/cloudflare-workers.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    typecheck: { include: ["test/**/*.test-d.ts"], tsconfig: "./tsconfig.json" },
  },
});
