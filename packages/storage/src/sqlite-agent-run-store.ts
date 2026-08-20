import type { DatabaseSync } from "node:sqlite";
import type {
  AgentEventEnvelope,
  AgentRunCheckpoint,
  AgentRunPlan,
  AgentRunRecord,
  AgentRunRequest,
  TranscriptEntryRecord,
  JobEvent,
} from "@fitz/protocol";
import { SqliteJobStore } from "./sqlite-job-store.js";

interface AgentRunRow {
  id: string;
  route_id: string;
  owner_user_id: string | null;
  owner_device_id: string | null;
  session_id: string | null;
  status: AgentRunRecord["status"];
  created_at: string;
  updated_at: string;
  last_sequence: number;
  error: string | null;
}

interface AgentRunStateRow {
  request_json: string;
  resume_of_run_id: string | null;
  checkpoint_json: string;
  resumable: number;
  client_request_id?: string | null;
}

interface ChildRunRow extends AgentRunRow {
  request_json: string;
}

interface TranscriptRow {
  id: string;
  session_id: string;
  sequence: number;
  kind: TranscriptEntryRecord["kind"];
  role: TranscriptEntryRecord["role"] | null;
  content_json: string;
  created_at: string;
}

const RUN_COLUMNS = "id, route_id, owner_user_id, owner_device_id, session_id, status, created_at, updated_at, last_sequence, error";

export class SqliteAgentRunStore {
  constructor(private readonly database: DatabaseSync, private readonly jobs = new SqliteJobStore(database)) {}

