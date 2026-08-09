// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagementPageLayout, managementRefreshIcon } from "../layout/management-page.js";
import { ModelsPageController, type ModelsPageOptions } from "./models-page.js";

function buildPage(): HTMLElement {
  const page = document.createElement("section");
  page.id = "models-page";
  page.className = "management-page";
  const layout = new ManagementPageLayout(page, {
    tabs: [
      { id: "llm-tab", label: "LLMs", dataset: { pipeline: "text-generation" }, active: true },
      { id: "vision-tab", label: "Vision", dataset: { pipeline: "image-text-to-text" } },
      { id: "audio-tab", label: "Audio", dataset: { pipeline: "automatic-speech-recognition" } },
    ],
    actions: [{ id: "refresh-models", icon: managementRefreshIcon, label: "Refresh models" }],
  });
  const downloadedSection = document.createElement("section");
  downloadedSection.className = "collapsible-section";
  downloadedSection.id = "models-downloaded-section";
  downloadedSection.innerHTML = '<div class="collapsible-heading"><button class="collapsible-toggle" id="downloaded-models-toggle" type="button" data-collapsible-key="downloaded" aria-expanded="true" aria-controls="downloaded-models-body"><h2>Downloaded</h2></button></div><div id="downloaded-models-body" class="collapsible-body"><div id="downloaded-models" class="model-grid"></div></div>';
  const discoverSection = document.createElement("section");
  discoverSection.className = "collapsible-section";
  discoverSection.id = "models-discover-section";
  discoverSection.innerHTML = '<div class="collapsible-heading"><button class="collapsible-toggle" id="model-catalog-toggle" type="button" data-collapsible-key="discover" aria-expanded="true" aria-controls="model-catalog-body"><h2>Discover</h2></button></div><div id="model-catalog-body" class="collapsible-body"><div id="model-catalog" class="model-grid"></div><button id="load-more-models" type="button" hidden>Load more</button></div>';
  layout.addContent({
    id: "models-view",
    title: "LLMs",
    titleId: "models-title",
    description: "Search GGUF models on Hugging Face by type.",
    search: { id: "model-search", placeholder: "Search models" },
    body: [downloadedSection, discoverSection],
  });
  document.body.append(page);
  return page;
}

function setup(api: (path: string, method?: string, body?: unknown) => Promise<Record<string, any>>) {
  const page = buildPage();
  const calls = {
    openExternal: vi.fn(),
    openPath: vi.fn(),
    showStatus: vi.fn(),
    errorMessage: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)),
  };
  const controller = new ModelsPageController({ page, api, ...calls });
  return { controller, page, calls };
}

function click(target: Element): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  } as Storage;
}

beforeEach(() => {
  // happy-dom ships an empty localStorage stub without working methods; install a real one.
  globalThis.localStorage = memoryStorage();
  document.body.replaceChildren();
});
afterEach(() => vi.useRealTimers());

