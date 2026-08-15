/**
 * AgentSafetyService: the host-side safety layer for agent runs.
 *
 * Wires the deterministic policy engine (trash-everything deletes, zone blocking),
 * pre-run workspace snapshots, the trash service, and content redaction into the
 * Pi runtime's extension hooks. All machine guarantees — no approval prompts involved.
 */

import { mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SqliteStore } from "@fitz/storage";
import type { SnapshotRecord, ToolActionRecord, TrashEntryRecord } from "@fitz/protocol";
import type { SandboxedBashExecutor, ToolDefinition, ToolEvaluator, ToolResultRedactor, TrashMoveResult } from "@fitz/agent-pi";
import { createSandboxedBashTool, createTrashTool } from "@fitz/agent-pi";
import { canonicalizePath, classifyPath, resolveAbsolutePath } from "./paths.js";
import { createWorkspaceSnapshot, restoreWorkspaceSnapshot } from "./snapshot.js";
import { TrashService } from "./trash.js";
import { evaluateToolCall, type ActionLog, type PolicyContext } from "./policy.js";
import { redactToolResultContent } from "./redaction.js";
import { bwrapAvailable, runSandboxed, type SandboxSpawn } from "./sandbox.js";

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
  /** Injectable spawn seam for the sandbox (tests); defaults to the real child_process.spawn. */
  sandboxSpawn?: SandboxSpawn;
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

