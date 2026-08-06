import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceSnapshot, readSnapshotManifest, restoreWorkspaceSnapshot } from "./snapshot.js";

const tempRoots: string[] = [];
afterEach(async () => { await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function makeDirectories() {
  const workspace = await mkdtemp(join(tmpdir(), "fitz-snap-ws-"));
  const snapshotDir = await mkdtemp(join(tmpdir(), "fitz-snap-dir-"));
  tempRoots.push(workspace, snapshotDir);
  return { workspace, snapshotDir };
}

describe("workspace snapshots", () => {
  it("captures files, excludes .git/node_modules/.fitz-trash, and restores an overlay", async () => {
    const { workspace, snapshotDir } = await makeDirectories();
    await writeFile(join(workspace, "keep.txt"), "original");
    await writeFile(join(workspace, "layout.ts"), "layout v1");
    await mkdir(join(workspace, "node_modules"), { recursive: true });
    await writeFile(join(workspace, "node_modules", "junk.txt"), "junk");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await writeFile(join(workspace, ".git", "HEAD"), "ref");
    await mkdir(join(workspace, ".fitz-trash"), { recursive: true });
    await writeFile(join(workspace, ".fitz-trash", "stale.txt"), "stale");

    const result = await createWorkspaceSnapshot({ workspaceRoot: workspace, snapshotDir });
    expect(result.status).toBe("active");
    const rels = (await readSnapshotManifest(snapshotDir))!.files.map((file) => file.rel);
    expect(rels).toEqual(expect.arrayContaining(["keep.txt", "layout.ts"]));
    expect(rels).not.toEqual(expect.arrayContaining([expect.stringContaining("node_modules"), expect.stringContaining(".git"), expect.stringContaining(".fitz-trash")]));

    // Clobber the workspace, then restore: snapshot files come back, new files stay.
    await writeFile(join(workspace, "keep.txt"), "CLOBBERED");
    await writeFile(join(workspace, "brand-new.txt"), "new");
    const restored = await restoreWorkspaceSnapshot(workspace, snapshotDir);
    expect(restored).toBeGreaterThanOrEqual(2);
    expect(await readFile(join(workspace, "keep.txt"), "utf8")).toBe("original");
    expect(await readFile(join(workspace, "layout.ts"), "utf8")).toBe("layout v1");
    expect(await readFile(join(workspace, "brand-new.txt"), "utf8")).toBe("new");
  });

  it("marks oversized snapshots as skipped without failing the run", async () => {
    const { workspace, snapshotDir } = await makeDirectories();
    await writeFile(join(workspace, "a.txt"), "a");
    await writeFile(join(workspace, "b.txt"), "b");
    const result = await createWorkspaceSnapshot({ workspaceRoot: workspace, snapshotDir, maxFiles: 1 });
    expect(result.status).toBe("skipped");
    // Both files made it into the manifest before the cap tripped; the copy phase stops.
    expect(result.fileCount).toBe(2);
  });

  it("restoring a missing or corrupt snapshot throws", async () => {
    const { workspace, snapshotDir } = await makeDirectories();
    await expect(restoreWorkspaceSnapshot(workspace, snapshotDir)).rejects.toThrow("manifest");
    await writeFile(join(snapshotDir, "manifest.json"), "not json", "utf8");
    await expect(restoreWorkspaceSnapshot(workspace, snapshotDir)).rejects.toThrow("manifest");
  });
});
