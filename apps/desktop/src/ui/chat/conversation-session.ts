import { isActiveMediaJobStatus } from "@fitz/protocol";
import type { MediaJobSummary } from "./media-job-tracker.js";
import type { AppLocation } from "../navigation/navigation-history.js";

type Json = Record<string, any>;

export interface ConversationSessionOptions {
  api: (path: string, method?: string, body?: unknown) => Promise<Json>;
  projects: {
    readonly currentSessionId: string | undefined;
    readonly currentProjectId: string | undefined;
    readonly projects: Array<{ id: string }>;
    activeProject(): { name: string } | undefined;
    currentSessionRecord(): { routeId?: string } | undefined;
    setCurrentProject(id: string | undefined): void;
    beginNewChat(): void;
    startSessionInProject(projectId: string, session: Json): void;
    startChat(session: Json): void;
  };
  sidebar: { ensureExpanded(projectId: string): void; beginCreateProject(): void };
  workspace: HTMLElement;
  messages: HTMLElement;
  composer: {
    resetContextStatus(): void;
    setRoute(routeId: string): void;
    enterNewChat(projectName?: string): void;
    exitNewChat(): void;
    refreshBranches(): Promise<void>;
    focus(): void;
  };
  inspector: { reset(): void; setChat(id: string | undefined): void };
  context: { reset(): void; restore(tokens: number): void; refresh(): void };
  transcript: { restore(entries: Json[], page: Json): number; eventSequenceForRun(runId: string): number };
  runs: { active: () => boolean; detach(): void; attach(state: Json, afterSequence: number): void };
  recovery: { clear(): void; show(state: Json): void };
  assistantPerformance: { reset(): void };
  mediaJobs: {
    reset(): void;
    watch(jobId: string): void;
    failureMessage(jobId: string, fallback: string): Promise<string>;
  };
  mediaFeed: { reset(): void; render(job: MediaJobSummary, failure?: string, artifact?: Json): void };
  activity: { appendApproval(approval: Json): void; finishWork(completedAt?: string, placement?: "next-message"): void };
  artifacts: { load(): Promise<Json[]> };
  showConversation(): void;
  showStatus(message: string, tone: "error"): void;
  errorMessage(error: unknown): string;
  renderTree(): void;
  showNewChatLanding(): void;
  showLanding(hasTask?: boolean): void;
  prepareNewChat(): void;
  refreshControls(): void;
  resetWarmup(): void;
  remember(location: AppLocation): void;
  loadingMessage(text: string): HTMLElement;
  appendSystem(message: string): void;
}

/** Owns new-chat state, session materialization, and durable conversation replay. */
export class ConversationSessionController {
  readonly #options: ConversationSessionOptions;
  #newChat = false;
  #inspectorChatId: string | undefined;

  constructor(options: ConversationSessionOptions) { this.#options = options; }

  get newChat(): boolean { return this.#newChat; }

  leaveNewChat(): void {
    this.#newChat = false;
    this.#options.workspace.classList.remove("new-chat-open");
    this.#options.composer.exitNewChat();
  }

  beginNewChat(projectBound: boolean): void {
    if (this.#options.runs.active()) {
      this.#options.showStatus("Stop the current response before starting a new chat", "error");
      return;
    }
    this.#options.showConversation();
    this.#scopeInspector(undefined, true);
    const { projects, sidebar } = this.#options;
    if (projectBound) {
      if (projects.projects.length === 0) { sidebar.beginCreateProject(); return; }
      projects.setCurrentProject(projects.currentProjectId ?? projects.projects[0]!.id);
      if (!projects.currentProjectId) return;
      sidebar.ensureExpanded(projects.currentProjectId);
    } else projects.setCurrentProject(undefined);
    projects.beginNewChat();
    this.#newChat = true;
    this.#options.context.reset();
    this.#options.composer.resetContextStatus();
    this.#options.workspace.classList.add("new-chat-open");
    this.#options.prepareNewChat();
    this.#options.composer.enterNewChat(projectBound ? projects.activeProject()?.name ?? "Project" : undefined);
    this.#options.resetWarmup();
    this.#options.renderTree();
    this.#options.showNewChatLanding();
    void this.#options.composer.refreshBranches();
    this.#options.context.refresh();
    this.#options.refreshControls();
    this.#options.composer.focus();
    this.#options.remember({
      view: "conversation",
      path: ["new"],
      ...(projectBound && projects.currentProjectId ? { context: { projectId: projects.currentProjectId } } : {}),
    });
  }

  openNewChatForProject(id: string): void {
    this.#options.projects.setCurrentProject(id);
    this.#options.sidebar.ensureExpanded(id);
    this.beginNewChat(true);
  }