  createRun(run: AgentRunRecord, request?: AgentRunRequest, resumeOfRunId?: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(`INSERT INTO agent_runs (${RUN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) `)
        .run(
          run.id,
          run.routeId,
          run.ownerUserId ?? null,
          run.ownerDeviceId ?? null,
          run.sessionId ?? null,
          run.status,
          run.createdAt,
          run.updatedAt,
          run.lastSequence,
          run.error ?? null,
        );
      if (request) {
        this.database
          .prepare("INSERT INTO agent_run_state (run_id, request_json, resume_of_run_id, checkpoint_json, resumable, client_request_id) VALUES (?, ?, ?, ?, 0, ?)")
          .run(
            run.id,
            JSON.stringify(request),
            resumeOfRunId ?? null,
            JSON.stringify(initialAgentCheckpoint(run.createdAt)),
            request.clientRequestId ?? null,
          );
      }
      this.jobs.create({
        id: run.id,
        kind: "agent",
        status: run.status,
        ...(run.ownerUserId ? { ownerUserId: run.ownerUserId } : {}),
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        ...(request?.delegation?.parentRunId ? { parentJobId: request.delegation.parentRunId } : {}),
        routeId: run.routeId,
        ...(run.error ? { error: run.error } : {}),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getRun(id: string): AgentRunRecord | undefined {
    const row = this.database.prepare(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE id = ?`).get(id) as AgentRunRow | undefined;
    return row ? this.withRunState(mapAgentRun(row)) : undefined;
  }

  listRuns(ownerUserId?: string, limit = 100): AgentRunRecord[] {
    const rows = (ownerUserId
      ? this.database.prepare(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT ?`).all(ownerUserId, limit)
      : this.database.prepare(`SELECT ${RUN_COLUMNS} FROM agent_runs ORDER BY created_at DESC LIMIT ?`).all(limit)) as unknown as AgentRunRow[];
    return rows.map((row) => this.withRunState(mapAgentRun(row)));
  }

  listRunsForSession(sessionId: string): AgentRunRecord[] {
    const rows = this.database.prepare(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE session_id = ? ORDER BY created_at, id`).all(sessionId) as unknown as AgentRunRow[];
    return rows.map((row) => this.withRunState(mapAgentRun(row)));
  }

  /** Child runs intentionally have no session_id because their conversation
   * is isolated from the visible chat. Forensics still needs to include them,
   * so correlate the durable delegation parent link without changing UI
   * transcript semantics. */
  listChildRuns(parentRunId: string): AgentRunRecord[] {
    const columns = RUN_COLUMNS.split(", ").map((column) => `r.${column}`).join(", ");
    const rows = this.database.prepare(`SELECT ${columns}, s.request_json FROM agent_runs r JOIN agent_run_state s ON s.run_id = r.id`).all() as unknown as ChildRunRow[];
    return rows.flatMap((row) => {
      try {
        const request = JSON.parse(row.request_json) as AgentRunRequest;
        return request.delegation?.parentRunId === parentRunId ? [this.withRunState(mapAgentRun(row))] : [];
      } catch {
        return [];
      }
    });
  }

  getRunRequest(id: string): AgentRunRequest | undefined {
    const row = this.database.prepare("SELECT request_json FROM agent_run_state WHERE run_id = ?").get(id) as Pick<AgentRunStateRow, "request_json"> | undefined;
    return row ? JSON.parse(row.request_json) as AgentRunRequest : undefined;
  }

  getRunPlan(runId: string): AgentRunPlan | undefined {
    const row = this.database
      .prepare("SELECT plan_json FROM agent_run_plans WHERE run_id = ?")
      .get(runId) as { plan_json: string } | undefined;
    return row ? JSON.parse(row.plan_json) as AgentRunPlan : undefined;
  }

  saveRunPlan(plan: AgentRunPlan, expectedRevision?: number): boolean {
    const existing = this.getRunPlan(plan.runId);
    if (expectedRevision !== undefined && existing?.revision !== expectedRevision) return false;
    if (!existing) {
      this.database.prepare("INSERT INTO agent_run_plans (run_id, revision, status, plan_json, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(plan.runId, plan.revision, plan.status, JSON.stringify(plan), plan.createdAt, plan.updatedAt, plan.completedAt ?? null);
      return true;
    }
    const result = this.database.prepare("UPDATE agent_run_plans SET revision = ?, status = ?, plan_json = ?, updated_at = ?, completed_at = ? WHERE run_id = ? AND revision = ?")
      .run(plan.revision, plan.status, JSON.stringify(plan), plan.updatedAt, plan.completedAt ?? null, plan.runId, existing.revision);
    return Number(result.changes) === 1;
  }

  latestSessionRun(sessionId: string): AgentRunRecord | undefined {
    const row = this.database
      .prepare(`SELECT ${RUN_COLUMNS.split(", ").map((column) => `r.${column}`).join(", ")} FROM agent_runs r LEFT JOIN agent_run_state s ON s.run_id = r.id WHERE r.session_id = ? AND (r.status IN ('queued', 'running') OR s.resumable = 1) ORDER BY CASE WHEN r.status IN ('queued', 'running') THEN 0 ELSE 1 END, r.updated_at DESC LIMIT 1`)
      .get(sessionId) as AgentRunRow | undefined;
    return row ? this.withRunState(mapAgentRun(row)) : undefined;
  }

  runResumedFrom(sourceRunId: string): AgentRunRecord | undefined {
    const row = this.database
      .prepare(`SELECT ${RUN_COLUMNS.split(", ").map((column) => `r.${column}`).join(", ")} FROM agent_runs r JOIN agent_run_state s ON s.run_id = r.id WHERE s.resume_of_run_id = ? ORDER BY r.created_at DESC LIMIT 1`)
      .get(sourceRunId) as AgentRunRow | undefined;
    return row ? this.withRunState(mapAgentRun(row)) : undefined;
  }

  runForClientRequest(clientRequestId: string): AgentRunRecord | undefined {
    const row = this.database
      .prepare(`SELECT ${RUN_COLUMNS.split(", ").map((column) => `r.${column}`).join(", ")} FROM agent_runs r JOIN agent_run_state s ON s.run_id = r.id WHERE s.client_request_id = ? LIMIT 1`)
      .get(clientRequestId) as AgentRunRow | undefined;
    return row ? this.withRunState(mapAgentRun(row)) : undefined;
  }

  claimResume(id: string): boolean {
    return Number(this.database.prepare("UPDATE agent_run_state SET resumable = 0 WHERE run_id = ? AND resumable = 1").run(id).changes) > 0;
  }

  setResumable(id: string, resumable: boolean): void {
    this.database.prepare("UPDATE agent_run_state SET resumable = ? WHERE run_id = ?").run(resumable ? 1 : 0, id);
  }

  updateRun(id: string, status: AgentRunRecord["status"], error?: string): void {
    const updatedAt = new Date().toISOString();
    this.database
      .prepare("UPDATE agent_runs SET status = ?, updated_at = ?, error = ? WHERE id = ?")
      .run(status, updatedAt, error ?? null, id);
    this.jobs.update(id, { status, updatedAt, ...(error ? { error } : {}) });
  }

  appendEvent(event: AgentEventEnvelope): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("INSERT INTO agent_events (run_id, sequence, timestamp, type, event_json) VALUES (?, ?, ?, ?, ?)")
        .run(event.runId, event.sequence, event.timestamp, event.type, JSON.stringify(event));
      const status = agentStatusForEvent(event.type);
      const eventError = typeof event.data.error === "string" ? event.data.error : null;
      this.database
        .prepare("UPDATE agent_runs SET last_sequence = ?, updated_at = ?, status = COALESCE(?, status), error = CASE WHEN ? IS NOT NULL THEN ? WHEN ? IN ('completed', 'cancelled', 'running') THEN NULL ELSE error END WHERE id = ?")
        .run(event.sequence, event.timestamp, status ?? null, eventError, eventError, status ?? null, event.runId);
      this.advanceCheckpoint(event);
      const jobEvent = normalizeAgentJobEvent(event);
      if (jobEvent) this.jobs.appendEvent(event.runId, jobEvent, event.timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  eventsAfter(runId: string, sequence: number, limit = 1000): AgentEventEnvelope[] {
    return (this.database
      .prepare("SELECT event_json FROM agent_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
      .all(runId, sequence, limit) as unknown as Array<{ event_json: string }>)
      .map((row) => JSON.parse(row.event_json) as AgentEventEnvelope);
  }

  recoverInterruptedRuns(): number {
    this.database
      .prepare("UPDATE agent_run_state SET resumable = 1 WHERE resumable = 0 AND run_id IN (SELECT id FROM agent_runs WHERE status IN ('failed', 'interrupted')) AND NOT EXISTS (SELECT 1 FROM agent_run_state child WHERE child.resume_of_run_id = agent_run_state.run_id)")
      .run();
    const rows = this.database
      .prepare("SELECT id FROM agent_runs WHERE status IN ('queued', 'running')")
      .all() as unknown as Array<{ id: string }>;
    for (const row of rows) {
      const timestamp = new Date().toISOString();
      this.materializeUncommittedEvents(row.id);
      this.database
        .prepare("UPDATE agent_runs SET status = 'interrupted', updated_at = ?, error = 'host_restarted' WHERE id = ?")
        .run(timestamp, row.id);
      this.setResumable(row.id, true);
      const run = this.getRun(row.id);
      if (run) {
        this.appendEvent({
          protocolVersion: "1",
          runId: row.id,
          sequence: run.lastSequence + 1,
          timestamp,
          type: "run.interrupted",
          data: { error: "host_restarted", resumable: true },
        });
      }
    }
    return rows.length;
  }

  private withRunState(run: AgentRunRecord): AgentRunRecord {
    const state = this.database
      .prepare("SELECT request_json, resume_of_run_id, checkpoint_json, resumable FROM agent_run_state WHERE run_id = ?")
      .get(run.id) as AgentRunStateRow | undefined;
    if (!state) return run;
    return {
      ...run,
      checkpoint: JSON.parse(state.checkpoint_json) as AgentRunCheckpoint,
      resumable: state.resumable === 1,
      ...(state.resume_of_run_id ? { resumeOfRunId: state.resume_of_run_id } : {}),
    };
  }

  private advanceCheckpoint(event: AgentEventEnvelope): void {
    const row = this.database
      .prepare("SELECT checkpoint_json FROM agent_run_state WHERE run_id = ?")
      .get(event.runId) as Pick<AgentRunStateRow, "checkpoint_json"> | undefined;
    if (!row) return;
    const checkpoint = JSON.parse(row.checkpoint_json) as AgentRunCheckpoint;
    const completedTools = [...checkpoint.completedTools];
    let inFlightTools = [...checkpoint.inFlightTools];
    let pendingApprovalIds = [...checkpoint.pendingApprovalIds];
    let phase = checkpoint.phase;
    if (event.type === "run.started") phase = "running";
    if (event.type === "tool.started") {
      const toolCallId = String(event.data.toolCallId ?? "");
      if (toolCallId && !inFlightTools.some((tool) => tool.toolCallId === toolCallId)) {
        inFlightTools.push({
          toolCallId,
          toolName: String(event.data.toolName ?? "tool"),
          ...(event.data.input !== undefined ? { input: event.data.input } : {}),
        });
      }
    }
    if (event.type === "tool.completed") {
      const toolCallId = String(event.data.toolCallId ?? "");
      const running = inFlightTools.find((tool) => tool.toolCallId === toolCallId);
      inFlightTools = inFlightTools.filter((tool) => tool.toolCallId !== toolCallId);
      if (toolCallId) {
        completedTools.push({
          toolCallId,
          toolName: running?.toolName ?? String(event.data.toolName ?? "tool"),
          ...(running?.input !== undefined ? { input: running.input } : {}),
          ...(event.data.isError !== undefined ? { isError: Boolean(event.data.isError) } : {}),
        });
      }
    }
    if (event.type === "tool.approval.requested") {
      const id = String(event.data.approvalId ?? "");
      if (id && !pendingApprovalIds.includes(id)) pendingApprovalIds.push(id);
      phase = "waiting-approval";
    }
    if (event.type === "tool.approval.resolved") {
      const id = String(event.data.approvalId ?? "");
      pendingApprovalIds = pendingApprovalIds.filter((item) => item !== id);
      phase = "running";
    }
    if (event.type === "run.completed") phase = "completed";
    if (event.type === "run.failed") phase = "failed";
    if (event.type === "run.cancelled") phase = "cancelled";
    if (event.type === "run.interrupted") phase = "interrupted";
    const resumeSafety = inFlightTools.length > 0 || pendingApprovalIds.length > 0 ? "review-required" : "safe";
    const next: AgentRunCheckpoint = {
      sequence: event.sequence,
      phase,
      completedTools,
      inFlightTools,
      pendingApprovalIds,
      resumeSafety,
      updatedAt: event.timestamp,
    };
    const terminalResumable = event.type === "run.failed" || event.type === "run.interrupted";
    const terminalFinal = event.type === "run.completed" || event.type === "run.cancelled";
    this.database
      .prepare("UPDATE agent_run_state SET checkpoint_json = ?, resumable = CASE WHEN ? = 1 THEN 1 WHEN ? = 1 THEN 0 ELSE resumable END WHERE run_id = ?")
      .run(JSON.stringify(next), terminalResumable ? 1 : 0, terminalFinal ? 1 : 0, event.runId);
  }

  private materializeUncommittedEvents(runId: string): void {
    const run = this.getRun(runId);
    if (!run?.sessionId) return;
    const represented = new Set<number>();
    let transcriptSequence = 0;
    while (true) {
      const page = this.transcriptAfter(run.sessionId, transcriptSequence, 1_000);
      for (const entry of page) {
        if (entry.content.runId === runId && Number.isFinite(Number(entry.content.eventSequence))) {
          represented.add(Number(entry.content.eventSequence));
        }
      }
      if (page.length < 1_000) break;
      transcriptSequence = page.at(-1)!.sequence;
    }
    const events: AgentEventEnvelope[] = [];
    let eventSequence = 0;
    while (true) {
      const page = this.eventsAfter(runId, eventSequence, 1_000);
      events.push(...page);
      if (page.length < 1_000) break;
      eventSequence = page.at(-1)!.sequence;
    }
    let textType: "assistant.delta" | "reasoning.delta" | undefined;
    let text = "";
    let from = 0;
    let through = 0;
    const flush = () => {
      if (!textType || !text || represented.has(through)) {
        textType = undefined;
        text = "";
        return;
      }
      const kind = textType === "assistant.delta" ? "message" : "reasoning";
      this.appendTranscriptEntryOnce({
        id: `agent-event:${runId}:${kind}:${from}-${through}`,
        sessionId: run.sessionId!,
        kind,
        role: "assistant",
        content: { text, runId, eventSequence: through, ...(kind === "message" ? { phase: "commentary" } : {}) },
        createdAt: events.find((event) => event.sequence === through)?.timestamp ?? new Date().toISOString(),
      });
      textType = undefined;
      text = "";
    };
    for (const event of events) {
      if (event.type === "assistant.delta" || event.type === "reasoning.delta") {
        if (textType && textType !== event.type) flush();
        if (!textType) {
          textType = event.type;
          from = event.sequence;
        }
        text += String(event.data.text ?? "");
        through = event.sequence;
        continue;
      }
      flush();
      if ((event.type === "tool.started" || event.type === "tool.completed") && !represented.has(event.sequence)) {
        this.appendTranscriptEntryOnce({
          id: `agent-event:${runId}:${event.type}:${event.sequence}`,
          sessionId: run.sessionId,
          kind: event.type === "tool.started" ? "tool-call" : "tool-result",
          role: "tool",
          content: { ...event.data, runId, eventSequence: event.sequence },
          createdAt: event.timestamp,
        });
      }
    }
    flush();
  }

  private transcriptAfter(sessionId: string, sequence: number, limit: number): TranscriptEntryRecord[] {
    return (this.database
      .prepare("SELECT id, session_id, sequence, kind, role, content_json, created_at FROM transcript_entries WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
      .all(sessionId, sequence, limit) as unknown as TranscriptRow[]).map(mapTranscript);
  }

  private appendTranscriptEntryOnce(entry: Omit<TranscriptEntryRecord, "sequence">): void {
    const exists = this.database.prepare("SELECT 1 AS found FROM transcript_entries WHERE id = ?").get(entry.id) as { found: number } | undefined;
    if (exists) return;
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM transcript_entries WHERE session_id = ?")
        .get(entry.sessionId) as { sequence: number };
      this.database
        .prepare("INSERT INTO transcript_entries (id, session_id, sequence, kind, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(entry.id, entry.sessionId, row.sequence, entry.kind, entry.role ?? null, JSON.stringify(entry.content), entry.createdAt);
      this.database.prepare("UPDATE sessions SET updated_at = ?, transcript_revision = transcript_revision + 1 WHERE id = ?").run(entry.createdAt, entry.sessionId);
      if (ownsTransaction) this.database.exec("COMMIT");
    } catch (error) {
      if (ownsTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function initialAgentCheckpoint(timestamp: string): AgentRunCheckpoint {
  return {
    sequence: 0,
    phase: "queued",
    completedTools: [],
    inFlightTools: [],
    pendingApprovalIds: [],
    resumeSafety: "safe",
    updatedAt: timestamp,
  };
}

function agentStatusForEvent(type: AgentEventEnvelope["type"]): AgentRunRecord["status"] | undefined {
  if (type === "run.started") return "running";
  if (type === "run.completed") return "completed";
  if (type === "run.failed") return "failed";
  if (type === "run.cancelled") return "cancelled";
  if (type === "run.interrupted") return "interrupted";
  return undefined;
}

function mapAgentRun(row: AgentRunRow): AgentRunRecord {
  return {
    id: row.id,
    routeId: row.route_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSequence: row.last_sequence,
    ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}),
    ...(row.owner_device_id ? { ownerDeviceId: row.owner_device_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

/** Keep high-volume assistant/reasoning/tool deltas in the specialized agent
 * log. The common job stream carries only lifecycle transitions and queue
 * state, which is enough for work dashboards without duplicating token data. */
function normalizeAgentJobEvent(event: AgentEventEnvelope): JobEvent | undefined {
  switch (event.type) {
    case "run.created":
      return undefined; // SqliteJobStore.create emits the canonical created event.
    case "run.started":
      return { type: "started", status: "running", sourceType: event.type };
    case "run.queue.updated": {
      const status = event.data.status === "running" || event.data.status === "queued" ? event.data.status : undefined;
      return { type: "updated", ...(status ? { status } : {}), sourceType: event.type };
    }
    case "run.completed":
      return { type: "completed", status: "completed", sourceType: event.type };
    case "run.failed": {
      const data = compactAgentEventData(event.data);
      return { type: "failed", status: "failed", sourceType: event.type, ...(data ? { data } : {}) };
    }
    case "run.cancelled":
      return { type: "cancelled", status: "cancelled", sourceType: event.type };
    case "run.interrupted": {
      const data = compactAgentEventData(event.data);
      return { type: "interrupted", status: "interrupted", sourceType: event.type, ...(data ? { data } : {}) };
    }
    default:
      return undefined;
  }
}

function compactAgentEventData(data: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
  const error = typeof data.error === "string" ? data.error : undefined;
  const resumable = typeof data.resumable === "boolean" ? data.resumable : undefined;
  if (error === undefined && resumable === undefined) return undefined;
  return { ...(error !== undefined ? { error } : {}), ...(resumable !== undefined ? { resumable } : {}) };
}

function mapTranscript(row: TranscriptRow): TranscriptEntryRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    kind: row.kind,
    content: JSON.parse(row.content_json) as Record<string, unknown>,
    createdAt: row.created_at,
    ...(row.role ? { role: row.role } : {}),
  };
}
