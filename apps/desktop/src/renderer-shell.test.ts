// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let shell: Document;

beforeAll(() => {
  const markup = readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/index.html"), "utf8");
  // Happy DOM eagerly fetches stylesheets while parsing. Preserve the asset
  // contract as inert metadata so this structural test never reaches the network.
  const inertMarkup = markup.replace('rel="stylesheet" href="styles.css"', 'rel="stylesheet" data-shell-href="styles.css"');
  shell = new DOMParser().parseFromString(inertMarkup, "text/html");
});

function required(id: string): HTMLElement {
  const element = shell.getElementById(id);
  expect(element, `missing shell element #${id}`).not.toBeNull();
  return element!;
}

describe("desktop renderer shell", () => {
  it("provides one accessible application frame", () => {
    expect(shell.title).toBe("Fitz Codex");
    expect(shell.querySelectorAll(":scope > body > .app-titlebar")).toHaveLength(1);
    expect(shell.querySelectorAll(":scope > body > .app-shell")).toHaveLength(1);
    expect(shell.querySelectorAll(".app-shell > aside.sidebar")).toHaveLength(1);
    expect(shell.querySelectorAll("aside.sidebar > .sidebar-scroll-region")).toHaveLength(1);
    expect(shell.querySelectorAll("aside.sidebar > .sidebar-footer")).toHaveLength(1);
    expect(required("hosting-enabled").closest(".sidebar-footer")).not.toBeNull();
    expect(shell.querySelectorAll(".app-shell > main.workspace")).toHaveLength(1);
    expect(shell.querySelector("aside.sidebar")?.getAttribute("aria-label")).toBe("Workspace navigation");
    expect(required("messages").getAttribute("aria-live")).toBe("polite");

    const windowActions = [...shell.querySelectorAll<HTMLElement>("[data-window-action]")]
      .map((element) => element.dataset.windowAction);
    expect(windowActions).toEqual(["minimize", "maximize", "close"]);
  });

  it("keeps ids and ARIA relationships structurally valid", () => {
    const ids = [...shell.querySelectorAll<HTMLElement>("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const controller of shell.querySelectorAll<HTMLElement>("[aria-controls]")) {
      const targetId = controller.getAttribute("aria-controls")!;
      expect(shell.getElementById(targetId), `${controller.id || controller.tagName} controls missing #${targetId}`).not.toBeNull();
    }
    for (const label of shell.querySelectorAll<HTMLLabelElement>("label[for]")) {
      expect(shell.getElementById(label.htmlFor), `label targets missing #${label.htmlFor}`).not.toBeNull();
    }
  });

  it("contains the durable navigation and mutually exclusive workspaces", () => {
    const navigation = [
      ["new-session", "New chat"],
      ["manage-connections", "Inference"],
      ["manage-plugins", "Plugins"],
      ["manage-models", "Models"],
      ["manage-administration", "Hosting"],
    ] as const;
    for (const [id, label] of navigation) expect(required(id).textContent).toContain(label);

    expect(required("messages").hidden).toBe(false);
    for (const id of ["playbook-page", "plugins-page", "models-page", "administration-page"]) {
      const page = required(id);
      expect(page.classList.contains("management-page")).toBe(true);
      expect(page.hidden).toBe(true);
    }
  });

  it("provides the static mount points owned by renderer controllers", () => {
    const mounts = [
      "projects", "pinned", "chats", "messages", "playbook-list", "management-editor",
      "plugins-installed-section", "plugins-skills-section", "plugins-discover-section", "plugins-custom-section",
      "models-downloaded-section", "models-discover-section", "administration-sections",
      "request-queue", "artifacts", "artifact-file", "select-popover", "sidebar-context-menu",
    ];
    for (const id of mounts) required(id);
  });

  it("boots only the compiled renderer under the locked-down document policy", () => {
    const policy = shell.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content ?? "";
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(shell.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')?.dataset.shellHref).toBe("styles.css");
    const scripts = [...shell.querySelectorAll<HTMLScriptElement>("script")];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.type).toBe("module");
    expect(scripts[0]?.getAttribute("src")).toBe("../renderer.js");
    expect(scripts[0]?.textContent?.trim()).toBe("");
  });
});
