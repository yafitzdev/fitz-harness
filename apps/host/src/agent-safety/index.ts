/**
 * AgentSafetyService: the host-side safety layer for agent runs.
 *
 * Wires the deterministic policy engine (trash-everything deletes, zone blocking),
 * pre-run workspace snapshots, the trash service, and content redaction into the
 * Pi runtime's extension hooks. All machine guarantees — no approval prompts involved.
 */

import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SqliteStore } from "@fitz/storage";
import type { SnapshotRecord, TrashEntryRecord } from "@fitz/protocol";
import type { ToolDefinition, ToolEvaluator, ToolResultRedactor, TrashMoveResult } from "@fitz/agent-pi";
import { createTrashTool } from "@fitz/agent-pi";
import { canonicalizePath, classifyPath, resolveAbsolutePath } from "./paths.js";
import { createWorkspaceSnapshot, restoreWorkspaceSnapshot } from "./snapshot.js";
import { TrashService } from "./trash.js";
import { evaluateToolCall, type ActionLog, type PolicyContext } from "./policy.js";
import { redactToolResultContent } from "./redaction.js";

export interface AgentSafetyOptions {
  store: SqliteStore;
  /** Where run snapshots are stored (e.g. `<dataRoot>/snapshots`). */
  snapshotsDir: string;
  /** Fitz runtime dirs the agent legitimately owns (pi agent dir, llm root, logs, cache, engines). */
  runtimeDirs?: readonly string[];
  /** Extra temp dirs beyond the OS temp dir. */
  tempDirs?: readonly string[];
  homeDir?: string;
  maxSnapshotBytes?: number;
  maxSnapshotFiles?: number;
}

interface RunSafetyContext {
  runId: string;
  cwd: string;
  trashDir: string;
  trash: TrashService;
  log: ActionLog;
  createdPaths: Set<string>;
  sequence: number;
}

const MAX_CONTEXTS = 64;

export class AgentSafetyService {
  readonly #store: SqliteStore;
  readonly #snapshotsDir: string;
  readonly #runtimeDirs: readonly string[];
  readonly #tempDirs: readonly string[];
  readonly #homeDir: string;
  readonly #maxSnapshotBytes: number;
  readonly #maxSnapshotFiles: number;
  readonly #contexts = new Map<string, RunSafetyContext>();

  constructor(options: AgentSafetyOptions) {
    this.#store = options.store;
    this.#snapshotsDir = options.snapshotsDir;
    this.#runtimeDirs = options.runtimeDirs ?? [];
    this.#tempDirs = [tmpdir(), ...(options.tempDirs ?? [])];
    this.#homeDir = options.homeDir ?? homedir();
    this.#maxSnapshotBytes = options.maxSnapshotBytes ?? 1_073_741_824;
    this.#maxSnapshotFiles = options.maxSnapshotFiles ?? 50_000;
  }

