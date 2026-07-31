import { reconnectDelay } from "@fitz/connectivity/reconnect";

type Json = Record<string, any>;

let projectRecords: Json[] = [];
const sessionsByProject = new Map<string, Json[]>();
let currentProject: string | undefined;
let currentSession: string | undefined;
let currentRun: string | undefined;
let lastSequence = 0;
let pendingTaskAfterProject = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const shell = query(".app-shell");
const projects = element("projects");
const messages = element("messages");
const model = element("model") as HTMLSelectElement;
const effort = element("effort") as HTMLSelectElement;
const speed = element("speed") as HTMLSelectElement;
const modelToggle = element("model-toggle") as HTMLButtonElement;
const modelMenu = element("model-menu");
const modelSummary = element("model-summary");
const form = element("composer") as HTMLFormElement;
const prompt = element("prompt") as HTMLTextAreaElement;
const status = element("status");
const sendButton = element("send") as HTMLButtonElement;
const attachButton = element("attach") as HTMLButtonElement;
const connectionStatus = element("connection-status") as HTMLButtonElement;
const connectionDetail = element("connection-detail");
const projectTitle = element("project-title");
const taskTitle = element("task-title");
const engineState = element("engine-state");
const routeState = element("route-state");
const contextPanel = element("context-panel") as HTMLElement;
const contextToggle = element("context-toggle") as HTMLButtonElement;
const artifacts = element("artifacts");
const artifactPreview = element("artifact-preview");
const artifactFile = element("artifact-file") as HTMLInputElement;
const composerAttachments = element("composer-attachments");
const addArtifactButton = element("add-artifact") as HTMLButtonElement;
const updateButton = element("update") as HTMLButtonElement;
const projectDialog = element("project-dialog") as HTMLDialogElement;
const projectForm = element("project-form") as HTMLFormElement;
const projectName = element("project-name") as HTMLInputElement;
const projectRootPath = element("project-root-path") as HTMLInputElement;
const projectFolderLabel = element("project-folder-label");
const chooseProjectFolder = element("choose-project-folder") as HTMLButtonElement;
const taskDialog = element("task-dialog") as HTMLDialogElement;
const taskForm = element("task-form") as HTMLFormElement;
const taskProject = element("task-project") as HTMLSelectElement;
const taskName = element("task-name") as HTMLInputElement;
const taskMenuToggle = element("task-menu-toggle") as HTMLButtonElement;
const taskMenu = element("task-menu");
const renameDialog = element("rename-dialog") as HTMLDialogElement;
const renameForm = element("rename-form") as HTMLFormElement;
const renameTaskName = element("rename-task-name") as HTMLInputElement;
const toast = element("toast");

void initialize();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (currentRun) void cancelRun();
  else void sendPrompt();
});
prompt.addEventListener("input", () => { resizePrompt(); refreshComposerState(); });
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === "n") { event.preventDefault(); openTaskDialog(); }
  if (event.ctrlKey && event.key.toLowerCase() === "b") { event.preventDefault(); toggleSidebar(); }
  if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "r") { event.preventDefault(); openRenameDialog(); }
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") { event.preventDefault(); void archiveCurrentTask(); }
  if (event.key === "Escape") closePopovers();
});

