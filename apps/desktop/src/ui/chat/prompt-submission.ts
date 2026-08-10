import type { MediaModality } from "@fitz/protocol";
import type { ComposerSubmission, PastedAttachment } from "./composer.js";
import type { MediaCreationParams } from "./media-creation-form.js";

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
  /** Submits a media job straight to the media-job pipeline, bypassing the LLM entirely. */
  submitMedia: (request: {
    routeId: string;
    modality: MediaModality;
    prompt: string;
    sessionId: string;
    size?: string;
    seed?: number;
    negativePrompt?: string;
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

  constructor(options: PromptSubmissionOptions) { this.#options = options; }

  async submit(submitted?: string | ComposerSubmission, existingUserMessage?: HTMLElement): Promise<void> {
    const draft = typeof submitted === "string" ? { content: submitted } : (submitted ?? this.#options.draft());
    const content = draft.content.trim();
    const mediaCommand = draft.mediaCommand;
    const attachments = this.#options.consumeAttachments();
    // A media command with no prompt text is still a valid submission: media
    // commands generate with a default prompt instead of being silently dropped.
    if (!content && attachments.length === 0 && !mediaCommand) return;
    const settings = this.#options.settings();
    let sessionId = this.#options.sessionId();
    if (!sessionId) {
      try { sessionId = await this.#options.ensureSession(titleFrom(content), settings.routeId); }
      catch (error) { this.#options.showError(this.#options.errorMessage(error)); return; }
    }
    if (!sessionId) { this.#options.openNewChat(); return; }
    if (!settings.routeId) { this.#options.showError("No model route is available"); return; }

    this.#options.resetWarmup();
    // Media generation only consumes pasted reference images (and audio takes
    // no references); regular messages upload every attachment for the agent.
    const uploadable = mediaCommand
      ? mediaCommand === "audio" ? [] : attachments.filter((attachment) => attachment.kind === "image")
      : attachments;
    const uploaded: Array<{ artifact: { id: string }; attachment: PastedAttachment }> = [];
    for (const attachment of uploadable) {
      try {
        const artifact = await this.#options.uploadAttachment(sessionId, attachment);
        uploaded.push({ artifact, attachment });
      } catch (error) { this.#options.showError(this.#options.errorMessage(error)); }
    }

    // Media commands skip the LLM entirely: the command is sent as a normal
    // chat message and an inline media creation card opens below it where the
    // user reviews the prompt and parameters. Confirming submits the job
    // straight to the media pipeline so no model can refuse a tool call.
    if (mediaCommand) {
      const refs = uploaded
        .filter(({ attachment }) => attachment.kind === "image")
        .map(({ artifact }) => ({ artifactId: artifact.id }));
      this.#options.clearDraft();
      this.#options.clearLanding();
      const displayContent = `/${mediaCommand}${content ? ` ${content}` : ""}`;
      if (!existingUserMessage) this.#options.appendUser(displayContent);
      if (displayContent && !existingUserMessage) this.#options.pushHistory(displayContent);
      this.#options.addTokenEstimate(displayContent);
      this.#options.refreshContext();
      this.#options.showMediaCreation({
        modality: mediaCommand,
        prompt: content || DEFAULT_MEDIA_PROMPTS[mediaCommand],
        refs,
        submit: async (params) => {
          try {
            const job = await this.#options.submitMedia({
              routeId: mediaCommand,
              modality: mediaCommand,
              prompt: params.prompt,
              sessionId,
              ...(params.size ? { size: params.size } : {}),
              ...(params.seed !== undefined ? { seed: params.seed } : {}),
              ...(params.negativePrompt ? { negativePrompt: params.negativePrompt } : {}),
              ...(params.durationSeconds !== undefined ? { durationSeconds: params.durationSeconds } : {}),
              ...(params.fps !== undefined ? { fps: params.fps } : {}),
              ...(refs.length > 0 && mediaCommand !== "audio" ? { refs } : {}),
            });
            this.#options.onMediaJobSubmitted(job.id, mediaCommand);
          } catch (error) {
            this.#options.showError(this.#options.errorMessage(error));
            throw error;
          }
        },
      });
      return;
    }

    this.#options.clearDraft();
    this.#options.clearLanding();
    if (!existingUserMessage) this.#options.appendUser(content);
    if (content && !existingUserMessage) this.#options.pushHistory(content);
    this.#options.addTokenEstimate(content);
    this.#options.refreshContext();
    const imageParts: Array<{ type: "image_url"; image_url: { url: string } }> = uploaded
      .filter(({ attachment }) => attachment.kind === "image")
      .map(({ artifact }) => ({ type: "image_url", image_url: { url: `/api/v1/artifacts/${artifact.id}` } }));
    const messageContent: PromptMessageContent = imageParts.length > 0
      ? [{ type: "text", text: content }, ...imageParts]
      : content;
    await this.#options.startRun({
      model: settings.routeId,
      max_tokens: settings.maxTokens,
      temperature: settings.temperature,
      sessionId,
      accessMode: settings.accessMode,
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
