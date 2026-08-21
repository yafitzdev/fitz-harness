import { describe, expect, it, vi } from "vitest";
import { LocalHostBootstrapController, type LocalHostBootstrapSnapshot } from "./local-host-bootstrap.js";

describe("LocalHostBootstrapController", () => {
  it("exposes an offline state and waits for an explicit retry", async () => {
    const states: LocalHostBootstrapSnapshot[] = [];
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error("Connection refused"))
      .mockResolvedValueOnce(undefined);
    const restartHost = vi.fn().mockResolvedValue(true);
    const controller = new LocalHostBootstrapController({ connect, restartHost, onStateChange: (state) => states.push(state) });

    await controller.start();

    expect(controller.state).toBe("offline");
    expect(states).toEqual([
      { state: "connecting" },
      { state: "offline", detail: "Connection refused" },
    ]);
    expect(restartHost).not.toHaveBeenCalled();

    await controller.retry();

    expect(controller.state).toBe("ready");
    expect(states.slice(-2)).toEqual([{ state: "retrying" }, { state: "ready" }]);
    expect(restartHost).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent host-ready signals into one workspace load", async () => {
    let release!: () => void;
    const connect = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new LocalHostBootstrapController({
      connect,
      restartHost: vi.fn().mockResolvedValue(true),
      onStateChange: vi.fn(),
    });

    const first = controller.start();
    const second = controller.start();
    expect(first).toBe(second);
    expect(connect).toHaveBeenCalledOnce();
    release();
    await first;
    expect(controller.isReady).toBe(true);
  });

  it("keeps restart failures offline without attempting a workspace load", async () => {
    const states: LocalHostBootstrapSnapshot[] = [];
    const connect = vi.fn();
    const controller = new LocalHostBootstrapController({
      connect,
      restartHost: vi.fn().mockResolvedValue(false),
      onStateChange: (state) => states.push(state),
    });

    await controller.retry();

    expect(connect).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ state: "offline", detail: "The local Fitz host could not be started." });
  });
});
