// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorPanel } from "./inspector-panel.js";

function mount(): HTMLElement {
  const element = document.createElement("main");
  element.className = "workspace";
  element.getBoundingClientRect = () => ({ width: 900, height: 700, top: 0, left: 0, right: 900, bottom: 700, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  // The tab bar mounts in the workspace header, above the panel.
  const header = document.createElement("header");
  header.className = "workspace-header";
  element.append(header);
  document.body.append(element);
  return element;
}

function options(host: HTMLElement, overrides: Partial<ConstructorParameters<typeof InspectorPanel>[0]> = {}): ConstructorParameters<typeof InspectorPanel>[0] {
  return {
    mount: host,
    tabMount: host.querySelector<HTMLElement>(".workspace-header")!,
    getProjectRoot: () => "",
    getSearchRoots: () => [],
    showStatus: vi.fn(),
    onLayoutChange: vi.fn(),
    ...overrides,
  };
}

function panel(host: HTMLElement, onLayoutChange = vi.fn()): InspectorPanel {
  return new InspectorPanel(options(host, { onLayoutChange }));
}

beforeEach(() => {
  document.body.replaceChildren();
  // happy-dom's global storage here is a bare stub; provide a Map-backed one
  // so ResizablePane and the artifact repository can persist.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  });
});

describe("InspectorPanel", () => {
  it("builds the content-only Inspector with tabs mounted in the workspace header", () => {
    const host = mount();
    const view = panel(host);

    expect(view.element.className).toContain("inspector-panel");
    expect(view.element.getAttribute("aria-label")).toBe("Inspector");
    expect(view.element.hidden).toBe(true);
    expect(view.resizer.className).toContain("inspector-resizer");
    expect(view.resizer.hidden).toBe(true);
    // The Inspector itself is content only: no heading, no tab bar of its own.
    expect(view.element.querySelector(".inspector-header")).toBeNull();
    expect(view.element.querySelector(".inspector-tabs")).toBeNull();
    expect(view.element.querySelector(".inspector-content")).not.toBeNull();
    // The tab bar lives in the workspace header, above the panel; it starts
    // hidden with no tabs — the repository is a view, not a tab.
    expect(host.querySelector(".workspace-header .inspector-tabs")).not.toBeNull();
    expect(view.tabBar.hidden).toBe(true);
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(0);
    // The repository view renders once into the panel content.
    expect(view.element.querySelector(".inspector-empty")?.textContent).toContain("land here automatically");
    expect(host.querySelectorAll(".inspector-panel, .inspector-resizer")).toHaveLength(2);
  });

  it("opens and closes the panel with the workspace reflowing around it", () => {
    const host = mount();
    const onLayoutChange = vi.fn();
    const view = panel(host, onLayoutChange);
    onLayoutChange.mockClear();

    view.open();
    expect(view.isOpen).toBe(true);
    expect(view.element.hidden).toBe(false);
    expect(view.resizer.hidden).toBe(false);
    expect(view.tabBar.hidden).toBe(false);
    expect(host.classList.contains("inspector-open")).toBe(true);
    expect(host.parentElement?.classList.contains("context-open")).toBe(true);
    expect(onLayoutChange).toHaveBeenCalledTimes(1);

    view.close();
    expect(view.isOpen).toBe(false);
    expect(view.element.hidden).toBe(true);
    expect(view.resizer.hidden).toBe(true);
    expect(view.tabBar.hidden).toBe(true);
    expect(host.classList.contains("inspector-open")).toBe(false);
    expect(host.parentElement?.classList.contains("context-open")).toBe(false);
    expect(onLayoutChange).toHaveBeenCalledTimes(2);
  });

  it("toggles the panel open and closed without destroying the open view", () => {
    const host = mount();
    const view = panel(host);

    view.toggle();
    expect(view.isOpen).toBe(true);
    expect(view.tabBar.hidden).toBe(false);
    view.toggle();
    expect(view.isOpen).toBe(false);

    // The repository is the panel's home view: opening lands there, and the
    // sidebar button closes the panel again without destroying the view.
    view.toggle();
    expect(view.isOpen).toBe(true);
    expect(view.tabBar.querySelector(".inspector-tab.active")).toBeNull();
    view.toggle();
    expect(view.isOpen).toBe(false);
    expect(view.element.hidden).toBe(true);
    expect(view.tabBar.hidden).toBe(true);
  });

  it("wires the header's raw↔rendered toggle to the active markdown tab", async () => {
    const host = mount();
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "icon-button";
    toggle.hidden = true;
    const view = new InspectorPanel(options(host, {
      renderToggle: toggle,
      getProjectRoot: () => "/project",
    }));
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async () => ({ kind: "markdown", name: "notes.md", path: "/project/notes.md", content: "# Hi", size: 5 })),
    });

    // A markdown doc reveals the toggle, showing the rendered view.
    await view.inspect("notes.md");
    expect(toggle.hidden).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.title).toBe("View source");
    expect(view.element.querySelector(".inspector-markdown")).not.toBeNull();

    // Clicking it switches to the raw source; the button state follows.
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.title).toBe("View rendered");
    expect(view.element.querySelector(".inspector-source")).not.toBeNull();

    // Tabs without a raw↔rendered mode (images) hide it again.
    view.previewImage("data:image/png;base64,AAAA", "image/png", "shot.png");
    expect(toggle.hidden).toBe(true);
    vi.unstubAllGlobals();
  });

  it("restores the persisted width and resizes from the divider keyboard", () => {
    const host = mount();
    const view = panel(host);

    expect(view.width()).toBe(400);
    expect(host.style.getPropertyValue("--inspector-width")).toBe("400px");

    view.resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(view.width()).toBe(388);
    expect(host.style.getPropertyValue("--inspector-width")).toBe("388px");
    expect(view.resizer.getAttribute("aria-valuenow")).toBe("388");

    view.resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(view.width()).toBe(400);
  });

  it("clamps the panel width when the workspace shrinks so it never overspills the conversation", () => {
    const host = mount();
    const view = panel(host);
    view.open();
    expect(view.width()).toBe(400);
    expect(host.style.getPropertyValue("--inspector-width")).toBe("400px");

    // The workspace narrows (window resize, sidebar drag): the pane's maximum
    // is workspaceWidth - 280, and re-clamping pulls the panel in so the
    // conversation keeps its 280px floor instead of being covered.
    host.getBoundingClientRect = () => ({ width: 600, height: 700, top: 0, left: 0, right: 600, bottom: 700, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    view.clampWidth();
    expect(view.width()).toBe(320); // 600 - 280
    expect(host.style.getPropertyValue("--inspector-width")).toBe("320px");
    expect(view.resizer.getAttribute("aria-valuenow")).toBe("320");

    // Growing the workspace back does not override the clamped width; the
    // user re-drags the divider to widen the panel.
    host.getBoundingClientRect = () => ({ width: 1000, height: 700, top: 0, left: 0, right: 1000, bottom: 700, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    view.clampWidth();
    expect(view.width()).toBe(320);

    // The clamped size is not persisted: the preferred width is restored on
    // the next launch at a roomier window.
    expect(localStorage.getItem("fitz-inspector-width")).toBeNull();
  });

  it("resets the panel and its tabs so the Inspector never leaks across chats", async () => {
    const host = mount();
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async () => ({ kind: "text", name: "notes.txt", path: "/project/notes.txt", content: "hello", size: 5 })),
    });

    await view.inspect("notes.txt");
    expect(view.isOpen).toBe(true);
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(1);
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("notes.txt");

    // reset() closes the panel and drops every resource tab.
    view.reset();
    expect(view.isOpen).toBe(false);
    expect(view.element.hidden).toBe(true);
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(0);

    // Reopening lands on the artifact repository home view — no stale tab.
    view.open();
    expect(view.isOpen).toBe(true);
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(0);
    expect(view.tabBar.querySelector(".inspector-tab.active")).toBeNull();
    const repo = view.element.querySelector<HTMLElement>(".inspector-tabpanel:not([hidden])")!;
    expect(repo.querySelector(".inspector-repository-item")?.textContent).toContain("notes.txt");
    vi.unstubAllGlobals();
  });

  it("scopes the artifact repository to the chat it was opened in", async () => {
    const host = mount();
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async (input: { reference: string }) => ({ kind: "text", name: input.reference.split(/[\\/]/).pop() ?? "file", path: `/project/${input.reference}`, content: "x", size: 1 })),
    });

    // Chat A: a streamed reference and an inspected file land in A's repo.
    view.setChat("chat-a");
    view.registerReference("a.txt");
    await view.inspect("b.txt");
    const storedA = JSON.parse(localStorage.getItem("fitz-inspector-repository:chat-a")!) as Array<{ path: string }>;
    expect(storedA.map((entry) => entry.path)).toEqual(["/project/b.txt", "a.txt"]);
    expect(view.element.querySelectorAll(".inspector-repository-item")).toHaveLength(2);

    // Switching chats re-scopes: chat B starts with a fresh, empty repo.
    view.reset();
    view.setChat("chat-b");
    expect(view.element.querySelectorAll(".inspector-repository-item")).toHaveLength(0);
    expect(view.element.querySelector(".inspector-empty")?.textContent).toContain("land here automatically");

    // B's own files persist under B's key, and A's come back on reopen.
    view.registerReference("c.txt");
    const storedB = JSON.parse(localStorage.getItem("fitz-inspector-repository:chat-b")!) as Array<{ path: string }>;
    expect(storedB.map((entry) => entry.path)).toEqual(["c.txt"]);
    expect(localStorage.getItem("fitz-inspector-repository:chat-a")).not.toBeNull();
    view.setChat("chat-a");
    expect(view.element.querySelectorAll(".inspector-repository-item")).toHaveLength(2);

    // Leaving the conversation (no session yet) scopes to a fresh draft repo.
    view.setChat(undefined);
    expect(view.element.querySelectorAll(".inspector-repository-item")).toHaveLength(0);
    expect(view.element.querySelector(".inspector-empty")?.textContent).toContain("land here automatically");
    vi.unstubAllGlobals();
  });

  it("previews a pasted image from its data URL in its own tab", () => {
    const host = mount();
    const view = panel(host);
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    view.previewImage(dataUrl, "image/png", "Pasted image");

    expect(view.isOpen).toBe(true);
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(1);
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("Pasted image");
    const img = view.element.querySelector<HTMLImageElement>(".inspector-media")!;
    expect(img).not.toBeNull();
    expect(img.src).toBe(dataUrl);
    expect(img.alt).toBe("Pasted image");
  });

  it("previews a pasted PDF from its data URL in its own tab", () => {
    const host = mount();
    const view = panel(host);
    // Keep the preview tree detached while asserting the iframe contract.
    // Happy DOM tries to navigate connected blob: iframes even though it does
    // not implement the blob: URL scheme, which otherwise prints a false
    // fetch failure after this passing test.
    host.remove();
    const createObjectURL = vi.fn(() => "blob:test-pdf");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const dataUrl = "data:application/pdf;base64,JVBERi0xLjQK";

    view.previewPdf(dataUrl, "application/pdf", "manual.pdf");

    expect(view.isOpen).toBe(true);
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(1);
    const frame = view.element.querySelector<HTMLIFrameElement>(".inspector-frame")!;
    expect(frame).not.toBeNull();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(frame.src).toBe("blob:test-pdf");
    expect(frame.title).toBe("manual.pdf");
    // The PDF viewer plugin cannot run in a sandboxed frame, so PDF frames are
    // intentionally left unsandboxed (they only ever hold an inert blob of the
    // user's own PDF).
    expect(frame.hasAttribute("sandbox")).toBe(false);

    // Closing the panel keeps the tab alive, so its preview survives a reopen.
    view.close();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    // Reopening returns to the same doc; closing the last tab then falls
    // back to the repository home view and releases the preview's blob URL.
    view.open();
    const close = view.tabBar.querySelector<HTMLButtonElement>(".inspector-tab-close")!;
    close.click();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-pdf");
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(0);
    expect(view.isOpen).toBe(true);
    expect(view.tabBar.querySelector(".inspector-tab.active")).toBeNull();
  });

  it("renders an inspected image file inline in the Inspector", async () => {
    const host = mount();
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async () => ({ kind: "image", name: "photo.png", path: "/project/photo.png", content: "", size: 1024, mimeType: "image/png", base64 })),
    });

    await view.inspect("photo.png");

    expect(window.fitz.previewResource).toHaveBeenCalledWith({ projectRoot: "/project", reference: "photo.png", searchRoots: [] });
    const img = view.element.querySelector<HTMLImageElement>(".inspector-media")!;
    expect(img).not.toBeNull();
    expect(img.src).toBe(`data:image/png;base64,${base64}`);
    expect(img.alt).toBe("photo.png");
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("photo.png");
    vi.unstubAllGlobals();
  });

  it("renders an inspected PDF as a blob-URL frame for Chromium's viewer", async () => {
    const host = mount();
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));
    // See the pasted-PDF test above: detaching prevents Happy DOM from trying
    // to fetch a blob URL that only Chromium's embedded PDF viewer consumes.
    host.remove();
    const createObjectURL = vi.fn(() => "blob:inspected-pdf");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async () => ({ kind: "pdf", name: "manual.pdf", path: "/project/manual.pdf", content: "", size: 2048, mimeType: "application/pdf", base64: "JVBERi0xLjQ=" })),
    });

    await view.inspect("manual.pdf");

    const frame = view.element.querySelector<HTMLIFrameElement>(".inspector-frame")!;
    expect(frame).not.toBeNull();
    expect(frame.src).toBe("blob:inspected-pdf");
    // Sandboxing would disable the PDF viewer plugin and blank the preview.
    expect(frame.hasAttribute("sandbox")).toBe(false);
    expect(frame.title).toBe("manual.pdf");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("grows the artifact repository with inspected files and reopens them from the repository view", async () => {
    const host = mount();
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));
    const previewResource = vi.fn(async (input: { reference: string }) => ({ kind: "text", name: "a.txt", path: "/project/a.txt", content: "hi", size: 2 }));
    vi.stubGlobal("fitz", { previewResource });

    await view.inspect("a.txt");
    view.showRepository();

    const repo = view.element.querySelector<HTMLElement>(".inspector-tabpanel:not([hidden])")!;
    const row = repo.querySelector<HTMLButtonElement>(".inspector-repository-item");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("a.txt");

    row!.click();
    expect(previewResource).toHaveBeenLastCalledWith({ projectRoot: "/project", reference: "/project/a.txt", searchRoots: [] });
    vi.unstubAllGlobals();
  });

  it("lists session uploads in the repository and opens them as closable tabs", async () => {
    const host = mount();
    const view = panel(host);
    const request = vi.fn(async () => ({ status: 200, body: "aGVsbG8=" }));
    vi.stubGlobal("fitz", { request });

    view.setSessionArtifacts([{ id: "42", name: "build.log", byteSize: 5, kind: "text" }]);
    view.open();

    const repo = view.element.querySelector<HTMLElement>(".inspector-tabpanel:not([hidden])")!;
    const row = repo.querySelector<HTMLButtonElement>(".inspector-repository-item")!;
    expect(row.textContent).toContain("build.log");
    row.click();

    await vi.waitFor(() => expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("build.log"));
    expect(request).toHaveBeenCalledWith({ path: "/api/v1/artifacts/42/content", responseType: "base64" });

    // Stale uploads from a previous session leave the repository; closing the
    // only tab falls back to the repository home view.
    view.setSessionArtifacts([]);
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(0);
    expect(view.isOpen).toBe(true);
    expect(view.tabBar.querySelector(".inspector-tab.active")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("closes every tab, and closing the last tab falls back to the repository", () => {
    const host = mount();
    const view = panel(host);
    view.previewImage("data:image/png;base64,AAAA", "image/png", "shot.png");
    view.previewImage("data:image/png;base64,BBBB", "image/png", "two.png");

    const tabs = view.tabBar.querySelectorAll<HTMLElement>(".inspector-tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.querySelector(".inspector-tab-close")).not.toBeNull();
    expect(view.tabBar.querySelectorAll(".inspector-tab-close")).toHaveLength(2);

    // Closing a background tab keeps the active one.
    const close = view.tabBar.querySelectorAll<HTMLButtonElement>(".inspector-tab-close")[0]!;
    close.click();
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(1);
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("two.png");

    // Closing the last tab falls back to the repository home view.
    const lastClose = view.tabBar.querySelector<HTMLButtonElement>(".inspector-tab-close")!;
    lastClose.click();
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(0);
    expect(view.isOpen).toBe(true);
    expect(view.tabBar.querySelector(".inspector-tab.active")).toBeNull();
    expect(view.element.querySelector(".inspector-tabpanel:not([hidden])")).not.toBeNull();
  });

  it("merges duplicate tabs for the same file opened by different references", async () => {
    const host = mount();
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async () => ({ kind: "text", name: "a.txt", path: "/project/a.txt", content: "x", size: 1 })),
    });

    // A chat link opens the file by relative name, then the repository by absolute path.
    await view.inspect("a.txt");
    await view.inspect("/project/a.txt");

    const fileTabs = [...view.tabBar.querySelectorAll<HTMLElement>(".inspector-tab")].filter((tab) => tab.textContent?.includes("a.txt"));
    expect(fileTabs).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("restores each tab's own preview when switching tabs", async () => {
    const host = mount();
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async (input: { reference: string }) => ({ kind: "text", name: input.reference, path: `/project/${input.reference}`, content: "x", size: 1 })),
    });

    await view.inspect("one.txt");
    await view.inspect("two.txt");

    const tabs = view.tabBar.querySelectorAll<HTMLElement>(".inspector-tab");
    tabs[0]!.click();
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("one.txt");
    vi.unstubAllGlobals();
  });

  it("shows project-relative paths in the repository rows and the tab tooltip", async () => {
    const host = mount();
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async () => ({ kind: "text", name: "app.ts", path: "/project/src/app.ts", content: "x", size: 1 })),
    });

    await view.inspect("src/app.ts");

    // Without a heading, the file tab's tooltip carries the project-relative path.
    const fileTab = [...view.tabBar.querySelectorAll<HTMLElement>(".inspector-tab")].find((tab) => tab.textContent?.includes("app.ts"));
    expect(fileTab?.getAttribute("title")).toBe("src/app.ts");
    // The repository row meta is relative too (the list itself stays hidden).
    const row = view.element.querySelector<HTMLButtonElement>(".inspector-repository-item")!;
    expect(row.querySelector("small")?.textContent).toBe("src/app.ts");
    expect(row.querySelector("small")?.textContent).not.toContain("/project");
    vi.unstubAllGlobals();
  });

  it("registers files in the repository as soon as they appear in the conversation", () => {
    const host = mount();
    const view = panel(host);

    // A streaming partial lands first, then the complete path supersedes it.
    view.registerReference("src/app.t");
    view.registerReference("src/app.ts");
    // Re-renders while streaming must not add duplicates.
    view.registerReference("src/app.ts");

    const rows = view.element.querySelectorAll<HTMLButtonElement>(".inspector-repository-item");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("app.ts");
    // Registration happens silently: no tab opens and none is selected.
    expect(view.tabBar.querySelector(".inspector-tab.active")).toBeNull();
  });

  it("supersedes a chat reference with the resolved path once the file is inspected", async () => {
    const host = mount();
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async () => ({ kind: "text", name: "app.ts", path: "/project/src/app.ts", content: "x", size: 1 })),
    });

    view.registerReference("src/app.ts");
    await view.inspect("src/app.ts");
    // A later mention of the same file must not re-add the relative reference.
    view.registerReference("src/app.ts");

    const rows = view.element.querySelectorAll<HTMLButtonElement>(".inspector-repository-item");
    expect(rows).toHaveLength(1);
    const stored = JSON.parse(localStorage.getItem("fitz-inspector-repository")!) as Array<{ path: string }>;
    expect(stored.map((entry) => entry.path)).toEqual(["/project/src/app.ts"]);
    vi.unstubAllGlobals();
  });

  it("closes artifact tabs with the mouse wheel button (middle-click)", () => {
    const host = mount();
    const view = panel(host);
    view.previewImage("data:image/png;base64,AAAA", "image/png", "shot.png");
    view.previewImage("data:image/png;base64,BBBB", "image/png", "two.png");

    const tabs = view.tabBar.querySelectorAll<HTMLElement>(".inspector-tab");
    expect(tabs).toHaveLength(2);
    // Middle-clicking the active tab closes it; the other tab takes over.
    tabs[1]!.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(1);
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("shot.png");

    // Middle-clicking the last tab falls back to the repository home view.
    const last = view.tabBar.querySelector<HTMLElement>(".inspector-tab")!;
    last.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(0);
    expect(view.isOpen).toBe(true);
    expect(view.element.querySelector(".inspector-tabpanel:not([hidden])")).not.toBeNull();
  });

  it("suppresses browser autoscroll for middle-clicks on the tab bar", () => {
    const host = mount();
    const view = panel(host);
    view.previewImage("data:image/png;base64,AAAA", "image/png", "shot.png");

    const tabBar = view.tabBar;
    const middle = new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true });
    tabBar.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);

    const left = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    tabBar.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(false);
  });

  it("closes and reopens the panel from the header button, keeping the open doc", async () => {
    const host = mount();
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async (input: { reference: string }) => ({ kind: "text", name: input.reference, path: `/project/${input.reference}`, content: "x", size: 1 })),
    });

    await view.inspect("one.txt");
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("one.txt");

    // The sidebar button closes the panel but keeps the open doc open.
    view.toggle();
    expect(view.isOpen).toBe(false);
    expect(view.element.hidden).toBe(true);

    // Reopening returns to the same doc, not the repository view.
    view.toggle();
    expect(view.isOpen).toBe(true);
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("one.txt");

    // Closing the doc tab falls back to the repository home view.
    view.tabBar.querySelector<HTMLElement>(".inspector-tab-close")!.click();
    expect(view.isOpen).toBe(true);
    expect(view.tabBar.querySelector(".inspector-tab.active")).toBeNull();
    expect(view.element.querySelector(".inspector-tabpanel:not([hidden])")).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("cleans stray delimiters in chat references and collapses absolute paths", () => {
    const host = mount();
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));

    // A streamed fragment arrives parenthesized mid-sentence.
    view.registerReference("(llama.cpp/tests/test-unified-mixed-replay.cpp");
    // An absolute path outside the project root still shows its bare name.
    view.registerReference("C:\\Users\\me\\Documents\\notes.txt");
    // A reference under the root renders relative.
    view.registerReference("/project/src/app.ts");

    const stored = JSON.parse(localStorage.getItem("fitz-inspector-repository")!) as Array<{ path: string }>;
    expect(stored.map((entry) => entry.path)).toEqual(["/project/src/app.ts", "C:\\Users\\me\\Documents\\notes.txt", "llama.cpp/tests/test-unified-mixed-replay.cpp"]);

    const rows = view.element.querySelectorAll<HTMLButtonElement>(".inspector-repository-item");
    const metas = [...rows].map((row) => row.querySelector("small")?.textContent);
    expect(metas).toEqual(["src/app.ts", "notes.txt", "llama.cpp/tests/test-unified-mixed-replay.cpp"]);
  });

  it("shows a file-type icon before each repository row", () => {
    const host = mount();
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));

    // Newest first: each registered reference tops the list.
    view.registerReference("manual.pdf");
    view.registerReference("photo.png");
    view.registerReference("src/app.ts");
    view.registerReference("README.md");
    view.registerReference("data.csv");
    view.registerReference("notes");

    const rows = view.element.querySelectorAll<HTMLButtonElement>(".inspector-repository-item");
    const types = [...rows].map((row) => row.querySelector("svg")?.getAttribute("data-file-type"));
    expect(types).toEqual(["file", "database", "file", "code", "image", "pdf"]);
    // The icon is decorative and never leaks into the row's label text.
    expect(rows[0]?.querySelector("span")?.textContent).toBe("notes");
    expect(rows[5]?.querySelector("span")?.textContent).toBe("manual.pdf");
  });

  it("falls back to the artifact kind for uploads whose names carry no extension", () => {
    const host = mount();
    const view = panel(host);

    view.setSessionArtifacts([
      { id: "1", name: "report", byteSize: 5, kind: "pdf" },
      { id: "2", name: "shot.png", byteSize: 5, kind: "image" },
      { id: "3", name: "recording", byteSize: 5, kind: "audio" },
      { id: "4", name: "thing", byteSize: 5, kind: "binary" },
    ]);

    const rows = view.element.querySelectorAll<HTMLButtonElement>(".inspector-repository-item");
    const types = [...rows].map((row) => row.querySelector("svg")?.getAttribute("data-file-type"));
    expect(types).toEqual(["pdf", "image", "audio", "file"]);
  });

  it("migrates and dedupes legacy repository entries on load", () => {
    localStorage.setItem("fitz-inspector-repository", JSON.stringify([
      { path: "(llama.cpp/tests/test-unified-mixed-replay.cpp", name: "test-unified-mixed-replay.cpp", addedAt: 2 },
      { path: "llama.cpp/tests/test-unified-mixed-replay.cpp", name: "test-unified-mixed-replay.cpp", addedAt: 1 },
      { path: "/project/a.txt", name: "a.txt", addedAt: 3 },
    ]));
    const host = mount();
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));

    const rows = view.element.querySelectorAll<HTMLButtonElement>(".inspector-repository-item");
    expect(rows).toHaveLength(2);
    const metas = [...rows].map((row) => row.querySelector("small")?.textContent);
    expect(metas).toEqual(["a.txt", "llama.cpp/tests/test-unified-mixed-replay.cpp"]);
  });
});
