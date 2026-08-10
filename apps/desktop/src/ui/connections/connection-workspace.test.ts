// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionWorkspaceController, MEDIA_ROUTES, type ConnectionWorkspaceBridge } from "./connection-workspace.js";

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
  const remote = { id: "remote-1", displayName: "Remote API", baseUrl: "https://remote.test/v1", authType: "bearer" as const, hasCredential: true, template: "openai-compatible" as const, models: [{ id: "remote-model", routeId: "", recipeId: "consumer-recipe--remote-model" }], mediaModels: [], updatedAt: "now" };
  const bridge: ConnectionWorkspaceBridge = {
    syncConsumerConnections: vi.fn(async () => []),
    listConsumerConnections: vi.fn(async () => [remote]),
    saveConsumerConnection: vi.fn(async () => remote),
    removeConsumerConnection: vi.fn(async () => undefined),
    ...overrides,
  };
  let configuration = {
    hostName: "YanPC",
    recipes: [{ id: "local-recipe", displayName: "Local Model", modelId: "local.gguf", contextTokens: 100_000, capabilities: { chatCompletions: true } }],
    routes: [] as Array<Record<string, unknown>>,
  };
  const calls = {
    api: vi.fn(async (path: string, _method?: string, body?: unknown) => { const match = /\/routes\/([^/]+)$/.exec(path); if (match) configuration = { ...configuration, routes: [{ id: match[1]!, recipeId: String((body as { recipeId?: unknown } | undefined)?.recipeId ?? "") }] }; return { data: {} }; }),
    reloadConfiguration: vi.fn(async () => configuration),
    testRecipe: vi.fn(async () => undefined),
    renderRecipeTestState: vi.fn(),
    closePopovers: vi.fn(),
    showStatus: vi.fn(),
    errorMessage: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)),
  };
  const controller = new ConnectionWorkspaceController({ mount, bridge, ...calls });
  return { controller, elements: controller.elements, bridge, calls, remote };
}