describe("ModelsPageController", () => {
  it("loads the Hugging Face catalog and downloaded models into the collapsible sections", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded") {
        return { data: [{ repoId: "org/model", fileName: "model.Q4_K_M.gguf", path: "/models/org/model/model.Q4_K_M.gguf", size: 4_300_000_000 }] };
      }
      if (path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 2, models: [
        { id: "org/model", downloads: 2_500_000, likes: 120, pipelineTag: "text-generation", updatedAt: "2026-01-15T00:00:00Z" },
        { id: "org/other", downloads: 900, likes: 30, pipelineTag: "text-generation" },
      ] } };
    });
    const { controller, page } = setup(api);

    await controller.load();

    // Downloaded models stay out of the Discover catalog.
    expect(page.querySelectorAll("#model-catalog .model-card")).toHaveLength(1);
    expect(page.querySelector("#model-catalog .model-copy strong")?.textContent).toBe("other");
    expect(page.querySelector("#model-catalog")?.textContent).toContain("org · 900 downloads · 30 likes");
    expect(page.querySelector("#model-catalog")?.textContent).not.toContain("org/model");
    expect(page.querySelector("#downloaded-models .model-copy strong")?.textContent).toBe("model");
    expect(page.querySelector("#downloaded-models")?.textContent).toContain("model.Q4_K_M.gguf · 4.0 GB");
    expect(page.querySelector("#downloaded-models")?.textContent).toContain("Show in folder");
    expect(page.querySelector("#downloaded-models")?.textContent).toContain("Delete");
  });

  it("shows a loading placeholder before a refresh", () => {
    const { controller, page } = setup(vi.fn(async () => ({ data: {} })));

    controller.showLoading();

    expect(page.querySelector("#downloaded-models")?.textContent).toContain("Loading models…");
  });

  it("passes website opening through to the page options", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded" || path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 1, models: [{ id: "org/extra", downloads: 1, likes: 0 }] } };
    });
    const { controller, page, calls } = setup(api);

    await controller.load();
    click(page.querySelector("#model-catalog .model-card")!);

    expect(calls.openExternal).toHaveBeenCalledWith("https://huggingface.co/org/extra");
  });

  it("reports rejected website bridge calls inline", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded" || path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 1, models: [{ id: "org/extra", downloads: 1, likes: 0 }] } };
    });
    const { controller, page, calls } = setup(api);
    calls.openExternal.mockRejectedValueOnce(new Error("Browser unavailable"));
    await controller.load();

    click(page.querySelector("#model-catalog .model-card")!);

    await vi.waitFor(() => expect(calls.showStatus).toHaveBeenCalledWith("Browser unavailable", "error"));
  });

  it("re-queries the catalog with the shared sort when the filter bar changes", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded" || path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 0, models: [] } };
    });
    const { controller, page } = setup(api);
    await controller.load();

    const select = page.querySelector<HTMLSelectElement>("#models-view .catalog-filter-select")!;
    select.value = "updated:desc";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/models/catalog?query=&pipeline=text-generation&offset=0&limit=30&sort=updated&direction=desc"));
  });

  it("filters the catalog by minimum likes and downloads", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded" || path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 0, models: [] } };
    });
    const { controller, page } = setup(api);
    await controller.load();

    const likes = page.querySelector<HTMLInputElement>('#models-view input[aria-label="Min likes"]')!;
    const downloads = page.querySelector<HTMLInputElement>('#models-view input[aria-label="Min downloads"]')!;
    const recency = page.querySelector<HTMLInputElement>('#models-view input[aria-label="Released within"]')!;
    expect(likes).not.toBeNull();
    expect(downloads).not.toBeNull();
    expect(recency).not.toBeNull();
    expect(likes.type).toBe("range");
    expect(downloads.type).toBe("range");
    expect(recency.type).toBe("range");

    // Readouts start at "no filter" and follow the thumb while dragging…
    const likesReadout = likes.closest("label")?.querySelector(".catalog-filter-value");
    const downloadsReadout = downloads.closest("label")?.querySelector(".catalog-filter-value");
    const recencyReadout = recency.closest("label")?.querySelector(".catalog-filter-value");
    expect(likesReadout?.textContent).toBe("0");
    expect(recencyReadout?.textContent).toBe("any time");
    likes.value = "3"; // third stop → 100 likes
    likes.dispatchEvent(new Event("input", { bubbles: true }));
    expect(likesReadout?.textContent).toBe("100");
    expect(api).not.toHaveBeenCalledWith(expect.stringContaining("min_likes=100"));

    // …and the query fires on release (change), with both thresholds applied.
    likes.dispatchEvent(new Event("change", { bubbles: true }));
    downloads.value = "2"; // second stop → 5000 downloads
    downloads.dispatchEvent(new Event("change", { bubbles: true }));
    expect(downloadsReadout?.textContent).toBe("5K");
    recency.value = "3"; // third stop → released within the last 4 weeks
    recency.dispatchEvent(new Event("change", { bubbles: true }));
    expect(recencyReadout?.textContent).toBe("last 4 weeks");

    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/models/catalog?query=&pipeline=text-generation&offset=0&limit=30&sort=downloads&direction=desc&min_likes=100&min_downloads=5000&released_within_weeks=4"));
    // Thresholds are dropped from the query while the sliders are at zero.
    expect(api).toHaveBeenCalledWith("/api/v1/management/models/catalog?query=&pipeline=text-generation&offset=0&limit=30&sort=downloads&direction=desc");
  });

  it("does not render uploader facet chips", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded" || path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 3, models: [
        { id: "Qwen/Qwen2.5-7B-GGUF", downloads: 1, likes: 0 },
        { id: "Qwen/Qwen2-1.5B-GGUF", downloads: 1, likes: 0 },
        { id: "google/gemma-2b-GGUF", downloads: 1, likes: 0 },
      ] } };
    });
    const { controller, page } = setup(api);
    await controller.load();

    expect(page.querySelectorAll("#models-view .catalog-filter-chip")).toHaveLength(0);
    expect(page.querySelectorAll("#model-catalog .model-card")).toHaveLength(3);
  });

  it("switches the catalog filter when a pipeline tab is clicked", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded" || path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 0, models: [] } };
    });
    const { controller, page } = setup(api);
    await controller.load();
    expect(api).toHaveBeenCalledWith("/api/v1/management/models/catalog?query=&pipeline=text-generation&offset=0&limit=30&sort=downloads&direction=desc");
    // The page title mirrors the active pipeline tab.
    expect(page.querySelector("#models-title")?.textContent).toBe("LLMs");

    click(page.querySelector("#vision-tab")!);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/models/catalog?query=&pipeline=image-text-to-text&offset=0&limit=30&sort=downloads&direction=desc"));
    expect(page.querySelector("#vision-tab")?.classList.contains("active")).toBe(true);
    expect(page.querySelector("#llm-tab")?.classList.contains("active")).toBe(false);
    expect(page.querySelector("#models-title")?.textContent).toBe("Vision");
  });

  it("searches the catalog after the debounce delay", async () => {
    vi.useFakeTimers();
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded" || path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 0, models: [] } };
    });
    const { controller, page } = setup(api);
    await controller.load();

    const search = page.querySelector<HTMLInputElement>("#model-search")!;
    search.value = "  llama  ";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(250);

    expect(api).toHaveBeenCalledWith("/api/v1/management/models/catalog?query=llama&pipeline=text-generation&offset=0&limit=30&sort=downloads&direction=desc");
  });

  it("does not let a slow stale search replace newer catalog results", async () => {
    let resolveOld: ((value: Record<string, any>) => void) | undefined;
    const oldResponse = new Promise<Record<string, any>>((resolve) => { resolveOld = resolve; });
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded" || path === "/api/v1/management/models/downloads") return { data: [] };
      if (path.includes("query=old")) return oldResponse;
      if (path.includes("query=new")) return { data: { total: 1, models: [{ id: "org/new-result", downloads: 2, likes: 1 }] } };
      return { data: { total: 0, models: [] } };
    });
    const { controller, page } = setup(api);
    const search = page.querySelector<HTMLInputElement>("#model-search")!;
    search.value = "old";
    const oldLoad = controller.load();
    await Promise.resolve();
    await Promise.resolve();
    search.value = "new";

    await controller.load();
    resolveOld?.({ data: { total: 1, models: [{ id: "org/old-result", downloads: 1, likes: 0 }] } });
    await oldLoad;

    expect(page.querySelector("#model-catalog")?.textContent).toContain("new-result");
    expect(page.querySelector("#model-catalog")?.textContent).not.toContain("old-result");
  });

  it("loads more catalog results on demand", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded" || path === "/api/v1/management/models/downloads") return { data: [] };
      if (path.includes("offset=0")) return { data: { total: 40, models: [{ id: "a/b", downloads: 1, likes: 0 }] } };
      return { data: { total: 40, models: [{ id: "c/d", downloads: 2, likes: 1 }] } };
    });
    const { controller, page } = setup(api);
    await controller.load();

    const loadMore = page.querySelector<HTMLButtonElement>("#load-more-models")!;
    expect(loadMore.hidden).toBe(false);
    expect(page.querySelectorAll("#model-catalog .model-card")).toHaveLength(1);

    click(loadMore);
    expect(api).toHaveBeenCalledWith("/api/v1/management/models/catalog?query=&pipeline=text-generation&offset=1&limit=30&sort=downloads&direction=desc");
    await vi.waitFor(() => expect(page.querySelectorAll("#model-catalog .model-card")).toHaveLength(2));
  });

  it("keeps active download controls while appending catalog results", async () => {
    vi.useFakeTimers();
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded") return { data: [] };
      if (path === "/api/v1/management/models/downloads") return { data: [{ id: "d1", repoId: "a/b", fileName: "b.gguf", received: 10, total: 100, status: "active" }] };
      if (path === "/api/v1/management/models/downloads/d1") return { data: { id: "d1", repoId: "a/b", fileName: "b.gguf", received: 10, total: 100, status: "active" } };
      if (path.includes("offset=0")) return { data: { total: 2, models: [{ id: "a/b", downloads: 1, likes: 0 }] } };
      return { data: { total: 2, models: [{ id: "c/d", downloads: 2, likes: 1 }] } };
    });
    const { controller, page } = setup(api);
    await controller.load();
    expect(page.querySelector("#model-catalog .model-progress-cancel")).not.toBeNull();

    click(page.querySelector<HTMLButtonElement>("#load-more-models")!);
    await Promise.resolve();
    await Promise.resolve();

    expect(page.querySelector("#model-catalog .model-progress-cancel")).not.toBeNull();
  });

  it("contains a rejected catalog pagination request", async () => {
    let catalogPage = 0;
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded" || path === "/api/v1/management/models/downloads") return { data: [] };
      if (catalogPage++ === 0) return { data: { total: 2, models: [{ id: "a/b", downloads: 1, likes: 0 }] } };
      throw new Error("Catalog unavailable");
    });
    const { controller, page, calls } = setup(api);
    await controller.load();

    click(page.querySelector<HTMLButtonElement>("#load-more-models")!);

    await vi.waitFor(() => expect(calls.showStatus).toHaveBeenCalledWith("Catalog unavailable", "error"));
    expect(page.querySelector("#model-catalog")?.textContent).toContain("b");
  });

  it("reloads the page when the header refresh action is clicked", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded" || path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 1, models: [{ id: "a/b", downloads: 1, likes: 0 }] } };
    });
    const { controller, page } = setup(api);
    await controller.load();
    expect(api).toHaveBeenCalledTimes(3);

    click(page.querySelector<HTMLButtonElement>("#refresh-models")!);
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(6));
  });

  it("downloads a model through the management API and polls to completion", async () => {
    vi.useFakeTimers();
    let downloaded: Record<string, any>[] = [];
    let polled = 0;
    const api = vi.fn(async (path: string, method?: string) => {
      if (method === "POST" && path === "/api/v1/management/models/download") {
        downloaded = [{ repoId: "org/model", fileName: "model.Q4_K_M.gguf", path: "/models/org/model/model.Q4_K_M.gguf", size: 100 }];
        return { data: { id: "d1", repoId: "org/model", fileName: "model.Q4_K_M.gguf", received: 0, total: 100, status: "active" } };
      }
      if (path === "/api/v1/management/models/downloads/d1") {
        polled += 1;
        return polled >= 2
          ? { data: { id: "d1", repoId: "org/model", fileName: "model.Q4_K_M.gguf", received: 100, total: 100, status: "done" } }
          : { data: { id: "d1", repoId: "org/model", fileName: "model.Q4_K_M.gguf", received: 50, total: 100, status: "active" } };
      }
      if (path === "/api/v1/management/models/downloaded") return { data: downloaded };
      if (path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 1, models: [{ id: "org/model", downloads: 10, likes: 2 }] } };
    });
    const { controller, page, calls } = setup(api);
    await controller.load();

    const downloadButton = page.querySelector<HTMLButtonElement>("#model-catalog .model-action")!;
    click(downloadButton);
    expect(downloadButton.textContent).toBe("Download?");
    click(downloadButton);
    expect(api).toHaveBeenCalledWith("/api/v1/management/models/download", "POST", { repo: "org/model" });

    // The catalog card now renders a progress control instead of the button.
    await vi.advanceTimersByTimeAsync(0);
    expect(page.querySelector("#model-catalog .model-progress")?.textContent).toContain("0 B / 100 B");

    await vi.advanceTimersByTimeAsync(500); // first poll: still active
    expect(page.querySelector("#model-catalog .model-progress")?.textContent).toContain("50 B / 100 B");

    await vi.advanceTimersByTimeAsync(500); // second poll: done → toast + reload
    expect(calls.showStatus).toHaveBeenCalledWith("Downloaded model.Q4_K_M.gguf", "success");
    // The finished model moves to Downloaded and leaves the Discover catalog.
    expect(page.querySelector("#model-catalog")?.textContent).not.toContain("org/model");
    expect(page.querySelector("#downloaded-models")?.textContent).toContain("model.Q4_K_M.gguf");
  });

  it("restores the Download action when host polling reports failure", async () => {
    vi.useFakeTimers();
    const api = vi.fn(async (path: string, method?: string) => {
      if (method === "POST" && path === "/api/v1/management/models/download") {
        return { data: { id: "d1", repoId: "org/model", fileName: "model.Q4_K_M.gguf", received: 0, total: 100, status: "active" } };
      }
      if (path === "/api/v1/management/models/downloads/d1") {
        return { data: { id: "d1", repoId: "org/model", fileName: "model.Q4_K_M.gguf", received: 20, total: 100, status: "failed", error: "Disk full" } };
      }
      if (path === "/api/v1/management/models/downloaded" || path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 1, models: [{ id: "org/model", downloads: 10, likes: 2 }] } };
    });
    const { controller, page, calls } = setup(api);
    await controller.load();
    const download = page.querySelector<HTMLButtonElement>("#model-catalog .model-action")!;
    click(download);
    click(download);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(500);

    expect(calls.showStatus).toHaveBeenCalledWith("Disk full", "error");
    expect(page.querySelector("#model-catalog .model-progress")).toBeNull();
    expect(page.querySelector("#model-catalog .model-action")?.textContent).toBe("Download");
  });

  it("restores the Download action when polling itself fails", async () => {
    vi.useFakeTimers();
    const api = vi.fn(async (path: string, method?: string) => {
      if (method === "POST" && path === "/api/v1/management/models/download") {
        return { data: { id: "d1", repoId: "org/model", fileName: "model.Q4_K_M.gguf", received: 0, total: 100, status: "active" } };
      }
      if (path === "/api/v1/management/models/downloads/d1") throw new Error("Host disconnected");
      if (path === "/api/v1/management/models/downloaded" || path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 1, models: [{ id: "org/model", downloads: 10, likes: 2 }] } };
    });
    const { controller, page, calls } = setup(api);
    await controller.load();
    const download = page.querySelector<HTMLButtonElement>("#model-catalog .model-action")!;
    click(download);
    click(download);
    await vi.advanceTimersByTimeAsync(500);

    expect(calls.showStatus).toHaveBeenCalledWith("Host disconnected", "error");
    expect(page.querySelector("#model-catalog .model-action")?.textContent).toBe("Download");
  });

  it("cancels an active download and restores the Download action", async () => {
    vi.useFakeTimers();
    const api = vi.fn(async (path: string, method?: string) => {
      if (method === "POST" && path === "/api/v1/management/models/download") {
        return { data: { id: "d1", repoId: "org/model", fileName: "model.Q4_K_M.gguf", received: 0, total: 100, status: "active" } };
      }
      if (path === "/api/v1/management/models/downloaded" || path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 1, models: [{ id: "org/model", downloads: 10, likes: 2 }] } };
    });
    const { controller, page } = setup(api);
    await controller.load();

    const downloadButton = page.querySelector<HTMLButtonElement>("#model-catalog .model-action")!;
    click(downloadButton);
    click(downloadButton);
    await vi.advanceTimersByTimeAsync(0);
    expect(page.querySelector("#model-catalog .model-progress-cancel")).not.toBeNull();

    click(page.querySelector<HTMLButtonElement>("#model-catalog .model-progress-cancel")!);
    await vi.advanceTimersByTimeAsync(1);
    expect(api).toHaveBeenCalledWith("/api/v1/management/models/downloads/d1", "DELETE");
    expect(page.querySelector("#model-catalog .model-action")?.textContent).toBe("Download");
  });

  it("opens the parent folder of a downloaded model from the row or its button", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded") {
        return { data: [{ repoId: "org/model", fileName: "model.Q4_K_M.gguf", path: "/models/org/model/model.Q4_K_M.gguf", size: 100 }] };
      }
      if (path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 0, models: [] } };
    });
    const { controller, page, calls } = setup(api);
    await controller.load();

    // Clicking the row itself reveals the local folder instead of a guessed Hugging Face URL.
    click(page.querySelector("#downloaded-models .model-card")!);
    expect(calls.openPath).toHaveBeenCalledWith("/models/org/model/");
    expect(calls.openExternal).not.toHaveBeenCalled();

    const show = [...page.querySelectorAll<HTMLButtonElement>("#downloaded-models .action-menu-surface button")].find((button) => button.textContent === "Show in folder")!;
    click(show);

    expect(calls.openPath).toHaveBeenCalledWith("/models/org/model/");
  });

  it("reports rejected folder bridge calls inline", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded") {
        return { data: [{ repoId: "org/model", fileName: "model.Q4_K_M.gguf", path: "/models/org/model/model.Q4_K_M.gguf", size: 100 }] };
      }
      if (path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 0, models: [] } };
    });
    const { controller, page, calls } = setup(api);
    calls.openPath.mockRejectedValueOnce(new Error("Folder unavailable"));
    await controller.load();

    click(page.querySelector("#downloaded-models .model-card")!);

    await vi.waitFor(() => expect(calls.showStatus).toHaveBeenCalledWith("Folder unavailable", "error"));
  });

  it("removes a downloaded model after confirming", async () => {
    let removed = false;
    const api = vi.fn(async (path: string, method?: string) => {
      if (method === "DELETE" && path === "/api/v1/management/models/downloaded") {
        removed = true;
        return { data: {} };
      }
      if (path === "/api/v1/management/models/downloaded") {
        return { data: removed ? [] : [{ repoId: "org/model", fileName: "model.Q4_K_M.gguf", path: "/models/org/model/model.Q4_K_M.gguf", size: 100 }] };
      }
      if (path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 0, models: [] } };
    });
    const { controller, page, calls } = setup(api);
    await controller.load();
    expect(page.querySelector("#downloaded-models")?.textContent).toContain("model.Q4_K_M.gguf");

    const deleteButton = page.querySelector<HTMLButtonElement>("#downloaded-models .action-menu-surface button.danger")!;
    click(deleteButton);
    expect(deleteButton.textContent).toBe("Confirm delete");
    click(deleteButton);

    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/models/downloaded", "DELETE", { repoId: "org/model", fileName: "model.Q4_K_M.gguf" }));
    await vi.waitFor(() => expect(page.querySelector("#downloaded-models")?.textContent).toContain("No models downloaded"));
    expect(calls.showStatus).toHaveBeenCalledWith("Removed model.Q4_K_M.gguf", "success");
  });

  it("collapses and expands the Downloaded and Discover sections", () => {
    const { page } = setup(vi.fn(async () => ({ data: {} })));

    const downloadedToggle = page.querySelector<HTMLButtonElement>("#downloaded-models-toggle")!;
    const downloadedSection = downloadedToggle.closest(".collapsible-section")!;
    click(downloadedToggle);
    expect(downloadedSection.classList.contains("collapsed")).toBe(true);
    expect(downloadedToggle.getAttribute("aria-expanded")).toBe("false");
    click(downloadedToggle);
    expect(downloadedSection.classList.contains("collapsed")).toBe(false);
    expect(downloadedToggle.getAttribute("aria-expanded")).toBe("true");

    const catalogToggle = page.querySelector<HTMLButtonElement>("#model-catalog-toggle")!;
    click(catalogToggle);
    expect(catalogToggle.closest(".collapsible-section")?.classList.contains("collapsed")).toBe(true);
  });

  it("fails loudly when the page is missing a required catalog control", () => {
    const page = document.createElement("section");
    page.id = "models-page";
    new ManagementPageLayout(page, { tabs: [{ id: "llm-tab", label: "LLMs", dataset: { pipeline: "text-generation" }, active: true }] });
    expect(() => new ModelsPageController({ page, api: vi.fn(), openExternal: vi.fn(), openPath: vi.fn(), showStatus: vi.fn(), errorMessage: vi.fn() } satisfies ModelsPageOptions))
      .toThrow("Models page is missing #models-view");
  });
});