element("new-project").addEventListener("click", () => openProjectDialog());
element("new-session").addEventListener("click", () => openTaskDialog());
element("sidebar-menu").addEventListener("click", toggleSidebar);
element("sidebar-restore").addEventListener("click", toggleSidebar);
connectionStatus.addEventListener("click", () => void initialize());
contextToggle.addEventListener("click", () => setContextPanel(contextPanel.hasAttribute("hidden")));
element("context-close").addEventListener("click", () => setContextPanel(false));
attachButton.addEventListener("click", chooseArtifact);
addArtifactButton.addEventListener("click", chooseArtifact);
artifactFile.addEventListener("change", () => void uploadArtifact());
chooseProjectFolder.addEventListener("click", () => void selectProjectFolder());
model.addEventListener("change", updateModelControls);
effort.addEventListener("change", updateModelControls);
speed.addEventListener("change", () => { const route = speed.value === "fast" ? "fast" : "default-agent"; if ([...model.options].some((option) => option.value === route)) model.value = route; updateModelControls(); });
modelToggle.addEventListener("click", (event) => { event.stopPropagation(); togglePopover(modelMenu, modelToggle); });
taskMenuToggle.addEventListener("click", (event) => { event.stopPropagation(); togglePopover(taskMenu, taskMenuToggle); });
modelMenu.addEventListener("click", (event) => event.stopPropagation());
taskMenu.addEventListener("click", (event) => event.stopPropagation());
element("rename-task").addEventListener("click", openRenameDialog);
element("archive-task").addEventListener("click", () => void archiveCurrentTask());
renameForm.addEventListener("submit", (event) => { event.preventDefault(); void renameCurrentTask(); });
updateButton.addEventListener("click", () => void window.fitz.installUpdate());
window.fitz.onUpdateStatus((updateStatus) => {
  updateButton.hidden = updateStatus !== "downloaded";
});
projectForm.addEventListener("submit", (event) => { event.preventDefault(); void createProject(); });
taskForm.addEventListener("submit", (event) => { event.preventDefault(); void createSession(); });
for (const closeButton of document.querySelectorAll<HTMLElement>("[data-close-dialog]")) {
  closeButton.addEventListener("click", () => {
    const dialog = document.getElementById(closeButton.dataset.closeDialog ?? "") as HTMLDialogElement | null;
    dialog?.close();
  });
}
document.addEventListener("click", closePopovers);

async function initialize(): Promise<void> {
  try {
    setConnection("Connecting…", "loading");
    setStatus("Connecting", "loading");
    const [health, models] = await Promise.all([api("/health"), api("/v1/models")]);
    model.replaceChildren();
    for (const card of models.data ?? []) model.add(new Option(card.display_name ?? card.id, card.id));
    updateModelControls();
    engineState.textContent = health.engine?.state ?? "UNLOADED";
    routeState.textContent = model.selectedOptions[0]?.textContent ?? "—";
    setConnection("127.0.0.1:8787", "active");
    setStatus(health.engine?.state ?? "Ready", "idle");
    await loadProjects();
  } catch (error) {
    setConnection("Click to retry", "error");
    setStatus("Offline", "error");
    showConnectionFailure(errorMessage(error));
  } finally {
    refreshComposerState();
  }
}

async function loadProjects(preferredProject?: string, preferredSession?: string): Promise<void> {
  const response = await api("/api/v1/projects");
  projectRecords = response.data ?? [];
  sessionsByProject.clear();
  await Promise.all(projectRecords.map(async (project) => {
    const sessions = await api(`/api/v1/projects/${project.id}/sessions`);
    sessionsByProject.set(project.id, (sessions.data ?? []).filter((session: Json) => session.status !== "archived"));
  }));

  if (preferredProject && projectRecords.some((project) => project.id === preferredProject)) currentProject = preferredProject;
  else if (!currentProject || !projectRecords.some((project) => project.id === currentProject)) currentProject = projectRecords[0]?.id;

  if (preferredSession) currentSession = preferredSession;
  const selectedSessions = currentProject ? sessionsByProject.get(currentProject) ?? [] : [];
  if (!currentSession || !selectedSessions.some((session) => session.id === currentSession)) currentSession = selectedSessions[0]?.id;

  renderProjectTree();
  if (currentSession) await selectSession(currentSession, false);
  else { showLanding(); await loadArtifacts(); }
}

