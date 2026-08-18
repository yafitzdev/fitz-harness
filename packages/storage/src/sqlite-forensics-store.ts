import type { DatabaseSync } from "node:sqlite";
import type {
  AgentEventEnvelope,
  AgentRunRecord,
  AuditEventRecord,
  InferenceEvidenceRecord,
  InferenceRequestRecord,
  MediaJobEvent,
  RequestUsageRecord,
  SessionForensicsBundle,
  SessionForensicsMediaJob,
  SessionForensicsRun,
} from "@fitz/protocol";
import { SqliteAgentRunStore } from "./sqlite-agent-run-store.js";
import { SqliteInferenceEvidenceStore } from "./sqlite-inference-evidence-store.js";
import { SqliteInferenceTelemetryStore } from "./sqlite-inference-telemetry-store.js";
import { SqliteIdentityStore } from "./sqlite-identity-store.js";
import { SqliteMediaStore } from "./sqlite-media-store.js";
import { SqliteSafetyStore } from "./sqlite-safety-store.js";
import { SqliteWorkspaceStore } from "./sqlite-workspace-store.js";
import { ForensicsPersistenceTracker } from "./forensics-persistence-tracker.js";

interface JsonRow { event_json: string }
interface AuditRow { id: string; timestamp: string; actor_user_id: string | null; action: string; target_type: string | null; target_id: string | null; detail_json: string }
interface LegacyRequestRow { id: string; route_id: string; status: InferenceRequestRecord["status"]; enqueued_at: string; started_at: string | null; completed_at: string | null; error_code: string | null }
interface GpuRow { id: string; route_id: string; kind: "chat" | "media" | "warm"; status: string; position: number; depth: number; enqueued_at: string; started_at: string | null; completed_at: string | null; error_code: string | null }

/** Joins the normalized durable stores into one session-rooted evidence
 * document. This is the only place that defines what “session forensics”
 * means; routes and tools consume this service instead of duplicating joins. */
export class SqliteForensicsStore {
  readonly #agent: SqliteAgentRunStore;
  readonly #evidence: SqliteInferenceEvidenceStore;
  readonly #telemetry: SqliteInferenceTelemetryStore;
  readonly #identity: SqliteIdentityStore;
  readonly #media: SqliteMediaStore;
  readonly #safety: SqliteSafetyStore;
  readonly #workspace: SqliteWorkspaceStore;

  constructor(private readonly database: DatabaseSync, private readonly persistence: ForensicsPersistenceTracker) {
    this.#agent = new SqliteAgentRunStore(database);
    this.#evidence = new SqliteInferenceEvidenceStore(database);
    this.#telemetry = new SqliteInferenceTelemetryStore(database);
    this.#identity = new SqliteIdentityStore(database);
    this.#media = new SqliteMediaStore(database);
    this.#safety = new SqliteSafetyStore(database);
    this.#workspace = new SqliteWorkspaceStore(database);
  }

  build(sessionId: string, generatedAt = new Date().toISOString()): SessionForensicsBundle | undefined {
    const session = this.#workspace.getSession(sessionId);
    if (!session) return undefined;
    const project = session.projectId ? this.#workspace.getProject(session.projectId) : undefined;
    const transcript = readTranscript(this.#workspace, sessionId);
    const directEvidence = this.#evidence.listForSession(sessionId);
    const runs = sessionRuns(this.#agent, sessionId).map((run) => this.#run(run));
    const evidence = mergeEvidence(directEvidence, runs.flatMap((run) => run.evidence));
    const directUsage = this.#telemetry.listRequestUsageForSession(sessionId);
    const usage = mergeUsage(directUsage, runs.flatMap((run) => run.usage));
    const mediaJobs = this.#media.listJobs({ sessionId, limit: 100_000 }).map((job): SessionForensicsMediaJob => ({
      job,
      events: readMediaEvents(this.#media, job.id),
      usage: usage.filter((record) => record.id === job.id),
    }));
    const artifacts = this.#workspace.listArtifacts(sessionId).map((artifact) => ({ ...artifact }));
    const runIds = runs.map((item) => item.run.id);
    const artifactIds = artifacts.map((artifact) => artifact.id);
    const mediaJobIds = mediaJobs.map((item) => item.job.id);
    const approvals = this.#identity.listToolApprovals(sessionId);
    const approvalIds = approvals.map((approval) => approval.id);
    const requestIds = [...new Set([...evidence.map((item) => item.id), ...usage.map((item) => item.id), ...mediaJobIds])];
    const lifecycleEvents = this.#lifecycleEvents(sessionId, runIds, requestIds);
    const correlatedRequestIds = [...new Set([...requestIds, ...lifecycleRequestIds(lifecycleEvents)])];
    const externalProcessLogs = evidence.some((item) => {
      const diagnostics = item.engine?.diagnostics;
      return typeof diagnostics === "object" && diagnostics !== null && Array.isArray((diagnostics as Record<string, unknown>).logs);
    }) ? "best-effort" as const : "not-captured" as const;
    const persistenceErrors = this.persistence.listForSession(sessionId);

    return {
      schemaVersion: 1,
      generatedAt,
      session,
      ...(project ? { project } : {}),
      transcript,
      evidence,
      runs,
      approvals,
      artifacts,
      mediaJobs,
      usage,
      auditEvents: this.#auditEvents(sessionId, session.projectId, runIds, artifactIds, mediaJobIds, approvalIds),
      lifecycleEvents,
      legacyInferenceRequests: this.#legacyRequests(correlatedRequestIds),
      gpuWork: this.#gpuWork(correlatedRequestIds),
      coverage: {
        normalizedAdapterEvidence: persistenceErrors.length === 0,
        persistenceErrors,
        rawProviderWirePayloads: "not-captured",
        externalProcessLogs,
        reasoning: "emitted-events-only",
        artifactContent: "metadata-only",
      },
    };
  }

