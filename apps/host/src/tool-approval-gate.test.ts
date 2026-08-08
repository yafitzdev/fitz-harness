import { describe, expect, it } from "vitest";
import type { Recipe } from "@fitz/protocol";
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

  it("attaches an estimated credit cost to media tool approval requests (§5.9)", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createProject({ id: "project-1", name: "Project", createdAt: now, updatedAt: now });
    store.createSession({ id: "session-1", projectId: "project-1", title: "Task", status: "active", createdAt: now, updatedAt: now });
    store.upsertRecipe({ ...mediaRecipe("h3-img"), configuration: { costCentsPerJob: 2 } });
    store.upsertRoute({ id: "image", displayName: "Image generation", recipeId: "h3-img", enabled: true, kind: "image" });
    const requester = createToolApprovalRequester(store, 1);
    const handle = requester({ sessionId: "session-1", toolCallId: "img-1", toolName: "generate_image", input: { prompt: "a cat" } }, new AbortController().signal);
    expect(store.getToolApproval(handle.approvalId)).toMatchObject({ toolName: "generate_image", request: { prompt: "a cat", estimated_credit_cost_cents: 2 } });
    expect(store.resolveToolApproval(handle.approvalId, "approved")).toBe(true);
    await expect(handle.decision).resolves.toBe("approved");
    store.close();
  });

  it("leaves non-media approvals and cost-less media requests unchanged", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createProject({ id: "project-1", name: "Project", createdAt: now, updatedAt: now });
    store.createSession({ id: "session-1", projectId: "project-1", title: "Task", status: "active", createdAt: now, updatedAt: now });
    const requester = createToolApprovalRequester(store, 1);
    const bash = requester({ sessionId: "session-1", toolCallId: "bash-1", toolName: "bash", input: { command: "git status" } }, new AbortController().signal);
    expect(store.getToolApproval(bash.approvalId)).toMatchObject({ request: { command: "git status" } });
    // No image route/recipe in the store: the estimate is absent rather than guessed.
    const media = requester({ sessionId: "session-1", toolCallId: "img-2", toolName: "generate_image", input: { prompt: "a cat" } }, new AbortController().signal);
    expect(store.getToolApproval(media.approvalId)).toMatchObject({ request: { prompt: "a cat" } });
    // Resolve both pending handles so their polling loops stop before the store closes.
    expect(store.resolveToolApproval(bash.approvalId, "approved")).toBe(true);
    expect(store.resolveToolApproval(media.approvalId, "approved")).toBe(true);
    await expect(bash.decision).resolves.toBe("approved");
    await expect(media.decision).resolves.toBe("approved");
    store.close();
  });
});

function mediaRecipe(id: string): Recipe {
  return {
    id,
    playbookId: "test",
    displayName: id,
    adapter: "media-fake",
    modelId: `${id}-model`,
    contextTokens: 100_000,
    capabilities: {
      chatCompletions: false,
      streaming: true,
      toolCalls: false,
      responseFormat: false,
      minP: false,
      maxConcurrentGenerations: 1,
      modalities: { input: ["text"], output: ["image"] },
    },
    lifecycle: { loadPolicy: "onDemand", evictionPolicy: "idle-ttl", idleTtlSeconds: 60, minimumResidencySeconds: 0 },
    configuration: {},
  };
}