  #getContext(runId: string | undefined, cwd: string): RunSafetyContext {
    const key = runId ?? `cwd::${cwd}`;
    const existing = this.#contexts.get(key);
    if (existing) return existing;
    const effectiveRunId = runId ?? "unkeyed";
    const trash = new TrashService({ store: this.#store, workspaceRoot: cwd });
    const trashDir = trash.trashDir(effectiveRunId);
    try {
      mkdirSync(trashDir, { recursive: true });
    } catch {
      // If the workspace is not writable the trash cannot be created; the policy engine
      // still blocks deletes outside allowed zones and every move will surface an error.
    }
    const ctx: RunSafetyContext = {
      runId: effectiveRunId,
      cwd,
      trashDir,
      trash,
      log: {
        record: (entry) => {
          try {
            this.#store.appendToolAction({ runId: effectiveRunId, timestamp: new Date().toISOString(), toolName: entry.toolName, effect: entry.effect, ...(entry.path ? { path: entry.path } : {}), detail: entry.detail ?? {} });
          } catch {
            // A missing agent_run row (e.g. in unit tests) must not crash the run.
          }
        },
      },
      createdPaths: new Set(),
      sequence: 0,
    };
    this.#contexts.set(key, ctx);
    if (this.#contexts.size > MAX_CONTEXTS) {
      const oldest = this.#contexts.keys().next().value;
      if (oldest !== undefined) this.#contexts.delete(oldest);
    }
    this.#startSnapshot(ctx);
    return ctx;
  }

  #startSnapshot(ctx: RunSafetyContext): void {
    const snapshotDir = join(this.#snapshotsDir, ctx.runId);
    void (async () => {
      // Snapshotting is best-effort and must never surface an unhandled rejection:
      // a missing agent_run row (e.g. an unkeyed context) degrades to a failed record.
      try {
        const result = await createWorkspaceSnapshot({
          workspaceRoot: ctx.cwd,
          snapshotDir,
          maxBytes: this.#maxSnapshotBytes,
          maxFiles: this.#maxSnapshotFiles,
        });
        try {
          this.#store.createSnapshot({ runId: ctx.runId, workspaceRoot: ctx.cwd, snapshotDir, createdAt: new Date().toISOString(), status: result.status, fileCount: result.fileCount });
        } catch {
          // Missing run row: nothing to record against.
        }
      } catch {
        try {
          this.#store.createSnapshot({ runId: ctx.runId, workspaceRoot: ctx.cwd, snapshotDir, createdAt: new Date().toISOString(), status: "failed", fileCount: 0 });
        } catch {
          // Missing run row: nothing to record against.
        }
      }
    })();
  }

  /** The runtime's `toolPolicy`: evaluates every non-read-only (and read) tool call. */
  createToolEvaluator(): ToolEvaluator {
    return async (request, signal) => {
      const ctx = this.#getContext(request.runId, request.cwd);
      const policyCtx: PolicyContext = {
        runId: ctx.runId,
        cwd: ctx.cwd,
        homeDir: this.#homeDir,
        runtimeDirs: this.#runtimeDirs,
        tempDirs: this.#tempDirs,
        trashDir: ctx.trashDir,
        trash: {
          move: (input) => ctx.trash.move(input),
          // The policy records trash entries at rewrite time (the shell executes the
          // mv later), so the management API can restore policy-rewritten deletes.
          record: (input) => {
            try {
              this.#store.createTrashEntry({ id: randomUUID(), runId: ctx.runId, workspaceRoot: input.workspaceRoot, originalPath: input.originalPath, trashPath: input.trashPath, createdAt: new Date().toISOString() });
            } catch {
              // Missing agent_run row (e.g. in unit tests) must not crash the run.
            }
          },
        },
        nextSequence: () => ++ctx.sequence,
        log: ctx.log,
        createdPaths: ctx.createdPaths,
      };
      return evaluateToolCall(request, policyCtx, signal);
    };
  }

  /** The runtime's `redactToolResult`: scrubs secrets from tool output before the model reads it. */
  createResultRedactor(): ToolResultRedactor {
    return ({ content }) => redactToolResultContent(content as Array<{ type: string; text?: string }>);
  }

  /** The runtime's `customTools`: registers `fitz.trash` bound to this run's trash. */
  createCustomTools(): (context: { cwd: string; runId?: string }) => ToolDefinition[] {
    return (context) => [createTrashTool(async (input) => this.trash(input.paths, context.runId, context.cwd))];
  }

  /** Handler backing the `fitz.trash` tool: move paths into the run trash, zone-validated. */
  async trash(paths: string[], runId: string | undefined, cwd: string): Promise<TrashMoveResult | { error: string }> {
    const ctx = this.#getContext(runId, cwd);
    const entries: TrashMoveResult["entries"] = [];
    const failures: string[] = [];
    for (const rawPath of paths) {
      const absolute = resolveAbsolutePath(rawPath, cwd);
      if (!absolute) { failures.push(rawPath); continue; }
      const info = classifyPath(rawPath, { workspaceRoot: cwd, runtimeDirs: this.#runtimeDirs, tempDirs: this.#tempDirs, homeDir: this.#homeDir });
      const workspaceKey = canonicalizePath(cwd, cwd);
      const isWorkspaceRoot = workspaceKey !== undefined && info.canonical === workspaceKey;
      if ((info.zone !== "workspace" && info.zone !== "runtime" && info.zone !== "temp") || isWorkspaceRoot) {
        failures.push(rawPath);
        continue;
      }
      try {
        const trashPath = await ctx.trash.move({ runId: ctx.runId, workspaceRoot: cwd, path: absolute, sequence: ++ctx.sequence });
        entries.push({ originalPath: rawPath, trashPath });
      } catch (error) {
        failures.push(rawPath);
      }
    }
    if (failures.length > 0) {
      return { error: `Fitz refused to trash: ${failures.join(", ")}. Only files inside the project workspace (or the run's runtime/temp dirs) can be trashed.` };
    }
    return { moved: entries.length, entries };
  }

  async restoreSnapshot(runId: string): Promise<{ runId: string; restored: number; status: SnapshotRecord["status"] }> {
    const snapshot = this.#store.getSnapshot(runId);
    if (!snapshot) throw new Error("Snapshot not found");
    if (snapshot.status === "skipped" || snapshot.status === "failed") {
      throw new Error(`Snapshot for run ${runId} is ${snapshot.status}; nothing to restore`);
    }
    const restored = await restoreWorkspaceSnapshot(snapshot.workspaceRoot, snapshot.snapshotDir);
    this.#store.updateSnapshotStatus(runId, "restored");
    return { runId, restored, status: "restored" };
  }

  listSnapshots(limit = 100): SnapshotRecord[] {
    return this.#store.listSnapshots(limit);
  }

  listTrash(workspaceRoot?: string, limit = 200): TrashEntryRecord[] {
    return this.#store.listTrashEntries(workspaceRoot, limit);
  }

  async restoreTrash(id: string): Promise<TrashEntryRecord> {
    const entry = this.#store.getTrashEntry(id);
    if (!entry) throw new Error("Trash entry not found");
    return new TrashService({ store: this.#store, workspaceRoot: entry.workspaceRoot }).restore(id);
  }
}
