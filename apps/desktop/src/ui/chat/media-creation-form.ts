import type { MediaModality } from "@fitz/protocol";
import { validateMediaGenerationParams } from "@fitz/media";
import { scrollToLatestIfFollowing } from "./conversation-scroll.js";
import { createMediaCard } from "./media-card.js";

/** Parameters collected from the media creation form, keyed like MediaGenerationParams. */
export interface MediaCreationParams {
  prompt: string;
  size?: string;
  seed?: number;
  negativePrompt?: string;
  durationSeconds?: number;
  fps?: number;
}

export interface MediaCreationRequest {
  modality: MediaModality;
  prompt: string;
  refs: Array<{ artifactId: string }>;
  /** Invoked when the user confirms; the card is dismissed on resolve and stays on reject. */
  onCreate: (params: MediaCreationParams) => Promise<void>;
}

export interface MediaCreationFormOptions {
  messages: HTMLElement;
}

const MODALITY_LABELS: Record<MediaModality, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
};

interface FieldOptions {
  multiline?: boolean;
  required?: boolean;
  type?: string;
  suffix?: string;
  min?: string;
  step?: string;
  placeholder?: string;
}

/**
 * Pre-submission media creation UI embedded in the chat: a card where the user
 * reviews and edits the prompt and the generation parameters before the media
 * job is actually created. Media commands render this card instead of going
 * through the LLM.
 */
export class MediaCreationForm {
  readonly #options: MediaCreationFormOptions;
  #card: HTMLElement | undefined;
  #onCreate: ((params: MediaCreationParams) => Promise<void>) | undefined;

  constructor(options: MediaCreationFormOptions) { this.#options = options; }

  show(request: MediaCreationRequest): void {
    this.dismiss();
    this.#onCreate = request.onCreate;
    const label = MODALITY_LABELS[request.modality];

    const card = createMediaCard("media-creation-card");
    const title = document.createElement("h2");
    title.textContent = `Create ${label.toLowerCase()}`;

    const form = document.createElement("form");
    form.className = "media-creation-form";
    const promptField = this.#field("Prompt", "prompt", request.prompt, { multiline: true, required: true });
    const promptControl = promptField.querySelector<HTMLTextAreaElement>("textarea")!;
    form.append(promptField);

    const parameters = document.createElement("div");
    parameters.className = "media-approval-parameters";
    if (request.modality === "image") {
      parameters.append(
        this.#field("Size", "size", undefined, { placeholder: "Route default" }),
        this.#field("Seed", "seed", undefined, { type: "number", placeholder: "Random" }),
      );
      form.append(parameters, this.#field("Negative prompt", "negativePrompt", undefined, { multiline: true, placeholder: "Optional" }));
    } else if (request.modality === "video") {
      parameters.append(
        this.#field("Duration", "durationSeconds", undefined, { type: "number", suffix: "seconds", min: "0.1", step: "0.1", placeholder: "Route default" }),
        this.#field("Resolution", "size", undefined, { placeholder: "Route default" }),
        this.#field("Frame rate", "fps", undefined, { type: "number", suffix: "fps", min: "1", step: "1", placeholder: "Route default" }),
      );
      form.append(parameters);
    } else {
      parameters.append(this.#field("Duration", "durationSeconds", undefined, { type: "number", suffix: "seconds", min: "0.1", step: "0.1", placeholder: "Route default" }));
      form.append(parameters);
    }

    if (request.refs.length > 0) {
      const references = document.createElement("p");
      references.className = "media-approval-references";
      references.textContent = `${request.refs.length} reference${request.refs.length === 1 ? "" : "s"} attached`;
      form.append(references);
    }

    const actions = document.createElement("footer");
    actions.className = "media-creation-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "media-creation-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.#cancel());
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "media-creation-submit";
    submit.textContent = `Create ${label.toLowerCase()}`;
    actions.append(cancel, submit);
    form.append(actions);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#create(form);
    });
    promptControl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.#create(form);
      }
    });

    card.append(title, form);
    this.#options.messages.append(card);
    this.#card = card;
    scrollToLatestIfFollowing(this.#options.messages);
    promptControl.focus();
  }

  dismiss(): void {
    this.#card?.remove();
    this.#card = undefined;
    this.#onCreate = undefined;
  }

  async #create(form: HTMLFormElement): Promise<void> {
    const onCreate = this.#onCreate;
    if (!onCreate) return;
    const params = this.#readParams(form);
    if (!params.prompt) return;
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) control.setCustomValidity("");
    try { validateMediaGenerationParams(params); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fieldName = message.split(" ", 1)[0];
      const control = fieldName ? form.querySelector<HTMLInputElement>(`[data-creation-field='${fieldName}']`) : undefined;
      control?.setCustomValidity(message);
      control?.reportValidity();
      return;
    }
    const buttons = [...form.querySelectorAll<HTMLButtonElement>("button")];
    for (const button of buttons) button.disabled = true;
    try {
      await onCreate(params);
      this.dismiss();
    } catch {
      for (const button of buttons) button.disabled = false;
    }
  }

  #cancel(): void {
    this.dismiss();
  }

  #readParams(form: HTMLFormElement): MediaCreationParams {
    const params: MediaCreationParams = { prompt: "" };
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-creation-field]")) {
      const name = control.dataset.creationField!;
      const value = control.value.trim();
      if (!value) continue;
      if (name === "prompt") { params.prompt = value; continue; }
      if (control instanceof HTMLInputElement && control.type === "number") {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) (params as unknown as Record<string, unknown>)[name] = numeric;
      } else {
        (params as unknown as Record<string, unknown>)[name] = value;
      }
    }
    return params;
  }

  #field(labelText: string, name: string, value: string | undefined, options: FieldOptions = {}): HTMLLabelElement {
    const label = document.createElement("label");
    label.className = `media-approval-field${options.multiline ? " media-prompt-field" : ""}`;
    const title = document.createElement("span");
    title.textContent = labelText;
    const control = options.multiline ? document.createElement("textarea") : document.createElement("input");
    control.dataset.creationField = name;
    if (control instanceof HTMLInputElement) control.type = options.type ?? "text";
    control.value = value ?? "";
    control.required = Boolean(options.required);
    if (options.placeholder) control.placeholder = options.placeholder;
    if (control instanceof HTMLInputElement) {
      if (options.min) control.min = options.min;
      if (options.step) control.step = options.step;
    }
    const shell = document.createElement("span");
    shell.className = "media-approval-control";
    shell.append(control);
    if (options.suffix) shell.append(Object.assign(document.createElement("span"), { className: "media-approval-suffix", textContent: options.suffix }));
    label.append(title, shell);
    return label;
  }
}
