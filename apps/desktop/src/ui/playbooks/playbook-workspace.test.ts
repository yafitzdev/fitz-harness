// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybookWorkspaceController, type PlaybookWorkspaceElements } from "./playbook-workspace.js";
import { RecipeConfigurationEditor } from "./recipe-configuration-editor.js";

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

// happy-dom does not ship the global `Option` constructor used by the editor
// selects; polyfill it with real option elements so select.add() and value
// binding behave like the browser.
if (typeof globalThis.Option === "undefined") {
  (globalThis as any).Option = function Option(this: HTMLOptionElement, text = "", value?: string, defaultSelected = false, selected = false) {
    const option = document.createElement("option");
    option.text = text;
    if (value !== undefined) option.value = value;
    option.defaultSelected = defaultSelected;
    option.selected = selected;
    return option;
  };
}

type Json = Record<string, any>;

function node<T extends HTMLElement>(tag: string): T {
  const element = document.createElement(tag) as T;
  document.body.append(element);
  return element;
}

function sampleConfiguration(): Json {
  return {
    engineRoot: "C:\\Users\\me\\.llm\\engines",
    engineFolders: [
      {
        folderName: "ninfer", rootPath: "C:\\Users\\me\\.llm\\engines\\ninfer",
        engine: {
          displayName: "NiNfer", connectionMode: "managed", runtime: "linux-managed", baseUrl: "http://127.0.0.1:18080",
          healthPath: "/v1/models", launchCommand: "./run", launchArguments: ["--host", "127.0.0.1"], workingDirectory: ".", runtimeId: "inference-linux",
        },
        registered: true,
      },
      { folderName: "scratch", rootPath: "C:\\Users\\me\\.llm\\engines\\scratch" },
    ],
    recipes: [
      { id: "ninfer-qwen36", playbookId: "ninfer", displayName: "Qwen 3.6", adapter: "openai-managed", modelId: "Qwen3.6", contextTokens: 131072, configuration: {} },
    ],
    routes: [],
  };
}

function setup(
  configuration: Json | undefined = sampleConfiguration(),
  api = vi.fn(async (_path: string, _method?: string, _body?: unknown) => ({ data: {} })),
) {
  const elements: PlaybookWorkspaceElements = {
    page: node("section"), list: node("div"), search: node("input"), title: node("h1"), description: node("p"),
    browser: node("div"), editor: node("section"), closeEditorButtons: [node("button"), node("button")],
    refresh: node("button"),
    engineForm: node("form"), engineFolder: node("select"), engineDisplayName: node("input"), engineConnection: node("select"),
    engineRuntime: node("select"), engineBaseUrl: node("input"), engineHealthPath: node("input"), engineCommand: node("input"),
    engineArguments: node("textarea"), engineWorkingDirectory: node("input"), engineRuntimeId: node("input"),
    engineManagedFields: node("div"), engineRuntimeField: node("div"), engineBaseUrlField: node("div"), engineRuntimeIdField: node("div"),
    engineEditorTitle: node("h1"),
    recipeForm: node("form"), recipePlaybookId: node("input"), recipeId: node("input"), recipeDisplayName: node("input"),
    recipeAdapter: node("input"), recipeModelId: node("input"), recipeContextTokens: node("input"), recipeConfiguration: node("section"),
    recipeEditorTitle: node("h1"), recipeEditorEyebrow: node("small"), recipeEditorDescription: node("p"),
    recipeRename: node("button"), recipeIdentityFields: node("div"),
  };
  elements.editor.hidden = true;
  elements.engineForm.hidden = true;
  elements.recipeForm.hidden = true;
  // Mirror the static markup in renderer/index.html so that setting
  // select.value behaves like it does in the real page.
  for (const value of ["managed", "external"]) elements.engineConnection.add(new Option(value, value));
  elements.engineRuntime.add(new Option("linux-managed", "linux-managed"));
  const showStatus = vi.fn();
  const reloadConfiguration = vi.fn(async () => configuration);
  const onRouteChange = vi.fn();
  const controller = new PlaybookWorkspaceController(elements, {
    api,
    reloadConfiguration,
    showStatus,
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    onRouteChange,
  });
  controller.setConfiguration(configuration);
  return { controller, elements, showStatus, reloadConfiguration, onRouteChange, api };
}

function submit(form: HTMLFormElement): void { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }
function click(target: Element): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
function change(target: Element): void { target.dispatchEvent(new Event("change", { bubbles: true })); }

