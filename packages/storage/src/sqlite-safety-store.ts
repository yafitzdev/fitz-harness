import type { DatabaseSync } from "node:sqlite";
import type { SnapshotRecord, ToolActionRecord, TrashEntryRecord } from "@fitz/protocol";

interface ToolActionRow { run_id: string; sequence: number; timestamp: string; tool_name: string; effect: ToolActionRecord["effect"]; path: string | null; detail_json: string }
interface SnapshotRow { run_id: string; workspace_root: string; snapshot_dir: string; created_at: string; status: SnapshotRecord["status"]; file_count: number }
interface TrashRow { id: string; run_id: string | null; workspace_root: string; original_path: string; trash_path: string; created_at: string; restored_at: string | null }

/** Durable safety audit, snapshot, and recoverable-trash persistence. */
export class SqliteSafetyStore {
  constructor(private readonly database: DatabaseSync) {}

  appendToolAction(action: Omit<ToolActionRecord, "sequence">): ToolActionRecord { const sequence = this.nextToolActionSequence(action.runId); const record: ToolActionRecord = { ...action, sequence }; this.database.prepare(`INSERT INTO tool_action_log (run_id, sequence, timestamp, tool_name, effect, path, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(record.runId, record.sequence, record.timestamp, record.toolName, record.effect, record.path ?? null, JSON.stringify(record.detail)); return record; }
  nextToolActionSequence(runId: string): number { const row = this.database.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM tool_action_log WHERE run_id = ?`).get(runId) as { sequence: number }; return row.sequence; }
  listToolActions(runId: string, limit = 1000): ToolActionRecord[] { const rows = this.database.prepare(`SELECT run_id, sequence, timestamp, tool_name, effect, path, detail_json FROM tool_action_log WHERE run_id = ? ORDER BY sequence LIMIT ?`).all(runId, limit) as unknown as ToolActionRow[]; return rows.map(mapToolAction); }
  listAllToolActions(limit = 500): ToolActionRecord[] { const rows = this.database.prepare(`SELECT run_id, sequence, timestamp, tool_name, effect, path, detail_json FROM tool_action_log ORDER BY timestamp DESC, run_id DESC, sequence DESC LIMIT ?`).all(limit) as unknown as ToolActionRow[]; return rows.map(mapToolAction); }

  createSnapshot(snapshot: SnapshotRecord): void { this.database.prepare(`INSERT INTO snapshots (run_id, workspace_root, snapshot_dir, created_at, status, file_count) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET workspace_root = excluded.workspace_root, snapshot_dir = excluded.snapshot_dir, created_at = excluded.created_at, status = excluded.status, file_count = excluded.file_count`).run(snapshot.runId, snapshot.workspaceRoot, snapshot.snapshotDir, snapshot.createdAt, snapshot.status, snapshot.fileCount); }
  getSnapshot(runId: string): SnapshotRecord | undefined { const row = this.database.prepare(`SELECT run_id, workspace_root, snapshot_dir, created_at, status, file_count FROM snapshots WHERE run_id = ?`).get(runId) as SnapshotRow | undefined; return row ? mapSnapshot(row) : undefined; }
  listSnapshots(limit = 100): SnapshotRecord[] { return (this.database.prepare(`SELECT run_id, workspace_root, snapshot_dir, created_at, status, file_count FROM snapshots ORDER BY created_at DESC LIMIT ?`).all(limit) as unknown as SnapshotRow[]).map(mapSnapshot); }
  updateSnapshotStatus(runId: string, status: SnapshotRecord["status"]): void { this.database.prepare(`UPDATE snapshots SET status = ? WHERE run_id = ?`).run(status, runId); }
  deleteSnapshot(runId: string): boolean { return this.database.prepare(`DELETE FROM snapshots WHERE run_id = ?`).run(runId).changes > 0; }

  createTrashEntry(entry: TrashEntryRecord): void { this.database.prepare(`INSERT INTO trash_entries (id, run_id, workspace_root, original_path, trash_path, created_at, restored_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(entry.id, entry.runId ?? null, entry.workspaceRoot, entry.originalPath, entry.trashPath, entry.createdAt, entry.restoredAt ?? null); }
  getTrashEntry(id: string): TrashEntryRecord | undefined { const row = this.database.prepare(`SELECT id, run_id, workspace_root, original_path, trash_path, created_at, restored_at FROM trash_entries WHERE id = ?`).get(id) as TrashRow | undefined; return row ? mapTrash(row) : undefined; }
  listTrashEntries(workspaceRoot?: string, limit = 200): TrashEntryRecord[] { const rows = (workspaceRoot ? this.database.prepare(`SELECT id, run_id, workspace_root, original_path, trash_path, created_at, restored_at FROM trash_entries WHERE workspace_root = ? ORDER BY created_at DESC LIMIT ?`).all(workspaceRoot, limit) : this.database.prepare(`SELECT id, run_id, workspace_root, original_path, trash_path, created_at, restored_at FROM trash_entries ORDER BY created_at DESC LIMIT ?`).all(limit)) as unknown as TrashRow[]; return rows.map(mapTrash); }
  markTrashRestored(id: string, restoredAt: string): boolean { return Number(this.database.prepare(`UPDATE trash_entries SET restored_at = ? WHERE id = ? AND restored_at IS NULL`).run(restoredAt, id).changes) > 0; }
  deleteTrashEntry(id: string): boolean { return this.database.prepare(`DELETE FROM trash_entries WHERE id = ?`).run(id).changes > 0; }
  deleteTrashEntriesBefore(before: string, workspaceRoot?: string): number { return Number((workspaceRoot ? this.database.prepare(`DELETE FROM trash_entries WHERE created_at < ? AND workspace_root = ?`) : this.database.prepare(`DELETE FROM trash_entries WHERE created_at < ?`)).run(before, ...(workspaceRoot ? [workspaceRoot] : [])).changes); }
}

function mapToolAction(row: ToolActionRow): ToolActionRecord { return { runId: row.run_id, sequence: row.sequence, timestamp: row.timestamp, toolName: row.tool_name, effect: row.effect, detail: JSON.parse(row.detail_json) as Record<string, unknown>, ...(row.path ? { path: row.path } : {}) }; }
function mapSnapshot(row: SnapshotRow): SnapshotRecord { return { runId: row.run_id, workspaceRoot: row.workspace_root, snapshotDir: row.snapshot_dir, createdAt: row.created_at, status: row.status, fileCount: row.file_count }; }
function mapTrash(row: TrashRow): TrashEntryRecord { return { id: row.id, workspaceRoot: row.workspace_root, originalPath: row.original_path, trashPath: row.trash_path, createdAt: row.created_at, ...(row.run_id ? { runId: row.run_id } : {}), ...(row.restored_at ? { restoredAt: row.restored_at } : {}) }; }
