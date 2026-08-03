export function requiredElement(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value;
}

export function requiredQuery(selector: string): HTMLElement {
  const value = document.querySelector<HTMLElement>(selector);
  if (!value) throw new Error(`Missing ${selector}`);
  return value;
}

export function svgIcon(markup: string, viewBox = "0 0 20 20"): SVGElement {
  const value = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  value.setAttribute("viewBox", viewBox);
  value.setAttribute("aria-hidden", "true");
  value.innerHTML = markup;
  return value;
}

export function textBlock(className: string, text: string): HTMLElement {
  const value = document.createElement("div");
  value.className = className;
  value.textContent = text;
  return value;
}
