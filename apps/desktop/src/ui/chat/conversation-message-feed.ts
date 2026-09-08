import { setMarkdown } from "../../markdown.js";
import type { ActionableMessageRole } from "./message-actions.js";
import { projectRelativePath } from "./tool-activity.js";
import { scrollToLatestIfFollowing } from "./conversation-scroll.js";
import type { ChatContentDocument } from "@fitz/protocol";

export interface ConversationMessageActivity {
  finishWork(createdAt?: string, boundary?: "completed" | "next-message"): void;
  appendCommentary(node: HTMLElement, createdAt?: string): void;
}

export interface ConversationMessageActions {
  attach(article: HTMLElement, content: HTMLElement, role: ActionableMessageRole, text: string, createdAt?: string): void;
}

export interface ConversationMessageFeedOptions {
  messages: HTMLElement;
  activity: ConversationMessageActivity;
  actions: ConversationMessageActions;
  runActive: () => boolean;
  projectRoot: () => string;
  openAttachment?: (attachment: MessageAttachment) => void;
  loadAttachmentPreview?: (attachment: MessageAttachment) => Promise<string | undefined>;
}

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: string;
  byteSize?: number;
  dataUrl?: string;
}

export interface TranscriptMessageMetadata {
  id?: string;
  sequence?: number;
  document?: ChatContentDocument;
}

/** Owns durable user/assistant/commentary messages and file-change summaries. */
export class ConversationMessageFeed {
  readonly #options: ConversationMessageFeedOptions;

  constructor(options: ConversationMessageFeedOptions) { this.#options = options; }

  append(role: string, text: string, createdAt?: string, attachments: readonly MessageAttachment[] = [], metadata?: TranscriptMessageMetadata): HTMLElement {
    return this.#append(role, text, createdAt, true, attachments, metadata);
  }

  /** Appends a peer message without treating it as an agent-run boundary.
   * Durable asynchronous results use this after their originating run has
   * already closed (or while a restored transcript is still being rebuilt). */
  appendDetached(role: string, text: string, createdAt?: string, metadata?: TranscriptMessageMetadata): HTMLElement {
    return this.#append(role, text, createdAt, false, [], metadata);
  }

  #append(role: string, text: string, createdAt: string | undefined, closesWork: boolean, attachments: readonly MessageAttachment[], metadata?: TranscriptMessageMetadata): HTMLElement {
    this.clearLanding();
    if (closesWork && role !== "commentary" && !this.#options.runActive()) {
      this.#options.activity.finishWork(createdAt, role === "user" ? "next-message" : "completed");
    }
    const article = document.createElement("article");
    article.className = `message ${role}`;
    if (metadata?.id) article.dataset.transcriptId = metadata.id;
    if (metadata?.sequence !== undefined && Number.isFinite(metadata.sequence)) article.dataset.transcriptSequence = String(metadata.sequence);
    if (role === "system") {
      article.setAttribute("role", "alert");
      article.setAttribute("aria-live", "polite");
    }
    const content = document.createElement("div");
    content.className = "message-body";
    if (role === "assistant" || role === "commentary") setMarkdown(content, text, metadata?.document);
    else content.textContent = text;
    if (role === "user" && attachments.length) article.append(this.#attachmentStrip(attachments));
    if (!text) content.hidden = true;
    article.append(content);
    if (role === "user" || role === "assistant") this.#options.actions.attach(article, content, role, text, createdAt);
    this.#options.messages.append(article);
    this.#scroll();
    return content;
  }

  #attachmentStrip(attachments: readonly MessageAttachment[]): HTMLElement {
    const strip = document.createElement("div");
    strip.className = "message-attachments";
    for (const attachment of attachments) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `message-attachment${attachment.kind === "image" || attachment.mimeType.startsWith("image/") ? " image" : " file"}`;
      button.setAttribute("aria-label", `Open attachment ${attachment.name}`);
      button.addEventListener("click", () => this.#options.openAttachment?.(attachment));
      if (attachment.kind === "image" || attachment.mimeType.startsWith("image/")) {
        const image = document.createElement("img");
        image.alt = attachment.name;
        if (attachment.dataUrl) image.src = attachment.dataUrl;
        else void this.#options.loadAttachmentPreview?.(attachment).then((url) => { if (url) image.src = url; });
        button.append(image);
      } else {
        const icon = document.createElement("span");
        icon.className = "message-attachment-icon";
        icon.textContent = attachment.kind === "pdf" ? "PDF" : "FILE";
        button.append(icon);
      }
      const label = document.createElement("span");
      label.className = "message-attachment-name";
      label.textContent = attachment.name;
      button.append(label);
      strip.append(button);
    }
    return strip;
  }

  appendCommentary(text: string, createdAt?: string): HTMLElement {
    this.clearLanding();
    const article = document.createElement("article");
    article.className = "message commentary";
    const content = document.createElement("div");
    content.className = "message-body";
    setMarkdown(content, text);
    article.append(content);
    this.#options.activity.appendCommentary(article, createdAt);
    return content;
  }

  appendChangeSummary(files: Array<{ path: string; action: "edited" | "created" }>): void {
    this.clearLanding();
    const article = document.createElement("article");
    article.className = "message change-summary";
    const content = document.createElement("div");
    content.className = "message-body change-summary-body";
    const created = files.filter((file) => file.action === "created").length;
    const edited = files.filter((file) => file.action === "edited").length;
    const parts = [...(created ? [`${created} created`] : []), ...(edited ? [`${edited} edited`] : [])];
    const header = document.createElement("div");
    header.className = "change-summary-header";
    header.textContent = `${files.length} file${files.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
    content.append(header);
    const list = document.createElement("div");
    list.className = "change-summary-list";
    for (const file of files) {
      const row = document.createElement("div");
      row.className = `change-summary-row ${file.action}`;
      const icon = document.createElement("span");
      icon.className = "change-summary-icon";
      icon.textContent = file.action === "created" ? "+" : "~";
      const path = document.createElement("span");
      path.className = "change-summary-path";
      path.textContent = projectRelativePath(file.path, this.#options.projectRoot());
      row.append(icon, path);
      list.append(row);
    }
    content.append(list);
    article.append(content);
    this.#options.messages.append(article);
    this.#scroll();
  }

  clearLanding(): void {
    if (this.#options.messages.querySelector(".landing, .new-chat-landing")) this.#options.messages.replaceChildren();
  }

  #scroll(): void { scrollToLatestIfFollowing(this.#options.messages); }
}
