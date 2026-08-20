// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  const shellCss = readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/styles.css"), "utf8")
    .replace(/^@import .*;\r?\n/gm, "");
  const sidebarCss = readFileSync(resolve(process.cwd(), "apps/desktop/src/ui/sidebar/project-sidebar.css"), "utf8");
  const style = document.createElement("style");
  style.textContent = `${sidebarCss}\n${shellCss}`;
  document.head.append(style);
});

describe("sidebar scrolling", () => {
  it("keeps one hidden-chrome content scroller above a fixed hosting footer", () => {
    const sidebar = document.createElement("aside");
    sidebar.className = "sidebar";
    const scrollRegion = document.createElement("div");
    scrollRegion.className = "sidebar-scroll-region";
    const pinned = document.createElement("section");
    pinned.className = "sidebar-section";
    const projects = document.createElement("section");
    projects.className = "sidebar-section projects-section";
    const chats = document.createElement("section");
    chats.className = "sidebar-section";
    const footer = document.createElement("footer");
    footer.className = "sidebar-footer";
    scrollRegion.append(pinned, projects, chats);
    sidebar.append(scrollRegion, footer);
    document.body.append(sidebar);

    expect(getComputedStyle(sidebar).overflow).toBe("hidden");
    expect(getComputedStyle(scrollRegion).overflowY).toBe("auto");
    expect(getComputedStyle(scrollRegion).flexGrow).toBe("1");
    expect(getComputedStyle(footer).flexShrink).toBe("0");
    const rules = [...document.styleSheets[0]!.cssRules] as CSSStyleRule[];
    expect(rules.find((rule) => rule.selectorText === ".sidebar-scroll-region")?.style.getPropertyValue("scrollbar-width")).toBe("none");
    expect(rules.find((rule) => rule.selectorText === ".sidebar-scroll-region::-webkit-scrollbar")?.style.display).toBe("none");
    for (const section of [pinned, projects, chats]) {
      expect(getComputedStyle(section).overflow).toBe("visible");
      expect(getComputedStyle(section).flexShrink).toBe("0");
    }
  });
});