/** Default retention for trash and snapshots: 30 days. */
export const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class AgentSafetyService {
  readonly #store: SqliteStore;
  readonly #snapshotsDir: string;
  readonly #runtimeDirs: readonly string[];
  readonly #tempDirs: readonly string[];
  readonly #homeDir: string;
  readonly #maxSnapshotBytes: number;
  readonly #maxSnapshotFiles: number;
  readonly #sandboxSpawn: SandboxSpawn | undefined;
  readonly #contexts = new Map<string, RunSafetyContext>();
  #containmentWarned = false;

  constructor(options: AgentSafetyOptions) {
    this.#store = options.store;
    this.#snapshotsDir = options.snapshotsDir;
    this.#runtimeDirs = options.runtimeDirs ?? [];
    this.#tempDirs = [tmpdir(), ...(options.tempDirs ?? [])];
    this.#homeDir = options.homeDir ?? homedir();
    this.#maxSnapshotBytes = options.maxSnapshotBytes ?? 1_073_741_824;
    this.#maxSnapshotFiles = options.maxSnapshotFiles ?? 50_000;
    this.#sandboxSpawn = options.sandboxSpawn;
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
      // Media tools (§5.9) resolve their per-tool policy against the run's owner, exactly
      // like the HTTP approval endpoint's `resolveToolPolicy(userId, role, toolName)`
      // consult: user-level policy wins, then role-level, then the "ask" default.
      const run = request.runId ? this.#store.getAgentRun(request.runId) : undefined;
      const owner = run?.ownerUserId ? this.#store.getUser(run.ownerUserId) : undefined;
      // Consumer credentials are safe for Internet sharing: they may use the
      // model and explicitly granted media APIs, but may never execute tools on
      // the host PC. Agent and administrator accounts retain the normal policy.
      if (owner?.role === "consumer") {
        // The durable plan tool only updates this run's host-side bookkeeping.
        // It cannot inspect or mutate the host filesystem, and blocking it makes
        // the mandatory plan-first loop impossible for every shared chat.
        if (request.toolName === "agent_plan") return { action: "allow" };
        // Block before constructing a run safety context: context construction
        // creates a workspace snapshot, which a remote consumer must not be able
        // to trigger merely by asking the model to call a tool.
        if (request.runId) {
          try {
            this.#store.appendToolAction({
              runId: request.runId,
              timestamp: new Date().toISOString(),
              toolName: request.toolName,
              effect: "block",
              detail: { reason: "consumer-chat-only" },
            });
          } catch {
            // A missing run row must not turn a safe block into a runtime error.
          }
        }
        return { action: "block", reason: "Shared consumer accounts cannot execute tools on the Fitz host" };
      }
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
        resolveToolPolicy: (toolName) => this.#store.resolveToolPolicy(owner?.id, owner?.role, toolName),
      };
      return evaluateToolCall(request, policyCtx, signal);
    };
  }

  /** The runtime's `redactToolResult`: scrubs secrets from tool output before the model reads it. */
  createResultRedactor(): ToolResultRedactor {
    return ({ content }) => redactToolResultContent(content as Array<{ type: string; text?: string }>);
  }

  /** The runtime's `customTools`: registers `fitz_trash` and the sandboxed `bash` for this run. */
  createCustomTools(): (context: { cwd: string; runId?: string }) => ToolDefinition[] {
    return (context) => [
      createTrashTool(async (input) => this.trash(input.paths, context.runId, context.cwd)),
      createSandboxedBashTool(this.#sandboxedBashExecutor(context.cwd)),
    ];
  }

  /** The executor behind the sandboxed `bash` tool: run the policy-cleared command in the container. */
  #sandboxedBashExecutor(cwd: string): SandboxedBashExecutor {
    const containment = {
      workspace: cwd,
      runtimeDirs: this.#runtimeDirs,
      tempDirs: this.#tempDirs,
      homeDir: this.#homeDir,
    };
    return async ({ command, timeout, signal }) => {
      if (!bwrapAvailable() && !this.#containmentWarned) {
        this.#containmentWarned = true;
        console.warn(
          "[fitz-safety] bubblewrap (bwrap) is not available: bash commands run WITHOUT OS-level containment. " +
            "The deterministic policy still rewrites deletes to the trash and blocks destructive commands, " +
            "but there is no kernel-level write barrier. Install bubblewrap for full sandboxing.",
        );
      }
      return runSandboxed(
        { command, ...containment, ...(timeout !== undefined ? { timeout } : {}), ...(signal ? { signal } : {}) },
        this.#sandboxSpawn,
      );
    };
  }

  /** Handler backing the `fitz_trash` tool: move paths into the run trash, zone-validated. */
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
    // Opportunistic retention GC: listing the trash is the natural moment to sweep
    // expired entries in the background; the response never waits on it.
    void this.collectTrash(DEFAULT_RETENTION_MS).catch(() => undefined);
    return this.#store.listTrashEntries(workspaceRoot, limit);
  }

  async restoreTrash(id: string): Promise<TrashEntryRecord> {
    const entry = this.#store.getTrashEntry(id);
    if (!entry) throw new Error("Trash entry not found");
    return new TrashService({ store: this.#store, workspaceRoot: entry.workspaceRoot }).restore(id);
  }

  /** Audit readout over every recorded tool evaluation (all runs, newest first). */
  listToolActions(limit = 200): ToolActionRecord[] {
    return this.#store.listAllToolActions(limit);
  }

  /**
   * Explicitly empty the trash for one workspace (or all workspaces): the single
   * sanctioned permanent delete, initiated by a human from the management UI.
   */
  async emptyTrash(workspaceRoot?: string): Promise<{ removed: number }> {
    if (workspaceRoot) {
      return new TrashService({ store: this.#store, workspaceRoot }).empty();
    }
    const workspaces = new Set(this.#store.listTrashEntries(undefined, 10_000).map((entry) => entry.workspaceRoot));
    let removed = 0;
    for (const root of workspaces) {
      const result = await new TrashService({ store: this.#store, workspaceRoot: root }).empty();
      removed += result.removed;
    }
    return { removed };
  }

  /** Retention GC for trashed files: permanently deletes entries older than `maxAgeMs`. */
  async collectTrash(maxAgeMs: number): Promise<{ removed: number }> {
    const before = new Date(Date.now() - maxAgeMs).toISOString();
    const workspaces = new Set(this.#store.listTrashEntries(undefined, 10_000).map((entry) => entry.workspaceRoot));
    let removed = 0;
    for (const root of workspaces) {
      const result = await new TrashService({ store: this.#store, workspaceRoot: root }).collectExpired(before);
      removed += result.removed;
    }
    return { removed };
  }

  /** Retention GC for pre-run snapshots: deletes snapshot dirs older than `maxAgeMs`. */
  async collectSnapshots(maxAgeMs: number): Promise<{ removed: number }> {
    const before = new Date(Date.now() - maxAgeMs).toISOString();
    let removed = 0;
    for (const snapshot of this.#store.listSnapshots(10_000)) {
      if (snapshot.createdAt >= before) continue;
      try {
        rmSync(snapshot.snapshotDir, { recursive: true, force: true });
      } catch {
        // Best effort: a locked dir must not abort the sweep.
      }
      if (this.#store.deleteSnapshot(snapshot.runId)) removed++;
    }
    return { removed };
  }

  /** Full retention sweep (trash + snapshots), used by the GC endpoint and run completion. */
  async collect(maxAgeMs: number = DEFAULT_RETENTION_MS): Promise<{ trash: number; snapshots: number }> {
    const [trash, snapshots] = await Promise.all([this.collectTrash(maxAgeMs), this.collectSnapshots(maxAgeMs)]);
    return { trash: trash.removed, snapshots: snapshots.removed };
  }
}
