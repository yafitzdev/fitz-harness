import { describe, expect, it } from "vitest";
import { parseSseJson } from "./sse.js";

describe("parseSseJson", () => {
  it("parses split CRLF-delimited data events and ignores DONE", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hel"}}]}\r\n'));
        controller.enqueue(
          encoder.encode('\r\ndata: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n'),
        );
        controller.close();
      },
    });

    const chunks = [];
    for await (const chunk of parseSseJson(body, new AbortController().signal)) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.choices?.[0]?.delta?.content).join("")).toBe("hello");
  });
});
