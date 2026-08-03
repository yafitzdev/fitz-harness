export type ActionableMessageRole = "user" | "assistant";

export interface MessageActionsOptions {
  canEdit: () => boolean;
  onEditBlocked: () => void;
  copyText: (text: string) => void | Promise<void>;
  resend: (text: string, article: HTMLElement) => void | Promise<void>;
}

/** Owns message metadata, copy actions, and in-bubble user-message editing. */
export class MessageActions {
  readonly #options: MessageActionsOptions;

  constructor(options: MessageActionsOptions) {
    this.#options = options;
  }

  attach(article: HTMLElement, content: HTMLElement, role: ActionableMessageRole, originalText: string, createdAt?: string): void {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const time = document.createElement("time");
    time.className = "message-time";
    time.dateTime = createdAt ?? new Date().toISOString();
    time.textContent = this.#formatTimestamp(createdAt);
    actions.append(time, this.#copyButton(content));
    if (role === "user") actions.append(this.#actionButton("Edit message", this.#editIcon(), () => this.#startEdit(article, content, actions, originalText)));
    article.append(actions);
  }

  #startEdit(article: HTMLElement, content: HTMLElement, actions: HTMLElement, originalText: string): void {
    if (!this.#options.canEdit()) { this.#options.onEditBlocked(); return; }
    const bubble = document.createElement("div");
    bubble.className = "message-edit-bubble";
    const editor = document.createElement("textarea");
    editor.className = "message-inline-editor";
    editor.value = originalText;
    editor.setAttribute("aria-label", "Edit message");
    const controls = document.createElement("div");
    controls.className = "message-edit-controls";
    const cancel = this.#textButton("Cancel", "message-edit-cancel");
    const send = this.#textButton("Send", "message-edit-send");
    const restore = () => { bubble.replaceWith(content); actions.hidden = false; article.classList.remove("editing"); };
    const submit = () => {
      const revised = editor.value.trim();
      if (!revised) { editor.focus(); return; }
      content.textContent = revised;
      restore();
      void this.#options.resend(revised, article);
    };
    cancel.addEventListener("click", restore);
    send.addEventListener("click", submit);
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); restore(); }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
    });
    controls.append(cancel, send);
    bubble.append(editor, controls);
    actions.hidden = true;
    article.classList.add("editing");
    content.replaceWith(bubble);
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  #actionButton(label: string, icon: SVGElement, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-action";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(icon);
    button.addEventListener("click", action);
    return button;
  }

  #copyButton(content: HTMLElement): HTMLButtonElement {
    const button = this.#actionButton("Copy message", this.#copyIcon(), () => {
      void Promise.resolve(this.#options.copyText(content.innerText)).then(() => {
        button.replaceChildren(this.#checkIcon());
        button.classList.add("copied");
        button.title = "Copied";
        button.setAttribute("aria-label", "Copied");
        window.setTimeout(() => {
          button.replaceChildren(this.#copyIcon());
          button.classList.remove("copied");
          button.title = "Copy message";
          button.setAttribute("aria-label", "Copy message");
        }, 1_200);
      });
    });
    return button;
  }

  #textButton(label: string, className: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    return button;
  }

  #formatTimestamp(value?: string): string {
    const date = value ? new Date(value) : new Date();
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
    const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
    return `${weekday} ${time}`;
  }

  #icon(markup: string): SVGElement {
    const value = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    value.setAttribute("viewBox", "0 0 20 20");
    value.setAttribute("aria-hidden", "true");
    value.innerHTML = markup;
    return value;
  }

  #copyIcon(): SVGElement { return this.#icon('<rect x="7" y="7" width="9" height="9" rx="1.6"></rect><path d="M5.8 13.4H5A2 2 0 0 1 3 11.4V5a2 2 0 0 1 2-2h6.4a2 2 0 0 1 2 2v.8"></path>'); }
  #checkIcon(): SVGElement { return this.#icon('<path d="m4.2 10.1 3.25 3.25 8.35-8.35"></path>'); }
  #editIcon(): SVGElement { return this.#icon('<path d="m4.2 14.8.7-3.2 7.8-7.8a1.45 1.45 0 0 1 2.05 2.05L7 13.65z"></path><path d="m11.7 4.8 2.05 2.05"></path>'); }
}
