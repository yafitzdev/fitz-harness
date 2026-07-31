import type {
  InferenceLifecycleEvent,
  InstanceStateChangedEvent,
  QueueUpdatedEvent,
} from "@fitz/protocol";
import { PROTOCOL_VERSION } from "@fitz/protocol";

export type EventListener = (event: InferenceLifecycleEvent) => void;

export class LifecycleEventBus {
  #sequence: number;
  readonly #events: InferenceLifecycleEvent[] = [];
  readonly #listeners = new Set<EventListener>();
  readonly retention: number;

  constructor(retention = 1_000, initialSequence = 0) {
    this.retention = retention;
    this.#sequence = initialSequence;
  }

  instanceStateChanged(data: InstanceStateChangedEvent["data"]): InstanceStateChangedEvent {
    return this.#publish({
      sequence: ++this.#sequence,
      protocolVersion: PROTOCOL_VERSION,
      timestamp: new Date().toISOString(),
      type: "instance.state.changed",
      data,
    });
  }

  queueUpdated(data: QueueUpdatedEvent["data"]): QueueUpdatedEvent {
    return this.#publish({
      sequence: ++this.#sequence,
      protocolVersion: PROTOCOL_VERSION,
      timestamp: new Date().toISOString(),
      type: "queue.updated",
      data,
    });
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  after(sequence: number): InferenceLifecycleEvent[] {
    return this.#events.filter((event) => event.sequence > sequence);
  }

  latestSequence(): number {
    return this.#sequence;
  }

  #publish<T extends InferenceLifecycleEvent>(event: T): T {
    this.#events.push(event);
    if (this.#events.length > this.retention) this.#events.shift();
    for (const listener of this.#listeners) listener(event);
    return event;
  }
}
