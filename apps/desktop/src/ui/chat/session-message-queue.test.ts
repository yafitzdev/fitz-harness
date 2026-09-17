// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { SessionMessageQueue } from "./session-message-queue.js";

describe("SessionMessageQueue", () => {
  it("renders durable items and dispatches the head with its accepted identity", async () => {
    const mount = document.createElement("div"); mount.innerHTML = '<div class="composer-shell"></div>';
    const item = { id: "q1", sessionId: "s1", text: "next", model: "default", effort: "normal" as const, maxTokens: 1000, temperature: 0.4, accessMode: "full" as const, createdAt: "now", updatedAt: "now" };
    const api = vi.fn(async (path: string, method?: string) => method === "DELETE" ? {} : { data: [item] });
    let accepted: (() => void) | undefined;
    const queue = new SessionMessageQueue({ mount, api, sessionId: () => "s1", settings: () => ({ routeId: "default", effort: "normal", maxTokens: 1000, temperature: 0.4, accessMode: "full" }), submit: (_message, onAccepted) => { accepted = onAccepted; }, steer: vi.fn(), isRunning: () => false, onError: vi.fn() });
    await queue.load();
    expect(queue.element.textContent).toContain("1 message queued");
    queue.dispatchNext(); expect(accepted).toBeTypeOf("function"); accepted!(); await Promise.resolve();
    expect(api).toHaveBeenCalledWith("/api/v1/sessions/s1/message-queue/q1", "DELETE");
  });
});
