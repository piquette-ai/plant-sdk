import { describe, expectTypeOf, it } from "vitest";
import { isEventType, type EventData, type PlantEvent, type TypedPlantEvent } from "../src/index.js";

declare module "../src/index.js" {
  interface PlantEventRegistry {
    "consent.recorded": { receiptId: string; purposes: string[] };
  }
}

describe("typed event registry", () => {
  it("maps registered types to their payload and others to unknown", () => {
    expectTypeOf<EventData<"consent.recorded">>().toEqualTypeOf<{ receiptId: string; purposes: string[] }>();
    expectTypeOf<EventData<"ads.clicked">>().toEqualTypeOf<unknown>();
  });

  it("narrows an incoming event with isEventType", () => {
    const event = {} as PlantEvent;
    if (isEventType(event, "consent.recorded")) {
      expectTypeOf(event).toEqualTypeOf<TypedPlantEvent<"consent.recorded">>();
      expectTypeOf(event.data.receiptId).toEqualTypeOf<string>();
      expectTypeOf(event.type).toEqualTypeOf<"consent.recorded">();
    }
  });
});