  async ensurePromptSession(title: string, routeId?: string): Promise<string | undefined> {
    const { projects } = this.#options;
    if (projects.currentSessionId) return projects.currentSessionId;
    if (!this.#newChat) return undefined;
    const payload = { title, ...(routeId ? { routeId } : {}) };
    const response = projects.currentProjectId
      ? await this.#options.api(`/api/v1/projects/${projects.currentProjectId}/sessions`, "POST", payload)
      : await this.#options.api("/api/v1/chats", "POST", payload);
    this.leaveNewChat();
    if (projects.currentProjectId) projects.startSessionInProject(projects.currentProjectId, response.data);
    else projects.startChat(response.data);
    this.#scopeInspector(response.data.id, false);
    return response.data.id as string;
  }

  async selectSession(sessionId: string): Promise<void> {
    const isCurrent = () => this.#options.projects.currentSessionId === sessionId;
    const { runs, assistantPerformance, recovery, mediaJobs, mediaFeed, composer, context, messages } = this.#options;
    runs.detach();
    assistantPerformance.reset();
    recovery.clear();
    mediaJobs.reset();
    mediaFeed.reset();
    if (sessionId !== this.#inspectorChatId) this.#scopeInspector(sessionId, true);
    composer.resetContextStatus();
    const selectedSession = this.#options.projects.currentSessionRecord();
    if (selectedSession?.routeId) composer.setRoute(selectedSession.routeId);
    context.refresh();
    messages.replaceChildren(this.#options.loadingMessage("Loading conversation…"));
    try {
      const transcript = await this.#options.api(`/api/v1/sessions/${sessionId}/transcript`);
      if (!isCurrent()) return;
      context.restore(this.#options.transcript.restore(transcript.data ?? [], transcript.page ?? {}));
      const pendingApprovals = await this.#options.api(`/api/v1/sessions/${sessionId}/tool-approvals?status=pending`);
      if (!isCurrent()) return;
      for (const approval of pendingApprovals.data ?? []) this.#options.activity.appendApproval(approval);
      const runState = await this.#options.api(`/api/v1/sessions/${sessionId}/agent-run-state`);
      if (!isCurrent()) return;
      if (runState.data?.status === "queued" || runState.data?.status === "running") {
        runs.attach(runState.data, this.#options.transcript.eventSequenceForRun(String(runState.data.id)));
      } else if (runState.data?.resumable) recovery.show(runState.data);
      context.refresh();
      if (!messages.childElementCount) this.#options.showLanding(true);
      messages.scrollTop = messages.scrollHeight;
      const sessionArtifacts = await this.#options.artifacts.load();
      if (!isCurrent()) return;
      await this.#loadMediaJobs(sessionId, sessionArtifacts, isCurrent);
    } catch (error) {
      if (!isCurrent()) return;
      messages.replaceChildren();
      this.#options.appendSystem(this.#options.errorMessage(error));
    }
    if (!isCurrent()) return;
    this.#options.refreshControls();
    composer.focus();
    this.#options.remember({
      view: "conversation",
      path: ["session", sessionId],
      ...(this.#options.projects.currentProjectId ? { context: { projectId: this.#options.projects.currentProjectId } } : {}),
    });
  }

  async showNoSession(): Promise<void> {
    this.#options.mediaJobs.reset();
    this.#options.mediaFeed.reset();
    this.#scopeInspector(undefined, true);
    this.#options.context.reset();
    this.#options.context.refresh();
    if (this.#options.projects.currentProjectId) this.openNewChatForProject(this.#options.projects.currentProjectId);
    else this.#options.showLanding();
    await this.#options.artifacts.load();
  }

  #scopeInspector(id: string | undefined, reset: boolean): void {
    if (reset) this.#options.inspector.reset();
    this.#options.inspector.setChat(id);
    this.#inspectorChatId = id;
  }

  async #loadMediaJobs(sessionId: string, sessionArtifacts: Json[], isCurrent: () => boolean): Promise<void> {
    const response = await this.#options.api(`/api/v1/media/jobs?sessionId=${encodeURIComponent(sessionId)}&limit=100&includeLineage=true`);
    if (!isCurrent()) return;
    const jobs = Array.isArray(response.data) ? [...response.data].reverse() as MediaJobSummary[] : [];
    let hasActiveJob = false;
    for (const job of jobs) {
      if (!isCurrent()) return;
      const artifact = job.artifactId ? sessionArtifacts.find((item) => item.id === job.artifactId) : undefined;
      if (isActiveMediaJobStatus(job.status)) {
        hasActiveJob = true;
        this.#options.mediaFeed.render(job, undefined, artifact);
        this.#options.mediaJobs.watch(job.id);
        continue;
      }
      const failure = job.status === "completed" ? undefined : await this.#options.mediaJobs.failureMessage(job.id, job.errorCode ?? `Media generation ${job.status}`);
      if (!isCurrent()) return;
      this.#options.mediaFeed.render(job, failure, artifact);
    }
    if (!isCurrent()) return;
    if (!hasActiveJob) this.#options.activity.finishWork(undefined, "next-message");
    this.#options.messages.scrollTop = this.#options.messages.scrollHeight;
  }
}
