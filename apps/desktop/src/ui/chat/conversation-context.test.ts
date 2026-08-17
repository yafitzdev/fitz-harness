import { describe, expect, it, vi } from "vitest";
import { ConversationContextController, type ConversationContextOptions } from "./conversation-context.js";

function harness(overrides: Partial<ConversationContextOptions> = {}) {
  const options: ConversationContextOptions = {
    draft: () => "draft",
    estimateTokens: (text) => text.length,
    configuredLimit: () => 8_192,
    updateMeter: vi.fn(),
    currentSessionId: () => "session-1",
    routeId: () => "smart",
    compact: vi.fn(async () => ({ estimatedContextTokens: 120, estimatedInputTokens: 2_400 })),
    refreshSessionEstimate: vi.fn(async () => 118),
    setStatus: vi.fn(),
    appendContext: vi.fn(),
    refreshControls: vi.fn(),
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    ...overrides,
  };
  return { controller: new ConversationContextController(options), options };
}

describe("ConversationContextController", () => {
  it("owns token estimates and route context limits", () => {
    const { controller, options } = harness();
    controller.add("hello");
    controller.refresh();
    expect(options.updateMeter).toHaveBeenCalledWith(10, 8_192);
  });

  it("compacts the active session and recalibrates its meter", async () => {
    const { controller, options } = harness();
    await controller.compact();
    expect(options.compact).toHaveBeenCalledWith("session-1", "smart");
    expect(options.refreshSessionEstimate).toHaveBeenCalledWith("session-1");
    expect(options.updateMeter).toHaveBeenLastCalledWith(123, 8_192);
    expect(options.appendContext).toHaveBeenCalledWith("Context compacted");
    expect(options.setStatus).toHaveBeenLastCalledWith("Reduced 2k to 118 tokens");
    expect(options.refreshControls).toHaveBeenCalledOnce();
  });

  it("does not silently drop compaction when the renderer run state is stale", async () => {
    const { controller, options } = harness({
      compact: vi.fn(async () => ({ estimatedContextTokens: 120, estimatedInputTokens: 2_400 })),
    });

    await controller.compact();

    expect(options.compact).toHaveBeenCalledWith("session-1", "smart");
    expect(options.setStatus).toHaveBeenCalledWith("Compacting…", true);
  });

  it("surfaces a missing session instead of silently returning", async () => {
    const { controller, options } = harness({ currentSessionId: () => undefined });

    await controller.compact();

    expect(options.compact).not.toHaveBeenCalled();
    expect(options.setStatus).toHaveBeenCalledWith("Open a chat before compacting");
    expect(options.refreshControls).toHaveBeenCalledOnce();
  });

  it("surfaces a host rejection without changing the current estimate", async () => {
    const { controller, options } = harness({
      compact: vi.fn(async () => { throw new Error("Stop the current response before compacting"); }),
    });

    await controller.compact();

    expect(options.setStatus).toHaveBeenLastCalledWith("Stop the current response before compacting");
    expect(options.appendContext).not.toHaveBeenCalled();
  });
});
