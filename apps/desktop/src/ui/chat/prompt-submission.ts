import type { AgentEffort, MediaModality } from "@fitz/protocol";
import type { ComposerSubmission, PastedAttachment } from "./composer.js";
import type { MediaCreationParams } from "./media-creation-form.js";
import type { MessageAttachment } from "./conversation-message-feed.js";

export type PromptMessageContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export interface PromptRunSettings {
  routeId: string;
  effort: AgentEffort;
  maxTokens: number;
  temperature: number;
  accessMode: string;
}

export interface PromptSubmissionOptions {
  draft: () => ComposerSubmission;
  consumeAttachments: () => PastedAttachment[];
  sessionId: () => string | undefined;
  isSessionCurrent?: (sessionId: string) => boolean;
  settings: () => PromptRunSettings;
  ensureSession: (title: string, routeId?: string) => Promise<string | undefined>;
  openNewChat: () => void;
  clearDraft: () => void;
  setDraft: (value: string) => void;
  resetWarmup: () => void;
  uploadAttachment: (sessionId: string, attachment: PastedAttachment) => Promise<{ id: string; name?: string; mimeType?: string; kind?: string; byteSize?: number }>;
  clearLanding: () => void;
  appendUser: (content: string, attachments?: readonly MessageAttachment[]) => void;
  persistUserMessage: (sessionId: string, content: string, clientMessageId: string) => Promise<void>;
  appendSteer: (content: string) => HTMLElement;
  pushHistory: (content: string) => void;
  addTokenEstimate: (content: string) => void;
  refreshContext: () => void;
  refreshControls: () => void;
  runId: () => string | undefined;
  startRun: (request: {
    model: string;
    effort: AgentEffort;
    max_tokens: number;
    temperature: number;
    sessionId: string;
    accessMode: string;
    persistedMessageId?: string;
    attachments?: Array<{ artifactId: string }>;
    messages: Array<{ role: "user"; content: PromptMessageContent }>;
  }) => Promise<void>;
  /** Submits a media job straight to the media-job pipeline, bypassing the LLM entirely. */
  submitMedia: (request: {
    routeId: string;
    modality: MediaModality;
    operation?: "generate" | "edit" | "animate";
    prompt: string;
    sessionId: string;
    size?: string;
    seed?: number;
    negativePrompt?: string;
    lyrics?: string;
    durationSeconds?: number;
    fps?: number;
    refs?: Array<{ artifactId: string }>;
  }) => Promise<{ id: string }>;
  /** Shows the inline media creation card (prompt + parameters) in the chat for a media command. */
  showMediaCreation: (request: {
    modality: MediaModality;
    prompt: string;
    refs: Array<{ artifactId: string }>;
    submit: (params: MediaCreationParams) => Promise<void>;
  }) => void;
  /** Renders the queued media card and starts following the job (separate from agent runs). */
  onMediaJobSubmitted: (jobId: string, modality: MediaModality) => void;
  steerRun: (content: string) => Promise<void>;
  showError: (message: string) => void;
  errorMessage: (error: unknown) => string;
}

/** Prompt used when a media command is submitted with no trailing prompt text. */
const DEFAULT_MEDIA_PROMPTS: Record<MediaModality, string> = {
  image: "a vivid, detailed image",
  video: "a short video clip",
  audio: "a short audio clip",
};

/** Owns first-message session creation, attachment upload, run submission, and steering. */
export class PromptSubmissionController {
  readonly #options: PromptSubmissionOptions;
  #pendingSubmission: Promise<void> | undefined;

