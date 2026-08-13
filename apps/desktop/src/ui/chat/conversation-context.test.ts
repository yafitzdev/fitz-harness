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
    runActive: () => false,
    compact: vi.fn(async () => ({ estimatedContextTokens: 120, estimatedInputTokens: 2_400 })),
    setStatus: vi.fn(),
    appendContext: vi.fn(),
    refreshControls: vi.fn(),
    errorMessage: (error) => String(error),
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
    expect(options.updateMeter).toHaveBeenLastCalledWith(125, 8_192);
    expect(options.appendContext).toHaveBeenCalledWith("Context compacted");
    expect(options.setStatus).toHaveBeenLastCalledWith("Reduced 2k to 120 tokens");
    expect(options.refreshControls).toHaveBeenCalledOnce();
  });
});
