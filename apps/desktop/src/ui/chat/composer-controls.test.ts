// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayHost } from "../primitives/overlay-host.js";
import { ComposerControls, type ComposerControlsElements } from "./composer-controls.js";

function node<T extends HTMLElement>(tag: string): T {
  const element = document.createElement(tag) as T;
  document.body.append(element);
  return element;
}

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}

function setup(storage = memoryStorage()) {
  const modelRow = node<HTMLButtonElement>("button");
  modelRow.dataset.setting = "model";
  const effortRow = node<HTMLButtonElement>("button");
  effortRow.dataset.setting = "effort";
  const accessFull = node<HTMLButtonElement>("button");
  accessFull.dataset.accessMode = "full";
  const accessAsk = node<HTMLButtonElement>("button");
  accessAsk.dataset.accessMode = "ask";
  const accessReadOnly = node<HTMLButtonElement>("button");
  accessReadOnly.dataset.accessMode = "read-only";
  const effort = node<HTMLSelectElement>("select");
  for (const [label, value, maxTokens] of [["Light", "light", "4096"], ["Medium", "normal", "10240"], ["High", "high", "24576"]]) {
    const option = document.createElement("option");
    option.textContent = label;
    option.value = value;
    option.dataset.maxTokens = maxTokens;
    if (value === "normal") option.selected = true;
    effort.add(option);
  }
  const modelSummary = node<HTMLElement>("span");
  const modelRoute = document.createElement("span");
  const modelEffort = document.createElement("span");
  modelSummary.append(modelRoute, modelEffort);
  const elements: ComposerControlsElements = {
    model: node("select"), effort,
    modelToggle: node("button"), modelMenu: node("div"), modelMenuRoot: node("div"), modelSummary, modelRoute, modelEffort, modelValue: node("span"), effortValue: node("span"),
    settingsSubmenu: node("div"), settingRows: [modelRow, effortRow], advancedSettings: node("button"), advancedSettingsPanel: node("div"),
    temperature: node("input"), temperatureValue: node("output"), agentTopologySummary: node("span"), contextMeter: node("button"), contextUsagePopover: node("div"),
    contextPercent: node("strong"), contextTokens: node("b"), contextCompactButton: node("button"), contextCompactStatus: node("small"),
    accessModeToggle: node("button"), accessModeMenu: node("div"), accessModeLabel: node("span"), accessModeIcon: document.createElementNS("http://www.w3.org/2000/svg", "svg"),
    accessModeChoices: [accessFull, accessAsk, accessReadOnly],
  };
  document.body.append(elements.accessModeIcon);
  for (const popover of [elements.modelMenu, elements.settingsSubmenu, elements.advancedSettingsPanel, elements.contextUsagePopover, elements.accessModeMenu]) popover.hidden = true;
  elements.temperature.type = "range";
  elements.temperature.min = "0";
  elements.temperature.max = "2";
  elements.temperature.step = "0.1";
  const calls = { closeAllPopovers: vi.fn(), onRouteChange: vi.fn(), onEffortChange: vi.fn(), onCompact: vi.fn() };
  const overlayHost = new OverlayHost(document);
  const controls = new ComposerControls(elements, { ...calls, storage, overlayHost });
  return { controls, elements, calls, overlayHost };
}

function click(target: Element): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }

beforeEach(() => document.body.replaceChildren());

