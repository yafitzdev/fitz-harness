// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShareFitzController, type ShareFitzElements } from "./share-fitz-controller.js";

function elements(): ShareFitzElements {
  const form = document.createElement("form");
  const publicUrl = document.createElement("input");
  const tunnelToken = document.createElement("input");
  const submit = document.createElement("button");
  submit.type = "submit";
  form.append(publicUrl, tunnelToken, submit);
  return { form, publicUrl, tunnelToken, status: document.createElement("div"), refresh: document.createElement("button"), disable: document.createElement("button"), forget: document.createElement("button"), origin: document.createElement("code") };
}

describe("ShareFitzController", () => {
  beforeEach(() => { document.body.replaceChildren(); });
  it("enables sharing without retaining the tunnel token in the renderer", async () => {
    const nodes = elements();
    document.body.append(nodes.form, nodes.status, nodes.refresh, nodes.disable, nodes.forget, nodes.origin);
    const bridge = {
      shareStatus: vi.fn(async () => ({ state: "disabled" as const, available: true, configured: false, origin: "http://127.0.0.1:8790" })),
      enableShare: vi.fn(async () => ({ state: "starting" as const, available: true, configured: true, origin: "http://127.0.0.1:8790", publicUrl: "https://fitz.example.com" })),
      disableShare: vi.fn(async () => ({ state: "disabled" as const, available: true, configured: false, origin: "http://127.0.0.1:8790" })),
    };
    new ShareFitzController(nodes, bridge);
    nodes.publicUrl.value = "https://fitz.example.com";
    nodes.tunnelToken.value = "secret-tunnel-token";
    nodes.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(bridge.enableShare).toHaveBeenCalledWith({ publicUrl: "https://fitz.example.com", tunnelToken: "secret-tunnel-token" }));
    expect(nodes.tunnelToken.value).toBe("");
    expect(nodes.status.textContent).toContain("Connecting");
  });
});
