import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@fitz/storage";
import { AgentSafetyService } from "./index.js";
import type { ToolEvaluation } from "@fitz/agent-pi";

const tempRoots: string[] = [];
afterEach(async () => {
  // Windows can hold file handles open for a moment after async copies finish; retry
  // a few times before giving up rather than racing a background snapshot copy.
  for (const path of tempRoots.splice(0)) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await rm(path, { recursive: true, force: true }); lastError = undefined; break; }
      catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    if (lastError) throw lastError;
  }
});

async function makeService() {
  const workspace = await mkdtemp(join(tmpdir(), "fitz-ws-"));
  const snapshotsDir = await mkdtemp(join(tmpdir(), "fitz-snap-"));
  tempRoots.push(workspace, snapshotsDir);
  const store = SqliteStore.memory();
  const now = new Date().toISOString();
  store.createAgentRun({ id: "run-1", routeId: "fast", status: "queued", createdAt: now, updatedAt: now, lastSequence: 0 });
  store.createAgentRun({ id: "run-2", routeId: "fast", status: "queued", createdAt: now, updatedAt: now, lastSequence: 0 });
  const safety = new AgentSafetyService({ store, snapshotsDir });
  return { workspace, snapshotsDir, store, safety };
}

function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("Timed out waiting for condition"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Run a `mv <src> <dst>` rewrite the way the shell would (same filesystem here). */
async function executeRewrite(outcome: ToolEvaluation): Promise<void> {
  if (outcome.action !== "rewrite") throw new Error(`expected a rewrite, got ${outcome.action}`);
  const command = outcome.input.command as string;
  const match = /^mv (.+) (.+)$/.exec(command);
  if (!match) throw new Error(`unexpected rewrite: ${command}`);
  const source = match[1]!;
  const dest = match[2]!;
  const destStat = await stat(dest).catch(() => undefined);
  if (destStat?.isDirectory()) {
    // Shell `mv file dir` moves the file inside the directory.
    await rename(source, join(dest, source.split(/[\\/]/).pop()!));
  } else {
    await rename(source, dest);
  }
}

describe("AgentSafetyService", () => {
  it("rewrites rm into a trash mv that actually lands in .fitz-trash", async () => {
    const { workspace, store, safety } = await makeService();
    const file = join(workspace, "important.txt").replace(/\\/g, "/");
    await writeFile(join(workspace, "important.txt"), "precious");
    const evaluate = safety.createToolEvaluator();
    const outcome = await evaluate({ toolName: "bash", input: { command: `rm ${file}` }, cwd: workspace, runId: "run-1" });
    const dest = join(workspace, ".fitz-trash", "run-1", "1-important.txt").replace(/\\/g, "/");
    expect(outcome).toEqual({ action: "rewrite", input: { command: `mv ${file} ${dest}` } });
    await executeRewrite(outcome);
    await waitFor(() => store.getSnapshot("run-1") !== undefined);
    await expect(stat(join(workspace, "important.txt"))).rejects.toThrow();
    expect(await readFile(dest, "utf8")).toBe("precious");
    // The policy recorded the entry at rewrite time, so the management API can restore it.
    const [entry] = store.listTrashEntries(workspace);
    expect(entry).toMatchObject({ runId: "run-1", originalPath: file, trashPath: dest });
    const restored = await safety.restoreTrash(entry!.id);
    expect(restored.restoredAt).toBeDefined();
    expect(await readFile(join(workspace, "important.txt"), "utf8")).toBe("precious");
    expect(store.listToolActions("run-1").some((action) => action.effect === "rewrite")).toBe(true);
  });

  it("registers the fitz.trash tool bound to the run's trash", async () => {
    const { workspace, safety } = await makeService();
    await writeFile(join(workspace, "notes.md"), "keep");
    const tools = safety.createCustomTools()({ cwd: workspace, runId: "run-1" });
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("fitz.trash");
    const result = await tools[0]!.execute("call-1", { paths: [join(workspace, "notes.md")] });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Moved 1 path") });
    await expect(stat(join(workspace, "notes.md"))).rejects.toThrow();
  });

  it("refuses to trash paths outside allowed zones", async () => {
    const { workspace, safety } = await makeService();
    const result = await safety.trash(["/etc/hosts", `${workspace}/nope.txt`], "run-1", workspace);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("refused");
  });

  it("snapshots the workspace at run start and restores it on demand", async () => {
    const { workspace, store, safety } = await makeService();
    await writeFile(join(workspace, "code.ts"), "version 1");
    const evaluate = safety.createToolEvaluator();
    await evaluate({ toolName: "bash", input: { command: "git status" }, cwd: workspace, runId: "run-1" });
    await waitFor(() => store.getSnapshot("run-1")?.status === "active");
    await writeFile(join(workspace, "code.ts"), "version 2 CLOBBERED");
    const restored = await safety.restoreSnapshot("run-1");
    expect(restored.restored).toBeGreaterThan(0);
    expect(await readFile(join(workspace, "code.ts"), "utf8")).toBe("version 1");
    expect(store.getSnapshot("run-1")?.status).toBe("restored");
  });

  it("restores a trashed file through the management-facing API", async () => {
    const { workspace, store, safety } = await makeService();
    await writeFile(join(workspace, "draft.md"), "draft");
    await safety.trash([join(workspace, "draft.md")], "run-1", workspace);
    const [entry] = store.listTrashEntries(workspace);
    expect(entry).toBeDefined();
    await expect(stat(join(workspace, "draft.md"))).rejects.toThrow();
    const restored = await safety.restoreTrash(entry!.id);
    expect(restored.restoredAt).toBeDefined();
    expect(await readFile(join(workspace, "draft.md"), "utf8")).toBe("draft");
  });

  it("keeps per-run contexts isolated", async () => {
    const { workspace, store, safety } = await makeService();
    await writeFile(join(workspace, "a.txt"), "a");
    const arg = join(workspace, "a.txt").replace(/\\/g, "/");
    const trash1 = join(workspace, ".fitz-trash", "run-1", "1-a.txt").replace(/\\/g, "/");
    const trash2 = join(workspace, ".fitz-trash", "run-2", "1-a.txt").replace(/\\/g, "/");
    const evaluate = safety.createToolEvaluator();
    const first = await evaluate({ toolName: "bash", input: { command: `rm ${arg}` }, cwd: workspace, runId: "run-1" });
    const second = await evaluate({ toolName: "bash", input: { command: `rm ${arg}` }, cwd: workspace, runId: "run-2" });
    expect(first).toEqual({ action: "rewrite", input: { command: `mv ${arg} ${trash1}` } });
    expect(second).toEqual({ action: "rewrite", input: { command: `mv ${arg} ${trash2}` } });
    // Let both background snapshots finish so afterEach cleanup is not racing a copy.
    await waitFor(() => store.getSnapshot("run-1") !== undefined);
    await waitFor(() => store.getSnapshot("run-2") !== undefined);
  });
});