function click(target: Element): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }

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

    expect(elements.connections.querySelectorAll(".consumer-playbook-card")).toHaveLength(2);
    expect(elements.connections.textContent).toContain("YanPC");
    expect(elements.connections.textContent).toContain("Local Model");
    expect(elements.connections.textContent).toContain("Remote API");
    expect(elements.connections.querySelector(".media-text")?.textContent).toBe("Text");
    expect(calls.showStatus).toHaveBeenCalledWith("Remote unavailable", "error");

    elements.search.value = "local.gguf";
    elements.search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(elements.connections.querySelectorAll(".consumer-playbook-card")).toHaveLength(1);
    expect(elements.connections.textContent).toContain("YanPC");
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

  it("owns editor auth state and saves a new OpenAI-compatible connection", async () => {
    const { controller, elements, bridge, calls } = setup();
    click(elements.newConnection);
    expect(controller.editorOpen).toBe(true);
    expect(elements.listView.hidden).toBe(true);

    elements.name.value = "Self hosted";
    elements.url.value = "http://127.0.0.1:8000/v1";
    elements.auth.value = "none";
    elements.auth.dispatchEvent(new Event("change", { bubbles: true }));
    expect(elements.apiKeyField.hidden).toBe(true);
    expect(elements.apiKey.required).toBe(false);

    elements.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(bridge.saveConsumerConnection).toHaveBeenCalledWith({ displayName: "Self hosted", baseUrl: "http://127.0.0.1:8000/v1", authType: "none", template: "openai-compatible" }));
    await vi.waitFor(() => expect(controller.editorOpen).toBe(false));
    expect(bridge.listConsumerConnections).toHaveBeenCalled();
    await vi.waitFor(() => expect(calls.showStatus).toHaveBeenCalledWith("Connection added", "success"));
  });

  it("assigns global routes from any connection and delegates recipe tests", async () => {
    const { controller, elements, calls } = setup();
    await controller.sync(false);
    const cards = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card");
    const remoteCard = cards[1]!;
    const fast = remoteCard.querySelector<HTMLButtonElement>(".route-fast")!;
    click(fast);
    await vi.waitFor(() => expect(calls.api).toHaveBeenCalledWith("/api/v1/management/routes/fast", "PUT", expect.objectContaining({ recipeId: "consumer-recipe--remote-model" })));
    await vi.waitFor(() => expect(elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[1]?.querySelector(".route-fast")?.classList.contains("active")).toBe(true));
    expect(calls.showStatus).toHaveBeenCalledWith("Fast route updated", "success");

    const test = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[1]!.querySelector<HTMLButtonElement>(".recipe-test-button")!;
    click(test);
    expect(calls.testRecipe).toHaveBeenCalledWith(expect.objectContaining({ id: "consumer-recipe--remote-model" }), expect.any(HTMLElement), test);
  });

  it("removes a connection and its cards from the workspace", async () => {
    const listConsumerConnections = vi.fn()
      .mockResolvedValueOnce([{ id: "remote-1", displayName: "Remote API", baseUrl: "https://remote.test/v1", authType: "bearer", hasCredential: true, template: "openai-compatible", models: [], mediaModels: [], updatedAt: "now" }])
      .mockResolvedValue([]);
    const { controller, elements, bridge, calls } = setup({ listConsumerConnections });
    await controller.sync(false);
    expect(elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")).toHaveLength(2);
    const remoteCard = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[1]!;
    const remove = [...remoteCard.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove")!;
    click(remove);
    expect(remove.textContent).toBe("Confirm");
    click(remove);
    await vi.waitFor(() => expect(bridge.removeConsumerConnection).toHaveBeenCalledWith("remote-1"));
    await vi.waitFor(() => expect(elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")).toHaveLength(1));
    expect(calls.showStatus).toHaveBeenCalledWith("Connection removed", "success");
  });

  it("collapses and expands a connection without losing state across re-renders", async () => {
    const { controller, elements } = setup();
    await controller.sync(false);
    let cards = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card");
    expect(cards).toHaveLength(2);
    const remoteToggle = cards[1]!.querySelector<HTMLButtonElement>(".collapsible-toggle")!;
    expect(remoteToggle.getAttribute("aria-expanded")).toBe("true");
    expect(cards[1]!.querySelectorAll(".recipe-card").length).toBeGreaterThan(0);

    click(remoteToggle);
    cards = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card");
    expect(cards[1]!.classList.contains("collapsed")).toBe(true);
    expect(cards[1]!.querySelectorAll(".recipe-card")).toHaveLength(0);
    expect(cards[1]!.querySelector<HTMLButtonElement>(".collapsible-toggle")!.getAttribute("aria-expanded")).toBe("false");

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
    const remoteCard = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[1]!;
    click(remoteCard.querySelector<HTMLButtonElement>(".collapsible-toggle")!);
    expect(JSON.parse(localStorage.getItem("fitz-collapsed-connections") ?? "[]")).toContain("remote-1");

    await controller.sync(false);
    const cards = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card");
    expect(cards[1]!.classList.contains("collapsed")).toBe(true);

    // Route assignment still works on an expanded card without collapsing it.
    click(cards[0]!.querySelector<HTMLButtonElement>(".route-fast")!);
    await vi.waitFor(() => expect(calls.api).toHaveBeenCalledWith("/api/v1/management/routes/fast", "PUT", expect.objectContaining({ recipeId: "local-recipe" })));
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

    const card = [...elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")][1]!;
    expect(card.textContent).not.toContain("Media generation");
    const mediaCards = [...card.querySelectorAll<HTMLElement>(".media-recipe-card")];
    expect(mediaCards).toHaveLength(2);
    expect(mediaCards[0]!.querySelector(".recipe-display-name")?.textContent).toBe("fal-ai/flux/dev");
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
    expect(calls.showStatus).toHaveBeenCalledWith("Image route updated", "success");
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
    elements.auth.value = "none";
    elements.auth.dispatchEvent(new Event("change", { bubbles: true }));
    elements.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(bridge.saveConsumerConnection).toHaveBeenCalledWith({ displayName: "Fal", template: "fal", authType: "none", modelIds: ["fal-ai/flux/dev", "fal-ai/minimax-video"] }));
  });
});
