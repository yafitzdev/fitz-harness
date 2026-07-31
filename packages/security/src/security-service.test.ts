import { describe, expect, it } from "vitest";
import { SqliteStore } from "@fitz/storage";
import { SecurityPolicyError, SecurityService } from "./security-service.js";

describe("SecurityService", () => {
  it("authenticates hashed device tokens and rejects revocation", () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "test-pepper");
    const user = security.createUser("Agent", "agent"); security.setRouteGrants(user.id, ["fast"]);
    const issued = security.issueDevice(user.id, "Laptop", "secret-device-token");
    expect(security.authenticate("Bearer secret-device-token")).toEqual(expect.objectContaining({ user: expect.objectContaining({ id: user.id }), routeGrants: ["fast"] }));
    expect(store.findDeviceByTokenHash("secret-device-token")).toBeUndefined();
    store.revokeDevice(issued.device.id, new Date().toISOString());
    expect(security.authenticate("Bearer secret-device-token")).toBeUndefined(); store.close();
  });

  it("enforces role defaults and custom quotas", () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper");
    const user = security.createUser("Consumer"); security.setQuota(user.id, { maxRequestsPerMinute: 1, maxPromptChars: 5, maxOutputTokens: 2, maxQueueDepth: 1 });
    const { token } = security.issueDevice(user.id, "Phone"); const principal = security.authenticate(`Bearer ${token}`)!;
    expect(() => security.enforceQuota(principal, 6, 1, 0)).toThrow("Prompt quota exceeded");
    security.enforceQuota(principal, 5, 2, 0);
    expect(() => security.enforceQuota(principal, 5, 2, 0)).toThrow(SecurityPolicyError); store.close();
  });

  it("redeems a hashed one-time pairing code", () => { const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper"); const pairing = security.issuePairingCode("agent", 60); expect(store.consumePairingCode(pairing.code, new Date().toISOString())).toBeUndefined(); const redeemed = security.redeemPairingCode(pairing.code, "Remote", "Phone"); expect(redeemed.user.role).toBe("agent"); expect(security.authenticate(`Bearer ${redeemed.token}`)?.device.id).toBe(redeemed.device.id); expect(() => security.redeemPairingCode(pairing.code, "Again", "Again")).toThrow("already used"); store.close(); });
});
