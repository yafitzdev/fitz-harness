import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostInstanceLock } from "./host-instance-lock.js";

describe("HostInstanceLock", () => {
  it("fails closed while a live host owns the data root and releases cleanly", () => {
    const directory = mkdtempSync(join(tmpdir(), "fitz-host-lock-"));
    const path = join(directory, "host.lock");
    try {
      const first = HostInstanceLock.acquire(path);
      expect(() => HostInstanceLock.acquire(path)).toThrow(/already running/);
      first.release();
      const second = HostInstanceLock.acquire(path);
      second.release();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("reclaims a stale ownership file", () => {
    const directory = mkdtempSync(join(tmpdir(), "fitz-host-lock-stale-"));
    const path = join(directory, "host.lock");
    try {
      writeFileSync(path, JSON.stringify({ pid: 2_147_483_647, token: "stale", startedAt: new Date(0).toISOString() }));
      const lock = HostInstanceLock.acquire(path);
      lock.release();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
