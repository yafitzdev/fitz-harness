import { svgIcon } from "./dom.js";

export interface ActionMenuItem {
  label: string;
  action: () => void | Promise<void>;
  onError?: (error: unknown) => void;
  danger?: boolean;
  confirm?: boolean;
}

const moreIcon = '<circle cx="5" cy="10" r="1"></circle><circle cx="10" cy="10" r="1"></circle><circle cx="15" cy="10" r="1"></circle>';

/** A compact, self-contained overflow menu for secondary row actions. */
export function createActionMenu(items: readonly ActionMenuItem[], label = "More actions"): HTMLDetailsElement {
  const root = document.createElement("details");
  root.className = "action-menu";
  const toggle = document.createElement("summary");
  toggle.className = "action-menu-toggle";
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
  toggle.append(svgIcon(moreIcon));
  const menu = document.createElement("div");
  menu.className = "action-menu-surface menu-surface";

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.toggle("danger", item.danger === true);
    button.textContent = item.label;
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (button.disabled) return;
      if (item.confirm && button.dataset.confirm !== "true") {
        button.dataset.confirm = "true";
        button.textContent = `Confirm ${item.label.toLowerCase()}`;
        return;
      }
      root.open = false;
      button.disabled = true;
      root.setAttribute("aria-busy", "true");
      try {
        await item.action();
      } catch (error) {
        item.onError?.(error);
      } finally {
        button.disabled = false;
        root.removeAttribute("aria-busy");
      }
    });
    menu.append(button);
  }

  root.addEventListener("toggle", () => {
    if (root.open) {
      for (const other of document.querySelectorAll<HTMLDetailsElement>("details.action-menu[open]")) if (other !== root) other.open = false;
    } else {
      for (const button of menu.querySelectorAll<HTMLButtonElement>("button[data-confirm='true']")) {
        button.dataset.confirm = "false";
        const item = items[[...menu.children].indexOf(button)];
        if (item) button.textContent = item.label;
      }
    }
  });
  root.append(toggle, menu);
  return root;
}
