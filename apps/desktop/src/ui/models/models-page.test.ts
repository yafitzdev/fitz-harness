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
      { id: "llm-tab", label: "LLM", pipeline: "text-generation", active: true },
      { id: "embedder-tab", label: "Embedder", pipeline: "feature-extraction" },
      { id: "reranker-tab", label: "Reranker", pipeline: "reranker" },
      { id: "vision-tab", label: "Vision", pipeline: "image-text-to-text" },
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
    title: "Models",
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
    showToast: vi.fn(),
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

  it("derives uploader facet chips from the loaded models and filters the rows", async () => {
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

    const chips = [...page.querySelectorAll<HTMLButtonElement>("#models-view .catalog-filter-chip")];
    expect(chips.map((chip) => chip.dataset.facet)).toEqual(["Qwen", "google"]);

    click(chips[0]!);
    await vi.waitFor(() => expect(page.querySelectorAll("#model-catalog .model-card")).toHaveLength(2));
    expect(page.querySelector("#model-catalog")?.textContent).toContain("Qwen2.5-7B-GGUF");
    expect(page.querySelector("#model-catalog")?.textContent).not.toContain("gemma-2b-GGUF");
  });

  it("switches the catalog filter when a pipeline tab is clicked", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/models/downloaded" || path === "/api/v1/management/models/downloads") return { data: [] };
      return { data: { total: 0, models: [] } };
    });
    const { controller, page } = setup(api);
    await controller.load();
    expect(api).toHaveBeenCalledWith("/api/v1/management/models/catalog?query=&pipeline=text-generation&offset=0&limit=30&sort=downloads&direction=desc");

    click(page.querySelector("#embedder-tab")!);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/models/catalog?query=&pipeline=feature-extraction&offset=0&limit=30&sort=downloads&direction=desc"));
    expect(page.querySelector("#embedder-tab")?.classList.contains("active")).toBe(true);
    expect(page.querySelector("#llm-tab")?.classList.contains("active")).toBe(false);
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
    expect(calls.showToast).toHaveBeenCalledWith("Downloaded model.Q4_K_M.gguf");
    // The finished model moves to Downloaded and leaves the Discover catalog.
    expect(page.querySelector("#model-catalog")?.textContent).not.toContain("org/model");
    expect(page.querySelector("#downloaded-models")?.textContent).toContain("model.Q4_K_M.gguf");
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

    const show = [...page.querySelectorAll<HTMLButtonElement>("#downloaded-models .model-action")].find((button) => button.textContent === "Show in folder")!;
    click(show);

    expect(calls.openPath).toHaveBeenCalledWith("/models/org/model/");
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

    const deleteButton = page.querySelector<HTMLButtonElement>("#downloaded-models .model-action.danger")!;
    click(deleteButton);
    expect(deleteButton.textContent).toBe("Delete?");
    click(deleteButton);

    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/models/downloaded", "DELETE", { repoId: "org/model", fileName: "model.Q4_K_M.gguf" }));
    await vi.waitFor(() => expect(page.querySelector("#downloaded-models")?.textContent).toContain("No models downloaded"));
    expect(calls.showToast).toHaveBeenCalledWith("Removed model.Q4_K_M.gguf");
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
    new ManagementPageLayout(page, { tabs: [{ id: "llm-tab", label: "LLM", pipeline: "text-generation", active: true }] });
    expect(() => new ModelsPageController({ page, api: vi.fn(), openExternal: vi.fn(), openPath: vi.fn(), showToast: vi.fn(), errorMessage: vi.fn() } satisfies ModelsPageOptions))
      .toThrow("Models page is missing #models-view");
  });
});