function renderProjectTree(): void {
  projects.replaceChildren();
  if (projectRecords.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "tree-empty";
    emptyState.textContent = "No projects yet";
    projects.append(emptyState);
    return;
  }

  for (const project of projectRecords) {
    const group = document.createElement("div");
    group.className = "project-group";
    const projectButton = treeButton(project.name, "project-row", folderIcon(), () => void selectProject(project.id));
    projectButton.classList.toggle("active", project.id === currentProject && !currentSession);
    group.append(projectButton);
    if (project.id === currentProject) {
      const projectSessions = sessionsByProject.get(project.id) ?? [];
      if (projectSessions.length === 0) {
        const emptyState = document.createElement("div"); emptyState.className = "tree-empty"; emptyState.textContent = "No tasks"; group.append(emptyState);
      }
      for (const session of projectSessions) {
        const sessionButton = treeButton(session.title, "task-row", chatIcon(), () => void selectSession(session.id));
        sessionButton.classList.toggle("active", session.id === currentSession);
        group.append(sessionButton);
      }
    }
    projects.append(group);
  }
  updateTitles();
}

async function selectProject(id: string): Promise<void> {
  currentProject = id;
  const projectSessions = sessionsByProject.get(id) ?? [];
  currentSession = projectSessions[0]?.id;
  renderProjectTree();
  if (currentSession) await selectSession(currentSession, false);
  else { showLanding(); await loadArtifacts(); }
  refreshComposerState();
}

async function selectSession(id: string, rerender = true): Promise<void> {
  currentSession = id;
  lastSequence = 0;
  if (rerender) renderProjectTree();
  updateTitles();
  messages.replaceChildren(loadingMessage("Loading conversation…"));
  try {
    const transcript = await api(`/api/v1/sessions/${id}/transcript`);
    messages.replaceChildren();
    for (const entry of transcript.data ?? []) {
      if (entry.kind === "message") appendMessage(entry.role ?? "system", entry.content?.text ?? "");
    }
    if (!messages.childElementCount) showLanding(true);
    await loadArtifacts();
  } catch (error) {
    messages.replaceChildren();
    appendMessage("system", errorMessage(error));
  }
  refreshComposerState();
  prompt.focus();
}

function openProjectDialog(afterCreateTask = false): void {
  pendingTaskAfterProject = afterCreateTask;
  projectForm.reset();
  projectRootPath.value = "";
  projectFolderLabel.textContent = "Add a folder Fitz can read and edit";
  chooseProjectFolder.classList.remove("has-folder");
  projectDialog.showModal();
  projectName.focus();
}

function openTaskDialog(): void {
  if (projectRecords.length === 0) { openProjectDialog(true); return; }
  taskForm.reset();
  taskProject.replaceChildren();
  for (const project of projectRecords) taskProject.add(new Option(project.name, project.id, false, project.id === currentProject));
  taskDialog.showModal();
  taskName.focus();
}

async function createProject(): Promise<void> {
  const name = projectName.value.trim();
  if (!name) return;
  setFormBusy(projectForm, true);
  try {
    const response = await api("/api/v1/projects", "POST", { name, ...(projectRootPath.value ? { rootPath: projectRootPath.value } : {}) });
    projectDialog.close();
    await loadProjects(response.data.id);
    showToast(`Created ${name}`);
    if (pendingTaskAfterProject) { pendingTaskAfterProject = false; openTaskDialog(); }
  } catch (error) {
    showToast(errorMessage(error));
  } finally {
    setFormBusy(projectForm, false);
  }
}

async function createSession(): Promise<void> {
  const projectId = taskProject.value;
  const title = taskName.value.trim();
  if (!projectId || !title) return;
  setFormBusy(taskForm, true);
  try {
    const response = await api(`/api/v1/projects/${projectId}/sessions`, "POST", { title });
    taskDialog.close();
    await loadProjects(projectId, response.data.id);
    showToast(`Started ${title}`);
  } catch (error) {
    showToast(errorMessage(error));
  } finally {
    setFormBusy(taskForm, false);
  }
}

