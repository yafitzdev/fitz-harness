/** Agent safety records: the durable ground truth behind the policy engine. */

export type ToolActionEffect =
  | "create"
  | "write"
  | "delete"
  | "move"
  | "trash"
  | "restore"
  | "allow"
  | "rewrite"
  | "block"
  | "unknown";

/** One recorded tool evaluation, persisted so every decision is replayable. */
export interface ToolActionRecord {
  runId: string;
  sequence: number;
  timestamp: string;
  toolName: string;
  effect: ToolActionEffect;
  /** Canonical path the action targeted, when one is meaningful. */
  path?: string;
  detail: Readonly<Record<string, unknown>>;
}

export type SnapshotStatus = "active" | "restored" | "failed" | "skipped";

/** A pre-run snapshot of a workspace, used for provenance checks and recovery. */
export interface SnapshotRecord {
  runId: string;
  workspaceRoot: string;
  snapshotDir: string;
  createdAt: string;
  status: SnapshotStatus;
  fileCount: number;
}

/** A file moved to the agent trash instead of being hard-deleted. */
export interface TrashEntryRecord {
  id: string;
  runId?: string;
  workspaceRoot: string;
  originalPath: string;
  trashPath: string;
  createdAt: string;
  restoredAt?: string;
}
