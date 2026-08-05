export interface CopyButtonOptions {
  /** Copies the given text to the clipboard. */
  copyText: (text: string) => void | Promise<void>;
  /** Returns the text to copy at click time, so dynamic values stay current. */
  value: () => string;
  /** Button title and aria-label. Default "Copy". */
  title?: string;
  /** Title shown while the success state is visible. Default "Copied". */
  copiedTitle?: string;
  /** Extra class(es) added to the button, e.g. a site-specific style hook. */
  className?: string;
  /** Render a labeled text button ("Copy" → "✓ Copied") instead of an icon-only button. */
  text?: boolean;
  /** How long the success state stays visible before restoring. Default 1_200 ms. */
  duration?: number;
}

const COPY_ICON = '<rect x="7" y="7" width="9" height="9" rx="1.6"></rect><path d="M5.8 13.4H5A2 2 0 0 1 3 11.4V5a2 2 0 0 1 2-2h6.4a2 2 0 0 1 2 2v.8"></path>';
const CHECK_ICON = '<path d="m4.2 10.1 3.25 3.25 8.35-8.35"></path>';

function icon(markup: string): SVGElement {
  const value = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  value.setAttribute("viewBox", "0 0 20 20");
  value.setAttribute("aria-hidden", "true");
  value.innerHTML = markup;
  return value;
}

function copyIcon(): SVGElement { return icon(COPY_ICON); }
function checkIcon(): SVGElement { return icon(CHECK_ICON); }

/**
 * A copy button with consistent feedback: clicking copies `value()`, then swaps
 * the icon for a checkmark (and the label to "Copied" in text mode), marks the
 * button `.copied`, and restores after `duration` ms. The value is read lazily
 * at click time so the button stays correct for live content.
 */
export function createCopyButton(options: CopyButtonOptions): HTMLButtonElement {
  const title = options.title ?? "Copy";
  const copiedTitle = options.copiedTitle ?? "Copied";
  const duration = options.duration ?? 1_200;
  let resetTimer: number | undefined;

  const button = document.createElement("button");
  button.type = "button";
  button.className = ["copy-button", options.text ? "copy-button-text" : undefined, options.className].filter(Boolean).join(" ");
  button.title = title;
  button.setAttribute("aria-label", title);
  button.append(copyIcon());
  const label = document.createElement("span");
  label.textContent = "Copy";
  if (options.text) button.append(label);

  const restore = () => {
    resetTimer = undefined;
    button.replaceChildren(copyIcon());
    if (options.text) { label.textContent = "Copy"; button.append(label); }
    button.classList.remove("copied");
    button.title = title;
    button.setAttribute("aria-label", title);
  };

  button.addEventListener("click", () => {
    const value = options.value();
    if (!value) return;
    window.clearTimeout(resetTimer);
    void Promise.resolve(options.copyText(value))
      .then(() => {
        button.replaceChildren(checkIcon());
        if (options.text) { label.textContent = "Copied"; button.append(label); }
        button.classList.add("copied");
        button.title = copiedTitle;
        button.setAttribute("aria-label", copiedTitle);
        resetTimer = window.setTimeout(restore, duration);
      })
      .catch(restore);
  });

  return button;
}
