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
    const mark = document.createElement("div");
    mark.className = "new-chat-ripple";
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", "JEON lab");
    mark.append(rippleLogo());
    landing.append(mark);
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

function rippleLogo(): SVGElement {
  return svgIcon(`
    <defs><clipPath id="jeon-new-chat-ripple-clip"><circle class="ripple-clip-shape" cx="24" cy="24" r="19"></circle></clipPath></defs>
    <g clip-path="url(#jeon-new-chat-ripple-clip)">
      <path d="M-12 7C-6 1 0 1 6 7S18 13 24 7S36 1 42 7S54 13 60 7"></path>
      <path d="M-12 12C-6 6 0 6 6 12S18 18 24 12S36 6 42 12S54 18 60 12"></path>
      <path d="M-12 17C-6 11 0 11 6 17S18 23 24 17S36 11 42 17S54 23 60 17"></path>
      <path d="M-12 22C-6 16 0 16 6 22S18 28 24 22S36 16 42 22S54 28 60 22"></path>
      <path d="M-12 27C-6 21 0 21 6 27S18 33 24 27S36 21 42 27S54 33 60 27"></path>
      <path d="M-12 32C-6 26 0 26 6 32S18 38 24 32S36 26 42 32S54 38 60 32"></path>
      <path d="M-12 37C-6 31 0 31 6 37S18 43 24 37S36 31 42 37S54 43 60 37"></path>
      <path d="M-12 42C-6 36 0 36 6 42S18 48 24 42S36 36 42 42S54 48 60 42"></path>
    </g>
  `, "0 0 48 48");
}
