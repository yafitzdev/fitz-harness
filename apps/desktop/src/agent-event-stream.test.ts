import { describe, expect, it } from "vitest";
import { parseAgentEventStream } from "./agent-event-stream.js";

describe("parseAgentEventStream", () => {
  it("preserves individual events across arbitrary stream chunks", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('id: 1\r\nevent: reasoning.delta\r\ndata: {"sequence":1,"type":"reason'));
        controller.enqueue(encoder.encode('ing.delta","data":{"text":"one"}}\r\n\r\nid: 2\nevent: reasoning.delta\ndata: {"sequence":2,"type":"reasoning.delta","data":{"text":"two"}}\n\n'));
        controller.close();
      },
    });

    const events = [];
    for await (const event of parseAgentEventStream(body, new AbortController().signal)) events.push(event);

    expect(events).toEqual([
      { sequence: 1, type: "reasoning.delta", data: { text: "one" } },
      { sequence: 2, type: "reasoning.delta", data: { text: "two" } },
    ]);
  });

  it("rejects malformed event payloads instead of forwarding them to the renderer", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"reasoning.delta"}\n\n'));
        controller.close();
      },
    });

    const consume = async () => {
      for await (const _event of parseAgentEventStream(body, new AbortController().signal)) { /* consume */ }
    };
    await expect(consume()).rejects.toThrow("invalid agent event");
  });
});
