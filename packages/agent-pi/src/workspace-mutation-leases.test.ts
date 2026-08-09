import { describe, expect, it } from "vitest";
import { WorkspaceMutationLeaseManager, isWorkspaceMutation } from "./workspace-mutation-leases.js";

describe("WorkspaceMutationLeaseManager", () => {
  it("serializes mutations in one workspace while allowing other workspaces", async () => {
    const leases = new WorkspaceMutationLeaseManager();
    const first = await leases.acquire({ cwd: "C:/work/a", runId: "r1", toolCallId: "t1", toolName: "edit" }, new AbortController().signal);
    let secondAcquired = false;
    const second = leases.acquire({ cwd: "C:/work/a", runId: "r2", toolCallId: "t2", toolName: "bash" }, new AbortController().signal).then((release) => { secondAcquired = true; return release; });
    const other = await leases.acquire({ cwd: "C:/work/b", runId: "r3", toolCallId: "t3", toolName: "write" }, new AbortController().signal);
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    other(); first();
    (await second)();
    expect(secondAcquired).toBe(true);
  });

  it("does not lease read-only or media tools and removes cancelled waiters", async () => {
    expect(isWorkspaceMutation("read")).toBe(false);
    expect(isWorkspaceMutation("generate_video")).toBe(false);
    expect(isWorkspaceMutation("unknown-extension-tool")).toBe(true);
    const leases = new WorkspaceMutationLeaseManager();
    const first = await leases.acquire({ cwd: "C:/work/a", toolCallId: "t1", toolName: "edit" }, new AbortController().signal);
    const controller = new AbortController();
    const waiting = leases.acquire({ cwd: "C:/work/a", toolCallId: "t2", toolName: "write" }, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    first();
    const release = await leases.acquire({ cwd: "C:/work/a", toolCallId: "t3", toolName: "read" }, new AbortController().signal);
    release();
  });
});
