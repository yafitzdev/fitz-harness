export interface ResizablePaneOptions {
  divider: HTMLElement;
  storageKey: string;
  defaultValue: number;
  minimum: number;
  maximum: number | (() => number);
  pointerValue: (event: PointerEvent) => number;
  keyboardDirection?: 1 | -1;
  apply: (value: number) => void;
  onChange?: () => void;
}

export class ResizablePane {
  readonly #options: ResizablePaneOptions;
  #value: number;

  constructor(options: ResizablePaneOptions) {
    this.#options = options;
    this.#value = options.defaultValue;
    options.divider.addEventListener("pointerdown", this.#beginPointerResize);
    options.divider.addEventListener("keydown", this.#resizeWithKeyboard);
    this.restore();
  }

  value(): number { return this.#value; }

  set(value: number, persist = false): void {
    const maximum = typeof this.#options.maximum === "function" ? this.#options.maximum() : this.#options.maximum;
    this.#value = Math.max(this.#options.minimum, Math.min(maximum, value));
    this.#options.apply(this.#value);
    this.#options.divider.setAttribute("aria-valuenow", String(Math.round(this.#value)));
    if (persist) localStorage.setItem(this.#options.storageKey, String(this.#value));
    this.#options.onChange?.();
  }

  restore(): void {
    const stored = Number(localStorage.getItem(this.#options.storageKey));
    this.set(Number.isFinite(stored) && stored > 0 ? stored : this.#options.defaultValue);
  }

  readonly #beginPointerResize = (event: PointerEvent): void => {
    event.preventDefault();
    const divider = this.#options.divider;
    divider.classList.add("dragging");
    divider.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => this.set(this.#options.pointerValue(moveEvent));
    const finish = () => {
      divider.classList.remove("dragging");
      divider.removeEventListener("pointermove", move);
      localStorage.setItem(this.#options.storageKey, String(this.#value));
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", finish, { once: true });
    divider.addEventListener("pointercancel", finish, { once: true });
  };

  readonly #resizeWithKeyboard = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = (this.#options.keyboardDirection ?? 1) * (event.key === "ArrowRight" ? 1 : -1);
    this.set(this.#value + direction * 12, true);
  };
}
