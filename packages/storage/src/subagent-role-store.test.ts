import { describe, expect, it } from "vitest";
import { SqliteStore } from "./sqlite-store.js";

describe("subagent role registry", () => {
  it("seeds deterministic versioned role definitions", () => {
    const store = SqliteStore.memory();
    try {
      expect(store.listSubagentRoles().map((role) => role.id)).toEqual(["implementer", "researcher", "reviewer"]);
      expect(store.getSubagentRole("researcher")).toMatchObject({
        version: 1,
        accessMode: "read-only",
        toolCallBudget: 20,
        maxOutputTokens: 4096,
        enabled: true,
      });
      expect(store.getSubagentRole("researcher", 1)?.systemInstructions).toContain("without modifying files");
      expect(store.getSubagentRole("missing")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
