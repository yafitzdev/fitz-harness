import type { MediaJobRecord } from "@fitz/protocol";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "./sqlite-store.js";

describe("SqliteStore media persistence", () => {
  it("persists jobs, partial updates, filters, and restart recovery", () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    store.createProject({ id: "media-project", name: "Media", createdAt: now, updatedAt: now });
    store.createSession({ id: "session-1", projectId: "media-project", title: "Media", status: "active", createdAt: now, updatedAt: now });
    const job: MediaJobRecord = {
      id: "job-1",
      sessionId: "session-1",
      routeId: "video",
      modality: "video",
      status: "queued",
      execution: { recipeId: "h3", recipeDisplayName: "MiniMax H3", modelId: "minimax-h3", adapter: "media-fake" },
      params: { prompt: "a cat", durationSeconds: 5 },
      enqueuedAt: now,
      createdByUserId: "user-1",
      creditCostCents: 3,
    };
    store.createMediaJob(job);
    expect(store.getMediaJob("job-1")).toEqual(job);
    store.updateMediaJob("job-1", {});
    expect(store.getMediaJob("job-1")).toEqual(job);
    store.updateMediaJob("job-1", { status: "started", startedAt: now, providerJobId: "provider-1", progress: 0.25 });
    expect(store.getMediaJob("job-1")).toEqual(expect.objectContaining({
      status: "started",
      startedAt: now,
      providerJobId: "provider-1",
      progress: 0.25,
      sessionId: "session-1",
    }));
    expect(store.listMediaJobs({ ownerUserId: "user-1" })).toHaveLength(1);
    expect(store.listMediaJobs({ sessionId: "session-1" })).toHaveLength(1);
    expect(store.listMediaJobs({ sessionId: "another-session" })).toHaveLength(0);
    expect(store.listMediaJobs({ status: "queued" })).toHaveLength(0);
    expect(store.countNonTerminalMediaJobs("user-1", now)).toBe(1);
    expect(store.recoverInterruptedMediaJobs()).toBe(1);
    expect(store.getMediaJob("job-1")).toEqual(expect.objectContaining({ status: "interrupted", errorCode: "host_restarted" }));
    store.close();
  });

  it("appends sequenced events and replays after a sequence", () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    store.createMediaJob({ id: "job-1", routeId: "video", modality: "video", status: "queued", params: { prompt: "x" }, enqueuedAt: now });
    const first = store.appendMediaJobEvent("job-1", { type: "progress", progress: 0.5 }, now);
    const second = store.appendMediaJobEvent("job-1", { type: "completed", result: { data: { url: "https://example.com/out.mp4" }, mimeType: "video/mp4", byteSize: 1024 } }, now);
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(store.mediaJobEventsAfter("job-1", 0)).toEqual([first, second]);
    expect(store.mediaJobEventsAfter("job-1", 1)).toEqual([second]);
    expect(store.mediaJobEventsAfter("missing", 0)).toEqual([]);
    store.close();
  });

  it("persists direct media edit ancestry", () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    store.createMediaJob({ id: "original", routeId: "image", modality: "image", status: "completed", params: { prompt: "dog" }, enqueuedAt: now });
    store.createMediaJob({
      id: "edit",
      sourceJobId: "original",
      routeId: "image",
      modality: "image",
      status: "queued",
      params: { operation: "edit", prompt: "cat", refs: [{ artifactId: "artifact-original" }] },
      enqueuedAt: now,
    });
    expect(store.getMediaJob("edit")).toEqual(expect.objectContaining({ sourceJobId: "original" }));
    expect(store.listMediaJobs().find((job) => job.id === "edit")).toEqual(expect.objectContaining({ sourceJobId: "original" }));
    store.close();
  });

  it("accumulates the credit ledger per user within a window", () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    store.createMediaJob({ id: "job-1", routeId: "image", modality: "image", status: "completed", params: { prompt: "x" }, enqueuedAt: now, createdByUserId: "user-1" });
    store.createMediaJob({ id: "job-2", routeId: "image", modality: "image", status: "completed", params: { prompt: "y" }, enqueuedAt: now, createdByUserId: "user-2" });
    store.appendMediaCredit({ id: "c-1", userId: "user-1", jobId: "job-1", modality: "image", costCents: 3, createdAt: now });
    store.appendMediaCredit({ id: "c-2", userId: "user-1", jobId: "job-1", modality: "image", costCents: 7, createdAt: now });
    store.appendMediaCredit({ id: "c-3", userId: "user-2", jobId: "job-2", modality: "image", costCents: 100, createdAt: now });
    expect(store.sumMediaLedgerForUser("user-1", now)).toBe(10);
    expect(store.sumMediaLedgerForUser("user-1", new Date(1).toISOString())).toBe(0);
    expect(store.sumMediaLedgerForUser("user-2", now)).toBe(100);
    store.close();
  });

  it("detaches jobs from deleted sessions without deleting them", () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    store.createProject({ id: "mp", name: "Media", createdAt: now, updatedAt: now });
    store.createSession({ id: "ms", projectId: "mp", title: "Media", status: "active", createdAt: now, updatedAt: now });
    store.createMediaJob({ id: "job-1", sessionId: "ms", routeId: "image", modality: "image", status: "queued", params: { prompt: "x" }, enqueuedAt: now });
    expect(store.deleteProject("mp")).toBe(true);
    expect(store.getSession("ms")).toBeUndefined();
    expect(store.getMediaJob("job-1")).toEqual(expect.objectContaining({ id: "job-1" }));
    expect(store.getMediaJob("job-1")?.sessionId).toBeUndefined();
    store.close();
  });
});