async function selectProjectFolder(): Promise<void> {
  const folder = await window.fitz.chooseFolder();
  if (!folder) return;
  projectRootPath.value = folder;
  projectFolderLabel.textContent = folder;
  chooseProjectFolder.classList.add("has-folder");
  if (!projectName.value.trim()) projectName.value = folder.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project";
}

function openRenameDialog(): void {
  closePopovers();
  const session = currentSessionRecord();
  if (!session) return;
  renameTaskName.value = session.title;
  renameDialog.showModal();
  renameTaskName.select();
}

async function renameCurrentTask(): Promise<void> {
  const title = renameTaskName.value.trim();
  if (!currentSession || !currentProject || !title) return;
  setFormBusy(renameForm, true);
  try {
    await api(`/api/v1/sessions/${currentSession}`, "PATCH", { title });
    renameDialog.close();
    await loadProjects(currentProject, currentSession);
    showToast(`Renamed to ${title}`);
  } catch (error) { showToast(errorMessage(error)); }
  finally { setFormBusy(renameForm, false); }
}

async function archiveCurrentTask(): Promise<void> {
  closePopovers();
  const session = currentSessionRecord();
  if (!session || !currentProject) return;
  try {
    await api(`/api/v1/sessions/${session.id}`, "PATCH", { status: "archived" });
    currentSession = undefined;
    await loadProjects(currentProject);
    showToast(`Archived ${session.title}`);
  } catch (error) { showToast(errorMessage(error)); }
}

function currentSessionRecord(): Json | undefined {
  return currentProject ? (sessionsByProject.get(currentProject) ?? []).find((session) => session.id === currentSession) : undefined;
}

function updateModelControls(): void {
  routeState.textContent = model.selectedOptions[0]?.textContent ?? "—";
  const effortLabel = effort.selectedOptions[0]?.textContent ?? "Medium";
  modelSummary.textContent = `${model.selectedOptions[0]?.textContent ?? "Model"} · ${effortLabel}`;
  speed.value = model.value === "fast" ? "fast" : "standard";
}

function togglePopover(popover: HTMLElement, toggle: HTMLButtonElement): void {
  const opening = popover.hidden;
  closePopovers();
  popover.hidden = !opening;
  toggle.setAttribute("aria-expanded", String(opening));
}

function closePopovers(): void {
  modelMenu.hidden = true;
  taskMenu.hidden = true;
  modelToggle.setAttribute("aria-expanded", "false");
  taskMenuToggle.setAttribute("aria-expanded", "false");
}

async function sendPrompt(): Promise<void> {
  const content = prompt.value.trim();
  if (!content) return;
  if (!currentSession) { openTaskDialog(); return; }
  if (!model.value) { showToast("No model route is available"); return; }
  prompt.value = "";
  resizePrompt();
  if (messages.querySelector(".landing")) messages.replaceChildren();
  appendMessage("user", content);
  setStatus("Queued", "loading");
  try {
    const response = await api("/api/v1/agent/runs", "POST", {
      model: model.value,
      maxTokens: Number(effort.value),
      sessionId: currentSession,
      messages: [{ role: "user", content }],
    });
    const runId = String(response.data.id);
    currentRun = runId;
    lastSequence = 0;
    engineState.textContent = "QUEUED";
    refreshComposerState();
    await followRun(runId);
  } catch (error) {
    appendMessage("system", errorMessage(error));
    setStatus("Failed", "error");
  } finally {
    currentRun = undefined;
    refreshComposerState();
  }
}

async function cancelRun(): Promise<void> {
  if (!currentRun) return;
  sendButton.disabled = true;
  setStatus("Stopping", "loading");
  try {
    await api(`/api/v1/agent/runs/${currentRun}`, "DELETE");
  } catch (error) {
    showToast(errorMessage(error));
    sendButton.disabled = false;
  }
}

