/**
 * Agent trash: deletes become moves into `<workspace>/.fitz-trash/<runId>/`.
 *
 * The policy engine rewrites `rm` commands into `mv` commands that land here, and the
 * `fitz.trash` tool routes through the same service, so a hard delete is impossible:
 * the worst case is "moved to trash", which the management API can restore.
 *
 * The trash dir lives inside the workspace (same filesystem → atomic renames) but is
 * classified "protected" so the agent can never touch it.
 */

import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { SqliteStore } from "@fitz/storage";
import type { TrashEntryRecord } from "@fitz/protocol";

export interface TrashMoveInput {
  runId: string;
  workspaceRoot: string;
  path: string;
  /** Per-run counter so repeated deletes of the same basename never collide. */
  sequence: number;
}

export interface TrashServiceOptions {
  store: SqliteStore;
  workspaceRoot: string;
}

export class TrashService {
  readonly #store: SqliteStore;
  readonly #workspaceRoot: string;

  constructor(options: TrashServiceOptions) {
    this.#store = options.store;
    this.#workspaceRoot = options.workspaceRoot.replace(/[\\/]+$/, "");
  }

  trashDir(runId: string): string {
    return join(this.#workspaceRoot, ".fitz-trash", runId);
  }

  /** Ensure the trash dir exists (called eagerly when a run context initializes). */
  async ensure(runId: string): Promise<string> {
    const dir = this.trashDir(runId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Move one path into the run trash. `path` must already be validated by the policy
   * engine (inside the workspace, not protected). Returns the trash destination.
   */
  async move(input: TrashMoveInput): Promise<string> {
    const source = input.path;
    const trashDir = await this.ensure(input.runId);
    const basename = source.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "item";
    const target = join(trashDir, `${input.sequence}-${basename}`);
    try {
      await fs.rename(source, target);
    } catch (error) {
      if (!isCrossDevice(error)) throw error;
      // Cross-device move (e.g. temp dir on another drive): copy first, delete the
      // source only after the copy fully succeeded — a partial copy must never lose data.
      await fs.cp(source, target, { recursive: true, force: true });
      await fs.rm(source, { recursive: true, force: true });
    }
    const entry: TrashEntryRecord = {
      id: randomUUID(),
      runId: input.runId,
      workspaceRoot: this.#workspaceRoot,
      originalPath: source,
      trashPath: target,
      createdAt: new Date().toISOString(),
    };
    this.#store.createTrashEntry(entry);
    return target;
  }

  /** Move a trashed path back to its original location. */
  async restore(id: string): Promise<TrashEntryRecord> {
    const entry = this.#store.getTrashEntry(id);
    if (!entry) throw new Error("Trash entry not found");
    if (entry.restoredAt) throw new Error("Trash entry was already restored");
    await fs.mkdir(dirname(entry.originalPath), { recursive: true });
    try {
      await fs.rename(entry.trashPath, entry.originalPath);
    } catch (error) {
      if (!isCrossDevice(error)) throw new Error(`Could not restore ${entry.originalPath}: it may already exist`);
      await fs.cp(entry.trashPath, entry.originalPath, { recursive: true, force: true });
      await fs.rm(entry.trashPath, { recursive: true, force: true });
    }
    const restoredAt = new Date().toISOString();
    this.#store.markTrashRestored(id, restoredAt);
    return { ...entry, restoredAt };
  }

  /**
   * Permanently delete every trashed file for this workspace and clear its rows.
   * This is the one sanctioned hard delete: it is explicitly user-initiated (an
   * "empty trash" action), never something an agent run can trigger.
   */
  async empty(): Promise<{ removed: number }> {
    const entries = this.#store.listTrashEntries(this.#workspaceRoot, 10_000);
    let removed = 0;
    for (const entry of entries) {
      if (await this.#removeEntry(entry)) removed++;
    }
    await this.#pruneRunDirs();
    return { removed };
  }

  /**
   * Permanently delete trashed files older than `before` (retention GC). Entries the
   * user explicitly emptied already have their rows gone; this catches everything the
   * retention window outlived. The files are in the trash, so deleting them loses
   * nothing the user did not already give up by leaving them there past retention.
   */
  async collectExpired(before: string): Promise<{ removed: number }> {
    const expired = this.#store.listTrashEntries(this.#workspaceRoot, 10_000).filter((entry) => entry.createdAt < before);
    let removed = 0;
    for (const entry of expired) {
      if (await this.#removeEntry(entry)) removed++;
    }
    await this.#pruneRunDirs();
    return { removed };
  }

  /** Delete one trashed file and its row; returns true when the row existed. */
  async #removeEntry(entry: TrashEntryRecord): Promise<boolean> {
    try {
      await fs.rm(entry.trashPath, { recursive: true, force: true });
    } catch {
      // The file may already be gone; the row is still removed so the DB stays the
      // source of truth for what remains in the trash.
    }
    return this.#store.deleteTrashEntry(entry.id);
  }

  /** Remove now-empty run dirs (and the trash root itself) so retention leaves no shell behind. */
  async #pruneRunDirs(): Promise<void> {
    const root = join(this.#workspaceRoot, ".fitz-trash");
    let children: string[];
    try {
      children = await fs.readdir(root);
    } catch {
      return; // No trash dir at all.
    }
    for (const child of children) {
      try {
        await fs.rmdir(join(root, child));
      } catch {
        // Not empty or not a directory — leave it.
      }
    }
    try {
      await fs.rmdir(root);
    } catch {
      // Still holds files (or was recreated) — leave it.
    }
  }
}

function isCrossDevice(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "EXDEV";
}
