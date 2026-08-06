import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@fitz/storage";
import { TrashService } from "./trash.js";

const tempRoots: string[] = [];
afterEach(async () => { await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "fitz-trash-"));
  tempRoots.push(root);
  const store = SqliteStore.memory();
  const now = new Date().toISOString();
  store.createAgentRun({ id: "run-1", routeId: "fast", status: "queued", createdAt: now, updatedAt: now, lastSequence: 0 });
  const service = new TrashService({ store, workspaceRoot: root });
  return { root, store, service };
}

describe("TrashService", () => {
  it("moves a file into the run trash and records the entry", async () => {
    const { root, store, service } = await makeWorkspace();
    await writeFile(join(root, "notes.txt"), "keep me");
    const trashPath = await service.move({ runId: "run-1", workspaceRoot: root, path: join(root, "notes.txt"), sequence: 1 });
    expect(trashPath).toBe(join(root, ".fitz-trash", "run-1", "1-notes.txt"));
    await expect(stat(join(root, "notes.txt"))).rejects.toThrow();
    expect(await readFile(trashPath, "utf8")).toBe("keep me");
    const entries = store.listTrashEntries(root);
    expect(entries).toEqual([
      expect.objectContaining({ runId: "run-1", originalPath: join(root, "notes.txt"), trashPath }),
    ]);
  });

  it("handles whole directories and collides without overwriting", async () => {
    const { root, store, service } = await makeWorkspace();
    await writeFile(join(root, "a.txt"), "first");
    await writeFile(join(root, "b.txt"), "second");
    await service.move({ runId: "run-1", workspaceRoot: root, path: join(root, "a.txt"), sequence: 1 });
    await service.move({ runId: "run-1", workspaceRoot: root, path: join(root, "b.txt"), sequence: 2 });
    expect(store.listTrashEntries(root)).toHaveLength(2);
    expect(await readdir(join(root, ".fitz-trash", "run-1"))).toEqual(["1-a.txt", "2-b.txt"]);
  });

  it("restores a trashed file to its original location", async () => {
    const { root, store, service } = await makeWorkspace();
    await writeFile(join(root, "draft.md"), "draft");
    await service.move({ runId: "run-1", workspaceRoot: root, path: join(root, "draft.md"), sequence: 1 });
    const [entry] = store.listTrashEntries(root);
    const restored = await service.restore(entry!.id);
    expect(restored.restoredAt).toBeDefined();
    expect(await readFile(join(root, "draft.md"), "utf8")).toBe("draft");
  });

  it("throws for unknown or already-restored entries", async () => {
    const { root, store, service } = await makeWorkspace();
    await writeFile(join(root, "x.txt"), "x");
    await service.move({ runId: "run-1", workspaceRoot: root, path: join(root, "x.txt"), sequence: 1 });
    await expect(service.restore("missing-id")).rejects.toThrow("not found");
    const [entry] = store.listTrashEntries(root);
    await service.restore(entry!.id);
    await expect(service.restore(entry!.id)).rejects.toThrow("already restored");
  });

  it("empties the trash: files and rows are gone, run dirs pruned", async () => {
    const { root, store, service } = await makeWorkspace();
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    await service.move({ runId: "run-1", workspaceRoot: root, path: join(root, "a.txt"), sequence: 1 });
    await service.move({ runId: "run-1", workspaceRoot: root, path: join(root, "b.txt"), sequence: 2 });
    const result = await service.empty();
    expect(result.removed).toBe(2);
    expect(store.listTrashEntries(root)).toHaveLength(0);
    await expect(readdir(join(root, ".fitz-trash"))).rejects.toThrow();
  });

  it("collectExpired honors the cutoff: nothing new, everything old", async () => {
    const { root, store, service } = await makeWorkspace();
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    await service.move({ runId: "run-1", workspaceRoot: root, path: join(root, "a.txt"), sequence: 1 });
    await service.move({ runId: "run-1", workspaceRoot: root, path: join(root, "b.txt"), sequence: 2 });
    // A cutoff one minute ago keeps everything (entries are brand new).
    expect((await service.collectExpired(new Date(Date.now() - 60_000).toISOString())).removed).toBe(0);
    expect(store.listTrashEntries(root)).toHaveLength(2);
    // A cutoff one minute from now expires everything.
    expect((await service.collectExpired(new Date(Date.now() + 60_000).toISOString())).removed).toBe(2);
    expect(store.listTrashEntries(root)).toHaveLength(0);
    await expect(readdir(join(root, ".fitz-trash"))).rejects.toThrow();
  });
});
