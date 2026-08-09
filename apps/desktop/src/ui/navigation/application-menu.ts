import { svgIcon } from "../primitives/dom.js";
import type { ActionFeedback } from "../primitives/action-status.js";

type EditCommand = "undo" | "redo" | "cut" | "copy" | "paste" | "select-all" | "reload" | "devtools";

export interface ApplicationMenuOptions {
  popover: HTMLElement;
  toggles: HTMLButtonElement[];
  newChat: () => void;
  newProject: () => void;
  toggleSidebar: () => void;
  editCommand: (command: EditCommand) => void | Promise<void>;
  windowAction: (action: "close") => void | Promise<void>;
  openExternal: (url: string) => void | Promise<void>;
  showStatus: ActionFeedback;
  errorMessage: (error: unknown) => string;
  closeOthers: () => void;
}

/** Owns native-style File/Edit/View/Help menu content and positioning. */
export class ApplicationMenuController {
  readonly #options: ApplicationMenuOptions;

  constructor(options: ApplicationMenuOptions) {
    this.#options = options;
    for (const toggle of options.toggles) {
      toggle.addEventListener("click", (event) => this.open(toggle.dataset.appMenu ?? "", toggle, event));
    }
  }

  open(name: string, toggle: HTMLButtonElement, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const reopening = this.#options.popover.dataset.menu === name && !this.#options.popover.hidden;
    this.close();
    if (reopening) return;
    const popover = this.#options.popover;
    popover.dataset.menu = name;
    popover.replaceChildren();
    this.#render(name);
    const rect = toggle.getBoundingClientRect();
    popover.style.left = `${rect.left}px`;
    popover.style.top = `${rect.bottom + 3}px`;
    popover.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
  }

  close(): void {
    this.#options.closeOthers();
    this.#options.popover.hidden = true;
    for (const toggle of this.#options.toggles) toggle.setAttribute("aria-expanded", "false");
  }

  #render(name: string): void {
    const edit = (command: EditCommand) => () => this.#options.editCommand(command);
    if (name === "File") {
      this.#item("New chat", '<path d="M4 4h12v12H4z"></path><path d="M7 10h6M10 7v6"></path>', this.#options.newChat, "Ctrl+N");
      this.#item("New project", '<path d="M3 6h5l1.5 2H17v8H3z"></path><path d="M3 6V4h5l1.5 2"></path>', this.#options.newProject);
      this.#separator();
      this.#item("Close window", '<path d="m5 5 10 10M15 5 5 15"></path>', () => this.#options.windowAction("close"));
    } else if (name === "Edit") {
      this.#item("Undo", '<path d="M7 7H3V3"></path><path d="M3 7c2-3 5-4 8-3 3 1 5 4 5 7"></path>', edit("undo"), "Ctrl+Z");
      this.#item("Redo", '<path d="M13 7h4V3"></path><path d="M17 7c-2-3-5-4-8-3-3 1-5 4-5 7"></path>', edit("redo"), "Ctrl+Y");
      this.#separator();
      this.#item("Cut", '<circle cx="6" cy="15" r="2"></circle><circle cx="14" cy="15" r="2"></circle><path d="m7.5 13.5 7-9M12.5 13.5l-7-9"></path>', edit("cut"), "Ctrl+X");
      this.#item("Copy", '<rect x="7" y="7" width="10" height="10" rx="2"></rect><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"></path>', edit("copy"), "Ctrl+C");
      this.#item("Paste", '<rect x="5" y="5" width="10" height="12" rx="2"></rect><path d="M8 5V3h4v2"></path>', edit("paste"), "Ctrl+V");
      this.#item("Select all", '<path d="M7 3H3v4M13 3h4v4M17 13v4h-4M7 17H3v-4"></path>', edit("select-all"), "Ctrl+A");
    } else if (name === "View") {
      this.#item("Toggle sidebar", '<rect x="3" y="4" width="14" height="12" rx="2"></rect><path d="M7 4v12"></path>', this.#options.toggleSidebar, "Ctrl+B");
      this.#item("Reload", '<path d="M16 7V3l-2 2a6 6 0 1 0 1 8"></path>', edit("reload"), "Ctrl+R");
      this.#item("Developer tools", '<path d="m7 6-4 4 4 4M13 6l4 4-4 4M11 4 9 16"></path>', edit("devtools"));
    } else if (name === "Help") {
      this.#item("Fitz Codex on GitHub", '<circle cx="10" cy="10" r="7"></circle><path d="M8 8a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.5M10 14h.01"></path>', () => this.#options.openExternal("https://github.com/yafitzdev/fitz-codex"));
    }
  }

  #item(label: string, icon: string, action: () => void | Promise<void>, shortcut = ""): void {
    const button = document.createElement("button");
    button.type = "button";
    const text = document.createElement("span");
    text.className = "menu-label";
    text.textContent = label;
    button.append(svgIcon(icon), text);
    if (shortcut) {
      const key = document.createElement("kbd");
      key.textContent = shortcut;
      button.append(key);
    }
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.close();
      try {
        void Promise.resolve(action()).catch((error) => this.#options.showStatus(this.#options.errorMessage(error), "error"));
      } catch (error) {
        this.#options.showStatus(this.#options.errorMessage(error), "error");
      }
    });
    this.#options.popover.append(button);
  }

  #separator(): void { this.#options.popover.append(document.createElement("hr")); }
}
