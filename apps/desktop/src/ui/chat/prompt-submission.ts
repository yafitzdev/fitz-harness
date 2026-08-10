import type { MediaModality } from "@fitz/protocol";
import type { ComposerSubmission, PastedAttachment } from "./composer.js";

export type PromptMessageContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export interface PromptRunSettings {
  routeId: string;
  maxTokens: number;
  temperature: number;
  accessMode: string;
}

export interface PromptSubmissionOptions {
  draft: () => ComposerSubmission;
  consumeAttachments: () => PastedAttachment[];
  sessionId: () => string | undefined;
  settings: () => PromptRunSettings;
  ensureSession: (title: string, routeId: string) => Promise<string | undefined>;
  openNewChat: () => void;
  clearDraft: () => void;
  setDraft: (value: string) => void;
  resetWarmup: () => void;
  uploadAttachment: (sessionId: string, attachment: PastedAttachment) => Promise<{ id: string }>;
  clearLanding: () => void;
  appendUser: (content: string) => void;
  appendSteer: (content: string) => HTMLElement;
  pushHistory: (content: string) => void;
  addTokenEstimate: (content: string) => void;
  refreshContext: () => void;
  refreshControls: () => void;
  runId: () => string | undefined;
  startRun: (request: {
    model: string;
    max_tokens: number;
    temperature: number;
    sessionId: string;
    accessMode: string;
    mediaCommand?: MediaModality;
    messages: Array<{ role: "user"; content: PromptMessageContent }>;
  }) => Promise<void>;
  steerRun: (content: string) => Promise<void>;
  showError: (message: string) => void;
  errorMessage: (error: unknown) => string;
}

/** Owns first-message session creation, attachment upload, run submission, and steering. */
export class PromptSubmissionController {
  readonly #options: PromptSubmissionOptions;

  constructor(options: PromptSubmissionOptions) { this.#options = options; }

  async submit(submitted?: string | ComposerSubmission, existingUserMessage?: HTMLElement): Promise<void> {
    const draft = typeof submitted === "string" ? { content: submitted } : (submitted ?? this.#options.draft());
    const content = draft.content.trim();
    const mediaCommand = draft.mediaCommand;
    const attachments = this.#options.consumeAttachments();
    if (!content && attachments.length === 0) return;
    const settings = this.#options.settings();
    let sessionId = this.#options.sessionId();
    if (!sessionId) {
      try { sessionId = await this.#options.ensureSession(titleFrom(content), settings.routeId); }
      catch (error) { this.#options.showError(this.#options.errorMessage(error)); return; }
    }
    if (!sessionId) { this.#options.openNewChat(); return; }
    if (!settings.routeId) { this.#options.showError("No model route is available"); return; }

    this.#options.clearDraft();
    this.#options.resetWarmup();
    const imageParts: Array<{ type: "image_url"; image_url: { url: string } }> = [];
    for (const attachment of attachments) {
      try {
        const artifact = await this.#options.uploadAttachment(sessionId, attachment);
        if (attachment.kind === "image") imageParts.push({ type: "image_url", image_url: { url: `/api/v1/artifacts/${artifact.id}` } });
      } catch (error) { this.#options.showError(this.#options.errorMessage(error)); }
    }
    this.#options.clearLanding();
    const displayContent = mediaCommand ? `/${mediaCommand}${content ? ` ${content}` : ""}` : content;
    if (!existingUserMessage) this.#options.appendUser(displayContent);
    if (displayContent && !existingUserMessage) this.#options.pushHistory(displayContent);
    this.#options.addTokenEstimate(displayContent);
    this.#options.refreshContext();
    const messageContent: PromptMessageContent = imageParts.length > 0
      ? [{ type: "text", text: displayContent }, ...imageParts]
      : displayContent;
    await this.#options.startRun({
      model: settings.routeId,
      max_tokens: settings.maxTokens,
      temperature: settings.temperature,
      sessionId,
      accessMode: settings.accessMode,
      ...(mediaCommand ? { mediaCommand } : {}),
      messages: [{ role: "user", content: messageContent }],
    });
  }

  async steer(content: string): Promise<void> {
    const runId = this.#options.runId();
    if (!content || !runId) return;
    this.#options.clearDraft();
    this.#options.resetWarmup();
    this.#options.refreshContext();
    this.#options.refreshControls();
    const row = this.#options.appendSteer(content);
    this.#options.pushHistory(content);
    this.#options.addTokenEstimate(content);
    this.#options.refreshContext();
    try { await this.#options.steerRun(content); }
    catch {
      row.remove();
      this.#options.setDraft(content);
    }
  }
}

function titleFrom(content: string): string {
  return content.split(/\r?\n/, 1)[0]!.trim().slice(0, 80) || "New chat";
}
