export type OverlayPlacement = "above-start" | "above-center" | "above-end" | "auto-start" | "auto-end" | "beside-end";

export interface OverlayOpenOptions {
  anchor: HTMLElement;
  placement: OverlayPlacement;
  gap?: number;
}

interface OverlayRegistration {
  onClose?: () => void;
  open?: OverlayOpenOptions;
}

/** Owns document-level popovers as one mutually exclusive stacking context. */
export class OverlayHost {
  readonly root: HTMLElement;
  readonly #registrations = new Map<HTMLElement, OverlayRegistration>();
  readonly #window: Window;

  constructor(private readonly document: Document) {
    const existing = document.querySelector<HTMLElement>("#overlay-host");
    this.root = existing ?? document.createElement("div");
    this.root.id = "overlay-host";
    this.root.className = "overlay-host";
    this.root.setAttribute("aria-live", "off");
    if (!existing) document.body.append(this.root);
    const view = document.defaultView;
    if (!view) throw new Error("OverlayHost requires a document with a window");
    this.#window = view;
    view.addEventListener("resize", this.#repositionOpen);
    document.addEventListener("scroll", this.#repositionOpen, true);
  }

  register(element: HTMLElement, onClose?: () => void): void {
    const previous = this.#registrations.get(element);
    this.#registrations.set(element, { ...previous, ...(onClose ? { onClose } : {}) });
    element.classList.add("overlay-surface");
    this.root.append(element);
  }

  isOpen(element: HTMLElement): boolean { return this.#registrations.get(element)?.open !== undefined && !element.hidden; }

  toggle(element: HTMLElement, options: OverlayOpenOptions): boolean {
    const opening = !this.isOpen(element);
    if (!opening) {
      this.close(element);
      return false;
    }
    this.open(element, options);
    return true;
  }

  open(element: HTMLElement, options: OverlayOpenOptions): void {
    if (!this.#registrations.has(element)) this.register(element);
    for (const other of this.#registrations.keys()) if (other !== element) this.close(other);
    const registration = this.#registrations.get(element)!;
    registration.open = options;
    element.hidden = false;
    this.#position(element, options);
  }

  close(element: HTMLElement): void {
    const registration = this.#registrations.get(element);
    if (!registration?.open && element.hidden) return;
    if (registration) delete registration.open;
    element.hidden = true;
    registration?.onClose?.();
  }

  closeAll(): void {
    for (const element of this.#registrations.keys()) this.close(element);
  }

  readonly #repositionOpen = (): void => {
    for (const [element, registration] of this.#registrations) {
      if (registration.open && !element.hidden) this.#position(element, registration.open);
    }
  };

  #position(element: HTMLElement, options: OverlayOpenOptions): void {
    const margin = 8;
    const gap = options.gap ?? 5;
    const anchor = options.anchor.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const width = bounds.width || element.offsetWidth;
    const height = bounds.height || element.offsetHeight;
    let left: number;
    let top: number;

    if (options.placement === "beside-end") {
      left = anchor.right + gap;
      top = anchor.top;
    } else {
      const alignment = options.placement.endsWith("-end") ? "end" : options.placement.endsWith("-center") ? "center" : "start";
      left = alignment === "end" ? anchor.right - width : alignment === "center" ? anchor.left + (anchor.width - width) / 2 : anchor.left;
      const preferAbove = options.placement.startsWith("above-");
      const below = anchor.bottom + gap;
      const above = anchor.top - height - gap;
      top = preferAbove || (below + height > this.#window.innerHeight - margin && above >= margin) ? above : below;
    }

    element.style.left = `${Math.round(clamp(left, margin, this.#window.innerWidth - width - margin))}px`;
    element.style.top = `${Math.round(clamp(top, margin, this.#window.innerHeight - height - margin))}px`;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, Math.max(minimum, maximum)));
}
