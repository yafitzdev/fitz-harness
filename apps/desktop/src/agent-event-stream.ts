export type DesktopAgentEvent = Record<string, unknown> & {
  sequence: number;
  type: string;
};

/** Parse the host's durable agent SSE feed without coalescing its JSON events.
 * Chunk boundaries are transport details: one event may span several chunks,
 * and one chunk may contain several events. */
export async function* parseAgentEventStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<DesktopAgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = extractCompleteEvents(buffer);
      buffer = parsed.remainder;
      for (const block of parsed.blocks) yield parseAgentEvent(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield parseAgentEvent(buffer);
  } finally {
    reader.releaseLock();
  }
}

function extractCompleteEvents(value: string): { blocks: string[]; remainder: string } {
  const blocks: string[] = [];
  let remainder = value;
  for (;;) {
    const boundary = /\r?\n\r?\n/.exec(remainder);
    if (!boundary || boundary.index === undefined) return { blocks, remainder };
    blocks.push(remainder.slice(0, boundary.index));
    remainder = remainder.slice(boundary.index + boundary[0].length);
  }
}

function parseAgentEvent(block: string): DesktopAgentEvent {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) throw new Error("The host sent an agent event without data");
  const value = JSON.parse(data) as unknown;
  if (!isRecord(value) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 || typeof value.type !== "string" || !value.type) {
    throw new Error("The host sent an invalid agent event");
  }
  return value as DesktopAgentEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
