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

/** Every operation admitted to an inference resource lane. `warm` always uses
 * the local GPU lane, so loading a model into VRAM cannot race local chat or
 * local media generation; remote media occupies the independent cloud lane. */
export type QueueJobKind = "chat" | "media" | "warm";
export type InferenceLane = "gpu" | "cloud";

export type QueueUpdatedEvent = EventEnvelope<
  "queue.updated",
  {
    requestId: string;
    routeId: string;
    /** Discriminator: media jobs must not persist to `inference_requests` (§5.5). */
    kind: QueueJobKind;
    lane: InferenceLane;
    ownerUserId?: string;
    sessionId?: string;
    runId?: string;
    label?: string;
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
