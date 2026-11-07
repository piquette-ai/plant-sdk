import { describe, expect, it } from "vitest";
import { isEventType, type PlantEvent } from "../src/index.js";

describe("isEventType", () => {
  it("matches on type", () => {
    const event: PlantEvent = {
      id: "evt_1",
      type: "consent.recorded",
      tenantId: "t_1",
      source: "consent",
      occurredAt: new Date(0).toISOString(),
      data: {},
    };
    expect(isEventType(event, "consent.recorded")).toBe(true);
    expect(isEventType(event, "consent.revoked")).toBe(false);
  });
});
