// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_ROUTES, ConnectionWorkspaceController, FIXED_ROUTES, MEDIA_ROUTES, type ConnectionWorkspaceBridge } from "./connection-workspace.js";

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

function node<T extends HTMLElement>(tag: string): T {
  const element = document.createElement(tag) as T;
  document.body.append(element);
  return element;
}

function setup(overrides: Partial<ConnectionWorkspaceBridge> = {}) {
  const mount = node("div");
  const remote = { id: "remote-1", displayName: "Remote API", baseUrl: "https://remote.test/v1", authType: "bearer" as const, hasCredential: true, template: "openai-compatible" as const, models: [{ id: "remote-model", recipeId: "consumer-recipe--remote-model" }], mediaModels: [], updatedAt: "now" };
  const bridge: ConnectionWorkspaceBridge = {
    syncConsumerConnections: vi.fn(async () => []),
    listConsumerConnections: vi.fn(async () => [remote]),
    saveConsumerConnection: vi.fn(async () => remote),
    removeConsumerConnection: vi.fn(async () => undefined),
    ...overrides,
  };
  let configuration = {
    hostName: "YanPC",
    isAdministrator: true,
    recipes: [
      { id: "local-recipe", playbookId: "llama.cpp", adapter: "llama-cpp", displayName: "Local Model", modelId: "local.gguf", contextTokens: 100_000, configuration: {}, capabilities: { chatCompletions: true, toolCalls: true, maxConcurrentGenerations: 3 }, agentTopology: { sharedContextTokens: 100_000, workers: { count: 0, contextTokens: 32_000 } } },
      { id: "consumer-recipe--remote-model", playbookId: "consumer-remote", adapter: "openai-compatible", displayName: "Remote Model", modelId: "remote-model", contextTokens: 131_072, configuration: {}, capabilities: { chatCompletions: true, toolCalls: true, maxConcurrentGenerations: 8 } },
    ],
    routes: [] as Array<Record<string, unknown>>,
    cloudRoutes: {} as Record<string, string>,
  };
  const calls = {
    api: vi.fn(async (path: string, method?: string, body?: unknown) => {
      const cloudMatch = /\/cloud-routes\/(smart|fast)$/.exec(path);
      if (cloudMatch) {
        const role = cloudMatch[1]!;
        const cloudRoutes = { ...configuration.cloudRoutes };
        if (method === "DELETE") delete cloudRoutes[role];
        else cloudRoutes[role] = (body as { recipeId: string }).recipeId;
        configuration = { ...configuration, cloudRoutes };
        return { data: { role, recipeId: cloudRoutes[role] } };
      }
      const match = /\/routes\/([^/]+)$/.exec(path);
      const route = { ...(body as Record<string, unknown>), id: match?.[1] };
      if (match) configuration = { ...configuration, routes: [route] };
      return { data: route };
    }),
    reloadConfiguration: vi.fn(async () => configuration),
    updateRouteConfiguration: vi.fn((routeId: string, route: Record<string, unknown> | undefined) => {
      configuration = { ...configuration, routes: [...configuration.routes.filter((item) => item.id !== routeId), ...(route ? [route] : [])] };
    }),
    updateCloudRouteConfiguration: vi.fn((role: "smart" | "fast", recipeId: string | undefined) => {
      configuration = { ...configuration, cloudRoutes: { ...configuration.cloudRoutes, [role]: recipeId } };
    }),
    closePopovers: vi.fn(),
    showStatus: vi.fn(),
    errorMessage: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)),
    onRouteChange: vi.fn(),
  };
  const controller = new ConnectionWorkspaceController({ mount, bridge, ...calls });
  return { controller, elements: controller.elements, bridge, calls, remote };
}

function click(target: Element): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
function selectInferenceTab(elements: { listView: HTMLElement }, tab: "cloud" | "local"): void {
  click(elements.listView.closest(".inference-page")!.querySelector(`#inference-${tab}-tab`)!);
}

beforeEach(() => {
  // happy-dom ships an empty localStorage stub without a working clear(); install a real one.
  globalThis.localStorage = memoryStorage();
  document.body.replaceChildren();
});

