import { describe, expect, it } from "vitest";
import { rootAgentToolCallBudget } from "./agent-effort-policy.js";

describe("root agent effort policy", () => {
  it("bounds substantive tool loops without changing the context policy", () => {
    expect(rootAgentToolCallBudget("light")).toBe(16);
    expect(rootAgentToolCallBudget("normal")).toBe(24);
    expect(rootAgentToolCallBudget(undefined)).toBe(24);
    expect(rootAgentToolCallBudget("high")).toBe(48);
  });
});