  #run(run: AgentRunRecord): SessionForensicsRun {
    const events = readAgentEvents(this.#agent, run.id);
    const request = this.#agent.getRunRequest(run.id);
    const plan = this.#agent.getRunPlan(run.id);
    const snapshot = this.#safety.getSnapshot(run.id);
    return {
      run,
      ...(request ? { request } : {}),
      ...(run.checkpoint ? { checkpoint: run.checkpoint } : {}),
      ...(plan ? { plan } : {}),
      events,
      usage: this.#telemetry.listRequestUsageForRun(run.id),
      evidence: this.#evidence.listForRun(run.id),
      toolActions: this.#safety.listToolActions(run.id, 100_000),
      ...(snapshot ? { snapshot } : {}),
      trashEntries: this.#safety.listTrashEntriesForRun(run.id),
    };
  }

  #auditEvents(sessionId: string, projectId: string | undefined, runIds: string[], artifactIds: string[], mediaJobIds: string[], approvalIds: string[]): AuditEventRecord[] {
    const clauses: string[] = ["(target_type = 'session' AND target_id = ?)"];
    const values: string[] = [sessionId];
    addTargetClause(clauses, values, "project", projectId ? [projectId] : []);
    addTargetClause(clauses, values, "agent-run", runIds);
    addTargetClause(clauses, values, "artifact", artifactIds);
    addTargetClause(clauses, values, "media-job", mediaJobIds);
    addTargetClause(clauses, values, "tool-approval", approvalIds);
    const rows = this.database.prepare(`SELECT id, timestamp, actor_user_id, action, target_type, target_id, detail_json FROM audit_events WHERE ${clauses.join(" OR ")} ORDER BY timestamp, id`).all(...values) as unknown as AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      action: row.action,
      detail: JSON.parse(row.detail_json) as Record<string, unknown>,
      ...(row.actor_user_id ? { actorUserId: row.actor_user_id } : {}),
      ...(row.target_type ? { targetType: row.target_type } : {}),
      ...(row.target_id ? { targetId: row.target_id } : {}),
    }));
  }

  #lifecycleEvents(sessionId: string, runIds: string[], requestIds: string[]): ReadonlyArray<Readonly<Record<string, unknown>>> {
    const ids = [sessionId, ...runIds, ...requestIds];
    const clauses = ids.map(() => "event_json LIKE ?");
    const values = ids.map((id) => `%${escapeLike(id)}%`);
    if (clauses.length === 0) return [];
    const rows = this.database.prepare(`SELECT event_json FROM lifecycle_events WHERE ${clauses.join(" OR ")} ESCAPE '\\' ORDER BY sequence`).all(...values) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.event_json) as Record<string, unknown>);
  }

  #legacyRequests(ids: string[]): ReadonlyArray<Readonly<Record<string, unknown>>> {
    if (ids.length === 0) return [];
    const rows = this.database.prepare(`SELECT id, route_id, status, enqueued_at, started_at, completed_at, error_code FROM inference_requests WHERE id IN (${placeholders(ids.length)}) ORDER BY enqueued_at, id`).all(...ids) as unknown as LegacyRequestRow[];
    return rows.map((row) => ({
      id: row.id,
      routeId: row.route_id,
      status: row.status,
      enqueuedAt: row.enqueued_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
    }));
  }

  #gpuWork(ids: string[]): ReadonlyArray<Readonly<Record<string, unknown>>> {
    if (ids.length === 0) return [];
    const rows = this.database.prepare(`SELECT id, route_id, kind, status, position, depth, enqueued_at, started_at, completed_at, error_code FROM gpu_work_items WHERE id IN (${placeholders(ids.length)}) ORDER BY enqueued_at, id`).all(...ids) as unknown as GpuRow[];
    return rows.map((row) => ({
      id: row.id,
      routeId: row.route_id,
      kind: row.kind,
      status: row.status,
      position: row.position,
      depth: row.depth,
      enqueuedAt: row.enqueued_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
    }));
  }
}