describe("ComposerControls", () => {
  it("defaults new and invalid preferences to Ask first while preserving explicit Full access", () => {
    expect(setup().controls.accessMode).toBe("ask");
    document.body.replaceChildren();
    expect(setup(memoryStorage({ "fitz-access-mode": "unknown" })).controls.accessMode).toBe("ask");
    document.body.replaceChildren();
    expect(setup(memoryStorage({ "fitz-access-mode": "full" })).controls.accessMode).toBe("full");
  });

  it("owns route and effort options, labels, and user selection callbacks", () => {
    const { controls, elements, calls } = setup();
    controls.setRoutes([
      { id: "default", label: "Local", group: "Routes" },
      { id: "smart", label: "Smart", group: "Routes" },
    ], "smart");

    expect(controls.routeId).toBe("smart");
    expect(controls.effort).toBe("normal");
    expect(controls.maxTokens).toBe(10_240);
    expect(elements.modelSummary.textContent).toBe("Smart · Medium");

    click(elements.settingRows[0]!);
    expect(elements.settingsSubmenu.hidden).toBe(false);
    expect(elements.modelMenuRoot.hidden).toBe(true);
    expect(elements.settingsSubmenu.querySelector(".settings-submenu-heading")).toBeNull();
    expect(elements.settingsSubmenu.querySelector(".settings-page-back")).toBeNull();
    click([...elements.settingsSubmenu.querySelectorAll("button")][0]!);

    expect(controls.routeId).toBe("default");
    expect(elements.modelSummary.textContent).toBe("Local · Medium");
    expect(calls.onRouteChange).toHaveBeenCalledWith("default");
    expect(calls.closeAllPopovers).toHaveBeenCalled();
  });

  it("keeps the composer route-based while retaining resolved model details in settings", () => {
    const { controls, elements, calls } = setup();
    controls.setRoutes([
      { id: "smart", label: "Smart · ninfer-1.5b", displayName: "Smart", group: "Routes" },
    ], "smart");

    expect(elements.modelSummary.textContent).toBe("Smart · Medium");
    expect(elements.modelRoute.textContent).toBe("Smart");
    expect(elements.modelEffort.textContent).toBe(" · Medium");
    // The settings menu still shows the full label.
    expect(elements.modelValue.textContent).toBe("Smart · ninfer-1.5b");

    // A route without a model name collapses the name span entirely.
    controls.setRoutes([{ id: "default", label: "Local", displayName: "Local" }], "default");
    expect(elements.modelSummary.textContent).toBe("Local · Medium");
    expect(elements.modelRoute.textContent).toBe("Local");
  });

  it("resets every new chat to Local with medium effort", () => {
    const { controls, elements } = setup();
    controls.setRoutes([
      { id: "default", label: "Local", displayName: "Local" },
      { id: "smart", label: "Smart", displayName: "Smart" },
    ], "smart");
    elements.effort.value = "high";

    controls.resetForNewChat();

    expect(controls.routeId).toBe("default");
    expect(controls.effort).toBe("normal");
    expect(elements.modelSummary.textContent).toBe("Local · Medium");
  });

  it("restores and persists temperature and access mode", () => {
    const storage = memoryStorage({ "fitz-temperature": "1.2", "fitz-access-mode": "ask" });
    const { controls, elements } = setup(storage);

    expect(controls.temperature).toBe(1.2);
    expect(elements.temperatureValue.textContent).toBe("1.2");
    expect(controls.accessMode).toBe("ask");
    expect(elements.accessModeLabel.textContent).toBe("Ask first");

    elements.temperature.value = "0.7";
    elements.temperature.dispatchEvent(new Event("input", { bubbles: true }));
    click(elements.accessModeChoices[2]!);
    expect(controls.temperature).toBe(0.7);
    expect(controls.accessMode).toBe("read-only");
    expect(storage.getItem("fitz-temperature")).toBe("0.7");
    expect(storage.getItem("fitz-access-mode")).toBe("read-only");
  });

  it("renders context usage and gates controls from one state update", () => {
    const { controls, elements, calls } = setup();
    controls.setRoutes([{ id: "default", label: "Default" }]);
    controls.updateContext(32_768, 131_072);
    controls.updateState({ running: true, hasSession: true });

    expect(elements.contextPercent.textContent).toBe("25% full");
    expect(elements.contextTokens.textContent).toBe("≈33k / 131k tokens used");
    expect(elements.modelToggle.disabled).toBe(true);
    expect(elements.contextCompactButton.disabled).toBe(false);

    controls.updateState({ running: false, hasSession: true });
    expect(elements.modelToggle.disabled).toBe(false);
    expect(elements.contextCompactButton.disabled).toBe(false);
    click(elements.contextCompactButton);
    expect(calls.onCompact).toHaveBeenCalledOnce();
  });

  it("shows the resolved main and worker context in the context popover", () => {
    const { controls, elements, calls } = setup();

    controls.setAgentTopology({
      orchestratorContextTokens: 131_072,
      workerContextTokens: 32_768,
      workerCounts: { light: 0, normal: 3, high: 8 },
    });

    expect(elements.agentTopologySummary.hidden).toBe(false);
    expect(elements.agentTopologySummary.textContent).toBe("131k context · 3 workers at 32k");
    elements.effort.value = "light";
    elements.effort.dispatchEvent(new Event("change", { bubbles: true }));
    controls.setAgentTopology({ orchestratorContextTokens: 131_072, workerContextTokens: 32_768, workerCounts: { light: 0, normal: 3, high: 8 } });
    expect(elements.agentTopologySummary.textContent).toBe("131k context · no workers");
    expect(calls.onEffortChange).toHaveBeenCalledWith("light");
    controls.setAgentTopology();
    expect(elements.agentTopologySummary.hidden).toBe(true);
  });

  it("closes every composer-owned popover and resets ARIA state", () => {
    const { controls, elements } = setup();
    for (const popover of [elements.modelMenu, elements.settingsSubmenu, elements.advancedSettingsPanel, elements.contextUsagePopover, elements.accessModeMenu]) popover.hidden = false;
    for (const toggle of [elements.modelToggle, elements.advancedSettings, elements.contextMeter, elements.accessModeToggle]) toggle.setAttribute("aria-expanded", "true");

    controls.closePopovers();

    expect([elements.modelMenu, elements.settingsSubmenu, elements.advancedSettingsPanel, elements.contextUsagePopover, elements.accessModeMenu].every((popover) => popover.hidden)).toBe(true);
    expect([elements.modelToggle, elements.advancedSettings, elements.contextMeter, elements.accessModeToggle].every((toggle) => toggle.getAttribute("aria-expanded") === "false")).toBe(true);
  });

  it("positions the route and effort menu in the fixed top overlay", () => {
    const { elements } = setup();
    elements.modelToggle.getBoundingClientRect = () => ({ left: 500, right: 620, top: 300, bottom: 330, width: 120, height: 30, x: 500, y: 300, toJSON: () => ({}) });
    elements.modelMenu.getBoundingClientRect = () => ({ left: 0, right: 286, top: 0, bottom: 180, width: 286, height: 180, x: 0, y: 0, toJSON: () => ({}) });

    click(elements.modelToggle);

    expect(elements.modelMenu.hidden).toBe(false);
    expect(elements.modelMenu.style.left).toBe("334px");
    expect(elements.modelMenu.style.top).toBe("336px");
  });
});
