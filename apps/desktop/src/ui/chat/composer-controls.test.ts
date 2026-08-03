// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
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
  for (const [label, value] of [["Light", "2048"], ["Medium", "8192"], ["High", "16384"]]) {
    const option = document.createElement("option");
    option.textContent = label;
    option.value = value;
    if (value === "8192") option.selected = true;
    effort.add(option);
  }
  const elements: ComposerControlsElements = {
    model: node("select"), effort,
    modelToggle: node("button"), modelMenu: node("div"), modelSummary: node("span"), modelValue: node("span"), effortValue: node("span"),
    settingsSubmenu: node("div"), settingRows: [modelRow, effortRow], advancedSettings: node("button"), advancedSettingsPanel: node("div"),
    temperature: node("input"), temperatureValue: node("output"), contextMeter: node("button"), contextUsagePopover: node("div"),
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
  const calls = { closeAllPopovers: vi.fn(), onRouteChange: vi.fn(), onCompact: vi.fn() };
  const controls = new ComposerControls(elements, { ...calls, storage });
  return { controls, elements, calls };
}

function click(target: Element): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }

beforeEach(() => document.body.replaceChildren());

describe("ComposerControls", () => {
  it("owns route and effort options, labels, and user selection callbacks", () => {
    const { controls, elements, calls } = setup();
    controls.setRoutes([
      { id: "default", label: "Default", group: "Routes" },
      { id: "smart", label: "Smart", group: "Routes" },
    ], "smart");

    expect(controls.routeId).toBe("smart");
    expect(elements.modelSummary.textContent).toBe("Smart · Medium");

    click(elements.settingRows[0]!);
    expect(elements.settingsSubmenu.hidden).toBe(false);
    expect(elements.settingsSubmenu.querySelector(".settings-submenu-heading")?.textContent).toBe("Routes");
    click([...elements.settingsSubmenu.querySelectorAll("button")][0]!);

    expect(controls.routeId).toBe("default");
    expect(elements.modelSummary.textContent).toBe("Default · Medium");
    expect(calls.onRouteChange).toHaveBeenCalledWith("default");
    expect(calls.closeAllPopovers).toHaveBeenCalled();
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
    expect(elements.contextCompactButton.disabled).toBe(true);

    controls.updateState({ running: false, hasSession: true });
    expect(elements.modelToggle.disabled).toBe(false);
    expect(elements.contextCompactButton.disabled).toBe(false);
    click(elements.contextCompactButton);
    expect(calls.onCompact).toHaveBeenCalledOnce();
  });

  it("closes every composer-owned popover and resets ARIA state", () => {
    const { controls, elements } = setup();
    for (const popover of [elements.modelMenu, elements.settingsSubmenu, elements.advancedSettingsPanel, elements.contextUsagePopover, elements.accessModeMenu]) popover.hidden = false;
    for (const toggle of [elements.modelToggle, elements.advancedSettings, elements.contextMeter, elements.accessModeToggle]) toggle.setAttribute("aria-expanded", "true");

    controls.closePopovers();

    expect([elements.modelMenu, elements.settingsSubmenu, elements.advancedSettingsPanel, elements.contextUsagePopover, elements.accessModeMenu].every((popover) => popover.hidden)).toBe(true);
    expect([elements.modelToggle, elements.advancedSettings, elements.contextMeter, elements.accessModeToggle].every((toggle) => toggle.getAttribute("aria-expanded") === "false")).toBe(true);
  });
});
