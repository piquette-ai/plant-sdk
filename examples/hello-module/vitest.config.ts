import { fileURLToPath } from "node:url";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { build } from "esbuild";

// Tests run in local workerd (Miniflare). The hello module runs as its own
// Worker, and the test Worker reaches it over a service binding, the way the
// plant's router does. There is no wrangler config and no remote binding, so
// nothing here can reach a Cloudflare account. As a second guard, wrangler
// gets an empty config dir and no API token.
process.env.XDG_CONFIG_HOME = fileURLToPath(new URL("./.wrangler/no-auth-config", import.meta.url));
process.env.CLOUDFLARE_API_TOKEN = "";
process.env.CLOUDFLARE_ACCOUNT_ID = "";
process.env.WRANGLER_SEND_METRICS = "false";

const sdkSource = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const compatibilityDate = "2026-03-01";
// A throwaway test key (32 bytes, hex), not a secret. Only the mock core and
// the test (to check proofs) get it.
const TEST_SUBJECT_KEY = "68656c6c6f2d6d6f64756c652d746573742d7375626a6563742d6b65792d3332";

const bundle = async (entry: string) =>
  (
    await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      write: false,
      external: ["cloudflare:*"],
      alias: { "@piquette/plant-sdk": sdkSource },
      logLevel: "silent",
    })
  ).outputFiles[0]!.text;

export default defineWorkersConfig(async () => {
  const [helloScript, mockCoreScript] = await Promise.all([bundle("./src/index.ts"), bundle("./test/mock-core.ts")]);
  return {
    resolve: { alias: { "@piquette/plant-sdk": sdkSource } },
    test: {
      include: ["test/**/*.test.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          miniflare: {
            compatibilityDate,
            compatibilityFlags: ["nodejs_compat"],
            serviceBindings: { HELLO: "hello" },
            bindings: { TEST_SUBJECT_KEY },
            workers: [
              {
                name: "hello",
                modules: true,
                script: helloScript,
                compatibilityDate,
                kvNamespaces: ["GREETINGS"],
                // As in the plant: a binding to core's Privacy entrypoint, here the
                // SDK's mock core. The module itself holds no subject key.
                serviceBindings: {
                  PLANT_PRIVACY: { name: "mock-core", entrypoint: "MockCorePrivacy", props: { moduleId: "hello" } },
                },
              },
              {
                name: "mock-core",
                modules: true,
                script: mockCoreScript,
                compatibilityDate,
                bindings: { PLANT_TEST_SUBJECT_KEY: TEST_SUBJECT_KEY },
              },
            ],
          },
        },
      },
    },
  };
});
