import { HOST_CONTRACT_VERSION, PROTOCOL_VERSION } from "@fitz/protocol";
import { describe, expect, it, vi } from "vitest";
import { HostStartupError, HostSupervisor } from "./host-supervisor.js";

const origin = new URL("http://127.0.0.1:8787");

describe("HostSupervisor", () => {
  it("accepts an exact healthy local host without spawning", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok", protocolVersion: PROTOCOL_VERSION, hostContractVersion: HOST_CONTRACT_VERSION }));
    await expect(new HostSupervisor({ origin, packaged: false, resourcesPath: "unused", fetch }).ensureReady()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a reachable stale host instead of silently driving it", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok", protocolVersion: PROTOCOL_VERSION, hostContractVersion: "stale" }));
    await expect(new HostSupervisor({ origin, packaged: false, resourcesPath: "unused", fetch }).ensureReady()).rejects.toMatchObject({
      name: "HostStartupError",
      message: "A different Fitz host version is already running",
    });
  });

  it("reports an unavailable development host with an actionable error", async () => {
    const fetch = vi.fn(async () => { throw new Error("connection refused"); });
    await expect(new HostSupervisor({ origin, packaged: false, resourcesPath: "unused", fetch }).ensureReady()).rejects.toBeInstanceOf(HostStartupError);
  });
});
