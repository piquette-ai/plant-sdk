// The SDK's mock of core's Privacy entrypoint, run as its own Worker in the
// tests (see vitest.config.ts). It accepts only the harness's unsigned
// capabilities, so it is test tooling: never deploy it.
export { MockCorePrivacy } from "@piquette/plant-sdk";
export default { fetch: () => new Response("mock core", { status: 404 }) };
