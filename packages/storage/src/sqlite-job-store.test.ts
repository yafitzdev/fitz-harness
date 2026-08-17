import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope, AgentRunRecord, MediaJobRecord } from "@fitz/protocol";
import { SqliteStore } from "./sqlite-store.js";

describe("SqliteStore unified job registry", () => {
  it("indexes agent lifecycle without duplicating high-volume stream events", () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    const run: AgentRunRecord = { id: "run-1", routeId: "default", status: "queued", createdAt: now, updatedAt: now, lastSequence: 0 };
    store.createAgentRun(run, { model: "default", messages: [{ role: "user", content: "hello" }] });

    expect(store.getJob("run-1")).toMatchObject({ id: "run-1", kind: "agent", status: "queued", routeId: "default" });
    expect(store.jobEventsAfter("run-1", 0).map((entry) => entry.event.type)).toEqual(["created"]);

    store.appendAgentEvent(agentEvent("run-1", 1, "run.started", {}));
    store.appendAgentEvent(agentEvent("run-1", 2, "assistant.delta", { text: "a" }));
    store.appendAgentEvent(agentEvent("run-1", 3, "run.completed", {}));
    expect(store.getJob("run-1")).toMatchObject({ status: "completed", startedAt: expect.any(String), completedAt: expect.any(String) });
    expect(store.jobEventsAfter("run-1", 0).map((entry) => entry.event.type)).toEqual(["created", "started", "completed"]);
    store.close();
  });

  it("indexes media jobs, progress, terminal state, and parent lineage", () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    store.createMediaJob({ id: "media-0", routeId: "video", modality: "video", status: "completed", params: { prompt: "source" }, enqueuedAt: now });
    const job: MediaJobRecord = { id: "media-1", sourceJobId: "media-0", routeId: "video", modality: "video", status: "queued", params: { prompt: "cat" }, enqueuedAt: now };
    store.createMediaJob(job);
    store.updateMediaJob(job.id, { status: "progressing", progress: 0.5 });
    store.appendMediaJobEvent(job.id, { type: "progress", progress: 0.5 }, now);
    store.appendMediaJobEvent(job.id, { type: "completed", result: { data: { url: "artifact:out" }, mimeType: "video/mp4", byteSize: 8 } }, now);

    expect(store.getJob(job.id)).toMatchObject({ kind: "media", status: "completed", parentJobId: "media-0", progress: 0.5 });
    expect(store.jobEventsAfter(job.id, 0).map((entry) => entry.event.type)).toEqual(["created", "progress", "completed"]);
    expect(store.listJobs({ kind: "media" }).map((entry) => entry.id)).toEqual([job.id, "media-0"]);
    store.close();
  });
});

function agentEvent(runId: string, sequence: number, type: AgentEventEnvelope["type"], data: Record<string, unknown>): AgentEventEnvelope {
  return { protocolVersion: "1", runId, sequence, timestamp: new Date(sequence * 1000).toISOString(), type, data };
}
