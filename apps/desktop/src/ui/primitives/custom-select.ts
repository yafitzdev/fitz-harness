export class CustomSelectController {
  readonly #popover: HTMLElement;
  readonly #beforeOpen: () => void;
  #active: HTMLSelectElement | undefined;

  constructor(popover: HTMLElement, beforeOpen: () => void) {
    this.#popover = popover;
    this.#beforeOpen = beforeOpen;
    document.querySelectorAll<HTMLSelectElement>("select").forEach(this.enhance);
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node instanceof HTMLSelectElement) this.enhance(node);
        node.querySelectorAll<HTMLSelectElement>("select").forEach(this.enhance);
      }
    }).observe(document.body, { childList: true, subtree: true });
    popover.addEventListener("click", (event) => event.stopPropagation());
    popover.addEventListener("keydown", this.#handleMenuKeydown);
  }

  readonly enhance = (select: HTMLSelectElement): void => {
    if (select.hidden || select.dataset.customMenu === "true") return;
    select.dataset.customMenu = "true";
    select.setAttribute("aria-haspopup", "listbox");
    select.setAttribute("aria-expanded", "false");
    select.addEventListener("pointerdown", (event) => {
      if (select.disabled || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); select.focus(); this.open(select);
    });
    select.addEventListener("click", (event) => { if (!select.disabled) { event.preventDefault(); event.stopPropagation(); } });
    select.addEventListener("keydown", (event) => {
      if (select.disabled || !["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); this.open(select, true);
    });
  };

  open(select: HTMLSelectElement, focusSelection = false): void {
    const reopening = this.#active === select && !this.#popover.hidden;
    this.#beforeOpen();
    if (reopening) return;
    this.#active = select;
    select.setAttribute("aria-expanded", "true");
    this.#popover.replaceChildren();
    let currentGroup = "";
    let selectedButton: HTMLButtonElement | undefined;
    for (const option of [...select.options]) {
      const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : "";
      if (group && group !== currentGroup) {
        const heading = document.createElement("small"); heading.className = "select-group-label"; heading.textContent = group; this.#popover.append(heading); currentGroup = group;
      }
      const button = document.createElement("button"); button.type = "button"; button.className = "select-option"; button.disabled = option.disabled; button.dataset.value = option.value; button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(option.selected)); button.classList.toggle("selected", option.selected); button.textContent = option.textContent ?? option.value;
      if (option.selected) selectedButton = button;
      button.addEventListener("click", (event) => { event.stopPropagation(); select.value = option.value; select.dispatchEvent(new Event("change", { bubbles: true })); this.close(); select.focus(); });
      this.#popover.append(button);
    }
    const rect = select.getBoundingClientRect();
    const width = Math.max(150, rect.width);
    this.#popover.style.width = `${width}px`;
    this.#popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    this.#popover.style.top = `${rect.bottom + 5}px`;
    this.#popover.hidden = false;
    const menuRect = this.#popover.getBoundingClientRect();
    if (menuRect.bottom > window.innerHeight - 8 && rect.top > menuRect.height + 12) this.#popover.style.top = `${Math.max(8, rect.top - menuRect.height - 5)}px`;
    if (focusSelection) queueMicrotask(() => (selectedButton ?? this.#popover.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus());
  }

  close(): void {
    this.#active?.setAttribute("aria-expanded", "false");
    this.#active = undefined;
    this.#popover.hidden = true;
  }

  readonly #handleMenuKeydown = (event: KeyboardEvent): void => {
    const choices = [...this.#popover.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const current = choices.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") { event.preventDefault(); this.#active?.focus(); this.close(); return; }
    const next = event.key === "ArrowDown" ? Math.min(current + 1, choices.length - 1) : event.key === "ArrowUp" ? Math.max(current - 1, 0) : event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); choices[next]?.focus(); }
  };
}