async function followRun(runId: string): Promise<void> {
  let assistant: HTMLElement | undefined;
  let done = false;
  let reconnectAttempt = 0;
  while (!done && currentRun === runId) {
    let replay: Json;
    try {
      replay = await api(`/api/v1/agent/runs/${runId}/events?after=${lastSequence}`);
      reconnectAttempt = 0;
    } catch (error) {
      if (error instanceof HttpError || reconnectAttempt >= 12) throw error;
      setStatus(`Reconnecting ${reconnectAttempt + 1}`, "loading");
      await delay(reconnectDelay(reconnectAttempt++));
      continue;
    }
    for (const event of replay.events ?? []) {
      lastSequence = event.sequence;
      if (event.type === "run.started") { setStatus("Working", "active"); engineState.textContent = "WORKING"; }
      if (event.type === "assistant.delta") {
        assistant ??= appendMessage("assistant", "");
        assistant.textContent += event.data.text ?? "";
        messages.scrollTop = messages.scrollHeight;
      }
      if (["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(event.type)) {
        done = true;
        const success = event.type === "run.completed";
        setStatus(success ? "Ready" : event.type.slice(4), success ? "idle" : "error");
        engineState.textContent = success || event.type === "run.cancelled" ? "READY" : event.type.slice(4).toUpperCase();
        if (!success && event.data?.error) appendMessage("system", event.data.error);
      }
    }
    if (!done) await delay(350);
  }
}

async function loadArtifacts(): Promise<void> {
  artifacts.replaceChildren();
  composerAttachments.replaceChildren();
  composerAttachments.hidden = true;
  artifactPreview.replaceChildren(panelEmpty("Select an artifact to preview it"));
  if (!currentSession) { artifacts.append(panelEmpty("Artifacts appear with a task")); return; }
  const response = await api(`/api/v1/sessions/${currentSession}/artifacts`);
  if (!(response.data ?? []).length) artifacts.append(panelEmpty("No artifacts yet"));
  for (const artifact of response.data ?? []) {
    const value = document.createElement("button"); value.type = "button"; value.className = "artifact-item";
    const name = document.createElement("span"); name.textContent = artifact.name;
    const size = document.createElement("small"); size.textContent = formatBytes(artifact.byteSize);
    value.append(name, size); value.addEventListener("click", () => void previewArtifact(artifact, value)); artifacts.append(value);
    const chip = document.createElement("button"); chip.type = "button"; chip.className = "attachment-chip";
    const chipName = document.createElement("span"); chipName.textContent = artifact.name;
    const chipSize = document.createElement("small"); chipSize.textContent = formatBytes(artifact.byteSize);
    chip.append(chipName, chipSize); chip.addEventListener("click", () => { setContextPanel(true); void previewArtifact(artifact, value); }); composerAttachments.append(chip);
  }
  composerAttachments.hidden = composerAttachments.childElementCount === 0;
}

function chooseArtifact(): void {
  if (!currentSession) { showToast("Create or select a task before attaching a file"); return; }
  artifactFile.click();
}

async function uploadArtifact(): Promise<void> {
  const file = artifactFile.files?.[0]; artifactFile.value = "";
  if (!file || !currentSession) return;
  if (file.size > 1_500_000) { showToast("Artifacts are currently limited to 1.5 MB"); return; }
  try {
    const contentBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    await api(`/api/v1/sessions/${currentSession}/artifacts`, "POST", { name: file.name, mimeType: file.type || "application/octet-stream", contentBase64 });
    await loadArtifacts(); setContextPanel(true); showToast(`Attached ${file.name}`);
  } catch (error) { showToast(errorMessage(error)); }
}

async function previewArtifact(artifact: Json, selected: HTMLButtonElement): Promise<void> {
  for (const item of artifacts.querySelectorAll(".artifact-item")) item.classList.remove("active");
  selected.classList.add("active");
  artifactPreview.replaceChildren(panelEmpty("Loading preview…"));
  try {
    const response = await window.fitz.request({ path: `/api/v1/artifacts/${artifact.id}/content`, responseType: "base64" });
    if (response.status >= 400) throw new HttpError("Artifact could not be loaded", response.status);
    artifactPreview.replaceChildren();
    if (artifact.kind === "text" || artifact.kind === "code") {
      const pre = document.createElement("pre"); pre.textContent = new TextDecoder().decode(base64Bytes(response.body)); artifactPreview.append(pre); return;
    }
    if (["image", "audio", "video"].includes(artifact.kind)) {
      const node = document.createElement(artifact.kind === "image" ? "img" : artifact.kind) as HTMLImageElement | HTMLMediaElement;
      node.setAttribute("src", `data:${artifact.mimeType};base64,${response.body}`);
      if (node instanceof HTMLMediaElement) node.controls = true;
      artifactPreview.append(node); return;
    }
    if (artifact.kind === "pdf") {
      const frame = document.createElement("iframe"); frame.setAttribute("sandbox", ""); frame.title = artifact.name; frame.src = `data:application/pdf;base64,${response.body}`; artifactPreview.append(frame); return;
    }
    artifactPreview.append(panelEmpty("Preview unavailable for this file type"));
  } catch (error) { artifactPreview.replaceChildren(panelEmpty(errorMessage(error))); }
}

function showLanding(hasTask = false): void {
  messages.replaceChildren();
  const landing = document.createElement("div"); landing.className = "landing";
  const mark = document.createElement("div"); mark.className = "landing-mark"; mark.append(sparkIcon());
  const heading = document.createElement("h1"); heading.textContent = hasTask ? "What should we work on?" : currentProject ? "Start a task" : "Bring your code. Build with Fitz.";
  const detail = document.createElement("p"); detail.textContent = hasTask ? "Describe a change, ask a question, or attach a file. Fitz keeps the work and transcript together." : currentProject ? "Create a task inside this project to begin a durable conversation." : "Create a project, start a task, and work with local or remote inference from one focused desktop.";
  landing.append(mark, heading, detail);
  if (!hasTask) {
    const action = document.createElement("button"); action.type = "button"; action.className = "primary-button"; action.textContent = currentProject ? "New task" : "Create project";
    action.addEventListener("click", () => currentProject ? openTaskDialog() : openProjectDialog(true)); landing.append(action);
  }
  messages.append(landing);
  updateTitles();
}

function showConnectionFailure(detail: string): void {
  messages.replaceChildren();
  const landing = document.createElement("div"); landing.className = "landing";
  const heading = document.createElement("h1"); heading.textContent = "Fitz host is offline";
  const message = document.createElement("p"); message.textContent = detail;
  const retry = document.createElement("button"); retry.type = "button"; retry.className = "primary-button"; retry.textContent = "Try again"; retry.addEventListener("click", () => void initialize());
  landing.append(heading, message, retry); messages.append(landing);
}

function appendMessage(role: string, text: string): HTMLElement {
  if (messages.querySelector(".landing")) messages.replaceChildren();
  const article = document.createElement("article"); article.className = `message ${role}`;
  if (role === "assistant") { const mark = document.createElement("span"); mark.className = "assistant-mark"; mark.append(sparkIcon()); article.append(mark); }
  const content = document.createElement("div"); content.className = "message-body"; content.textContent = text; article.append(content); messages.append(article); messages.scrollTop = messages.scrollHeight; return content;
}

function refreshComposerState(): void {
  const ready = Boolean(currentSession && model.value);
  prompt.disabled = !ready || Boolean(currentRun);
  model.disabled = model.options.length === 0 || Boolean(currentRun);
  effort.disabled = Boolean(currentRun);
  speed.disabled = model.options.length === 0 || Boolean(currentRun);
  modelToggle.disabled = model.options.length === 0 || Boolean(currentRun);
  attachButton.disabled = !currentSession || Boolean(currentRun);
  addArtifactButton.disabled = !currentSession;
  sendButton.classList.toggle("running", Boolean(currentRun));
  sendButton.title = currentRun ? "Stop task" : "Send message";
  sendButton.setAttribute("aria-label", sendButton.title);
  sendButton.disabled = currentRun ? false : !ready || prompt.value.trim().length === 0;
}

function updateTitles(): void {
  const project = projectRecords.find((item) => item.id === currentProject);
  const session = currentProject ? (sessionsByProject.get(currentProject) ?? []).find((item) => item.id === currentSession) : undefined;
  projectTitle.textContent = project?.name ?? "Fitz Codex";
  taskTitle.textContent = session?.title ?? "";
  taskMenuToggle.hidden = !session;
}

function setContextPanel(open: boolean): void {
  contextPanel.hidden = !open;
  shell.classList.toggle("context-open", open);
  contextToggle.setAttribute("aria-expanded", String(open));
}

function toggleSidebar(): void { shell.classList.toggle("sidebar-collapsed"); }
function resizePrompt(): void { prompt.style.height = "auto"; prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`; }
function setStatus(text: string, state: string): void { status.textContent = text; status.dataset.state = state; }
function setConnection(text: string, state: string): void { connectionDetail.textContent = text; connectionStatus.dataset.state = state; }
function setFormBusy(formElement: HTMLFormElement, busy: boolean): void { for (const control of formElement.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")) control.disabled = busy; }
function showToast(text: string): void { if (toastTimer) clearTimeout(toastTimer); toast.textContent = text; toast.hidden = false; toastTimer = setTimeout(() => { toast.hidden = true; }, 3_200); }
function panelEmpty(text: string): HTMLElement { const value = document.createElement("div"); value.className = "panel-empty"; value.textContent = text; return value; }
function loadingMessage(text: string): HTMLElement { const value = document.createElement("div"); value.className = "panel-empty"; value.textContent = text; return value; }
function treeButton(label: string, className: string, icon: SVGElement, action: () => void): HTMLButtonElement { const value = document.createElement("button"); value.type = "button"; value.className = className; const text = document.createElement("span"); text.textContent = label; value.append(icon, text); value.addEventListener("click", action); return value; }

async function api(path: string, method = "GET", body?: unknown): Promise<Json> {
  const response = await window.fitz.request({ path, method, ...(body !== undefined ? { body } : {}) });
  let parsed: Json;
  try { parsed = JSON.parse(response.body) as Json; } catch { parsed = { error: response.body }; }
  if (response.status >= 400) throw new HttpError(parsed.error?.message ?? parsed.error ?? `Request failed (${response.status})`, response.status);
  return parsed;
}

function svg(path: string): SVGElement { const value = document.createElementNS("http://www.w3.org/2000/svg", "svg"); value.setAttribute("viewBox", "0 0 20 20"); value.setAttribute("aria-hidden", "true"); value.innerHTML = path; return value; }
function folderIcon(): SVGElement { return svg('<path d="M3.5 6.5h5l1.5 2h6.5v7.5h-13z"></path><path d="M3.5 6.5V4h5l1.5 2"></path>'); }
function chatIcon(): SVGElement { return svg('<path d="M4 4.5h12v9H9l-3.5 2.5v-2.5H4z"></path>'); }
function sparkIcon(): SVGElement { return svg('<path d="M10 2.8c.5 3.7 2.4 5.8 6.2 7.2-3.8 1.4-5.7 3.5-6.2 7.2-.5-3.7-2.4-5.8-6.2-7.2C7.6 8.6 9.5 6.5 10 2.8Z"></path>'); }
function element(id: string): HTMLElement { const value = document.getElementById(id); if (!value) throw new Error(`Missing #${id}`); return value; }
function query(selector: string): HTMLElement { const value = document.querySelector<HTMLElement>(selector); if (!value) throw new Error(`Missing ${selector}`); return value; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function bytesToBase64(bytes: Uint8Array): string { let binary = ""; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(binary); }
function base64Bytes(value: string): Uint8Array { const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function formatBytes(value: number): string { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`; }
class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }
