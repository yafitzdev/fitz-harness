import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installGracefulShutdown, type ShutdownSignalSource } from "./graceful-shutdown.js";

class FakeProcess extends EventEmitter implements ShutdownSignalSource {
  exitCode: number | undefined;
  readonly exit = vi.fn();
}

describe("installGracefulShutdown", () => {
  it("closes once and records clean termination", async () => {
    const source = new FakeProcess();
    const close = vi.fn(async () => undefined);
    installGracefulShutdown(close, { source, timeoutMs: 100 });
    source.emit("SIGTERM");
    source.emit("SIGINT");
    await vi.waitFor(() => expect(source.exitCode).toBe(0));
    expect(close).toHaveBeenCalledTimes(1);
    expect(source.exit).not.toHaveBeenCalled();
  });

  it("marks a rejected close as failed", async () => {
    const source = new FakeProcess();
    const failure = new Error("close failed");
    const onError = vi.fn();
    installGracefulShutdown(async () => { throw failure; }, { source, timeoutMs: 100, onError });
    source.emit("SIGINT");
    await vi.waitFor(() => expect(source.exitCode).toBe(1));
    expect(onError).toHaveBeenCalledWith(failure);
    expect(source.exit).toHaveBeenCalledWith(1);
  });
});
