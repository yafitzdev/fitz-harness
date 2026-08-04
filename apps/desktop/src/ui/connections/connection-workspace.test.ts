// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionWorkspaceController, type ConnectionWorkspaceBridge } from "./connection-workspace.js";

function node<T extends HTMLElement>(tag: string): T {
  const element = document.createElement(tag) as T;
  document.body.append(element);
  return element;
}

function setup(overrides: Partial<ConnectionWorkspaceBridge> = {}) {
  const mount = node("div");
  const remote = { id: "remote-1", displayName: "Remote API", baseUrl: "https://remote.test/v1", authType: "bearer" as const, hasCredential: true, models: [{ id: "remote-model", routeId: "", recipeId: "consumer-recipe--remote-model" }], updatedAt: "now" };
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
    api: vi.fn(async (path: string) => { if (path.includes("/routes/")) configuration = { ...configuration, routes: [{ id: "fast", recipeId: "consumer-recipe--remote-model" }] }; return { data: {} }; }),
    reloadConfiguration: vi.fn(async () => configuration),
    testRecipe: vi.fn(async () => undefined),
    renderRecipeTestState: vi.fn(),
    closePopovers: vi.fn(),
    showToast: vi.fn(),
    errorMessage: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)),
  };
  const controller = new ConnectionWorkspaceController({ mount, bridge, ...calls });
  return { controller, elements: controller.elements, bridge, calls, remote };
}

function click(target: Element): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }

beforeEach(() => document.body.replaceChildren());

describe("ConnectionWorkspaceController", () => {
  it("syncs hosted and remote models, reports failures, and filters the workspace", async () => {
    const syncConsumerConnections = vi.fn(async () => [{ id: "remote-1", connected: false, error: "Remote unavailable" }]);
    const { controller, elements, calls } = setup({ syncConsumerConnections });

    await controller.sync(true);

    expect(elements.connections.querySelectorAll(".consumer-playbook-card")).toHaveLength(2);
    expect(elements.connections.textContent).toContain("YanPC");
    expect(elements.connections.textContent).toContain("Local Model");
    expect(elements.connections.textContent).toContain("Remote API");
    expect(calls.showToast).toHaveBeenCalledWith("Remote unavailable");

    elements.search.value = "local.gguf";
    elements.search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(elements.connections.querySelectorAll(".consumer-playbook-card")).toHaveLength(1);
    expect(elements.connections.textContent).toContain("YanPC");
  });

  it("owns editor auth state and saves a new OpenAI-compatible connection", async () => {
    const { controller, elements, bridge } = setup();
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
    await vi.waitFor(() => expect(bridge.saveConsumerConnection).toHaveBeenCalledWith({ displayName: "Self hosted", baseUrl: "http://127.0.0.1:8000/v1", authType: "none" }));
    await vi.waitFor(() => expect(controller.editorOpen).toBe(false));
    expect(bridge.listConsumerConnections).toHaveBeenCalled();
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

    const test = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[1]!.querySelector<HTMLButtonElement>(".recipe-test-button")!;
    click(test);
    expect(calls.testRecipe).toHaveBeenCalledWith(expect.objectContaining({ id: "consumer-recipe--remote-model" }), expect.any(HTMLElement), test);
  });

  it("removes a connection and its cards from the workspace", async () => {
    const listConsumerConnections = vi.fn()
      .mockResolvedValueOnce([{ id: "remote-1", displayName: "Remote API", baseUrl: "https://remote.test/v1", authType: "bearer", hasCredential: true, models: [], updatedAt: "now" }])
      .mockResolvedValue([]);
    const { controller, elements, bridge } = setup({ listConsumerConnections });
    await controller.sync(false);
    expect(elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")).toHaveLength(2);
    const remoteCard = elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")[1]!;
    const remove = [...remoteCard.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove")!;
    click(remove);
    expect(remove.textContent).toBe("Confirm");
    click(remove);
    await vi.waitFor(() => expect(bridge.removeConsumerConnection).toHaveBeenCalledWith("remote-1"));
    await vi.waitFor(() => expect(elements.connections.querySelectorAll<HTMLElement>(".consumer-playbook-card")).toHaveLength(1));
  });
});
