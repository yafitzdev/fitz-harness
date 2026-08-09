export interface BackpressureWritable {
  destroyed?: boolean;
  writableEnded?: boolean;
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
  once(event: "close", listener: () => void): unknown;
  removeListener(event: "drain", listener: () => void): unknown;
  removeListener(event: "error", listener: (error: unknown) => void): unknown;
  removeListener(event: "close", listener: () => void): unknown;
}

/** Writes one chunk and does not let the upstream producer outrun the socket. */
export async function writeWithBackpressure(
  writable: BackpressureWritable,
  chunk: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (writable.destroyed || writable.writableEnded) throw connectionClosedError();
  if (writable.write(chunk)) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      writable.removeListener("drain", onDrain);
      writable.removeListener("error", onError);
      writable.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onDrain = () => settle(resolve);
    const onError = (error: unknown) => settle(() => reject(error));
    const onClose = () => settle(() => reject(connectionClosedError()));
    const onAbort = () => settle(() => reject(abortError()));
    writable.once("drain", onDrain);
    writable.once("error", onError);
    writable.once("close", onClose);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function writeSse(writable: BackpressureWritable, value: unknown, signal?: AbortSignal): Promise<void> {
  return writeWithBackpressure(writable, `data: ${JSON.stringify(value)}\n\n`, signal);
}

export function writeSseDone(writable: BackpressureWritable, signal?: AbortSignal): Promise<void> {
  return writeWithBackpressure(writable, "data: [DONE]\n\n", signal);
}

function abortError(): Error {
  const error = new Error("Response stream was aborted");
  error.name = "AbortError";
  return error;
}

function connectionClosedError(): Error {
  const error = new Error("Response stream closed before completion");
  error.name = "ConnectionClosedError";
  return error;
}
