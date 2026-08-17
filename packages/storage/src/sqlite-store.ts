import { backup, DatabaseSync } from "node:sqlite";
import type {
  AuditEventRecord,
  AgentEventEnvelope,
  ArtifactRecord,
  AgentRunRecord,
  AgentRunPlan,
  AgentRunRequest,
  ProjectRecord,
  SessionRecord,
  ToolApprovalRecord,
  ToolPolicyRecord,
  TranscriptEntryRecord,
  DeviceAuthenticationRecord,
  DeviceRecord,
  InferenceLifecycleEvent,
  InferenceRequestRecord,
  QueueUpdatedEvent,
  EngineRegistration,
  Recipe,
  Route,
  UserQuota,
  UserRecord,
  SnapshotRecord,
  ToolActionRecord,
  TrashEntryRecord,
  MediaCreditRecord,
  MediaJobEvent,
  MediaJobRecord,
  MediaJobStatus,
  GpuWorkRecord,
  RequestUsageRecord,
  UsageReport,
  UserUsageSummary,
  SubagentRoleDefinition,
  InferenceDelta,
  InferenceEvidenceRecord,
  JobEvent,
  JobEventEnvelope,
  JobRecord,
  ListJobsOptions,
  SessionProjection,
} from "@fitz/protocol";
import { MIGRATIONS } from "./migrations.js";
import { SqliteAgentRunStore } from "./sqlite-agent-run-store.js";
import { SqliteConfigurationStore } from "./sqlite-configuration-store.js";
import { SqliteIdentityStore } from "./sqlite-identity-store.js";
import { SqliteInferenceTelemetryStore } from "./sqlite-inference-telemetry-store.js";
import { SqliteInferenceEvidenceStore } from "./sqlite-inference-evidence-store.js";
import { SqliteForensicsStore } from "./sqlite-forensics-store.js";
import { SqliteMediaStore, type MediaJobEventEnvelope } from "./sqlite-media-store.js";
import { SqliteJobStore } from "./sqlite-job-store.js";
import { SqliteSessionProjectionStore } from "./sqlite-session-projection.js";
import { SqliteSafetyStore } from "./sqlite-safety-store.js";
import { SqliteSettingsStore } from "./sqlite-settings-store.js";
import {
  SqliteWorkspaceStore,
  type ArtifactStorageEntry,
  type ArtifactStorageRef,
  type LegacyArtifactContent,
} from "./sqlite-workspace-store.js";

export type { MediaJobEventEnvelope } from "./sqlite-media-store.js";
export type { ArtifactStorageEntry, ArtifactStorageRef, LegacyArtifactContent } from "./sqlite-workspace-store.js";

export interface SettingsBackend {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
}