  constructor(options: PromptSubmissionOptions) { this.#options = options; }

  async submit(submitted?: string | ComposerSubmission, existingUserMessage?: HTMLElement, persistedMessageId?: string): Promise<void> {
    if (this.#pendingSubmission) { await this.#pendingSubmission; return; }
    let resolveAdmission!: () => void;
    const admission = new Promise<void>((resolve) => { resolveAdmission = resolve; });
    this.#pendingSubmission = admission;
    const releaseAdmission = () => {
      if (this.#pendingSubmission !== admission) return;
      this.#pendingSubmission = undefined;
      resolveAdmission();
    };
    try { await this.#submitOnce(submitted, existingUserMessage, persistedMessageId, releaseAdmission); }
    finally { releaseAdmission(); }
  }

  async #submitOnce(
    submitted: string | ComposerSubmission | undefined,
    existingUserMessage: HTMLElement | undefined,
    persistedMessageId: string | undefined,
    releaseAdmission: () => void,
  ): Promise<void> {
    const draft = typeof submitted === "string" ? { content: submitted } : (submitted ?? this.#options.draft());
    const content = draft.content.trim();
    const mediaCommand = draft.mediaCommand;
    // Inline edit/regenerate reuses the durable user turn and must not consume
    // unrelated attachments that are still sitting in the composer.
    const attachments = existingUserMessage ? [] : this.#options.consumeAttachments();
    // A media command with no prompt text is still a valid submission: media
    // commands generate with a default prompt instead of being silently dropped.
    if (!content && attachments.length === 0 && !mediaCommand) return;
    const settings = this.#options.settings();
    if (!settings.routeId && !mediaCommand) { this.#options.showError("No model route is available"); return; }
    let sessionId = this.#options.sessionId();
    if (!sessionId) {
      try { sessionId = await this.#options.ensureSession(titleFrom(content), settings.routeId || undefined); }
      catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        this.#options.showError(this.#options.errorMessage(error)); return;
      }
    }
    if (!sessionId) { this.#options.openNewChat(); return; }
    if (this.#options.isSessionCurrent?.(sessionId) === false) return;

    this.#options.resetWarmup();
    // Media generation only consumes pasted reference images (and audio takes
    // no references); regular messages upload every attachment for the agent.
    const uploadable = mediaCommand
      ? mediaCommand === "audio" ? [] : attachments.filter((attachment) => attachment.kind === "image")
      : attachments;
    const uploaded: Array<{ artifact: Awaited<ReturnType<PromptSubmissionOptions["uploadAttachment"]>>; attachment: PastedAttachment }> = [];
    for (const attachment of uploadable) {
      try {
        const artifact = await this.#options.uploadAttachment(sessionId, attachment);
        if (this.#options.isSessionCurrent?.(sessionId) === false) return;
        uploaded.push({ artifact, attachment });
      } catch (error) {
        this.#options.showError(this.#options.errorMessage(error));
        return;
      }
    }

    // Media commands skip the LLM entirely: the command is sent as a normal
    // chat message and an inline media creation card opens below it where the
    // user reviews the prompt and parameters. Confirming submits the job
    // straight to the media pipeline so no model can refuse a tool call.
    if (mediaCommand) {
      const refs = uploaded
        .filter(({ attachment }) => attachment.kind === "image")
        .map(({ artifact }) => ({ artifactId: artifact.id }));
      const displayContent = `/${mediaCommand}${content ? ` ${content}` : ""}`;
      if (!existingUserMessage) {
        try { await this.#options.persistUserMessage(sessionId, displayContent, crypto.randomUUID()); }
        catch (error) {
          this.#options.setDraft(displayContent);
          this.#options.showError(this.#options.errorMessage(error));
          return;
        }
      }
      if (this.#options.isSessionCurrent?.(sessionId) === false) return;
      this.#options.clearDraft();
      this.#options.clearLanding();
      if (!existingUserMessage) {
        const messageAttachments = uploaded.map(messageAttachment);
        if (messageAttachments.length) this.#options.appendUser(displayContent, messageAttachments);
        else this.#options.appendUser(displayContent);
      }
      if (displayContent && !existingUserMessage) this.#options.pushHistory(displayContent);
      this.#options.addTokenEstimate(displayContent);
      this.#options.refreshContext();
      this.#options.showMediaCreation({
        modality: mediaCommand,
        prompt: content || DEFAULT_MEDIA_PROMPTS[mediaCommand],
        refs,
        submit: async (params) => {
          try {
            if (this.#options.isSessionCurrent?.(sessionId) === false) throw staleConversationError();
            const job = await this.#options.submitMedia({
              routeId: mediaCommand,
              modality: mediaCommand,
              ...(mediaCommand === "image" && refs.length > 0 ? { operation: "edit" } : {}),
              ...(mediaCommand === "video" && refs.length > 0 ? { operation: "animate" } : {}),
              prompt: params.prompt,
              sessionId,
              ...(params.size ? { size: params.size } : {}),
              ...(params.seed !== undefined ? { seed: params.seed } : {}),
              ...(params.negativePrompt ? { negativePrompt: params.negativePrompt } : {}),
              ...(params.lyrics ? { lyrics: params.lyrics } : {}),
              ...(params.durationSeconds !== undefined ? { durationSeconds: params.durationSeconds } : {}),
              ...(params.fps !== undefined ? { fps: params.fps } : {}),
              ...(refs.length > 0 && mediaCommand !== "audio" ? { refs } : {}),
            });
            if (this.#options.isSessionCurrent?.(sessionId) === false) return;
            this.#options.onMediaJobSubmitted(job.id, mediaCommand);
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") return;
            this.#options.showError(this.#options.errorMessage(error));
            throw error;
          }
        },
      });
      return;
    }

    this.#options.clearDraft();
    this.#options.clearLanding();
    if (!existingUserMessage) {
      const messageAttachments = uploaded.map(messageAttachment);
      if (messageAttachments.length) this.#options.appendUser(content, messageAttachments);
      else this.#options.appendUser(content);
    }
    if (content && !existingUserMessage) this.#options.pushHistory(content);
    if (!existingUserMessage) this.#options.addTokenEstimate(content);
    this.#options.refreshContext();
    // The run controller marks itself active synchronously. Once it owns this
    // request, media commands no longer need to wait for the run to finish.
    releaseAdmission();
    await this.#options.startRun({
      model: settings.routeId,
      effort: settings.effort,
      max_tokens: settings.maxTokens,
      temperature: settings.temperature,
      sessionId,
      accessMode: settings.accessMode,
      ...(uploaded.length ? { attachments: uploaded.map(({ artifact }) => ({ artifactId: artifact.id })) } : {}),
      ...(persistedMessageId ? { persistedMessageId } : {}),
      messages: [{ role: "user", content }],
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

function staleConversationError(): Error {
  return Object.assign(new Error("Conversation changed before the request completed"), { name: "AbortError" });
}

function titleFrom(content: string): string {
  return content.split(/\r?\n/, 1)[0]!.trim().slice(0, 80) || "New chat";
}

function messageAttachment(uploaded: { artifact: Awaited<ReturnType<PromptSubmissionOptions["uploadAttachment"]>>; attachment: PastedAttachment }): MessageAttachment {
  return {
    id: uploaded.artifact.id,
    name: uploaded.artifact.name ?? uploaded.attachment.name,
    mimeType: uploaded.artifact.mimeType ?? uploaded.attachment.mimeType,
    kind: uploaded.artifact.kind ?? uploaded.attachment.kind,
    ...(uploaded.artifact.byteSize !== undefined ? { byteSize: uploaded.artifact.byteSize } : {}),
    dataUrl: uploaded.attachment.dataUrl,
  };
}
