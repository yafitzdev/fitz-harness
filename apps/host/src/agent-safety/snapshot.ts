/**
 * Pre-run workspace snapshots: a recoverable baseline plus a manifest that the policy
 * engine uses to distinguish "created this run" from "pre-existing" paths.
 *
 * Snapshots deliberately exclude `.git` (history is the source of truth for tracked
 * files), `node_modules` (reinstallable, huge) and `.fitz-trash` (already recoverable).
 */

import { promises as fs } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { SnapshotStatus } from "@fitz/protocol";

export interface WorkspaceSnapshot {
  status: Exclude<SnapshotStatus, "restored">;
  fileCount: number;
  byteCount: number;
  manifestPath: string;
}

export interface SnapshotManifest {
  version: 1;
  workspaceRoot: string;
  createdAt: string;
  bytes: number;
  files: Array<{ rel: string; size: number; isDir: boolean }>;
}

export const DEFAULT_EXCLUDES = [".git", "node_modules", ".fitz-trash"];

export interface CreateSnapshotOptions {
  workspaceRoot: string;
  snapshotDir: string;
  excludes?: readonly string[];
  maxBytes?: number;
  maxFiles?: number;
}

export async function createWorkspaceSnapshot(options: CreateSnapshotOptions): Promise<WorkspaceSnapshot> {
  const { workspaceRoot, snapshotDir } = options;
  const excludes = new Set(options.excludes ?? DEFAULT_EXCLUDES);
  const maxBytes = options.maxBytes ?? 1_073_741_824; // 1 GiB
  const maxFiles = options.maxFiles ?? 50_000;
  const files: SnapshotManifest["files"] = [];
  let bytes = 0;
  let skipped = false;

  await fs.mkdir(snapshotDir, { recursive: true });
  const filesRoot = join(snapshotDir, "files");

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dirs are skipped; the trash + createdPaths cover provenance
    }
    for (const entry of entries) {
      if (excludes.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const rel = relative(workspaceRoot, abs).split(sep).join("/");
      if (entry.isDirectory()) {
        files.push({ rel, size: 0, isDir: true });
        if (files.length > maxFiles) { skipped = true; return; }
        await walk(abs);
        if (skipped) return;
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        let size = 0;
        if (entry.isFile()) {
          try { size = (await fs.stat(abs)).size; } catch { continue; }
        }
        files.push({ rel, size, isDir: false });
        bytes += size;
        if (files.length > maxFiles || bytes > maxBytes) { skipped = true; return; }
      }
    }
  };
  await walk(workspaceRoot);

  // Copy captured files. Stop at the cap so a giant workspace cannot wedge the host;
  // manifest entries past the cap simply have no snapshot file (restore skips them).
  let copied = 0;
  for (const file of files) {
    if (copied >= maxFiles || bytes > maxBytes) break;
    const source = join(workspaceRoot, ...file.rel.split("/"));
    const target = join(filesRoot, ...file.rel.split("/"));
    if (file.isDir) {
      await fs.mkdir(target, { recursive: true });
    } else {
      try {
        await fs.mkdir(dirname(target), { recursive: true });
        await fs.copyFile(source, target);
      } catch {
        // Individual unreadable files are skipped rather than failing the whole snapshot.
      }
    }
    copied += 1;
  }

  const manifest: SnapshotManifest = {
    version: 1,
    workspaceRoot,
    createdAt: new Date().toISOString(),
    bytes,
    files,
  };
  const manifestPath = join(snapshotDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  return { status: skipped ? "skipped" : "active", fileCount: files.length, byteCount: bytes, manifestPath };
}

export async function readSnapshotManifest(snapshotDir: string): Promise<SnapshotManifest | undefined> {
  try {
    const raw = await fs.readFile(join(snapshotDir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as SnapshotManifest;
    return parsed && parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Overlay the snapshot files back onto the workspace (restore). Returns the number of paths restored. */
export async function restoreWorkspaceSnapshot(workspaceRoot: string, snapshotDir: string): Promise<number> {
  const manifest = await readSnapshotManifest(snapshotDir);
  if (!manifest) throw new Error("Snapshot manifest is missing or corrupt");
  let restored = 0;
  for (const file of manifest.files) {
    const source = join(snapshotDir, "files", ...file.rel.split("/"));
    const target = join(workspaceRoot, ...file.rel.split("/"));
    if (file.isDir) {
      await fs.mkdir(target, { recursive: true });
    } else {
      try {
        await fs.mkdir(dirname(target), { recursive: true });
        await fs.copyFile(source, target);
      } catch {
        // A missing file in the snapshot means it did not exist at run start; skip.
      }
    }
    restored += 1;
  }
  return restored;
}
