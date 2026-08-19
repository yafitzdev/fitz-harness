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
  it("uses the sidebar as one hidden-chrome scroll surface instead of scrolling each section", () => {
    const sidebar = document.createElement("aside");
    sidebar.className = "sidebar";
    const pinned = document.createElement("section");
    pinned.className = "sidebar-section";
    const projects = document.createElement("section");
    projects.className = "sidebar-section projects-section";
    const chats = document.createElement("section");
    chats.className = "sidebar-section";
    sidebar.append(pinned, projects, chats);
    document.body.append(sidebar);

    expect(getComputedStyle(sidebar).overflowY).toBe("auto");
    const rules = [...document.styleSheets[0]!.cssRules] as CSSStyleRule[];
    expect(rules.find((rule) => rule.selectorText === ".sidebar")?.style.getPropertyValue("scrollbar-width")).toBe("none");
    expect(rules.find((rule) => rule.selectorText === ".sidebar::-webkit-scrollbar")?.style.display).toBe("none");
    for (const section of [pinned, projects, chats]) {
      expect(getComputedStyle(section).overflow).toBe("visible");
      expect(getComputedStyle(section).flexShrink).toBe("0");
    }
  });
});
