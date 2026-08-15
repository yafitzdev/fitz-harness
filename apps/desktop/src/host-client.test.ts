import { describe, expect, it, vi } from "vitest";
import { HostClient, HOST_REQUEST_DEADLINES, HostRequestError, hostRequestDeadline } from "./host-client.js";

describe("HostClient", () => {
  it("uses bounded endpoint-aware deadlines", () => {
    expect(hostRequestDeadline("/health")).toBe(HOST_REQUEST_DEADLINES.connection);
    expect(hostRequestDeadline("/api/v1/me")).toBe(HOST_REQUEST_DEADLINES.connection);
    expect(hostRequestDeadline("/api/v1/projects")).toBe(HOST_REQUEST_DEADLINES.api);
    expect(hostRequestDeadline("/api/v1/artifacts/42/content", "base64")).toBe(HOST_REQUEST_DEADLINES.artifact);
    expect(hostRequestDeadline("/api/v1/management/recipes/h3-video/media-test")).toBe(HOST_REQUEST_DEADLINES.diagnostic);
    expect(hostRequestDeadline("/api/v1/management/recipes/qwen/test?force=true")).toBe(HOST_REQUEST_DEADLINES.diagnostic);
  });
  it("validates and authenticates JSON requests", async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => new Response(JSON.stringify({ ok: true }), { status: 201 }));
    const client = new HostClient({ origin: new URL("http://127.0.0.1:8787"), getToken: () => "secret", fetch: request });
    const result = await client.request("/api/v1/test", { method: "post", body: { hello: "world" } });
    expect(result).toEqual({ status: 201, body: JSON.stringify({ ok: true }) });
    expect(request).toHaveBeenCalledWith(new URL("http://127.0.0.1:8787/api/v1/test"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
      headers: expect.objectContaining({ authorization: "Bearer secret" }),
    }));
  });

  it("turns deadline expiry into a retryable typed error", async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const client = new HostClient({ origin: new URL("http://127.0.0.1:8787"), getToken: () => undefined, fetch: request });
    await expect(client.request("/health", { timeoutMs: 5 })).rejects.toMatchObject<Partial<HostRequestError>>({ code: "timeout", retryable: true, message: "The host did not respond to /health within 5 ms" });
  });

  it("distinguishes caller cancellation from a timeout", async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const client = new HostClient({ origin: new URL("http://127.0.0.1:8787"), getToken: () => undefined, fetch: request });
    const controller = new AbortController();
    const pending = client.request("/health", { signal: controller.signal, timeoutMs: 1_000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject<Partial<HostRequestError>>({ code: "cancelled", retryable: false });
  });
});
