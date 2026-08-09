import { setMarkdown } from "../../markdown.js";
import type { ActionableMessageRole } from "./message-actions.js";
import { projectRelativePath } from "./tool-activity.js";

export interface ConversationMessageActivity {
  finishWork(createdAt?: string): void;
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
}

/** Owns durable user/assistant/commentary messages and file-change summaries. */
export class ConversationMessageFeed {
  readonly #options: ConversationMessageFeedOptions;

  constructor(options: ConversationMessageFeedOptions) { this.#options = options; }

  append(role: string, text: string, createdAt?: string): HTMLElement {
    this.clearLanding();
    if (role !== "commentary" && !this.#options.runActive()) this.#options.activity.finishWork(createdAt);
    const article = document.createElement("article");
    article.className = `message ${role}`;
    const content = document.createElement("div");
    content.className = "message-body";
    if (role === "assistant" || role === "commentary") setMarkdown(content, text);
    else content.textContent = text;
    article.append(content);
    if (role === "user" || role === "assistant") this.#options.actions.attach(article, content, role, text, createdAt);
    this.#options.messages.append(article);
    this.#scroll();
    return content;
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

  #scroll(): void { this.#options.messages.scrollTop = this.#options.messages.scrollHeight; }
}
