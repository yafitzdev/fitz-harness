import { describe, expect, it } from "vitest";
import { SqliteStore } from "./sqlite-store.js";

describe("session message queue", () => {
  it("keeps ordered messages editable and compacts positions after removal", () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createSession({ id: "s", title: "Queue", status: "active", createdAt: now, updatedAt: now });
    const base = { sessionId: "s", model: "default", effort: "normal", maxTokens: 1024, temperature: 0.4, accessMode: "full" } as const;
    store.enqueueSessionMessage({ id: "one", text: "first", ...base }, now);
    store.enqueueSessionMessage({ id: "two", text: "second", ...base }, now);
    expect(store.updateSessionMessage("two", "edited", now)?.text).toBe("edited");
    expect(store.removeSessionMessage("one")).toBe(true);
    expect(store.listSessionMessages("s").map((item) => [item.id, item.text])).toEqual([["two", "edited"]]);
  });
});
