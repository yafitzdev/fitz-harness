import { describe, expect, it } from "vitest";
import { canOpenManagementView, managementNavigationVisibility } from "./navigation-policy.js";

describe("management navigation policy", () => {
  it("exposes local settings regardless of the active remote identity", () => {
    expect(managementNavigationVisibility(false)).toEqual({ playbooks: false, connections: true, plugins: true, models: true, administration: true });
    expect(canOpenManagementView("playbooks", false)).toBe(false);
    expect(canOpenManagementView("connections", false)).toBe(true);
    expect(canOpenManagementView("plugins", false)).toBe(true);
  });

  it("exposes every management surface to administrators", () => {
    expect(managementNavigationVisibility(true)).toEqual({ playbooks: false, connections: true, plugins: true, models: true, administration: true });
    expect(canOpenManagementView("playbooks", true)).toBe(false);
  });
});
