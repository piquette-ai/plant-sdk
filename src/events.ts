/**
 * Typed event registry.
 *
 * Event types are plain strings on the wire (`<module>.<name>`). Modules give
 * them payload types by augmenting {@link PlantEventRegistry}:
 *
 * ```ts
 * declare module "@piquette/plant-sdk" {
 *   interface PlantEventRegistry {
 *     "consent.recorded": { receiptId: string; purposes: string[] };
 *   }
 * }
 * ```
 *
 * Unregistered types still work; their data is `unknown`.
 */
import type { PlantEvent } from "./extensions.js";

export interface PlantEventRegistry {}

/** Every event type some module has registered. */
export type RegisteredEventType = keyof PlantEventRegistry & string;

/** The payload type of an event type: its registered type, or `unknown`. */
export type EventData<T extends string> = T extends RegisteredEventType ? PlantEventRegistry[T] : unknown;

/** A {@link PlantEvent} narrowed to one type, with its registered payload. */
export type TypedPlantEvent<T extends string> = PlantEvent<EventData<T>> & { readonly type: T };

/** Narrow an incoming event to one type, e.g. inside `onEvent`. */
export function isEventType<T extends string>(event: PlantEvent, type: T): event is TypedPlantEvent<T> {
  return event.type === type;
}
