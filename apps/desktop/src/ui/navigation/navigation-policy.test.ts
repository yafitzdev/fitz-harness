import { describe, expect, it } from "vitest";
import { canOpenManagementView, managementNavigationVisibility } from "./navigation-policy.js";

describe("management navigation policy", () => {
  it("exposes the complete desktop settings surface", () => {
    expect(managementNavigationVisibility()).toEqual({ playbooks: false, connections: true, plugins: true, models: true, administration: true });
    expect(canOpenManagementView("playbooks")).toBe(false);
    expect(canOpenManagementView("connections")).toBe(true);
    expect(canOpenManagementView("plugins")).toBe(true);
  });

  it("keeps the retired Playbooks surface hidden", () => {
    expect(managementNavigationVisibility()).toEqual({ playbooks: false, connections: true, plugins: true, models: true, administration: true });
    expect(canOpenManagementView("playbooks")).toBe(false);
  });
});
