import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CloudflareShareManager, requirePublicHttpsUrl } from "./cloudflare-share.js";

describe("Cloudflare Share Fitz", () => {
  it("accepts only clean public HTTPS origins", () => {
    expect(requirePublicHttpsUrl("https://fitz.example.com")).toBe("https://fitz.example.com");
    expect(() => requirePublicHttpsUrl("http://fitz.example.com")).toThrow("HTTPS");
    expect(() => requirePublicHttpsUrl("https://localhost")).toThrow("local");
    expect(() => requirePublicHttpsUrl("https://user:secret@example.com")).toThrow("without credentials");
  });

  it("passes the tunnel secret through the environment, never argv", async () => {
    const gateway = { origin: "http://127.0.0.1:8790", start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill: vi.fn() });
    const spawn = vi.fn(() => child as never);
    const manager = new CloudflareShareManager({ gateway: gateway as never, executable: "cloudflared", spawn });
    await manager.start({ publicUrl: "https://fitz.example.com", tunnelToken: "x".repeat(64) });
    expect(spawn).toHaveBeenCalledWith("cloudflared", expect.not.arrayContaining(["x".repeat(64)]), expect.objectContaining({ TUNNEL_TOKEN: "x".repeat(64), TUNNEL_URL: "http://127.0.0.1:8790" }));
    child.stderr.write("Registered tunnel connection");
    expect(manager.status(true)).toEqual(expect.objectContaining({ state: "connected", publicUrl: "https://fitz.example.com" }));
    await manager.stop();
  });

  it("can share an application-owned gateway with another tunnel provider", async () => {
    const gateway = { origin: "http://127.0.0.1:8790", start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, exitCode: null, kill: vi.fn(() => false) });
    const manager = new CloudflareShareManager({ gateway: gateway as never, executable: "cloudflared", spawn: () => child as never, manageGateway: false });
    await manager.start({ publicUrl: "https://fitz.example.com", tunnelToken: "x".repeat(64) });
    await manager.stop();
    expect(gateway.start).toHaveBeenCalledOnce();
    expect(gateway.stop).not.toHaveBeenCalled();
  });
});