function readTranscript(workspace: SqliteWorkspaceStore, sessionId: string) {
  const entries = [] as ReturnType<SqliteWorkspaceStore["transcriptAfter"]>;
  let sequence = 0;
  for (;;) {
    const page = workspace.transcriptAfter(sessionId, sequence, 1_000);
    entries.push(...page);
    if (page.length < 1_000) return entries;
    sequence = page.at(-1)!.sequence;
  }
}

function sessionRuns(agent: SqliteAgentRunStore, sessionId: string): AgentRunRecord[] {
  const roots = agent.listRunsForSession(sessionId);
  const found = new Map(roots.map((run) => [run.id, run]));
  const queue = [...roots];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const child of agent.listChildRuns(parent.id)) {
      if (found.has(child.id)) continue;
      found.set(child.id, child);
      queue.push(child);
    }
  }
  return [...found.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function mergeEvidence(...groups: InferenceEvidenceRecord[][]): InferenceEvidenceRecord[] {
  const merged = new Map<string, InferenceEvidenceRecord>();
  for (const group of groups) for (const record of group) merged.set(record.id, record);
  return [...merged.values()].sort((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt) || left.id.localeCompare(right.id));
}

function mergeUsage(...groups: RequestUsageRecord[][]): RequestUsageRecord[] {
  const merged = new Map<string, RequestUsageRecord>();
  for (const group of groups) for (const record of group) merged.set(record.id, record);
  return [...merged.values()].sort((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt) || left.id.localeCompare(right.id));
}

function readAgentEvents(agent: SqliteAgentRunStore, runId: string): AgentEventEnvelope[] {
  const events: AgentEventEnvelope[] = [];
  let sequence = 0;
  for (;;) {
    const page = agent.eventsAfter(runId, sequence, 1_000);
    events.push(...page);
    if (page.length < 1_000) return events;
    sequence = page.at(-1)!.sequence;
  }
}

function readMediaEvents(media: SqliteMediaStore, jobId: string): Array<{ jobId: string; sequence: number; timestamp: string; event: MediaJobEvent }> {
  const events: Array<{ jobId: string; sequence: number; timestamp: string; event: MediaJobEvent }> = [];
  let sequence = 0;
  for (;;) {
    const page = media.eventsAfter(jobId, sequence, 1_000);
    events.push(...page);
    if (page.length < 1_000) return events;
    sequence = page.at(-1)!.sequence;
  }
}

function addTargetClause(clauses: string[], values: string[], type: string, ids: string[]): void {
  if (ids.length === 0) return;
  clauses.push(`(target_type = '${type}' AND target_id IN (${placeholders(ids.length)}))`);
  values.push(...ids);
}

function lifecycleRequestIds(events: ReadonlyArray<Readonly<Record<string, unknown>>>): string[] {
  return events.flatMap((event) => {
    const direct = typeof event.requestId === "string" ? [event.requestId] : [];
    const data = event.data;
    const nested = typeof data === "object" && data !== null && !Array.isArray(data) && typeof (data as Record<string, unknown>).requestId === "string"
      ? [(data as Record<string, unknown>).requestId as string]
      : [];
    return [...direct, ...nested];
  });
}

function placeholders(count: number): string { return Array.from({ length: count }, () => "?").join(", "); }
function escapeLike(value: string): string { return value.replace(/[\\%_]/g, (character) => `\\${character}`); }
