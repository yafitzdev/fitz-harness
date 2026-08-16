import { describe, expect, it, vi } from "vitest";
import { AppNavigationController, type AppNavigationOptions } from "./app-navigation.js";
import type { ManagementView } from "./navigation-policy.js";

const MANAGEMENT_VIEWS: ManagementView[] = ["playbooks", "connections", "plugins", "models", "usage", "administration"];

function harness(overrides: Partial<AppNavigationOptions> = {}) {
  const navigation = Object.fromEntries(MANAGEMENT_VIEWS.map((view) => [view, { hidden: false }])) as Record<ManagementView, HTMLElement>;
  const management = Object.fromEntries(MANAGEMENT_VIEWS.map((view) => [view, {
    load: vi.fn(),
    openRoute: vi.fn(),
  }])) as unknown as AppNavigationOptions["management"];
  const options: AppNavigationOptions = {
    administrator: () => true,
    blocked: () => false,
    pairingActive: () => false,
    focusPairing: vi.fn(),
    closePopovers: vi.fn(),
    closeInspector: vi.fn(),
    closeEditors: vi.fn(),
    pages: { show: vi.fn() },
    navigation,
    management,
    replayConversation: vi.fn(),
    renderPairing: vi.fn(),
    ...overrides,
  };
  return { controller: new AppNavigationController(options), management, navigation, options };
}

describe("AppNavigationController", () => {
  it("applies the shared transition and loads the selected management page", async () => {
    const { controller, management, options } = harness();

    await controller.openManagement("models");

    expect(options.closePopovers).toHaveBeenCalledOnce();
    expect(options.closeInspector).toHaveBeenCalledOnce();
    expect(options.closeEditors).toHaveBeenCalledOnce();
    expect(options.pages.show).toHaveBeenCalledWith("models");
    expect(management.models.load).toHaveBeenCalledOnce();
  });

  it("replays conversation and nested management locations through one history", async () => {
    const { controller, management, options } = harness();
    controller.remember({ view: "conversation", path: ["session", "one"] });
    controller.rememberRoute("connections", ["edit", "remote-1"]);

    await controller.navigate(-1);
    await controller.navigate(1);

    expect(options.replayConversation).toHaveBeenCalledWith({ view: "conversation", path: ["session", "one"] });
    expect(options.pages.show).toHaveBeenCalledWith("connections");
    expect(management.connections.load).toHaveBeenCalledOnce();
    expect(management.connections.openRoute).toHaveBeenCalledWith(["edit", "remote-1"]);
  });

  it("centralizes management visibility, access checks, and pairing gates", async () => {
    let pairing = false;
    const focusPairing = vi.fn();
    const { controller, management, navigation, options } = harness({
      administrator: () => false,
      pairingActive: () => pairing,
      focusPairing,
    });

    controller.applyAvailability();
    expect(navigation.connections.hidden).toBe(false);
    expect(navigation.playbooks.hidden).toBe(true);
    expect(navigation.administration.hidden).toBe(false);
    expect(await controller.openManagement("plugins")).toBe(true);
    expect(options.pages.show).toHaveBeenCalledWith("plugins");

    pairing = true;
    expect(await controller.openManagement("connections")).toBe(false);
    expect(management.connections.load).not.toHaveBeenCalled();
    expect(focusPairing).toHaveBeenCalledOnce();
  });

  it("owns pairing and conversation workspace transitions", () => {
    const { controller, options } = harness();

    controller.showPairing("Pair this device");
    controller.showConversation();

    expect(options.renderPairing).toHaveBeenCalledWith("Pair this device");
    expect(options.focusPairing).toHaveBeenCalledOnce();
    expect(options.pages.show).toHaveBeenNthCalledWith(1, "pairing");
    expect(options.pages.show).toHaveBeenNthCalledWith(2, "conversation");
    expect(options.closeEditors).toHaveBeenCalledTimes(2);
  });
});
