// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InAppBrowserState } from "../../preload.js";
import { InAppBrowser } from "./in-app-browser.js";

function setup() {
  let publishState: ((state: InAppBrowserState) => void) | undefined;
  const bridge = {
    openBrowser: vi.fn(async () => {}),
    setBrowserBounds: vi.fn(async () => {}),
    browserAction: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
    onBrowserState: vi.fn((listener: (state: InAppBrowserState) => void) => { publishState = listener; return () => {}; }),
  };
  const mount = document.createElement("main");
  document.body.append(mount);
  const showStatus = vi.fn();
  const browser = new InAppBrowser({ mount, bridge, showStatus });
  return { browser, bridge, mount, showStatus, state: (value: InAppBrowserState) => publishState?.(value) };
}

beforeEach(() => document.body.replaceChildren());

describe("InAppBrowser", () => {
  it("opens HTTP links inside Fitz and exposes native browser controls", async () => {
    const { browser, bridge, mount, state } = setup();
    await browser.open("http://127.0.0.1:3080");
    expect(bridge.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:3080/");
    expect(browser.visible).toBe(true);
    expect(mount.querySelector<HTMLElement>(".in-app-browser")?.hidden).toBe(false);

    state({ url: "http://127.0.0.1:3080/docs", title: "Docs", canGoBack: true, canGoForward: false, loading: false });
    const buttons = [...mount.querySelectorAll<HTMLButtonElement>(".in-app-browser-button")];
    expect(buttons[0]?.disabled).toBe(false);
    expect(buttons[1]?.disabled).toBe(true);
    buttons[0]?.click();
    expect(bridge.browserAction).toHaveBeenCalledWith("back");
    buttons[3]?.click();
    expect(bridge.openExternal).toHaveBeenCalledWith("http://127.0.0.1:3080/docs");
    buttons[4]?.click();
    expect(browser.visible).toBe(false);
    expect(bridge.browserAction).toHaveBeenCalledWith("close");
  });

  it("rejects privileged and credential-bearing URLs before they reach Electron", async () => {
    const { browser, bridge, showStatus } = setup();
    await browser.open("file:///C:/secrets.txt");
    await browser.open("https://user:password@example.com");
    expect(bridge.openBrowser).not.toHaveBeenCalled();
    expect(browser.visible).toBe(false);
    expect(showStatus).toHaveBeenCalledTimes(2);
  });
});
