/** Shared shell primitives for every media card state and the creation form. */
export function createMediaCard(className: string): HTMLElement {
  const card = document.createElement("article");
  card.className = `message media-card ${className}`;
  return card;
}

export function createMediaCardSection(className: string, label: string, tagName: "section" | "form" = "section"): HTMLElement {
  const section = document.createElement(tagName);
  section.className = `media-job-section ${className}`;
  section.setAttribute("aria-label", label);
  return section;
}
