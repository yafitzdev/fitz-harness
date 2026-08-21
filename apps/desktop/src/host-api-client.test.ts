import { describe, expect, it, vi } from "vitest";
import { HostRequestError } from "./client-error.js";
import { HostApiClient } from "./host-api-client.js";

describe("HostApiClient", () => {
  it("serializes the request shape and parses typed JSON responses", async () => {
    const request = vi.fn(async () => ({ status: 200, body: JSON.stringify({ data: { id: "session-1" } }) }));
    const api = new HostApiClient({ request });

    const response = await api.request<{ data: { id: string } }>("/api/v1/sessions", "POST", { title: "New chat" });

    expect(response.data.id).toBe("session-1");
    expect(request).toHaveBeenCalledWith({ path: "/api/v1/sessions", method: "POST", body: { title: "New chat" } });
  });

  it("does not add a body to bodyless requests", async () => {
    const request = vi.fn(async () => ({ status: 204, body: "" }));
    const api = new HostApiClient({ request });

    await api.request("/api/v1/sessions/session-1", "DELETE");

    expect(request).toHaveBeenCalledWith({ path: "/api/v1/sessions/session-1", method: "DELETE" });
  });

  it("parses streamed artifact upload responses through the same error boundary", async () => {
    const request = vi.fn(async () => ({ status: 200, body: "{}" }));
    const uploadArtifact = vi.fn(async () => ({ status: 201, body: JSON.stringify({ data: { id: "video-1" } }) }));
    const api = new HostApiClient({ request, uploadArtifact });
    const file = new File(["video"], "motion.mp4", { type: "video/mp4" });
    await expect(api.uploadArtifact<{ data: { id: string } }>("session-1", file)).resolves.toEqual({ data: { id: "video-1" } });
    expect(uploadArtifact).toHaveBeenCalledWith({ sessionId: "session-1", file });
  });

  it("normalizes structured host errors", async () => {
    const request = vi.fn(async () => ({
      status: 409,
      body: JSON.stringify({ error: { code: "resource_busy", message: "GPU busy", remediation: "Wait or cancel.", retryable: true } }),
    }));
    const api = new HostApiClient({ request });

    await expect(api.request("/api/v1/models/load", "POST")).rejects.toMatchObject({
      name: "HostRequestError",
      status: 409,
      payload: { code: "resource_busy", retryable: true },
    } satisfies Partial<HostRequestError>);
  });

  it("keeps an invalid success body observable instead of throwing in JSON parsing", async () => {
    const request = vi.fn(async () => ({ status: 200, body: "plain host response" }));
    const api = new HostApiClient({ request });

    await expect(api.request("/health")).resolves.toEqual({ error: "plain host response" });
  });
});
