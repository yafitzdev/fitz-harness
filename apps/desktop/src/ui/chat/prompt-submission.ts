import type { AgentEffort, MediaGenerationReference, MediaModality } from "@fitz/protocol";
import type { ComposerSubmission, PastedAttachment } from "./composer.js";
import type { MediaCreationParams } from "./media-creation-form.js";
import type { MessageAttachment } from "./conversation-message-feed.js";
import { serializeComposerReferences } from "./composer-references.js";

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
  peekAttachments: () => PastedAttachment[];
  consumeAttachments: (attachments: readonly PastedAttachment[]) => void;
  sessionId: () => string | undefined;
  isSessionCurrent?: (sessionId: string) => boolean;
  settings: () => PromptRunSettings;
  ensureSession: (title: string, routeId?: string) => Promise<string | undefined>;
  openNewChat: () => void;
  clearDraft: () => void;
  setDraft: (value: string) => void;
  resetWarmup: () => void;
  uploadAttachment: (sessionId: string, attachment: PastedAttachment) => Promise<{ id: string; name?: string; mimeType?: string; kind?: string; byteSize?: number }>;
  discardUploadedAttachment: (sessionId: string, artifactId: string) => Promise<void>;
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
    clientRequestId?: string;
    persistedMessageId?: string;
    attachments?: Array<{ artifactId: string }>;
    messages: Array<{ role: "user"; content: PromptMessageContent }>;
  }, onAccepted: () => void) => Promise<void>;
  /** Submits a media job straight to the media-job pipeline, bypassing the LLM entirely. */
  submitMedia: (request: {
    routeId: string;
    clientRequestId: string;
    modality: MediaModality;
    operation?: "generate" | "edit" | "animate" | "reference";
    prompt: string;
    sessionId: string;
    size?: string;
    seed?: number;
    negativePrompt?: string;
    lyrics?: string;
    durationSeconds?: number;
    fps?: number;
    refs?: MediaGenerationReference[];
  }) => Promise<{ id: string }>;
  /** Shows the inline media creation card (prompt + parameters) in the chat for a media command. */
  showMediaCreation: (request: {
    modality: MediaModality;
    prompt: string;
    refs: MediaGenerationReference[];
    submit: (params: MediaCreationParams) => Promise<void>;
  }) => void;
  /** Renders the queued media card and starts following the job (separate from agent runs). */
  onMediaJobSubmitted: (jobId: string, modality: MediaModality) => void;
  steerRun: (content: string) => Promise<void>;
  showError: (message: string) => void;
  errorMessage: (error: unknown) => string;
}

type UploadedAttachment = {
  artifact: Awaited<ReturnType<PromptSubmissionOptions["uploadAttachment"]>>;
  attachment: PastedAttachment;
};

interface RetryableRunSubmission {
  sessionId: string;
  content: string;
  settings: PromptRunSettings;
  attachments: readonly PastedAttachment[];
  uploaded: readonly UploadedAttachment[];
  clientRequestId: string;
}

interface RetryableMediaMessage {
  sessionId: string;
  displayContent: string;
  clientMessageId: string;
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
  #pendingSubmissionKey: string | undefined;
  #retryableRun: RetryableRunSubmission | undefined;
  #retryableMediaMessage: RetryableMediaMessage | undefined;

