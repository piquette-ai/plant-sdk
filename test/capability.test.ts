import { describe, expect, it } from "vitest";
import {
  callbackContext,
  capabilityOf,
  createAgentHarness,
  createPlantContext,
  defineModule,
  moduleEntrypoint,
  redactContext,
  serializePlantContext,
  type AgentContext,
  type ContextCapability,
  type PlantContext,
} from "../src/index.js";
import { appCtx, baseDef } from "./fixtures.js";

const cap = "pcap1.opaque.capability" as ContextCapability;
const wire = { ...appCtx, capability: cap };

describe("context capabilities in the SDK", () => {
  it("keeps the capability off the PlantContext, so logging it never prints it", () => {
    const ctx = createPlantContext(wire);
    expect(Object.keys(ctx)).not.toContain("capability");
    expect(JSON.stringify(ctx)).not.toContain(cap);
    expect(capabilityOf(ctx)).toBe(cap);
  });

  it("round-trips the capability through serializePlantContext untouched", () => {
    expect(serializePlantContext(createPlantContext(wire)).capability).toBe(cap);
    expect("capability" in serializePlantContext(createPlantContext(appCtx))).toBe(false);
  });

  it("callbackContext hands back the tenant and the capability, nothing else", () => {
    const back = callbackContext(createPlantContext(wire));
    expect(back).toEqual({ tenant: { id: "t_1" }, capability: cap });
    expect(callbackContext(wire)).toEqual(back);
  });

  it("callbackContext refuses a context with no capability", () => {
    expect(() => callbackContext(createPlantContext(appCtx))).toThrow(/no capability/);
  });

  it("redactContext strips the capability for logs", () => {
    const safe = redactContext(wire);
    expect(safe).not.toHaveProperty("capability");
    expect(JSON.stringify(safe)).not.toContain(cap);
  });

  it("PlantModule.handle gives the module a context that carries the capability", async () => {
    const seen: PlantContext[] = [];
    const Entry = moduleEntrypoint(
      defineModule({ ...baseDef(), handle: (_r, ctx) => (seen.push(ctx), new Response("ok")) }),
    );
    await new Entry({} as ExecutionContext, {}).handle(new Request("https://acme.example.com/consent"), wire);
    expect(callbackContext(seen[0]!).capability).toBe(cap);
  });

  it("agent runs carry the capability core minted for the scope, and event deliveries pass theirs on", async () => {
    const contexts: AgentContext[] = [];
    const mod = defineModule({
      ...baseDef(),
      agents: [
        { name: "sweeper", schedule: "0 6 * * *", onSchedule: (_t, ctx) => void contexts.push(ctx) },
        { name: "watcher", listens: ["ads.changed"], onEvent: (_e, ctx) => void contexts.push(ctx) },
      ],
    });
    const worker = new (moduleEntrypoint(mod))({} as ExecutionContext, {});
    const agentCap = "pcap1.agent" as ContextCapability;
    await worker.onAgentTick!(
      "sweeper",
      { cron: "0 6 * * *", scheduledAt: "2026-11-04T06:00:00.000Z" },
      { tenant: { id: "t_1", hostname: "acme.example.com" }, entitlements: [], capability: agentCap },
    );
    await worker.onEvent!(
      { id: "evt_1", type: "ads.changed", tenantId: "t_1", source: "ads", occurredAt: "2026-11-04T06:00:00.000Z", data: {} },
      wire,
    );
    expect(callbackContext(contexts[0]!).capability).toBe(agentCap);
    expect(callbackContext(contexts[1]!).capability).toBe(cap);
    expect(JSON.stringify(contexts[0])).not.toContain(agentCap);

    // The harness has no core, so its contexts carry no capability.
    const run = await createAgentHarness(mod, { env: {} }).tick("sweeper");
    expect(capabilityOf(run.context)).toBeUndefined();
  });
});
