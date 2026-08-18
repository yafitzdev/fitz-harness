import { describe, expect, it } from "vitest";
import { rootAgentToolCallBudget } from "./agent-effort-policy.js";

describe("root agent effort policy", () => {
  it("bounds substantive tool loops without changing the context policy", () => {
    expect(rootAgentToolCallBudget("light")).toBe(100);
    expect(rootAgentToolCallBudget("normal")).toBe(100);
    expect(rootAgentToolCallBudget(undefined)).toBe(100);
    expect(rootAgentToolCallBudget("high")).toBe(100);
  });
});
