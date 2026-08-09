import { svgIcon } from "../primitives/dom.js";

export interface ConversationLandingOptions {
  messages: HTMLElement;
  clearActivity: () => void;
  project: () => { id?: string; name?: string } | undefined;
  projectDetached: () => boolean;
  setDraft: (value: string) => void;
  focusComposer: () => void;
  createProject: () => void;
  retryConnection: () => void | Promise<void>;
  updateTitles: () => void;
}

const suggestions = [
  ["Explore and understand code", '<path d="m4.2 7.4 8.7-4.1 2 4.1-8.8 4.2z"></path><path d="m11.1 4.2 2 4.1M8 10.7l2.5 5.8M6.2 11.6l-1.7 4.1M7.2 14h4.5"></path>'],
  ["Build a new feature, app, or tool", '<path d="m12.8 3.2 4 4-2.5 2.5-4-4z"></path><path d="m11.4 8.6-6.8 6.8M3.6 16.4l2.6-.7-1.9-1.9z"></path>'],
  ["Review code and suggest changes", '<path d="M15.7 7.2A6 6 0 0 0 5 5.4L3.6 7"></path><path d="M3.6 3.8V7h3.2M4.3 12.8A6 6 0 0 0 15 14.6l1.4-1.6"></path><path d="M16.4 16.2V13h-3.2"></path>'],
  ["Fix issues and failures", '<path d="M7 7.2 5.2 4.5M13 7.2l1.8-2.7M6.1 9.1h7.8v6.2H6.1z"></path><path d="M3.5 10.5h2.6M13.9 10.5h2.6M3.8 14.7l2.3-1M16.2 14.7l-2.3-1M8.2 6V4.8h3.6V6M10 9.1v6.2"></path>'],
] as const;

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
    const project = this.#options.project();
    const landing = document.createElement("div");
    landing.className = "new-chat-landing";
    const mark = document.createElement("div");
    mark.className = "landing-mark";
    mark.append(terminalCloudIcon());
    const heading = document.createElement("h1");
    if (this.#options.projectDetached() || !project?.id) heading.textContent = "What should we build?";
    else {
      heading.append("What should we build in ");
      const projectName = document.createElement("span");
      projectName.className = "landing-project-name";
      projectName.textContent = project.name ?? "this project";
      heading.append(projectName, "?");
    }
    const grid = document.createElement("div");
    grid.className = "starter-grid";
    for (const [label, icon] of suggestions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "starter-card";
      const text = document.createElement("span");
      text.textContent = label;
      button.append(svgIcon(icon), text);
      button.addEventListener("click", () => {
        this.#options.setDraft(label);
        this.#options.focusComposer();
      });
      grid.append(button);
    }
    landing.append(mark, heading, grid);
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

function terminalCloudIcon(): SVGElement {
  return svgIcon('<path d="M6.2 16.4c-2 0-3.7-1.6-3.7-3.6 0-1.2.6-2.3 1.5-3-.4-1.8.5-3.6 2.1-4.4.7-1.7 2.4-2.8 4.2-2.8 1.5 0 2.9.7 3.8 1.9 1.8-.1 3.3 1.3 3.4 3.1 1 .7 1.7 1.9 1.7 3.2 0 1.5-.8 2.8-2.1 3.5-.5 1.8-2.1 3-4 3-.8 0-1.6-.2-2.2-.7-.7.6-1.6.9-2.5.9-.8 0-1.6-.3-2.2-.7z"></path><path d="m6.8 8 1.8 2-1.8 2M10.7 12.3h2.7"></path>');
}
