import type { OverlayHost } from "./overlay-host.js";

export interface ContextMenuItem {
  label: string;
  action: () => void;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
}

/** Builds, positions, and activates a standard Fitz context menu. */
export class ContextMenu {
  readonly #element: HTMLElement;
  readonly #beforeAction: () => void;

  constructor(element: HTMLElement, private readonly overlayHost: OverlayHost, beforeAction: () => void, onClose?: () => void) {
    this.#element = element;
    this.#beforeAction = beforeAction;
    overlayHost.register(element, onClose);
  }

  reset(): void { this.#element.replaceChildren(); }
  close(): void { this.overlayHost.close(this.#element); }

  add(item: ContextMenuItem): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.toggle("danger", Boolean(item.danger));
    button.disabled = Boolean(item.disabled);
    if (item.icon) button.append(this.#icon(item.icon));
    const label = document.createElement("span");
    label.className = "menu-label";
    label.textContent = item.label;
    button.append(label);
    button.addEventListener("click", () => { this.#beforeAction(); item.action(); });
    this.#element.append(button);
    return button;
  }

  separator(): void { this.#element.append(document.createElement("hr")); }

  openBeside(anchor: HTMLElement, gap = 4): void {
    this.overlayHost.open(this.#element, { anchor, placement: "beside-end", gap });
  }

  #icon(markup: string): SVGElement {
    const value = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    value.setAttribute("viewBox", "0 0 20 20");
    value.setAttribute("aria-hidden", "true");
    value.innerHTML = markup;
    return value;
  }
}
