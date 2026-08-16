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
    blocked: () => false,
    closePopovers: vi.fn(),
    closeInspector: vi.fn(),
    closeEditors: vi.fn(),
    pages: { show: vi.fn() },
    navigation,
    management,
    replayConversation: vi.fn(),
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

  it("centralizes universal management visibility and access checks", async () => {
    const { controller, management, navigation, options } = harness({
    });

    controller.applyAvailability();
    expect(navigation.connections.hidden).toBe(false);
    expect(navigation.playbooks.hidden).toBe(true);
    expect(navigation.administration.hidden).toBe(false);
    expect(await controller.openManagement("plugins")).toBe(true);
    expect(options.pages.show).toHaveBeenCalledWith("plugins");

    expect(await controller.openManagement("connections")).toBe(true);
    expect(management.connections.load).toHaveBeenCalledOnce();
  });

  it("owns conversation workspace transitions", () => {
    const { controller, options } = harness();

    controller.showConversation();

    expect(options.pages.show).toHaveBeenCalledWith("conversation");
    expect(options.closeEditors).toHaveBeenCalledOnce();
  });
});
