import { describe, expect, it } from "vitest";
import type { InferenceEvidenceRecord, SessionForensicsBundle } from "./forensics.js";

describe("forensics protocol", () => {
  it("keeps the evidence contract engine-neutral and versioned", () => {
    const evidence: InferenceEvidenceRecord = {
      id: "request-1",
      kind: "chat",
      status: "completed",
      routeId: "default",
      executionLane: "gpu",
      enqueuedAt: new Date(0).toISOString(),
      request: { messages: [{ role: "user", content: "hello" }] },
      response: { deltas: [{ text: "hi" }] },
    };
    expect(evidence.kind).toBe("chat");
    const versioned: Pick<SessionForensicsBundle, "schemaVersion"> = { schemaVersion: 1 };
    expect(versioned.schemaVersion).toBe(1);
  });
});
