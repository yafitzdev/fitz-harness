import { describe, expect, it, vi } from "vitest";
import { createModelUnloadOnQuitHandler } from "./model-unload-on-quit.js";

describe("desktop model unload on quit", () => {
  it("waits for model unload before quitting", async () => {
    let release!: () => void;
    const unload = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const app = { quit: vi.fn() };
    const handler = createModelUnloadOnQuitHandler({ app, shouldUnload: () => true, unload });
    const first = { preventDefault: vi.fn() };

    handler(first);
    handler({ preventDefault: vi.fn() });
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(unload).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    const second = { preventDefault: vi.fn() };
    handler(second);
    expect(second.preventDefault).not.toHaveBeenCalled();
  });

  it("does not contact a remote host and never traps quit on unload failure", async () => {
    const remoteApp = { quit: vi.fn() };
    const remoteUnload = vi.fn(async () => undefined);
    const remoteEvent = { preventDefault: vi.fn() };
    createModelUnloadOnQuitHandler({ app: remoteApp, shouldUnload: () => false, unload: remoteUnload })(remoteEvent);
    expect(remoteEvent.preventDefault).not.toHaveBeenCalled();
    expect(remoteUnload).not.toHaveBeenCalled();

    const localApp = { quit: vi.fn() };
    const onError = vi.fn();
    createModelUnloadOnQuitHandler({ app: localApp, shouldUnload: () => true, unload: async () => { throw new Error("offline"); }, onError })({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(localApp.quit).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "offline" }));
  });
});
