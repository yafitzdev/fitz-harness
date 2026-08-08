// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorPanel } from "./inspector-panel.js";

function mount(): HTMLElement {
  const element = document.createElement("main");
  element.className = "workspace";
  element.getBoundingClientRect = () => ({ width: 900, height: 700, top: 0, left: 0, right: 900, bottom: 700, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.append(element);
  return element;
}

function panel(host: HTMLElement, onLayoutChange = vi.fn()): InspectorPanel {
  return new InspectorPanel({
    mount: host,
    getProjectRoot: () => "",
    getSearchRoots: () => [],
    showToast: vi.fn(),
    onLayoutChange,
  });
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
  it("builds the right-hand Inspector shell with a fixed Artifacts base tab", () => {
    const host = mount();
    const view = panel(host);

    expect(view.element.className).toContain("inspector-panel");
    expect(view.element.getAttribute("aria-label")).toBe("Inspector");
    expect(view.element.hidden).toBe(true);
    expect(view.resizer.className).toContain("inspector-resizer");
    expect(view.resizer.hidden).toBe(true);
    expect(view.element.querySelector(".inspector-header")).not.toBeNull();
    expect(view.element.querySelector(".inspector-tabs")).not.toBeNull();
    expect(view.element.querySelector(".inspector-content")).not.toBeNull();
    // The artifact repository is the base tab: present from the start, active,
    // and never closable.
    const tabs = view.element.querySelectorAll<HTMLElement>(".inspector-tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.textContent).toBe("Artifacts");
    expect(tabs[0]?.classList.contains("active")).toBe(true);
    expect(tabs[0]?.querySelector(".inspector-tab-close")).toBeNull();
    expect(view.element.querySelector("#inspector-title")?.textContent).toBe("Artifacts");
    expect(view.element.querySelector("#inspector-location")?.textContent).toContain("repository");
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
    expect(host.classList.contains("inspector-open")).toBe(true);
    expect(host.parentElement?.classList.contains("context-open")).toBe(true);
    expect(onLayoutChange).toHaveBeenCalledTimes(1);

    view.close();
    expect(view.isOpen).toBe(false);
    expect(view.element.hidden).toBe(true);
    expect(view.resizer.hidden).toBe(true);
    expect(host.classList.contains("inspector-open")).toBe(false);
    expect(host.parentElement?.classList.contains("context-open")).toBe(false);
    expect(onLayoutChange).toHaveBeenCalledTimes(2);
  });

  it("toggles open state and closes from the header close button", () => {
    const host = mount();
    const view = panel(host);

    view.toggle();
    expect(view.isOpen).toBe(true);
    view.toggle();
    expect(view.isOpen).toBe(false);

    view.open();
    const close = view.element.querySelector<HTMLButtonElement>("#inspector-close")!;
    close.click();
    expect(view.isOpen).toBe(false);
    expect(view.element.hidden).toBe(true);
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

  it("returns to the artifact repository when the panel is closed and reset", async () => {
    const host = mount();
    const view = new InspectorPanel({
      mount: host,
      getProjectRoot: () => "/project",
      getSearchRoots: () => [],
      showToast: vi.fn(),
      onLayoutChange: vi.fn(),
    });
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async () => ({ kind: "text", name: "notes.txt", path: "/project/notes.txt", content: "hello", size: 5 })),
    });

    await view.inspect("notes.txt");
    expect(view.element.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("notes.txt");

    // resetPreview only acts while the panel is closed, and lands on the base tab.
    view.open();
    view.resetPreview();
    expect(view.element.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("notes.txt");

    view.close();
    view.resetPreview();
    expect(view.element.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toBe("Artifacts");
    vi.unstubAllGlobals();
  });

  it("previews a pasted image from its data URL in its own tab", () => {
    const host = mount();
    const view = panel(host);
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    view.previewImage(dataUrl, "image/png", "Pasted image");

    expect(view.isOpen).toBe(true);
    expect(view.element.querySelectorAll(".inspector-tab")).toHaveLength(2);
    expect(view.element.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("Pasted image");
    const img = view.element.querySelector<HTMLImageElement>(".inspector-media")!;
    expect(img).not.toBeNull();
    expect(img.src).toBe(dataUrl);
    expect(img.alt).toBe("Pasted image");
    expect(view.element.querySelector("#inspector-title")?.textContent).toBe("Pasted image");
    expect(view.element.querySelector("#inspector-location")?.textContent).toContain("image/png");
  });

  it("previews a pasted PDF from its data URL in its own tab", () => {
    const host = mount();
    const view = panel(host);
    const createObjectURL = vi.fn(() => "blob:test-pdf");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const dataUrl = "data:application/pdf;base64,JVBERi0xLjQK";

    view.previewPdf(dataUrl, "application/pdf", "manual.pdf");

    expect(view.isOpen).toBe(true);
    expect(view.element.querySelectorAll(".inspector-tab")).toHaveLength(2);
    const frame = view.element.querySelector<HTMLIFrameElement>(".inspector-frame")!;
    expect(frame).not.toBeNull();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(frame.src).toBe("blob:test-pdf");
    expect(frame.title).toBe("manual.pdf");
    // The PDF viewer plugin cannot run in a sandboxed frame, so PDF frames are
    // intentionally left unsandboxed (they only ever hold an inert blob of the
    // user's own PDF).
    expect(frame.hasAttribute("sandbox")).toBe(false);
    expect(view.element.querySelector("#inspector-title")?.textContent).toBe("manual.pdf");
    expect(view.element.querySelector("#inspector-location")?.textContent).toContain("application/pdf");

    // Closing the panel keeps the tab alive, so its preview survives a reopen.
    view.close();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    // Closing the tab itself releases the preview's blob URL.
    const close = view.element.querySelector<HTMLButtonElement>(".inspector-tab-close")!;
    close.click();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-pdf");
    expect(view.element.querySelectorAll(".inspector-tab")).toHaveLength(1);
    expect(view.element.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toBe("Artifacts");
  });

  it("renders an inspected image file inline in the Inspector", async () => {
    const host = mount();
    const view = new InspectorPanel({
      mount: host,
      getProjectRoot: () => "/project",
      getSearchRoots: () => [],
      showToast: vi.fn(),
      onLayoutChange: vi.fn(),
    });
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
    expect(view.element.querySelector("#inspector-title")?.textContent).toBe("photo.png");
    expect(view.element.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("photo.png");
    vi.unstubAllGlobals();
  });

  it("renders an inspected PDF as a blob-URL frame for Chromium's viewer", async () => {
    const host = mount();
    const view = new InspectorPanel({
      mount: host,
      getProjectRoot: () => "/project",
      getSearchRoots: () => [],
      showToast: vi.fn(),
      onLayoutChange: vi.fn(),
    });
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

  it("grows the artifact repository with inspected files and reopens them from the base tab", async () => {
    const host = mount();
    const view = new InspectorPanel({
      mount: host,
      getProjectRoot: () => "/project",
      getSearchRoots: () => [],
      showToast: vi.fn(),
      onLayoutChange: vi.fn(),
    });
    const previewResource = vi.fn(async (input: { reference: string }) => ({ kind: "text", name: "a.txt", path: "/project/a.txt", content: "hi", size: 2 }));
    vi.stubGlobal("fitz", { previewResource });

    await view.inspect("a.txt");
    view.close();
    view.resetPreview();

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

    await vi.waitFor(() => expect(view.element.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("build.log"));
    expect(request).toHaveBeenCalledWith({ path: "/api/v1/artifacts/42/content", responseType: "base64" });

    // Stale uploads from a previous session leave the repository and their tabs close.
    view.setSessionArtifacts([]);
    expect(view.element.querySelectorAll(".inspector-tab")).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("closes artifact tabs and keeps the Artifacts base tab non-closable", () => {
    const host = mount();
    const view = panel(host);
    view.previewImage("data:image/png;base64,AAAA", "image/png", "shot.png");

    const tabs = view.element.querySelectorAll<HTMLElement>(".inspector-tab");
    expect(tabs).toHaveLength(2);
    const base = tabs[0]!;
    expect(base.textContent).toBe("Artifacts");
    expect(base.querySelector(".inspector-tab-close")).toBeNull();
    expect(view.element.querySelectorAll(".inspector-tab-close")).toHaveLength(1);

    const close = view.element.querySelector<HTMLButtonElement>(".inspector-tab-close")!;
    close.click();
    expect(view.element.querySelectorAll(".inspector-tab")).toHaveLength(1);
    expect(view.element.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toBe("Artifacts");
  });

  it("merges duplicate tabs for the same file opened by different references", async () => {
    const host = mount();
    const view = new InspectorPanel({
      mount: host,
      getProjectRoot: () => "/project",
      getSearchRoots: () => [],
      showToast: vi.fn(),
      onLayoutChange: vi.fn(),
    });
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async () => ({ kind: "text", name: "a.txt", path: "/project/a.txt", content: "x", size: 1 })),
    });

    // A chat link opens the file by relative name, then the repository by absolute path.
    await view.inspect("a.txt");
    await view.inspect("/project/a.txt");

    const fileTabs = [...view.element.querySelectorAll<HTMLElement>(".inspector-tab")].filter((tab) => tab.textContent?.includes("a.txt"));
    expect(fileTabs).toHaveLength(1);
    expect(view.element.querySelector("#inspector-title")?.textContent).toBe("a.txt");
    vi.unstubAllGlobals();
  });

  it("restores each tab's own preview and heading when switching tabs", async () => {
    const host = mount();
    const view = new InspectorPanel({
      mount: host,
      getProjectRoot: () => "/project",
      getSearchRoots: () => [],
      showToast: vi.fn(),
      onLayoutChange: vi.fn(),
    });
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async (input: { reference: string }) => ({ kind: "text", name: input.reference, path: `/project/${input.reference}`, content: "x", size: 1 })),
    });

    await view.inspect("one.txt");
    await view.inspect("two.txt");
    expect(view.element.querySelector("#inspector-title")?.textContent).toBe("two.txt");

    const tabs = view.element.querySelectorAll<HTMLElement>(".inspector-tab");
    tabs[1]!.click();
    expect(view.element.querySelector("#inspector-title")?.textContent).toBe("one.txt");
    expect(view.element.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("one.txt");
    vi.unstubAllGlobals();
  });

  it("shows project-relative paths in the repository rows and the location line", async () => {
    const host = mount();
    const view = new InspectorPanel({
      mount: host,
      getProjectRoot: () => "/project",
      getSearchRoots: () => [],
      showToast: vi.fn(),
      onLayoutChange: vi.fn(),
    });
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async () => ({ kind: "text", name: "app.ts", path: "/project/src/app.ts", content: "x", size: 1 })),
    });

    await view.inspect("src/app.ts");

    // The location line under the title shows the project-relative path.
    expect(view.element.querySelector("#inspector-location")?.textContent).toBe("src/app.ts");
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
    // Registration happens silently: the base tab stays active.
    expect(view.element.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toBe("Artifacts");
  });

  it("supersedes a chat reference with the resolved path once the file is inspected", async () => {
    const host = mount();
    const view = new InspectorPanel({
      mount: host,
      getProjectRoot: () => "/project",
      getSearchRoots: () => [],
      showToast: vi.fn(),
      onLayoutChange: vi.fn(),
    });
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

    const tabs = view.element.querySelectorAll<HTMLElement>(".inspector-tab");
    expect(tabs).toHaveLength(3);
    // Middle-clicking a background tab closes it without stealing focus.
    tabs[1]!.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    expect(view.element.querySelectorAll(".inspector-tab")).toHaveLength(2);
    expect(view.element.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("two.png");

    // The base Artifacts tab is never closable, even via middle-click.
    const base = view.element.querySelector<HTMLElement>(".inspector-tab")!;
    base.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    expect(view.element.querySelectorAll(".inspector-tab")).toHaveLength(2);
  });

  it("suppresses browser autoscroll for middle-clicks on the tab bar", () => {
    const host = mount();
    const view = panel(host);
    view.previewImage("data:image/png;base64,AAAA", "image/png", "shot.png");

    const tabBar = view.element.querySelector<HTMLElement>(".inspector-tabs")!;
    const middle = new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true });
    tabBar.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);

    const left = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    tabBar.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(false);
  });
});
