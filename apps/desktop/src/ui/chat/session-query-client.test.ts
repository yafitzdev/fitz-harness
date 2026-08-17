import { describe, expect, it } from "vitest";
import { querySessionTranscript } from "./session-query-client.js";

describe("querySessionTranscript", () => {
  it("reads the canonical query endpoint and maps the transcript page", async () => {
    let path = "";
    const response = await querySessionTranscript(async (requestPath) => {
      path = requestPath;
      return {
        data: {
          transcript: [{ sequence: 4, kind: "message" }],
          page: { direction: "backward", hasMore: true, estimatedContextTokens: 1234 },
        },
      };
    }, "session/1", { before: 4, limit: 25 });

    expect(path).toBe("/api/v1/sessions/session%2F1/query?section=transcript&before=4&limit=25");
    expect(response).toEqual({
      data: [{ sequence: 4, kind: "message" }],
      page: { hasEarlier: true, estimatedContextTokens: 1234 },
    });
  });

  it("does not claim earlier history for forward or malformed pages", async () => {
    const response = await querySessionTranscript(async () => ({ data: { transcript: "not-an-array", page: { direction: "forward", hasMore: true, estimatedContextTokens: -1 } } }), "session");
    expect(response).toEqual({ data: [], page: { hasEarlier: false } });
  });
});
