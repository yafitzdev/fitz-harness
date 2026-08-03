export function togglePopover(popover: HTMLElement, toggle: HTMLButtonElement, closeAll: () => void): void {
  const opening = popover.hidden;
  closeAll();
  popover.hidden = !opening;
  toggle.setAttribute("aria-expanded", String(opening));
}

export function positionFixedPopover(popover: HTMLElement, anchor: HTMLElement, gap = 5): void {
  const anchorRect = anchor.getBoundingClientRect();
  popover.style.left = `${Math.max(8, Math.min(anchorRect.left, window.innerWidth - popover.offsetWidth - 8))}px`;
  popover.style.top = `${anchorRect.bottom + gap}px`;
  const bounds = popover.getBoundingClientRect();
  if (bounds.bottom > window.innerHeight - 8 && anchorRect.top > bounds.height + gap + 8) popover.style.top = `${Math.max(8, anchorRect.top - bounds.height - gap)}px`;
}

export function positionNestedPopover(popover: HTMLElement, anchor: HTMLElement, margin = 16): void {
  popover.style.top = `${Math.max(-8, anchor.offsetTop - 8)}px`;
  popover.classList.remove("open-left");
  let bounds = popover.getBoundingClientRect();
  if (bounds.right > window.innerWidth - margin) { popover.classList.add("open-left"); bounds = popover.getBoundingClientRect(); }
  if (bounds.bottom > window.innerHeight - margin) popover.style.top = `${Number.parseFloat(popover.style.top) - (bounds.bottom - window.innerHeight + margin)}px`;
}
