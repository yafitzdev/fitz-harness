// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { suppressNativeTooltips } from "./native-tooltip-policy.js";

const observers: MutationObserver[] = [];

afterEach(() => {
  for (const observer of observers.splice(0)) observer.disconnect();
  document.body.replaceChildren();
});

describe("native tooltip policy", () => {
  it("removes existing native titles without removing accessible labels", () => {
    document.body.innerHTML = '<button title="New chat" aria-label="New chat"></button><iframe title="Preview"></iframe>';

    observers.push(suppressNativeTooltips());

    const button = document.querySelector("button")!;
    expect(button.hasAttribute("title")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("New chat");
    expect(document.querySelector("iframe")?.title).toBe("Preview");
  });

  it("removes native titles added after startup", async () => {
    observers.push(suppressNativeTooltips());
    const button = document.createElement("button");
    button.title = "Project actions";
    document.body.append(button);

    await Promise.resolve();

    expect(button.hasAttribute("title")).toBe(false);
  });
});