beforeEach(() => {
  // happy-dom ships an empty localStorage stub without a working clear(); install a real one.
  globalThis.localStorage = memoryStorage();
  document.body.replaceChildren();
});
afterEach(() => vi.useRealTimers());

describe("PlaybookWorkspaceController", () => {
  it("renders engine folders as playbook cards with their recipes", () => {
    const { controller, elements } = setup();
    controller.render();

    const cards = elements.list.querySelectorAll(".playbook-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.querySelector("h3")?.textContent).toBe("NiNfer");
    expect(cards[0]!.querySelectorAll(".recipe-card")).toHaveLength(1);
    expect(cards[0]!.querySelector(".recipe-display-name")?.textContent).toBe("Qwen 3.6");
    expect(cards[0]!.querySelector(".recipe-card-label")?.textContent).toBe("Qwen3.6");
    expect(cards[0]!.textContent).toContain("131k ctx");
    // Registered engines offer Configure and Add recipe; unregistered folders offer Set up.
    expect([...cards[0]!.querySelectorAll<HTMLButtonElement>(".collapsible-actions button")].map((button) => button.textContent)).toEqual(["Configure", "Add recipe"]);
    expect([...cards[1]!.querySelectorAll<HTMLButtonElement>(".collapsible-actions button")].map((button) => button.textContent)).toEqual(["Set up"]);
    expect(cards[1]!.querySelector("h3")?.textContent).toBe("Unconfigured engine");
    expect((cards[1] as HTMLElement).title).toBe("Engine folder: scratch");
    expect(elements.title.textContent).toBe("Playbooks");
  });

  it("joins Windows engine folders to canonical playbook ids without case drift", () => {
    const configuration = sampleConfiguration();
    configuration.engineFolders = [{ folderName: "ComfyUI", rootPath: "C:\\Users\\me\\.llm\\engines\\ComfyUI", registered: true, engine: { displayName: "comfyui" } }];
    configuration.recipes = [{ id: "h3-video", playbookId: "comfyui", displayName: "MiniMax H3", modelId: "minimax-h3", contextTokens: 1, configuration: {} }];
    const { controller, elements } = setup(configuration);
    controller.render();
    expect(elements.list.querySelector("h3")?.textContent).toBe("comfyui");
    expect(elements.list.querySelector(".recipe-display-name")?.textContent).toBe("MiniMax H3");
    expect(elements.list.textContent).not.toContain("Set up");
  });

  it("filters folders and recipes by the search query", () => {
    const { controller, elements } = setup();
    controller.render();

    elements.search.value = "qwen";
    elements.search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(elements.list.querySelectorAll(".playbook-card")).toHaveLength(1);
    expect(elements.list.querySelector("h3")?.textContent).toBe("NiNfer");

    elements.search.value = "no-such-engine";
    elements.search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(elements.list.textContent).toContain("No engine folders found");
  });

  it("shows loading and unavailable states", () => {
    const { controller, elements } = setup();
    controller.showLoading();
    expect(elements.list.textContent).toContain("Loading playbooks…");

    controller.setConfiguration(undefined);
    controller.render();
    expect(elements.list.textContent).toContain("Management data is unavailable");

    controller.showUnavailable("network down");
    expect(elements.list.textContent).toContain("network down");
  });

  it("does not render recipe test actions for chat or media recipes", () => {
    const configuration = sampleConfiguration();
    configuration.recipes.push({
      id: "h3-video", playbookId: "ninfer", displayName: "H3 Video", adapter: "openai-managed", modelId: "MiniMax-H3", contextTokens: 0,
      capabilities: { chatCompletions: false, modalities: { output: ["video", "audio"] } }, configuration: {},
    });
    const { controller, elements } = setup(configuration);
    controller.render();
    expect(elements.list.querySelectorAll(".recipe-card")).toHaveLength(2);
    expect(elements.list.querySelector(".recipe-test-button")).toBeNull();
    expect(elements.list.textContent).not.toContain("Test");
  });

  it("opens the engine editor with the folder applied and saves it", async () => {
    const { controller, elements, api, reloadConfiguration, showStatus } = setup();
    controller.render();

    const configure = [...elements.list.querySelectorAll<HTMLButtonElement>(".collapsible-actions button")].find((button) => button.textContent === "Configure")!;
    click(configure);

    expect(elements.editor.hidden).toBe(false);
    expect(elements.browser.hidden).toBe(true);
    expect(elements.engineForm.hidden).toBe(false);
    expect(elements.recipeForm.hidden).toBe(true);
    expect(controller.editorOpen).toBe(true);
    expect(elements.engineEditorTitle.textContent).toBe("Configure engine");
    expect(elements.engineFolder.value).toBe("ninfer");
    expect(elements.engineDisplayName.value).toBe("NiNfer");
    expect(elements.engineCommand.value).toBe("./run");
    expect(elements.engineArguments.value).toBe("--host\n127.0.0.1");

    // Switching the folder repopulates the managed fields for an unregistered engine.
    elements.engineFolder.value = "scratch";
    change(elements.engineFolder);
    expect(elements.engineDisplayName.value).toBe("scratch");
    expect(elements.engineConnection.value).toBe("managed");

    submit(elements.engineForm);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/engines/scratch", "PUT", expect.objectContaining({ displayName: "scratch", connectionMode: "managed" })));
    await vi.waitFor(() => expect(controller.editorOpen).toBe(false));
    expect(reloadConfiguration).toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith("Engine configuration saved", "success");
  });

  it("creates a recipe from an engine's managed configuration and saves it", async () => {
    const { controller, elements, api, reloadConfiguration, showStatus } = setup();
    controller.render();

    const addRecipe = [...elements.list.querySelectorAll<HTMLButtonElement>(".collapsible-actions button")].find((button) => button.textContent === "Add recipe")!;
    click(addRecipe);

    expect(elements.recipeForm.hidden).toBe(false);
    expect(elements.engineForm.hidden).toBe(true);
    expect(elements.recipeEditorTitle.textContent).toBe("Create recipe");
    expect(elements.recipePlaybookId.value).toBe("ninfer");
    expect(elements.recipePlaybookId.readOnly).toBe(true);
    expect(elements.recipeAdapter.value).toBe("openai-managed");
    expect(elements.recipeConfiguration.textContent).toContain("Engine folder");
    expect(elements.recipeConfiguration.querySelector<HTMLInputElement>('input[data-label="Engine folder"]')?.value).toContain("ninfer");

    elements.recipeId.value = "ninfer-extra";
    elements.recipeDisplayName.value = "Extra model";
    elements.recipeModelId.value = "model.gguf";
    elements.recipeContextTokens.value = "65536";
    submit(elements.recipeForm);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/recipes/ninfer-extra", "PUT", expect.objectContaining({
      playbookId: "ninfer", displayName: "Extra model", adapter: "openai-managed", modelId: "model.gguf", contextTokens: 65536,
    })));
    await vi.waitFor(() => expect(controller.editorOpen).toBe(false));
    expect(reloadConfiguration).toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith("Recipe saved", "success");
  });

  it("uses typed recipe fields instead of exposing raw configuration JSON", async () => {
    const { controller, elements, api } = setup();
    controller.render();
    click([...elements.list.querySelectorAll<HTMLButtonElement>(".collapsible-actions button")].find((button) => button.textContent === "Add recipe")!);

    elements.recipeId.value = "ninfer-extra";
    const enginePath = elements.recipeConfiguration.querySelector<HTMLInputElement>('input[data-label="Engine folder"]')!;
    enginePath.value = "C:\\engines\\ninfer";
    submit(elements.recipeForm);

    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/recipes/ninfer-extra", "PUT", expect.objectContaining({
      configuration: expect.objectContaining({ enginePath: "C:\\engines\\ninfer" }),
    })));
    expect(elements.recipeConfiguration.querySelector("textarea:not([data-field-type])")).toBeNull();
  });

  it("edits only the anonymous worker pool and derives the main agent context", async () => {
    const configuration = sampleConfiguration();
    configuration.recipes[0] = {
      id: "qwen-team", playbookId: "ninfer", displayName: "Qwen Team", adapter: "ninfer", modelId: "qwen3.8-27b", contextTokens: 262_144,
      capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: false, minP: false, maxConcurrentGenerations: 3 },
      lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
      configuration: { executable: "ninfer-serve", artifact: "qwen.ninfer", maxContext: 144_320 },
      agentTopology: { sharedContextTokens: 272_320, workers: { count: 2, contextTokens: 64_000 } },
    };
    const { controller, elements, api } = setup(configuration);
    controller.render();
    click(elements.list.querySelector(".recipe-card-details")!);

    expect(elements.recipeEditorTitle.textContent).toBe("Qwen Team");
    expect(elements.recipeRename.hidden).toBe(false);
    expect(elements.recipeEditorDescription.hidden).toBe(true);
    expect(elements.recipeIdentityFields.hidden).toBe(true);
    expect(elements.recipeConfiguration.textContent).not.toContain("Model limit");
    expect(elements.recipeConfiguration.textContent).not.toContain("Shared capacity");
    expect(elements.recipeConfiguration.textContent).not.toContain("Runtime settings");
    expect(elements.recipeConfiguration.textContent).not.toContain("Server executable");
    expect(elements.recipeConfiguration.textContent).not.toContain("Maximum context");
    expect(elements.recipeConfiguration.textContent).not.toContain("Agent topology");
    expect(elements.recipeConfiguration.textContent).not.toContain("The main agent is automatic");
    expect(elements.recipeConfiguration.textContent).not.toContain("Worker instructions");
    expect(elements.recipeConfiguration.textContent).not.toContain("Worker role");
    expect(elements.recipeConfiguration.textContent).not.toContain("Shared context pool");
    expect(elements.recipeConfiguration.textContent).not.toContain("Concurrency:");
    expect(elements.recipeConfiguration.textContent).not.toContain("144,320 + 2 × 64,000");
    expect(elements.recipeConfiguration.querySelector<HTMLElement>("[data-agent-main-context]")?.textContent).toBe("144,320 context");
    const count = elements.recipeConfiguration.querySelector<HTMLInputElement>("[data-agent-worker-count]")!;
    const workerContext = elements.recipeConfiguration.querySelector<HTMLInputElement>("[data-agent-worker-context]")!;
    expect(count.value).toBe("2");
    expect(workerContext.value).toBe("64000");
    expect(workerContext.step).toBe("1");
    expect(workerContext.checkValidity()).toBe(true);

    count.value = "1"; count.dispatchEvent(new Event("input", { bubbles: true }));
    workerContext.value = "32000"; workerContext.dispatchEvent(new Event("input", { bubbles: true }));
    expect(elements.recipeConfiguration.querySelector<HTMLElement>("[data-agent-main-context]")?.textContent).toBe("240,320 context");

    submit(elements.recipeForm);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/recipes/qwen-team", "PUT", expect.objectContaining({
      contextTokens: 262_144,
      agentTopology: { sharedContextTokens: 272_320, workers: { count: 1, contextTokens: 32_000 } },
      configuration: expect.objectContaining({ maxContext: 144_320 }),
    })));
  });

  it("renames an existing recipe inline from the header pen", () => {
    const { controller, elements } = setup();
    controller.render();
    click(elements.list.querySelector(".recipe-card-details")!);

    expect(elements.recipeEditorTitle.textContent).toBe("Qwen 3.6");
    expect(elements.recipeDisplayName.hidden).toBe(true);
    click(elements.recipeRename);
    expect(elements.recipeEditorTitle.hidden).toBe(true);
    expect(elements.recipeDisplayName.hidden).toBe(false);

    elements.recipeDisplayName.value = "My Qwen";
    elements.recipeDisplayName.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(elements.recipeEditorTitle.textContent).toBe("My Qwen");
    expect(elements.recipeEditorTitle.hidden).toBe(false);
    expect(elements.recipeDisplayName.hidden).toBe(true);
  });

  it("rejects an unknown adapter instead of silently applying another adapter's fields", () => {
    const editor = new RecipeConfigurationEditor(document.createElement("section"));
    expect(() => editor.load("unknown-adapter", {})).toThrow("Unsupported recipe adapter: unknown-adapter");
  });

  it("keeps request sampling out of recipe configuration", () => {
    const root = document.createElement("section");
    const editor = new RecipeConfigurationEditor(root);
    editor.load("ninfer", { temperature: 0.4, topP: 0.9, topK: 20, thinking: false });
    expect(root.textContent).not.toContain("Temperature");
    expect(root.textContent).not.toContain("Top P");
    expect(root.textContent).not.toContain("Top K");
    expect(root.textContent).not.toContain("Thinking mode");
    expect(editor.value().temperature).toBe(0.4);
  });

  it.each(["llama.cpp", "vllm"])("configures anonymous workers for %s recipes", (playbookId) => {
    const root = document.createElement("section");
    const editor = new RecipeConfigurationEditor(root);
    editor.load("openai-managed", {}, {
      playbookId,
      contextTokens: 32_768,
      capabilities: { chatCompletions: true, toolCalls: true, maxConcurrentGenerations: 3 },
      agentTopology: { sharedContextTokens: 32_768, workers: { count: 0, contextTokens: 8_192 } },
    });

    const workers = root.querySelector<HTMLInputElement>("[data-agent-worker-count]");
    const workerContext = root.querySelector<HTMLInputElement>("[data-agent-worker-context]");
    expect(workers?.disabled).toBe(false);
    expect(workers?.max).toBe("2");
    expect(workerContext?.disabled).toBe(false);
    expect(editor.agentTopology()).toEqual({ sharedContextTokens: 32_768, workers: { count: 0, contextTokens: 8_192 } });
  });

  it("refreshes from the page header and closes the editor with the back surface", () => {
    const { controller, elements, reloadConfiguration, onRouteChange } = setup();
    controller.render();
    click(elements.refresh);
    expect(reloadConfiguration).toHaveBeenCalled();

    controller.openEngineEditor();
    expect(controller.editorOpen).toBe(true);
    expect(onRouteChange).toHaveBeenLastCalledWith(["engine", "scratch"]);
    controller.closeEditor();
    expect(elements.editor.hidden).toBe(true);
    expect(elements.browser.hidden).toBe(false);
    expect(elements.engineForm.hidden).toBe(true);
    expect(elements.recipeForm.hidden).toBe(true);
    expect(onRouteChange).toHaveBeenLastCalledWith(undefined);

    controller.openEngineEditor();
    click(elements.closeEditorButtons[0]!);
    expect(controller.editorOpen).toBe(false);
  });

  it("reopens a recorded editor location for forward navigation", () => {
    const { controller, elements, onRouteChange } = setup();

    expect(controller.openRoute(["recipe", "ninfer", "ninfer-qwen36"])).toBe(true);
    expect(elements.recipeForm.hidden).toBe(false);
    expect(elements.recipeId.value).toBe("ninfer-qwen36");
    expect(onRouteChange).toHaveBeenLastCalledWith(["recipe", "ninfer", "ninfer-qwen36"]);

    controller.closeEditor();
    expect(controller.openRoute(["engine", "missing"])).toBe(false);
    expect(controller.editorOpen).toBe(false);
  });

  it("collapses and expands a playbook without losing state across re-renders", () => {
    const { controller, elements } = setup();
    controller.render();
    let cards = elements.list.querySelectorAll<HTMLElement>(".playbook-card");
    const toggle = cards[0]!.querySelector<HTMLButtonElement>(".collapsible-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(cards[0]!.querySelectorAll(".recipe-card")).toHaveLength(1);

    click(toggle);
    cards = elements.list.querySelectorAll<HTMLElement>(".playbook-card");
    expect(cards[0]!.classList.contains("collapsed")).toBe(true);
    expect(cards[0]!.querySelectorAll(".recipe-card")).toHaveLength(0);
    expect(cards[0]!.querySelector<HTMLButtonElement>(".collapsible-toggle")!.getAttribute("aria-expanded")).toBe("false");

    // A re-render (search filtering) keeps the collapsed playbook collapsed.
    elements.search.value = "ninfer";
    elements.search.dispatchEvent(new Event("input", { bubbles: true }));
    cards = elements.list.querySelectorAll<HTMLElement>(".playbook-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.classList.contains("collapsed")).toBe(true);

    click(cards[0]!.querySelector<HTMLButtonElement>(".collapsible-toggle")!);
    cards = elements.list.querySelectorAll<HTMLElement>(".playbook-card");
    expect(cards[0]!.classList.contains("collapsed")).toBe(false);
    expect(cards[0]!.querySelectorAll(".recipe-card")).toHaveLength(1);
    expect(cards[0]!.querySelector<HTMLButtonElement>(".collapsible-toggle")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("persists collapsed playbooks and keeps Configure actions usable", () => {
    const { controller, elements } = setup();
    controller.render();
    const cards = elements.list.querySelectorAll<HTMLElement>(".playbook-card");
    click(cards[0]!.querySelector<HTMLButtonElement>(".collapsible-toggle")!);
    expect(JSON.parse(localStorage.getItem("fitz-collapsed-playbooks") ?? "[]")).toContain("ninfer");

    controller.render();
    const collapsedCards = elements.list.querySelectorAll<HTMLElement>(".playbook-card");
    expect(collapsedCards[0]!.classList.contains("collapsed")).toBe(true);

    // Heading actions still work without toggling the collapse state.
    click(collapsedCards[0]!.querySelector<HTMLButtonElement>(".collapsible-actions button")!);
    expect(collapsedCards[0]!.classList.contains("collapsed")).toBe(true);
    expect(elements.editor.hidden).toBe(false);
  });
});
