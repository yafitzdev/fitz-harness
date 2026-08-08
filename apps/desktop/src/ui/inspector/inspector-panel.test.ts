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
    showToast: vi.fn(),
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
    // The tab bar lives in the workspace header, above the panel.
    expect(host.querySelector(".workspace-header .inspector-tabs")).not.toBeNull();
    // The artifact repository is the base tab: present from the start, active,
    // and closable like any other (closing it closes the panel).
    const tabs = view.tabBar.querySelectorAll<HTMLElement>(".inspector-tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.textContent).toBe("Artifacts");
    expect(tabs[0]?.classList.contains("active")).toBe(true);
    expect(tabs[0]?.querySelector(".inspector-tab-close")).not.toBeNull();
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

  it("toggles open state and closes from the Artifacts tab close button", () => {
    const host = mount();
    const view = panel(host);

    view.toggle();
    expect(view.isOpen).toBe(true);
    view.toggle();
    expect(view.isOpen).toBe(false);

    view.open();
    const close = view.tabBar.querySelector<HTMLButtonElement>(".inspector-tab-close")!;
    close.click();
    expect(view.isOpen).toBe(false);
    expect(view.element.hidden).toBe(true);
    expect(view.tabBar.hidden).toBe(true);
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
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async () => ({ kind: "text", name: "notes.txt", path: "/project/notes.txt", content: "hello", size: 5 })),
    });

    await view.inspect("notes.txt");
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("notes.txt");

    // resetPreview only acts while the panel is closed, and lands on the base tab.
    view.open();
    view.resetPreview();
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("notes.txt");

    view.close();
    view.resetPreview();
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toBe("Artifacts");
    vi.unstubAllGlobals();
  });

  it("previews a pasted image from its data URL in its own tab", () => {
    const host = mount();
    const view = panel(host);
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    view.previewImage(dataUrl, "image/png", "Pasted image");

    expect(view.isOpen).toBe(true);
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(2);
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("Pasted image");
    const img = view.element.querySelector<HTMLImageElement>(".inspector-media")!;
    expect(img).not.toBeNull();
    expect(img.src).toBe(dataUrl);
    expect(img.alt).toBe("Pasted image");
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
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(2);
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
    // Closing the tab itself releases the preview's blob URL.
    const close = view.tabBar.querySelectorAll<HTMLButtonElement>(".inspector-tab-close")[1]!;
    close.click();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-pdf");
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(1);
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toBe("Artifacts");
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
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));
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

    await vi.waitFor(() => expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("build.log"));
    expect(request).toHaveBeenCalledWith({ path: "/api/v1/artifacts/42/content", responseType: "base64" });

    // Stale uploads from a previous session leave the repository and their tabs close.
    view.setSessionArtifacts([]);
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("closes every tab, and closing the Artifacts tab closes the panel", () => {
    const host = mount();
    const view = panel(host);
    view.previewImage("data:image/png;base64,AAAA", "image/png", "shot.png");

    const tabs = view.tabBar.querySelectorAll<HTMLElement>(".inspector-tab");
    expect(tabs).toHaveLength(2);
    const base = tabs[0]!;
    expect(base.textContent).toBe("Artifacts");
    expect(base.querySelector(".inspector-tab-close")).not.toBeNull();
    expect(view.tabBar.querySelectorAll(".inspector-tab-close")).toHaveLength(2);

    // Closing an artifact tab returns to the repository.
    const close = view.tabBar.querySelectorAll<HTMLButtonElement>(".inspector-tab-close")[1]!;
    close.click();
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(1);
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toBe("Artifacts");

    // Closing the repository tab closes the whole panel.
    view.open();
    const baseClose = view.tabBar.querySelector<HTMLButtonElement>(".inspector-tab-close")!;
    baseClose.click();
    expect(view.isOpen).toBe(false);
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(0);
    expect(view.tabBar.hidden).toBe(true);
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
    tabs[1]!.click();
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
    // Registration happens silently: the base tab stays active.
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toBe("Artifacts");
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
    expect(tabs).toHaveLength(3);
    // Middle-clicking a background tab closes it without stealing focus.
    tabs[1]!.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(2);
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("two.png");

    // Middle-clicking the Artifacts base tab closes the whole panel; other
    // file tabs survive and return when the panel reopens.
    const base = view.tabBar.querySelector<HTMLElement>(".inspector-tab")!;
    base.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    expect(view.isOpen).toBe(false);
    expect(view.tabBar.hidden).toBe(true);
    expect(view.tabBar.querySelectorAll(".inspector-tab")).toHaveLength(1);
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab")?.textContent).toBe("two.png");
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

  it("returns to the Artifacts base tab when its tab is clicked", async () => {
    const host = mount();
    const view = new InspectorPanel(options(host, {
      getProjectRoot: () => "/project",
    }));
    vi.stubGlobal("fitz", {
      previewResource: vi.fn(async (input: { reference: string }) => ({ kind: "text", name: input.reference, path: `/project/${input.reference}`, content: "x", size: 1 })),
    });

    await view.inspect("one.txt");
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("one.txt");

    const tabs = view.tabBar.querySelectorAll<HTMLElement>(".inspector-tab");
    expect(tabs[0]?.textContent).toBe("Artifacts");
    tabs[0]!.click();

    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toBe("Artifacts");

    // Switching back to the resource tab keeps its preview alive.
    tabs[1]!.click();
    expect(view.tabBar.querySelector<HTMLElement>(".inspector-tab.active")?.textContent).toContain("one.txt");
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
