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

  constructor(element: HTMLElement, beforeAction: () => void) {
    this.#element = element;
    this.#beforeAction = beforeAction;
  }

  reset(): void { this.#element.replaceChildren(); }

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
    const anchorRect = anchor.getBoundingClientRect();
    this.#element.hidden = false;
    const bounds = this.#element.getBoundingClientRect();
    this.#element.style.left = `${Math.max(8, Math.min(anchorRect.right + gap, window.innerWidth - bounds.width - 8))}px`;
    this.#element.style.top = `${Math.max(8, Math.min(anchorRect.top, window.innerHeight - bounds.height - 8))}px`;
  }

  #icon(markup: string): SVGElement {
    const value = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    value.setAttribute("viewBox", "0 0 20 20");
    value.setAttribute("aria-hidden", "true");
    value.innerHTML = markup;
    return value;
  }
}