describe("ConnectionWorkspaceController", () => {
  it("syncs hosted and remote models, reports failures, and filters the workspace", async () => {
    const syncConsumerConnections = vi.fn(async () => [{ id: "remote-1", connected: false, error: "Remote unavailable" }]);
    const { controller, elements, calls } = setup({ syncConsumerConnections });

    await controller.sync(true);

    expect(elements.listView.closest(".inference-page")?.querySelector(".management-page-tabs")?.textContent).toBe("CloudLocal");
    expect(elements.listView.querySelector(":scope > h1")?.textContent).toBe("Cloud");
    expect(elements.newConnection.hidden).toBe(false);
    expect(elements.connections.querySelectorAll(".consumer-playbook-card")).toHaveLength(1);
    expect(elements.connections.textContent).toContain("Remote API");
    expect(elements.connections.querySelector(".media-text")?.textContent).toBe("Text");
    expect([...elements.connections.querySelectorAll(".recipe-card")].map((card) => card.querySelector(".recipe-card-label")?.textContent)).toEqual(["remote-model"]);
    expect(elements.connections.querySelector(".recipe-engine-label")).toBeNull();
    expect(calls.showStatus).toHaveBeenCalledWith("Remote unavailable", "error");

    selectInferenceTab(elements, "local");
    expect(elements.listView.querySelector(":scope > h1")?.textContent).toBe("Local");
    expect(elements.newConnection.hidden).toBe(true);
    expect(controller.root.querySelector("#edit-local-models")).toBeNull();
    expect(elements.connections.textContent).toContain("llama.cpp");
    expect(elements.connections.textContent).toContain("Local Model");
    expect(elements.connections.querySelector<HTMLButtonElement>('[aria-label="Rename model"]')).not.toBeNull();
    expect(elements.connections.querySelector(".media-text")).toBeNull();
    expect(elements.connections.querySelector(".recipe-context-label")).toBeNull();
    expect(elements.connections.querySelector(".recipe-concurrency-label")).toBeNull();
    expect(elements.connections.querySelector(".recipe-card-label")?.textContent).toBe("local.gguf");
    elements.search.value = "local.gguf";
    elements.search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(elements.connections.querySelectorAll(".consumer-playbook-card")).toHaveLength(1);
    expect(elements.connections.textContent).toContain("llama.cpp");
  });

  it("clusters local recipes by engine and omits redundant engine badges", async () => {
    const { controller, elements } = setup();
    await controller.sync(false);
    controller.setConfiguration({
      isAdministrator: true,
      recipes: [
        { id: "llama", playbookId: "llama.cpp", displayName: "Llama", modelId: "llama.gguf", contextTokens: 32_768, capabilities: { chatCompletions: true, toolCalls: true, maxConcurrentGenerations: 3 } },
        { id: "ninfer", playbookId: "ninfer", displayName: "Qwen", modelId: "qwen", contextTokens: 100_000, capabilities: { chatCompletions: true, toolCalls: true, maxConcurrentGenerations: 3 } },
        { id: "consumer-recipe--remote-model", playbookId: "consumer-remote", displayName: "Remote", modelId: "remote-model", contextTokens: 131_072, capabilities: { chatCompletions: true, toolCalls: true, maxConcurrentGenerations: 8 } },
      ],
      routes: [],
      cloudRoutes: {},
    });
    controller.render();

    selectInferenceTab(elements, "local");
    const local = elements.connections;
    expect([...local.querySelectorAll<HTMLElement>(".collapsible-title")].map((title) => title.textContent)).toEqual(["llama.cpp", "NInfer"]);
    expect(local.querySelectorAll(".consumer-playbook-card")).toHaveLength(2);
    expect(elements.connections.querySelector(".recipe-engine-label")).toBeNull();
  });

  it("does not let an obsolete connection sync replace the latest snapshot", async () => {
    let resolveOld: ((value: Array<{ id: string; connected: boolean; error?: string }>) => void) | undefined;
    const oldSync = new Promise<Array<{ id: string; connected: boolean; error?: string }>>((resolve) => { resolveOld = resolve; });
    let syncCalls = 0;
    const syncConsumerConnections = vi.fn(async () => {
      syncCalls += 1;
      return syncCalls === 1 ? oldSync : [];
    });
    let listCalls = 0;
    const listConsumerConnections = vi.fn(async () => {
      listCalls += 1;
      const current = listCalls === 1;
      return [{
        id: current ? "new" : "old",
        displayName: current ? "Current API" : "Stale API",
        baseUrl: "https://remote.test/v1",
        authType: "none" as const,
        hasCredential: false,
        template: "openai-compatible" as const,
        models: [],
        mediaModels: [],
        updatedAt: "now",
      }];
    });
    const { controller, elements, calls } = setup({ syncConsumerConnections, listConsumerConnections });
    const staleLoad = controller.sync(true);
    await Promise.resolve();

    await controller.sync(false);
    resolveOld?.([{ id: "old", connected: false, error: "Obsolete failure" }]);
    await staleLoad;

    expect(elements.connections.textContent).toContain("Current API");
    expect(elements.connections.textContent).not.toContain("Stale API");
    expect(calls.showStatus).not.toHaveBeenCalledWith("Obsolete failure", "error");
  });

  it("uses bearer credentials and saves a new OpenAI-compatible connection", async () => {
    const { controller, elements, bridge, calls } = setup();
    click(elements.newConnection);
    expect(controller.editorOpen).toBe(true);
    expect(elements.listView.hidden).toBe(true);
    expect(calls.onRouteChange).toHaveBeenLastCalledWith(["new"]);

    expect(controller.root.querySelector("#consumer-connection-auth")).toBeNull();
    expect(elements.name.closest(".connection-editor-heading")).not.toBeNull();
    expect(elements.editorTitleRow.hidden).toBe(true);
    expect(elements.editor.textContent).not.toContain("New connection");
    expect(elements.editor.textContent).not.toContain("API connection");
    expect(elements.editor.textContent).not.toContain("Connect a provider");
    expect(elements.form.querySelector(".configuration-grid small")).toBeNull();
    expect([...elements.form.querySelectorAll<HTMLElement>(".configuration-grid > label")].map((label) => label.querySelector("input,select")?.id)).toEqual([
      "consumer-connection-url",
      "consumer-connection-key",
      "consumer-connection-template",
      "consumer-connection-execution",
      "consumer-model-ids",
    ]);
    expect(elements.apiKeyField.hidden).toBe(false);
    expect(elements.apiKey.required).toBe(true);
    elements.name.value = "Self hosted";
    elements.url.value = "http://127.0.0.1:8000/v1";
    elements.execution.value = "self_hosted";
    elements.apiKey.value = "secret-token";

    elements.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(bridge.saveConsumerConnection).toHaveBeenCalledWith({ displayName: "Self hosted", baseUrl: "http://127.0.0.1:8000/v1", authType: "bearer", apiKey: "secret-token", template: "openai-compatible", executionClass: "self_hosted" }));
    await vi.waitFor(() => expect(controller.editorOpen).toBe(false));
    expect(bridge.listConsumerConnections).toHaveBeenCalled();
    await vi.waitFor(() => expect(calls.showStatus).toHaveBeenCalledWith("Connection added", "success"));
  });

  it("renames an existing cloud connection in the header and discards edits when switching to Local", async () => {
    const { controller, elements, bridge } = setup();
    await controller.sync(false);
    const remoteCard = elements.connections.querySelector<HTMLElement>(".consumer-playbook-card")!;
    const edit = [...remoteCard.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!;
    click(edit);

    expect(elements.editorTitle.textContent).toBe("Remote API");
    expect(elements.editorRename.hidden).toBe(false);
    expect(elements.name.hidden).toBe(true);
    click(elements.editorRename);
    expect(elements.editorTitleRow.hidden).toBe(true);
    expect(elements.name.hidden).toBe(false);
    elements.name.value = "Unsaved name";

    selectInferenceTab(elements, "local");
    expect(controller.editorOpen).toBe(false);
    expect(elements.listView.hidden).toBe(false);
    expect(elements.name.value).toBe("");
    expect(bridge.saveConsumerConnection).not.toHaveBeenCalled();
    expect(elements.listView.querySelector(":scope > h1")?.textContent).toBe("Local");
  });

  it("does not expose agent configuration or concurrency claims for cloud models", async () => {
    const { controller, elements, calls } = setup();
    await controller.sync(false);
    const remoteCard = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[0]!;
    const details = remoteCard.querySelector<HTMLElement>(".recipe-card-details")!;

    expect(details).not.toBeInstanceOf(HTMLButtonElement);
    expect(remoteCard.textContent).not.toContain("concurrent");
    expect(remoteCard.textContent).not.toContain("Sequential");
    click(details);
    expect(controller.editorOpen).toBe(false);
    expect(calls.api).not.toHaveBeenCalledWith(expect.stringContaining("agent-topology"), expect.anything(), expect.anything());
  });

  it("emits and restores generic nested routes without recording programmatic closes", async () => {
    const { controller, elements, calls } = setup();
    await controller.sync(false);

    expect(controller.openRoute(["edit", "remote-1"])).toBe(true);
    expect(elements.id.value).toBe("remote-1");
    expect(calls.onRouteChange).toHaveBeenLastCalledWith(["edit", "remote-1"]);

    calls.onRouteChange.mockClear();
    controller.closeEditor(false);
    expect(calls.onRouteChange).not.toHaveBeenCalled();
    expect(controller.openRoute(["edit", "missing"])).toBe(false);

    click(elements.newConnection);
    controller.closeEditor();
    expect(calls.onRouteChange).toHaveBeenLastCalledWith(undefined);
  });

  it("assigns user-owned cloud roles without rendering recipe test actions", async () => {
    const { controller, elements, calls } = setup();
    await controller.sync(false);
    let cards = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card");
    const remoteCard = cards[0]!;
    const fast = remoteCard.querySelector<HTMLButtonElement>(".route-fast")!;
    click(fast);
    await vi.waitFor(() => expect(calls.api).toHaveBeenCalledWith("/api/v1/cloud-routes/fast", "PUT", { recipeId: "consumer-recipe--remote-model" }));
    await vi.waitFor(() => expect(elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[0]?.querySelector(".route-fast")?.classList.contains("active")).toBe(true));
    expect(calls.showStatus).not.toHaveBeenCalledWith("Fast route updated", "success");

    expect(elements.connections.querySelector(".recipe-test-button")).toBeNull();
    expect(elements.connections.textContent).not.toContain("Test");
  });

  it("switches a route immediately without disabling it or waiting for persistence", async () => {
    let finishRequest = (_value: Record<string, unknown>) => {};
    const pending = new Promise<Record<string, unknown>>((resolve) => { finishRequest = resolve; });
    const { controller, elements, calls } = setup();
    await controller.sync(false);
    calls.api.mockImplementationOnce(async () => pending);
    const reloadsBeforeClick = calls.reloadConfiguration.mock.calls.length;

    click(elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[0]!.querySelector<HTMLButtonElement>(".route-smart")!);

    const active = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[0]!.querySelector<HTMLButtonElement>(".route-smart")!;
    expect(active.classList.contains("active")).toBe(true);
    expect(active.disabled).toBe(false);
    expect(calls.reloadConfiguration).toHaveBeenCalledTimes(reloadsBeforeClick);
    finishRequest({ data: { id: "smart", displayName: "Smart", recipeId: "consumer-recipe--remote-model", enabled: true } });
    await pending;
  });

  it("uses the canonical Default, Fast, Smart chat order and Fast, Smart cloud-button order", async () => {
    const { controller, elements, calls } = setup();
    await controller.sync(false);
    const remoteCard = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[0]!;
    expect(FIXED_ROUTES.map((route) => route.id)).toEqual(["default", "fast", "smart"]);
    expect(CLOUD_ROUTES.map((route) => route.id)).toEqual(["fast", "smart"]);
    expect([...remoteCard.querySelectorAll(".recipe-route-toggle .route-symbol")].map((button) => button.className)).toEqual(expect.arrayContaining([expect.stringContaining("route-fast"), expect.stringContaining("route-smart")]));
    expect(remoteCard.querySelector(".recipe-route-toggle .route-symbol:first-child")?.classList.contains("route-fast")).toBe(true);
    expect(remoteCard.querySelector(".route-subagent")).toBeNull();

    click(remoteCard.querySelector<HTMLButtonElement>(".route-fast")!);

    await vi.waitFor(() => expect(calls.api).toHaveBeenCalledWith(
      "/api/v1/cloud-routes/fast",
      "PUT",
      { recipeId: "consumer-recipe--remote-model" },
    ));
    expect(elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[0]?.querySelector(".route-fast")?.classList.contains("active")).toBe(true);

    click(elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[0]!.querySelector<HTMLButtonElement>(".route-fast")!);
    await vi.waitFor(() => expect(calls.api).toHaveBeenCalledWith("/api/v1/cloud-routes/fast", "DELETE"));
    expect(elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[0]?.querySelector(".route-fast")?.classList.contains("active")).toBe(false);
  });

  it("removes a connection and its cards from the workspace", async () => {
    const listConsumerConnections = vi.fn()
      .mockResolvedValueOnce([{ id: "remote-1", displayName: "Remote API", baseUrl: "https://remote.test/v1", authType: "bearer", hasCredential: true, template: "openai-compatible", models: [], mediaModels: [], updatedAt: "now" }])
      .mockResolvedValue([]);
    const { controller, elements, bridge, calls } = setup({ listConsumerConnections });
    await controller.sync(false);
    expect(elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")).toHaveLength(1);
    const remoteCard = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[0]!;
    const remove = [...remoteCard.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove")!;
    click(remove);
    expect(remove.textContent).toBe("Confirm");
    click(remove);
    await vi.waitFor(() => expect(bridge.removeConsumerConnection).toHaveBeenCalledWith("remote-1"));
    await vi.waitFor(() => expect(elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")).toHaveLength(0));
    expect(calls.showStatus).toHaveBeenCalledWith("Connection removed", "success");
  });

  it("collapses and expands a connection without losing state across re-renders", async () => {
    const { controller, elements } = setup();
    await controller.sync(false);
    let cards = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card");
    expect(cards).toHaveLength(1);
    const remoteToggle = cards[0]!.querySelector<HTMLButtonElement>(".collapsible-toggle")!;
    expect(remoteToggle.getAttribute("aria-expanded")).toBe("true");
    expect(cards[0]!.querySelectorAll(".recipe-card").length).toBeGreaterThan(0);

    click(remoteToggle);
    cards = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card");
    expect(cards[0]!.classList.contains("collapsed")).toBe(true);
    expect(cards[0]!.querySelectorAll(".recipe-card")).toHaveLength(0);
    expect(cards[0]!.querySelector<HTMLButtonElement>(".collapsible-toggle")!.getAttribute("aria-expanded")).toBe("false");

    // A re-render (search filtering) keeps the collapsed connection collapsed.
    elements.search.value = "remote";
    elements.search.dispatchEvent(new Event("input", { bubbles: true }));
    cards = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.classList.contains("collapsed")).toBe(true);

    click(cards[0]!.querySelector<HTMLButtonElement>(".collapsible-toggle")!);
    cards = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card");
    expect(cards[0]!.classList.contains("collapsed")).toBe(false);
    expect(cards[0]!.querySelectorAll(".recipe-card").length).toBeGreaterThan(0);
    expect(cards[0]!.querySelector<HTMLButtonElement>(".collapsible-toggle")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("persists collapsed connections across syncs and leaves route actions untouched", async () => {
    const { controller, elements, calls } = setup();
    await controller.sync(false);
    const remoteCard = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[0]!;
    click(remoteCard.querySelector<HTMLButtonElement>(".collapsible-toggle")!);
    expect(JSON.parse(localStorage.getItem("fitz-collapsed-connections") ?? "[]")).toContain("remote-1");

    await controller.sync(false);
    let cards = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card");
    expect(cards[0]!.classList.contains("collapsed")).toBe(true);

    // Route assignment still works on an expanded card without collapsing it.
    selectInferenceTab(elements, "local");
    cards = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card");
    click(cards[0]!.querySelector<HTMLButtonElement>(".route-default")!);
    await vi.waitFor(() => expect(calls.api).toHaveBeenCalledWith("/api/v1/management/routes/default", "PUT", expect.objectContaining({ recipeId: "local-recipe" })));
    expect(elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[0]!.classList.contains("collapsed")).toBe(false);
  });

  it("renders media model cards with modality badges and disabled incompatible toggles", async () => {
    const mediaRemote = {
      id: "fal-1", displayName: "Fal", baseUrl: "", authType: "none" as const, hasCredential: false, template: "fal" as const,
      models: [],
      mediaModels: [
        { id: "fal-ai/flux/dev", routeId: "consumer--media--fal-1--img", recipeId: "consumer-recipe--media--fal-1--flux", modality: "image" as const, template: "fal" as const },
        { id: "fal-ai/minimax-video", routeId: "consumer--media--fal-1--vid", recipeId: "consumer-recipe--media--fal-1--minimax", modality: "video" as const, template: "fal" as const },
      ],
      updatedAt: "now",
    };
    const { controller, elements } = setup({ listConsumerConnections: vi.fn(async () => [mediaRemote]) });
    await controller.sync(false);

    const card = [...elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")][0]!;
    expect(card.textContent).not.toContain("Media generation");
    const mediaCards = [...card.querySelectorAll<HTMLElement>(".media-recipe-card")];
    expect(mediaCards).toHaveLength(2);
    expect(mediaCards[0]!.querySelector(".recipe-display-name")?.textContent).toBe("fal-ai/flux/dev");
    expect(mediaCards[0]!.querySelector(".recipe-card-label")?.textContent).toBe("fal-ai/flux/dev");
    expect(mediaCards[0]!.querySelectorAll(".media-modality-badge")).toHaveLength(1);
    expect(mediaCards[0]!.querySelector(".media-modality-badge")?.textContent).toBe("Image");

    // The image model can only toggle the image route; video and audio are disabled.
    const imageToggles = mediaCards[0]!.querySelectorAll<HTMLButtonElement>(".route-media");
    expect(imageToggles[0]!.classList.contains("route-image")).toBe(true);
    expect(imageToggles[0]!.disabled).toBe(false);
    expect(imageToggles[1]!.disabled).toBe(true);
    expect(imageToggles[2]!.disabled).toBe(true);
    expect(imageToggles[1]!.title).toContain("does not generate video");
    expect(MEDIA_ROUTES.find((route) => route.id === "video")?.icon).toContain("route-icon-negative");
    expect(MEDIA_ROUTES.find((route) => route.id === "audio")?.icon).toContain("route-icon-wave");
  });

  it("renames local ComfyUI recipes inline without opening a detail page", async () => {
    const { controller, elements, calls } = setup();
    await controller.sync(false);
    controller.setConfiguration({
      isAdministrator: true,
      recipes: [{
        id: "h3-video",
        playbookId: "comfyui",
        adapter: "comfyui",
        displayName: "MiniMax H3",
        modelId: "minimax-h3-fl2va-int8",
        configuration: { comfyuiWorkflow: { output: "video" } },
        capabilities: { chatCompletions: false, modalities: { output: ["video"] } },
      }],
      routes: [],
      cloudRoutes: {},
    });
    selectInferenceTab(elements, "local");

    const details = elements.connections.querySelector<HTMLElement>(".media-recipe-card .recipe-card-details")!;
    expect(details).not.toBeInstanceOf(HTMLButtonElement);
    click(details);
    expect(controller.editorOpen).toBe(false);
    expect(controller.openRoute(["model", "hosted--local--comfyui", "h3-video"])).toBe(false);

    click(elements.connections.querySelector<HTMLButtonElement>('[aria-label="Rename model"]')!);
    const name = elements.connections.querySelector<HTMLInputElement>(".local-model-name-input")!;
    expect(name.value).toBe("MiniMax H3");
    name.value = "H3 Video";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    expect(elements.connections.querySelector<HTMLButtonElement>('[aria-label="Save model name"]')).not.toBeNull();
    expect(elements.connections.querySelector<HTMLButtonElement>('[aria-label="Cancel rename"]')).not.toBeNull();
    click(elements.connections.querySelector<HTMLButtonElement>('[aria-label="Save model name"]')!);

    await vi.waitFor(() => expect(calls.api).toHaveBeenCalledWith(
      "/api/v1/management/recipes/h3-video",
      "PUT",
      expect.objectContaining({ displayName: "H3 Video", configuration: { comfyuiWorkflow: { output: "video" } } }),
    ));
    const payload = calls.api.mock.calls.find(([path]) => path === "/api/v1/management/recipes/h3-video")?.[2] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("agentTopology");
    await vi.waitFor(() => expect(calls.showStatus).toHaveBeenCalledWith("Model name updated", "success"));
    expect(elements.connections.querySelector<HTMLInputElement>(".local-model-name-input")).toBeNull();
    expect(elements.connections.querySelector<HTMLButtonElement>('[aria-label="Rename model"]')).not.toBeNull();
  });

  it("assigns a well-known media route", async () => {
    const mediaRemote = {
      id: "media-1", displayName: "Media", baseUrl: "https://media.test/v1", authType: "none" as const, hasCredential: false, template: "openai-media" as const,
      models: [],
      mediaModels: [
        { id: "dall-e-3", routeId: "consumer--media--media-1--img", recipeId: "consumer-recipe--media--media-1--dalle", modality: "image" as const, template: "openai-media" as const },
      ],
      updatedAt: "now",
    };
    const { controller, elements, calls } = setup({ listConsumerConnections: vi.fn(async () => [mediaRemote]) });
    await controller.sync(false);

    const mediaCard = elements.connections.querySelector<HTMLElement>(".media-recipe-card")!;
    const imageToggle = mediaCard.querySelector<HTMLButtonElement>(".route-image")!;
    click(imageToggle);
    await vi.waitFor(() => expect(calls.api).toHaveBeenCalledWith("/api/v1/management/routes/image", "PUT", expect.objectContaining({ recipeId: "consumer-recipe--media--media-1--dalle", enabled: true })));
    await vi.waitFor(() => {
      const fresh = elements.connections.querySelector<HTMLElement>(".media-recipe-card")!.querySelector<HTMLButtonElement>(".route-image")!;
      expect(fresh.classList.contains("active")).toBe(true);
    });
    expect(calls.showStatus).not.toHaveBeenCalledWith("Image route updated", "success");

    click(elements.connections.querySelector<HTMLElement>(".media-recipe-card")!.querySelector<HTMLButtonElement>(".route-image")!);
    await vi.waitFor(() => expect(calls.api).toHaveBeenCalledWith("/api/v1/management/routes/image", "PUT", expect.objectContaining({ recipeId: "", enabled: false })));
    expect(elements.connections.querySelector<HTMLElement>(".media-recipe-card")!.querySelector(".route-image")?.classList.contains("active")).toBe(false);
  });

  it("hides the base URL for fal/replicate templates and sends model IDs", async () => {
    const { controller, elements, bridge } = setup();
    click(elements.newConnection);

    expect(elements.urlField.hidden).toBe(false);
    elements.template.value = "fal";
    elements.template.dispatchEvent(new Event("change", { bubbles: true }));
    expect(elements.urlField.hidden).toBe(true);
    expect(elements.url.required).toBe(false);
    expect(elements.modelIdsField.hidden).toBe(false);

    elements.name.value = "Fal";
    elements.modelIds.value = "fal-ai/flux/dev, fal-ai/minimax-video";
    elements.apiKey.value = "fal-token";
    elements.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(bridge.saveConsumerConnection).toHaveBeenCalledWith({ displayName: "Fal", template: "fal", authType: "bearer", apiKey: "fal-token", executionClass: "metered_cloud", modelIds: ["fal-ai/flux/dev", "fal-ai/minimax-video"] }));
  });
});