export class SqliteStore {
  readonly #database: DatabaseSync;
  readonly #agentRuns: SqliteAgentRunStore;
  readonly #configuration: SqliteConfigurationStore;
  readonly #identity: SqliteIdentityStore;
  readonly #inferenceTelemetry: SqliteInferenceTelemetryStore;
  readonly #inferenceEvidence: SqliteInferenceEvidenceStore;
  readonly #forensics: SqliteForensicsStore;
  readonly #media: SqliteMediaStore;
  readonly #jobs: SqliteJobStore;
  readonly #sessionProjections: SqliteSessionProjectionStore;
  readonly #safety: SqliteSafetyStore;
  readonly #settings: SqliteSettingsStore;
  readonly #workspace: SqliteWorkspaceStore;
  #settingsBackend: SettingsBackend | undefined;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
    this.#configuration = new SqliteConfigurationStore(this.#database);
    this.#identity = new SqliteIdentityStore(this.#database);
    this.#inferenceTelemetry = new SqliteInferenceTelemetryStore(this.#database);
    this.#inferenceEvidence = new SqliteInferenceEvidenceStore(this.#database);
    this.#forensics = new SqliteForensicsStore(this.#database);
    this.#jobs = new SqliteJobStore(this.#database);
    this.#sessionProjections = new SqliteSessionProjectionStore(this.#database);
    this.#media = new SqliteMediaStore(this.#database, this.#jobs);
    this.#safety = new SqliteSafetyStore(this.#database);
    this.#settings = new SqliteSettingsStore(this.#database);
    this.#workspace = new SqliteWorkspaceStore(this.#database);
    this.#agentRuns = new SqliteAgentRunStore(this.#database, this.#jobs);
  }

  static memory(): SqliteStore {
    return new SqliteStore(":memory:");
  }

  migrate(): void {
    const current = this.#database.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    let version = current?.user_version ?? 0;
    let rebuild = false;
    for (const migration of MIGRATIONS) {
      if (migration.version <= version) continue;
      if (migration.rebuild) {
        // Table rebuilds (DROP TABLE) must run with foreign keys disabled, or
        // the drop cascades into child rows (transcripts, approvals) and
        // referencing tables (agent_runs.session_id) block it entirely.
        this.#database.exec("PRAGMA foreign_keys = OFF");
        rebuild = true;
      }
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#database.exec(migration.sql);
        this.#database.exec(`PRAGMA user_version = ${migration.version}`);
        this.#database.exec("COMMIT");
        version = migration.version;
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    }
    if (rebuild) {
      try {
        const violations = this.#database.prepare("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new Error(`Foreign key violations after migration: ${JSON.stringify(violations)}`);
        }
      } finally {
        this.#database.exec("PRAGMA foreign_keys = ON");
      }
    }
  }

  /** Runs synchronous store operations as one immediate SQLite transaction. */
  withImmediateTransaction<T>(operation: () => T): T {
    if (this.#database.isTransaction) throw new Error("Nested store transactions are not supported");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      if (result instanceof Promise) throw new TypeError("Store transactions must be synchronous");
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  upsertRecipe(recipe: Recipe): void { this.#configuration.upsertRecipe(recipe); }
  upsertEngine(engine: EngineRegistration): void { this.#configuration.upsertEngine(engine); }
  getEngine(id: string): EngineRegistration | undefined { return this.#configuration.getEngine(id); }
  listEngines(): EngineRegistration[] { return this.#configuration.listEngines(); }
  deleteEngine(id: string): boolean { return this.#configuration.deleteEngine(id); }
  upsertRoute(route: Route): void { this.#configuration.upsertRoute(route); }
  deleteRoute(routeId: string): void { this.#configuration.deleteRoute(routeId); }
  deleteRecipe(recipeId: string): void { this.#configuration.deleteRecipe(recipeId); }
  listRecipes(): Recipe[] { return this.#configuration.listRecipes(); }
  listRoutes(): Route[] { return this.#configuration.listRoutes(); }
  listSubagentRoles(enabledOnly = true): SubagentRoleDefinition[] { return this.#configuration.listSubagentRoles(enabledOnly); }
  getSubagentRole(id: string, version?: number): SubagentRoleDefinition | undefined { return this.#configuration.getSubagentRole(id, version); }

  appendLifecycleEvent(event: InferenceLifecycleEvent): void { this.#inferenceTelemetry.appendLifecycleEvent(event); }
  lifecycleEventsAfter(sequence: number, limit = 500): InferenceLifecycleEvent[] { return this.#inferenceTelemetry.lifecycleEventsAfter(sequence, limit); }
  latestLifecycleSequence(): number { return this.#inferenceTelemetry.latestLifecycleSequence(); }
  recordQueueEvent(event: QueueUpdatedEvent): void { this.#inferenceTelemetry.recordQueueEvent(event); }
  recordGpuQueueEvent(event: QueueUpdatedEvent): void { this.#inferenceTelemetry.recordGpuQueueEvent(event); }
  recoverInterruptedGpuWork(): number { return this.#inferenceTelemetry.recoverInterruptedGpuWork(); }
  listGpuWork(limit = 100): GpuWorkRecord[] { return this.#inferenceTelemetry.listGpuWork(limit); }
  recoverInterruptedRequests(): number { return this.#inferenceTelemetry.recoverInterruptedRequests(); }
  listInferenceRequests(limit = 100): InferenceRequestRecord[] { return this.#inferenceTelemetry.listInferenceRequests(limit); }
  recordRequestUsage(record: RequestUsageRecord): void { this.#inferenceTelemetry.recordRequestUsage(record); }
  recordInferenceEvidence(record: InferenceEvidenceRecord): void { this.#inferenceEvidence.record(record); }
  recordInferenceEvidenceDelta(evidenceId: string, sequence: number, delta: InferenceDelta, timestamp?: string): void { this.#inferenceEvidence.recordDelta(evidenceId, sequence, delta, timestamp); }
  getInferenceEvidence(id: string): InferenceEvidenceRecord | undefined { return this.#inferenceEvidence.get(id); }
  listInferenceEvidenceForSession(sessionId: string): InferenceEvidenceRecord[] { return this.#inferenceEvidence.listForSession(sessionId); }
  listInferenceEvidenceForRun(runId: string): InferenceEvidenceRecord[] { return this.#inferenceEvidence.listForRun(runId); }
  recoverInterruptedInferenceEvidence(): number { return this.#inferenceEvidence.recoverInterrupted(); }
  sessionForensics(sessionId: string, generatedAt?: string): import("@fitz/protocol").SessionForensicsBundle | undefined { return this.#forensics.build(sessionId, generatedAt); }
  listRequestUsageForRun(runId: string): RequestUsageRecord[] { return this.#inferenceTelemetry.listRequestUsageForRun(runId); }
  listRequestUsageForSession(sessionId: string): RequestUsageRecord[] { return this.#inferenceTelemetry.listRequestUsageForSession(sessionId); }
  usageReport(options: { from: string; to: string; bucket: "hour" | "day"; ownerUserId?: string }): UsageReport { return this.#inferenceTelemetry.usageReport(options); }
  userUsageSummaries(options: { from: string; to: string }): UserUsageSummary[] { return this.#inferenceTelemetry.userUsageSummaries(options); }

  createMediaJob(job: MediaJobRecord): void {
    this.#media.createJob(job);
  }

  getMediaJob(id: string): MediaJobRecord | undefined {
    return this.#media.getJob(id);
  }

  updateMediaJob(id: string, patch: Partial<Omit<MediaJobRecord, "id" | "enqueuedAt">>): void {
    this.#media.updateJob(id, patch);
  }

  listMediaJobs(options: { ownerUserId?: string; sessionId?: string; status?: MediaJobStatus; limit?: number } = {}): MediaJobRecord[] {
    return this.#media.listJobs(options);
  }

  countNonTerminalMediaJobs(userId: string, since: string): number {
    return this.#media.countNonTerminalJobs(userId, since);
  }

  recoverInterruptedMediaJobs(): number {
    return this.#media.recoverInterruptedJobs();
  }

  appendMediaJobEvent(jobId: string, event: MediaJobEvent, timestamp: string): MediaJobEventEnvelope {
    return this.#media.appendJobEvent(jobId, event, timestamp);
  }

  mediaJobEventsAfter(jobId: string, sequence: number, limit = 1000): MediaJobEventEnvelope[] {
    return this.#media.eventsAfter(jobId, sequence, limit);
  }

  appendMediaCredit(record: MediaCreditRecord): void {
    this.#media.appendCredit(record);
  }

  sumMediaLedgerForUser(userId: string, since: string): number {
    return this.#media.sumLedgerForUser(userId, since);
  }

  createJob(job: JobRecord): void { this.#jobs.create(job); }
  getJob(id: string): JobRecord | undefined { return this.#jobs.get(id); }
  updateJob(id: string, patch: Partial<Omit<JobRecord, "id" | "kind" | "createdAt">>): void { this.#jobs.update(id, patch); }
  listJobs(options: ListJobsOptions = {}): JobRecord[] { return this.#jobs.list(options); }
  appendJobEvent(jobId: string, event: JobEvent, timestamp: string): JobEventEnvelope { return this.#jobs.appendEvent(jobId, event, timestamp); }
  jobEventsAfter(jobId: string, sequence: number, limit = 1000): JobEventEnvelope[] { return this.#jobs.eventsAfter(jobId, sequence, limit); }
  recoverInterruptedJobs(kind: JobRecord["kind"]): number { return this.#jobs.recoverInterrupted(kind); }

  getSessionProjection(sessionId: string): SessionProjection | undefined { return this.#sessionProjections.get(sessionId); }
  rebuildSessionProjection(sessionId: string): SessionProjection | undefined { return this.#sessionProjections.rebuild(sessionId); }

  createUser(user: UserRecord): void { this.#identity.createUser(user); }
  updateUser(user: UserRecord): void { this.#identity.updateUser(user); }
  getUser(id: string): UserRecord | undefined { return this.#identity.getUser(id); }
  listUsers(): UserRecord[] { return this.#identity.listUsers(); }
  createDevice(device: DeviceRecord, tokenHash: string): void { this.#identity.createDevice(device, tokenHash); }
  listDevices(userId: string): DeviceRecord[] { return this.#identity.listDevices(userId); }
  findDeviceByTokenHash(tokenHash: string): DeviceAuthenticationRecord | undefined { return this.#identity.findDeviceByTokenHash(tokenHash); }
  touchDevice(id: string, timestamp: string): void { this.#identity.touchDevice(id, timestamp); }
  revokeDevice(id: string, timestamp: string): boolean { return this.#identity.revokeDevice(id, timestamp); }
  replaceUserRouteGrants(userId: string, routeIds: readonly string[]): void { this.#identity.replaceUserRouteGrants(userId, routeIds); }
  listUserRouteGrants(userId: string): string[] { return this.#identity.listUserRouteGrants(userId); }
  setUserQuota(userId: string, quota: UserQuota): void { this.#identity.setUserQuota(userId, quota); }
  getUserQuota(userId: string): UserQuota | undefined { return this.#identity.getUserQuota(userId); }
  appendAuditEvent(event: AuditEventRecord): void { this.#identity.appendAuditEvent(event); }
  listAuditEvents(limit = 100): AuditEventRecord[] { return this.#identity.listAuditEvents(limit); }

  createAgentRun(run: AgentRunRecord, request?: AgentRunRequest, resumeOfRunId?: string): void {
    this.#agentRuns.createRun(run, request, resumeOfRunId);
  }
  getAgentRun(id: string): AgentRunRecord | undefined { return this.#agentRuns.getRun(id); }
  listAgentRuns(ownerUserId?: string, limit = 100): AgentRunRecord[] {
    return this.#agentRuns.listRuns(ownerUserId, limit);
  }
  listAgentRunsForSession(sessionId: string): AgentRunRecord[] { return this.#agentRuns.listRunsForSession(sessionId); }
  listAgentChildRuns(parentRunId: string): AgentRunRecord[] { return this.#agentRuns.listChildRuns(parentRunId); }
  getAgentRunRequest(id: string): AgentRunRequest | undefined { return this.#agentRuns.getRunRequest(id); }
  getAgentRunPlan(id: string): AgentRunPlan | undefined { return this.#agentRuns.getRunPlan(id); }
  saveAgentRunPlan(plan: AgentRunPlan, expectedRevision?: number): boolean { return this.#agentRuns.saveRunPlan(plan, expectedRevision); }
  latestSessionAgentRun(sessionId: string): AgentRunRecord | undefined { return this.#agentRuns.latestSessionRun(sessionId); }
  agentRunResumedFrom(sourceRunId: string): AgentRunRecord | undefined { return this.#agentRuns.runResumedFrom(sourceRunId); }
  agentRunForClientRequest(clientRequestId: string): AgentRunRecord | undefined { return this.#agentRuns.runForClientRequest(clientRequestId); }
  claimAgentRunResume(id: string): boolean { return this.#agentRuns.claimResume(id); }
  setAgentRunResumable(id: string, resumable: boolean): void { this.#agentRuns.setResumable(id, resumable); }
  updateAgentRun(id: string, status: AgentRunRecord["status"], error?: string): void { this.#agentRuns.updateRun(id, status, error); }
  appendAgentEvent(event: AgentEventEnvelope): void {
    this.#agentRuns.appendEvent(event);
  }
  agentEventsAfter(runId: string, sequence: number, limit = 1000): AgentEventEnvelope[] { return this.#agentRuns.eventsAfter(runId, sequence, limit); }
  recoverInterruptedAgentRuns(): number {
    return this.#agentRuns.recoverInterruptedRuns();
  }
  recoverInterruptedToolApprovals(): number { return this.#identity.recoverInterruptedToolApprovals(); }

  createProject(project: ProjectRecord): void { this.#workspace.createProject(project); }
  getProject(id: string): ProjectRecord | undefined { return this.#workspace.getProject(id); }
  listProjects(ownerUserId?: string): ProjectRecord[] { return this.#workspace.listProjects(ownerUserId); }
  updateProject(project: ProjectRecord): void { this.#workspace.updateProject(project); }
  deleteProject(id: string): boolean { return this.#workspace.deleteProject(id); }
  createSession(session: SessionRecord): void { this.#workspace.createSession(session); }
  getSession(id: string): SessionRecord | undefined { return this.#workspace.getSession(id); }
  listSessions(projectId: string, ownerUserId?: string): SessionRecord[] { return this.#workspace.listSessions(projectId, ownerUserId); }
  listStandaloneSessions(ownerUserId?: string): SessionRecord[] { return this.#workspace.listStandaloneSessions(ownerUserId); }
  updateSession(session: SessionRecord): void { this.#workspace.updateSession(session); }
  deleteSession(id: string): boolean { return this.#workspace.deleteSession(id); }
  appendTranscriptEntry(entry: Omit<TranscriptEntryRecord, "sequence">): TranscriptEntryRecord { return this.#workspace.appendTranscriptEntry(entry); }
  getTranscriptEntry(id: string): TranscriptEntryRecord | undefined { return this.#workspace.getTranscriptEntry(id); }
  transcriptAfter(sessionId: string, sequence: number, limit = 1000): TranscriptEntryRecord[] { return this.#workspace.transcriptAfter(sessionId, sequence, limit); }
  transcriptBefore(sessionId: string, sequence: number, limit = 250): TranscriptEntryRecord[] { return this.#workspace.transcriptBefore(sessionId, sequence, limit); }
  deleteTranscriptFrom(sessionId: string, sequence: number): number { return this.#workspace.deleteTranscriptFrom(sessionId, sequence); }
  hasTranscriptBefore(sessionId: string, sequence: number): boolean { return this.#workspace.hasTranscriptBefore(sessionId, sequence); }
  latestTranscriptCompaction(sessionId: string): TranscriptEntryRecord | undefined { return this.#workspace.latestTranscriptCompaction(sessionId); }

  upsertToolPolicy(policy: ToolPolicyRecord): void { this.#identity.upsertToolPolicy(policy); }
  listToolPolicies(subjectType?: ToolPolicyRecord["subjectType"], subjectId?: string): ToolPolicyRecord[] { return this.#identity.listToolPolicies(subjectType, subjectId); }
  resolveToolPolicy(userId: string | undefined, role: UserRecord["role"] | undefined, toolName: string): ToolPolicyRecord["decision"] { return this.#identity.resolveToolPolicy(userId, role, toolName); }
  createToolApproval(approval: ToolApprovalRecord): void { this.#identity.createToolApproval(approval); }
  getToolApproval(id: string): ToolApprovalRecord | undefined { return this.#identity.getToolApproval(id); }
  listToolApprovals(sessionId?: string, status?: ToolApprovalRecord["status"]): ToolApprovalRecord[] { return this.#identity.listToolApprovals(sessionId, status); }
  resolveToolApproval(id: string, status: "approved" | "denied", decidedByUserId?: string, note?: string, request?: Readonly<Record<string, unknown>>): boolean { return this.#identity.resolveToolApproval(id, status, decidedByUserId, note, request); }
  cancelToolApproval(id: string, note?: string): boolean { return this.#identity.cancelToolApproval(id, note); }
  /** Metadata-only artifact catalog. Payload I/O belongs to ArtifactRepository. */
  createArtifact(artifact: ArtifactRecord, storage: ArtifactStorageRef): void { this.#workspace.createArtifact(artifact, storage); }
  getArtifact(id: string): ArtifactRecord | undefined { return this.#workspace.getArtifact(id); }
  listArtifacts(sessionId: string): ArtifactRecord[] { return this.#workspace.listArtifacts(sessionId); }
  getArtifactStorage(id: string): ArtifactStorageRef | undefined { return this.#workspace.getArtifactStorage(id); }
  listArtifactStorage(backend: string): ArtifactStorageRef[] { return this.#workspace.listArtifactStorage(backend); }
  listArtifactStorageEntries(): ArtifactStorageEntry[] { return this.#workspace.listArtifactStorageEntries(); }
  deleteArtifact(id: string): boolean { return this.#workspace.deleteArtifact(id); }
  nextLegacyArtifactContent(): LegacyArtifactContent | undefined { return this.#workspace.nextLegacyArtifactContent(); }
  countLegacyArtifactRefs(): number { return this.#workspace.countLegacyArtifactRefs(); }
  migrateArtifactStorage(id: string, artifact: Pick<ArtifactRecord, "byteSize" | "sha256">, storage: ArtifactStorageRef): void { this.#workspace.migrateArtifactStorage(id, artifact, storage); }
  dropLegacyArtifacts(): void { this.#workspace.dropLegacyArtifacts(); }
  compactArtifactMigration(): void { this.#workspace.compactArtifactMigration(); }

  appendToolAction(action: Omit<ToolActionRecord, "sequence">): ToolActionRecord { return this.#safety.appendToolAction(action); }
  nextToolActionSequence(runId: string): number { return this.#safety.nextToolActionSequence(runId); }
  listToolActions(runId: string, limit = 1000): ToolActionRecord[] { return this.#safety.listToolActions(runId, limit); }
  listAllToolActions(limit = 500): ToolActionRecord[] { return this.#safety.listAllToolActions(limit); }
  createSnapshot(snapshot: SnapshotRecord): void { this.#safety.createSnapshot(snapshot); }
  getSnapshot(runId: string): SnapshotRecord | undefined { return this.#safety.getSnapshot(runId); }
  listSnapshots(limit = 100): SnapshotRecord[] { return this.#safety.listSnapshots(limit); }
  updateSnapshotStatus(runId: string, status: SnapshotRecord["status"]): void { this.#safety.updateSnapshotStatus(runId, status); }
  deleteSnapshot(runId: string): boolean { return this.#safety.deleteSnapshot(runId); }
  createTrashEntry(entry: TrashEntryRecord): void { this.#safety.createTrashEntry(entry); }
  getTrashEntry(id: string): TrashEntryRecord | undefined { return this.#safety.getTrashEntry(id); }
  listTrashEntries(workspaceRoot?: string, limit = 200): TrashEntryRecord[] { return this.#safety.listTrashEntries(workspaceRoot, limit); }
  listTrashEntriesForRun(runId: string): TrashEntryRecord[] { return this.#safety.listTrashEntriesForRun(runId); }
  markTrashRestored(id: string, restoredAt: string): boolean { return this.#safety.markTrashRestored(id, restoredAt); }
  deleteTrashEntry(id: string): boolean { return this.#safety.deleteTrashEntry(id); }
  deleteTrashEntriesBefore(before: string, workspaceRoot?: string): number { return this.#safety.deleteTrashEntriesBefore(before, workspaceRoot); }
  /** Switches non-secret settings to the canonical JSON backend after legacy
   * SQLite values have been migrated. Security material always remains in the
   * private database. */
  useSettingsBackend(backend: SettingsBackend): void { this.#settingsBackend = backend; }
  listLegacySettings(): Record<string, unknown> { return this.#settings.list(); }
  setSetting(key: string, value: unknown): void { this.#settingsTarget(key).set(key, value); }
  getSetting<T>(key: string): T | undefined { return this.#settingsTarget(key).get<T>(key); }
  deleteSetting(key: string): boolean { return this.#settingsTarget(key).delete(key); }

  #settingsTarget(key: string): SettingsBackend {
    // These keys are normalized runtime records retained for compatibility
    // until they receive dedicated tables. They are not app settings and must
    // never be copied into the human/LLM-editable canonical configuration.
    const sqliteRecord = key === "consumerConnections" || key === "consumerCloudRoutes";
    return key.startsWith("security.") || sqliteRecord ? this.#settings : this.#settingsBackend ?? this.#settings;
  }

  async backupTo(path: string): Promise<number> {
    return backup(this.#database, path);
  }

  close(): void {
    this.#database.close();
  }
}
