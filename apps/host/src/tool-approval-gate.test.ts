import { describe, expect, it } from "vitest";
import { SqliteStore } from "@fitz/storage";
import { createToolApprovalRequester } from "./tool-approval-gate.js";

describe("tool approval gate", () => {
  it("persists a pending request and resumes only after a durable decision", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createProject({ id: "project-1", name: "Project", createdAt: now, updatedAt: now });
    store.createSession({ id: "session-1", projectId: "project-1", title: "Task", status: "active", createdAt: now, updatedAt: now });
    const requester = createToolApprovalRequester(store, 1);
    const handle = requester({ sessionId: "session-1", toolCallId: "bash-1", toolName: "bash", input: { command: "git status" } }, new AbortController().signal);
    expect(store.getToolApproval(handle.approvalId)).toMatchObject({ sessionId: "session-1", toolName: "bash", status: "pending", request: { command: "git status" } });
    expect(store.resolveToolApproval(handle.approvalId, "approved")).toBe(true);
    await expect(handle.decision).resolves.toBe("approved");
    store.close();
  });

  it("marks a pending approval cancelled when its agent run stops", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createProject({ id: "project-1", name: "Project", createdAt: now, updatedAt: now });
    store.createSession({ id: "session-1", projectId: "project-1", title: "Task", status: "active", createdAt: now, updatedAt: now });
    const controller = new AbortController(); const handle = createToolApprovalRequester(store, 100)({ sessionId: "session-1", toolCallId: "edit-1", toolName: "edit", input: {} }, controller.signal);
    controller.abort(); await expect(handle.decision).rejects.toMatchObject({ name: "AbortError" });
    expect(store.getToolApproval(handle.approvalId)?.status).toBe("cancelled"); store.close();
  });
});
