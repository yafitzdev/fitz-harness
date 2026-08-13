import { svgIcon } from "../primitives/dom.js";

export interface ConversationLandingOptions {
  messages: HTMLElement;
  clearActivity: () => void;
  createProject: () => void;
  retryConnection: () => void | Promise<void>;
  updateTitles: () => void;
}

/** Owns the empty, new-chat, and disconnected conversation states. */
export class ConversationLanding {
  readonly #options: ConversationLandingOptions;

  constructor(options: ConversationLandingOptions) { this.#options = options; }

  showHome(hasTask = false): void {
    this.#reset(true);
    const landing = document.createElement("div");
    landing.className = "landing";
    const mark = document.createElement("div");
    mark.className = "landing-mark";
    mark.append(sparkIcon());
    const heading = document.createElement("h1");
    heading.textContent = hasTask ? "What should we work on?" : "Bring your code. Build with Fitz.";
    const detail = document.createElement("p");
    detail.textContent = hasTask
      ? "Describe a change, ask a question, or attach a file. Fitz keeps the work and transcript together."
      : "Create a project, start a task, and work with local or remote inference from one focused desktop.";
    landing.append(mark, heading, detail);
    if (!hasTask) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "primary-button";
      action.textContent = "Create project";
      action.addEventListener("click", this.#options.createProject);
      landing.append(action);
    }
    this.#options.messages.append(landing);
    this.#options.updateTitles();
  }

  showNewChat(): void {
    this.#reset(true);
    const landing = document.createElement("div");
    landing.className = "new-chat-landing";
    this.#options.messages.append(landing);
    this.#options.updateTitles();
  }

  showConnectionFailure(detail: string): void {
    this.#reset(false);
    const landing = document.createElement("div");
    landing.className = "landing";
    const heading = document.createElement("h1");
    heading.textContent = "Fitz host is offline";
    const message = document.createElement("p");
    message.textContent = detail;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "primary-button";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => void this.#options.retryConnection());
    landing.append(heading, message, retry);
    this.#options.messages.append(landing);
  }

  #reset(clearActivity: boolean): void {
    this.#options.messages.replaceChildren();
    if (clearActivity) this.#options.clearActivity();
  }
}

function sparkIcon(): SVGElement {
  return svgIcon('<path d="M10 2.8c.5 3.7 2.4 5.8 6.2 7.2-3.8 1.4-5.7 3.5-6.2 7.2-.5-3.7-2.4-5.8-6.2-7.2C7.6 8.6 9.5 6.5 10 2.8Z"></path>');
}