  constructor(options: PromptSubmissionOptions) { this.#options = options; }

  async submit(submitted?: string | ComposerSubmission, existingUserMessage?: HTMLElement, persistedMessageId?: string): Promise<void> {
    const captured = typeof submitted === "string" ? { content: submitted } : (submitted ?? this.#options.draft());
    const submissionKey = pendingSubmissionKey(captured, existingUserMessage, persistedMessageId);
    if (this.#pendingSubmission) {
      const duplicate = submissionKey === this.#pendingSubmissionKey;
      await this.#pendingSubmission;
      if (duplicate) return;
      // A distinct Enter press during slow first-chat creation must not vanish.
      // Restore it as an editable draft once the earlier admission resolves;
      // the user can then send it as steering or as the next regular turn.
      const currentDraft = submissionText(this.#options.draft());
      const queuedDraft = submissionText(captured);
      const recovered = mergeDraftText(currentDraft, queuedDraft);
      if (recovered) this.#options.setDraft(recovered);
      this.#options.refreshContext();
      this.#options.refreshControls();
      return;
    }
    let resolveAdmission!: () => void;
    const admission = new Promise<void>((resolve) => { resolveAdmission = resolve; });
    this.#pendingSubmission = admission;
    this.#pendingSubmissionKey = submissionKey;
    const releaseAdmission = () => {
      if (this.#pendingSubmission !== admission) return;
      this.#pendingSubmission = undefined;
      this.#pendingSubmissionKey = undefined;
      resolveAdmission();
    };
    try { await this.#submitOnce(captured, existingUserMessage, persistedMessageId, releaseAdmission); }
    finally { releaseAdmission(); }
  }

  async submitQueued(content: string, settings: PromptRunSettings, clientRequestId: string, onAccepted: () => void, onRejected: () => void): Promise<void> {
    if (this.#pendingSubmission) { onRejected(); return; }
    let release!: () => void;
    const admission = new Promise<void>((resolve) => { release = resolve; });
    this.#pendingSubmission = admission;
    this.#pendingSubmissionKey = `queued:${content}`;
    const releaseAdmission = () => { if (this.#pendingSubmission === admission) { this.#pendingSubmission = undefined; this.#pendingSubmissionKey = undefined; release(); } };
    try { await this.#submitOnce({ content }, undefined, undefined, releaseAdmission, { settings, detached: true, clientRequestId, onAccepted, onRejected }); }
    finally { releaseAdmission(); }
  }

  async #submitOnce(
    submitted: string | ComposerSubmission | undefined,
    existingUserMessage: HTMLElement | undefined,
    persistedMessageId: string | undefined,
    releaseAdmission: () => void,
    queued?: { settings: PromptRunSettings; detached: true; clientRequestId: string; onAccepted: () => void; onRejected: () => void },
  ): Promise<void> {
    const draft = typeof submitted === "string" ? { content: submitted } : (submitted ?? this.#options.draft());
    const content = contentWithReferences(draft).trim();
    const mediaCommand = draft.mediaCommand;
    if (!mediaCommand) this.#retryableMediaMessage = undefined;
    // Inline edit/regenerate reuses the durable user turn and must not consume
    // unrelated attachments that are still sitting in the composer.
    const attachments = existingUserMessage || queued?.detached ? [] : this.#options.peekAttachments();
    // A media command with no prompt text is still a valid submission: media
    // commands generate with a default prompt instead of being silently dropped.
    if (!content && attachments.length === 0 && !mediaCommand) return;
    const settings = queued?.settings ?? this.#options.settings();
    if (!settings.routeId && !mediaCommand) { this.#options.showError("No model route is available"); return; }
    let sessionId = this.#options.sessionId();
    if (!sessionId) {
      try { sessionId = await this.#options.ensureSession(titleFrom(content), settings.routeId || undefined); }
      catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        if (!existingUserMessage) this.#restoreSubmissionDraft(draft);
        this.#options.showError(this.#options.errorMessage(error)); return;
      }
    }
    if (!sessionId) { this.#options.openNewChat(); return; }
    if (this.#options.isSessionCurrent?.(sessionId) === false) return;

    this.#options.resetWarmup();
    // Media generation consumes only modalities its command can reference;
    // unrelated files stay staged for the next regular message.
    const uploadable = mediaCommand
      ? attachments.filter((attachment) => mediaCommand === "video"
        ? attachment.kind === "image" || attachment.kind === "video" || attachment.kind === "audio"
        : mediaCommand === "image" && attachment.kind === "image")
      : attachments;
    const retryable = !existingUserMessage && !mediaCommand && this.#matchesRetryableRun(sessionId, content, settings, attachments)
      ? this.#retryableRun
      : undefined;
    if (!retryable && !mediaCommand) this.#retryableRun = undefined;
    const uploaded: UploadedAttachment[] = retryable ? [...retryable.uploaded] : [];
    if (!retryable) {
      for (const attachment of uploadable) {
        try {
          const artifact = await this.#options.uploadAttachment(sessionId, attachment);
          uploaded.push({ artifact, attachment });
          if (this.#options.isSessionCurrent?.(sessionId) === false) {
            await this.#discardUploads(sessionId, uploaded);
            return;
          }
        } catch (error) {
          await this.#discardUploads(sessionId, uploaded);
          if (!existingUserMessage && this.#options.isSessionCurrent?.(sessionId) !== false) this.#restoreSubmissionDraft(draft);
          this.#options.showError(this.#options.errorMessage(error));
          return;
        }
      }
    }

    // Media commands skip the LLM entirely: the command is sent as a normal
    // chat message and an inline media creation card opens below it where the
    // user reviews the prompt and parameters. Confirming submits the job
    // straight to the media pipeline so no model can refuse a tool call.
    if (mediaCommand) {
      const refs = uploaded
        .filter(({ attachment }) => attachment.kind === "image" || attachment.kind === "video" || attachment.kind === "audio")
        .map(({ artifact, attachment }): MediaGenerationReference => ({ artifactId: artifact.id, modality: attachment.kind as MediaModality }));
      const displayContent = `/${mediaCommand}${content ? ` ${content}` : ""}`;
      const retryableMedia = this.#retryableMediaMessage?.sessionId === sessionId
        && this.#retryableMediaMessage.displayContent === displayContent
        ? this.#retryableMediaMessage
        : undefined;
      if (!retryableMedia) this.#retryableMediaMessage = undefined;
      const clientMessageId = retryableMedia?.clientMessageId ?? crypto.randomUUID();
      if (!existingUserMessage) {
        try { await this.#options.persistUserMessage(sessionId, displayContent, clientMessageId); }
        catch (error) {
          this.#retryableMediaMessage = { sessionId, displayContent, clientMessageId };
          await this.#discardUploads(sessionId, uploaded);
          this.#restoreSubmissionDraft(draft);
          this.#options.showError(this.#options.errorMessage(error));
          return;
        }
      }
      if (this.#options.isSessionCurrent?.(sessionId) === false) return;
      this.#retryableMediaMessage = undefined;
      this.#retryableRun = undefined;
      // Only consume references the media request actually captured. Files,
      // PDFs, and every attachment on /audio remain staged for the next turn.
      if (uploadable.length > 0) this.#options.consumeAttachments(uploadable);
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
      const mediaJobRequestId = crypto.randomUUID();
      this.#options.showMediaCreation({
        modality: mediaCommand,
        prompt: content || DEFAULT_MEDIA_PROMPTS[mediaCommand],
        refs,
        submit: async (params) => {
          try {
            if (this.#options.isSessionCurrent?.(sessionId) === false) throw staleConversationError();
            const job = await this.#options.submitMedia({
              routeId: mediaCommand,
              clientRequestId: mediaJobRequestId,
              modality: mediaCommand,
              ...(mediaCommand === "image" && refs.length > 0 ? { operation: "edit" } : {}),
              ...(mediaCommand === "video" && refs.length === 1 && refs[0]?.modality === "image" ? { operation: "animate" } : {}),
              ...(mediaCommand === "video" && (refs.length > 1 || refs[0]?.modality === "video" || refs[0]?.modality === "audio") ? { operation: "reference" } : {}),
              prompt: params.prompt,
              sessionId,
              ...(params.size ? { size: params.size } : {}),
              ...(params.seed !== undefined ? { seed: params.seed } : {}),
              ...(params.negativePrompt ? { negativePrompt: params.negativePrompt } : {}),
              ...(params.lyrics ? { lyrics: params.lyrics } : {}),
              ...(params.durationSeconds !== undefined ? { durationSeconds: params.durationSeconds } : {}),
              ...(params.fps !== undefined ? { fps: params.fps } : {}),
              ...(refs.length > 0 ? { refs } : {}),
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

    // Keep attachment chips staged until the host confirms that it durably
    // created the run. The text is cleared while admission is pending so the
    // unlocked running composer cannot accidentally steer the same prompt.
    if (!queued?.detached) { this.#options.clearDraft(); this.#options.refreshContext(); }
    const clientRequestId = queued?.clientRequestId ?? retryable?.clientRequestId ?? crypto.randomUUID();
    const retryState: RetryableRunSubmission = { sessionId, content, settings: { ...settings }, attachments: [...attachments], uploaded: [...uploaded], clientRequestId };
    let accepted = false;
    const accept = () => {
      if (accepted) return;
      accepted = true;
      if (this.#retryableRun === retryState || this.#retryableRun?.clientRequestId === clientRequestId) this.#retryableRun = undefined;
      try {
        queued?.onAccepted();
        if (attachments.length > 0) this.#options.consumeAttachments(attachments);
        // The run is durable even if its creation response arrived after the
        // user selected another chat. In that case transcript replay owns the
        // old chat's UI and this callback must not touch the new conversation.
        if (this.#options.isSessionCurrent?.(sessionId) !== false) {
          this.#options.clearLanding();
          if (!existingUserMessage) {
            const messageAttachments = uploaded.map(messageAttachment);
            if (messageAttachments.length) this.#options.appendUser(content, messageAttachments);
            else this.#options.appendUser(content);
          }
          if (content && !existingUserMessage) this.#options.pushHistory(content);
          if (!existingUserMessage) this.#options.addTokenEstimate(content);
          this.#options.refreshContext();
        }
      } finally {
        // Once admission succeeds, other independent media submissions may
        // use the composer while the agent continues following the run.
        releaseAdmission();
      }
    };
    try {
      await this.#options.startRun({
        model: settings.routeId,
        effort: settings.effort,
        max_tokens: settings.maxTokens,
        temperature: settings.temperature,
        sessionId,
        accessMode: settings.accessMode,
        clientRequestId,
        ...(uploaded.length ? { attachments: uploaded.map(({ artifact }) => ({ artifactId: artifact.id })) } : {}),
        ...(persistedMessageId ? { persistedMessageId } : {}),
        messages: [{ role: "user", content }],
      }, accept);
    } catch (error) {
      this.#options.showError(this.#options.errorMessage(error));
    } finally {
      if (!accepted && !existingUserMessage && !queued?.detached && this.#options.isSessionCurrent?.(sessionId) !== false) {
        this.#retryableRun = retryState;
        this.#restoreSubmissionDraft({ content });
      }
      if (!accepted) queued?.onRejected();
    }
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

  #matchesRetryableRun(
    sessionId: string,
    content: string,
    settings: PromptRunSettings,
    attachments: readonly PastedAttachment[],
  ): boolean {
    const retryable = this.#retryableRun;
    if (!retryable || retryable.sessionId !== sessionId || retryable.content !== content) return false;
    if (retryable.settings.routeId !== settings.routeId
      || retryable.settings.effort !== settings.effort
      || retryable.settings.maxTokens !== settings.maxTokens
      || retryable.settings.temperature !== settings.temperature
      || retryable.settings.accessMode !== settings.accessMode) return false;
    return retryable.attachments.length === attachments.length
      && retryable.attachments.every((attachment, index) => attachment === attachments[index]);
  }

  async #discardUploads(sessionId: string, uploaded: readonly UploadedAttachment[]): Promise<void> {
    await Promise.allSettled(uploaded.map(({ artifact }) => this.#options.discardUploadedAttachment(sessionId, artifact.id)));
  }

  #restoreSubmissionDraft(submission: ComposerSubmission): void {
    const recovered = mergeDraftText(submissionText(submission), submissionText(this.#options.draft()));
    if (recovered) this.#options.setDraft(recovered);
    this.#options.refreshContext();
    this.#options.refreshControls();
  }
}

function staleConversationError(): Error {
  return Object.assign(new Error("Conversation changed before the request completed"), { name: "AbortError" });
}

function titleFrom(content: string): string {
  return content.split(/\r?\n/, 1)[0]!.trim().slice(0, 80) || "New chat";
}

function submissionText(submission: ComposerSubmission): string {
  if (!submission.mediaCommand) return contentWithReferences(submission);
  return `/${submission.mediaCommand}${submission.content ? ` ${submission.content}` : ""}`;
}

function contentWithReferences(submission: ComposerSubmission): string {
  const references = serializeComposerReferences(submission.references ?? []);
  return [references, submission.content].filter(Boolean).join("\n");
}

function pendingSubmissionKey(submission: ComposerSubmission, existingUserMessage: HTMLElement | undefined, persistedMessageId: string | undefined): string {
  return JSON.stringify([submission.content.trim(), submission.mediaCommand ?? "", persistedMessageId ?? "", Boolean(existingUserMessage)]);
}

function mergeDraftText(first: string, second: string): string {
  const left = first.trim();
  const right = second.trim();
  if (!left) return right;
  if (!right || left === right || left.endsWith(`\n\n${right}`)) return left;
  if (right.startsWith(`${left}\n\n`)) return right;
  return `${left}\n\n${right}`;
}

function messageAttachment(uploaded: UploadedAttachment): MessageAttachment {
  return {
    id: uploaded.artifact.id,
    name: uploaded.artifact.name ?? uploaded.attachment.name,
    mimeType: uploaded.artifact.mimeType ?? uploaded.attachment.mimeType,
    kind: uploaded.artifact.kind ?? uploaded.attachment.kind,
    ...(uploaded.artifact.byteSize !== undefined ? { byteSize: uploaded.artifact.byteSize } : {}),
    ...(uploaded.attachment.dataUrl ? { dataUrl: uploaded.attachment.dataUrl } : {}),
  };
}
