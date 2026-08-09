import type { InstanceState } from "./domain.js";

export interface EventEnvelope<TType extends string, TData> {
  sequence: number;
  protocolVersion: "1";
  timestamp: string;
  type: TType;
  data: TData;
}

export type InstanceStateChangedEvent = EventEnvelope<
  "instance.state.changed",
  {
    instanceId?: string;
    recipeId?: string;
    previousState: InstanceState;
    state: InstanceState;
    reason?: string;
  }
>;

/** Every operation that may activate or use an inference engine. `warm` is
 * deliberately part of the same queue: loading a model into VRAM must never
 * race an active chat or media generation. */
export type QueueJobKind = "chat" | "media" | "warm";

export type QueueUpdatedEvent = EventEnvelope<
  "queue.updated",
  {
    requestId: string;
    routeId: string;
    /** Discriminator: media jobs must not persist to `inference_requests` (§5.5). */
    kind: QueueJobKind;
    position: number;
    depth: number;
    status: "queued" | "started" | "cancelled" | "completed" | "failed";
  }
>;

export type InferenceLifecycleEvent = InstanceStateChangedEvent | QueueUpdatedEvent;

export type NewInferenceLifecycleEvent =
  | {
      type: "instance.state.changed";
      data: InstanceStateChangedEvent["data"];
    }
  | {
      type: "queue.updated";
      data: QueueUpdatedEvent["data"];
    };
