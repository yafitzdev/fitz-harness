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
}

function isCrossDevice(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "EXDEV";
}
