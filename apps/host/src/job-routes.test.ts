import { describe, expect, it } from "vitest";
import type { AgentRunRecord } from "@fitz/protocol";
import { FakeEngineAdapter } from "@fitz/engine-fake";
import { createHost } from "./create-app.js";

describe("unified job routes", () => {
  it("lists a durable job and replays its lifecycle events", async () => {
    const runtime = createHost({ adapters: [new FakeEngineAdapter()] });
    try {
      const now = new Date(0).toISOString();
      const run: AgentRunRecord = { id: "job-route-run", routeId: "default", status: "queued", createdAt: now, updatedAt: now, lastSequence: 0 };
      runtime.store.createAgentRun(run, { model: "default", messages: [{ role: "user", content: "hello" }] });

      const list = await runtime.app.inject({ method: "GET", url: "/api/v1/jobs?kind=agent" });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().data).toEqual([expect.objectContaining({ id: run.id, kind: "agent", status: "queued" })]);

      const events = await runtime.app.inject({ method: "GET", url: `/api/v1/jobs/${run.id}/events` });
      expect(events.statusCode, events.body).toBe(200);
      expect(events.json().data.map((entry: { event: { type: string } }) => entry.event.type)).toEqual(["created"]);
    } finally {
      await runtime.app.close();
    }
  });
});
