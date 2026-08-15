import { describe, expect, it } from "vitest";
import { SqliteStore } from "@fitz/storage";
import { DEFAULT_QUOTAS, SecurityPolicyError, SecurityService } from "./security-service.js";

describe("SecurityService", () => {
  it("authenticates hashed device tokens and rejects revocation", () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "test-pepper");
    const user = security.createUser("Agent", "agent"); security.setRouteGrants(user.id, ["image"]);
    const issued = security.issueDevice(user.id, "Laptop", "secret-device-token");
    expect(security.authenticate("Bearer secret-device-token")).toEqual(expect.objectContaining({ user: expect.objectContaining({ id: user.id }), routeGrants: ["image"] }));
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

  it("normalizes and bounds externally supplied user and device names", () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper");
    const user = security.createUser("  Friend  ");
    expect(user.displayName).toBe("Friend");
    expect(security.issueDevice(user.id, "  Laptop  ").device.name).toBe("Laptop");
    expect(() => security.createUser("x".repeat(101))).toThrow("1 and 100");
    expect(() => security.issueDevice(user.id, " ")).toThrow("1 and 100");
    store.close();
  });

  it("rejects disabled users and malformed bearer credentials", () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper");
    const user = security.createUser("Disabled"); const { token } = security.issueDevice(user.id, "Old device");
    security.updateUser(user.id, { status: "disabled" });
    expect(security.authenticate(`Bearer ${token}`)).toBeUndefined();
    expect(security.authenticate(token)).toBeUndefined();
    store.close();
  });

  it("rejects invalid quotas and enforces administrator route access", () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper");
    const admin = security.createUser("Admin", "administrator"); const principal = security.authenticate(`Bearer ${security.issueDevice(admin.id, "Console").token}`)!;
    expect(security.authorizeRoute(principal, "ungranted-route")).toBe(true);
    expect(() => security.setQuota(admin.id, { maxRequestsPerMinute: 0, maxPromptChars: 1, maxOutputTokens: 1, maxQueueDepth: 1 })).toThrow("positive integers");
    store.close();
  });

  it("authorizes every fixed text role without route grants", () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper");
    const user = security.createUser("Consumer");
    const principal = security.principalForUser(user.id);
    expect(["default", "fast", "smart"].every((routeId) => security.authorizeRoute(principal, routeId))).toBe(true);
    expect(security.authorizeRoute(principal, "image")).toBe(false);
    store.close();
  });

  it("accepts media sub-quotas and rejects invalid media quota fields", () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper");
    const user = security.createUser("Admin", "administrator");
    const valid = { maxRequestsPerMinute: 10, maxPromptChars: 100, maxOutputTokens: 20, maxQueueDepth: 2, media: { maxJobsPerWindow: 5, windowHours: 24, maxConcurrentJobs: 1, creditBudgetCents: 0 } };
    security.setQuota(user.id, valid);
    expect(store.getUserQuota(user.id)).toEqual(valid);
    expect(() => security.setQuota(user.id, { ...valid, media: { maxJobsPerWindow: 0, windowHours: 24, maxConcurrentJobs: 1 } })).toThrow("maxJobsPerWindow");
    expect(() => security.setQuota(user.id, { ...valid, media: { maxJobsPerWindow: 5, windowHours: 24, maxConcurrentJobs: 0 } })).toThrow("maxConcurrentJobs");
    expect(() => security.setQuota(user.id, { ...valid, media: { maxJobsPerWindow: 5, windowHours: 24, maxConcurrentJobs: 1, creditBudgetCents: -1 } })).toThrow("creditBudgetCents");
    store.close();
  });

  it("builds device-less principals and fails closed without a media quota", () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper");
    const user = security.createUser("Creator", "agent");
    const principal = security.principalForUser(user.id);
    expect(principal).toEqual(expect.objectContaining({ user: expect.objectContaining({ id: user.id }), routeGrants: [], quota: DEFAULT_QUOTAS.agent }));
    expect(principal).not.toHaveProperty("device");
    expect(() => security.enforceMediaQuota(principal, { modality: "image" })).toThrow("Media quota is not configured");
    expect(() => security.principalForUser("missing")).toThrow(SecurityPolicyError);
    store.close();
  });

  it("lets the local administrator use media tools by default while non-administrators remain fail-closed", () => {
    const store = SqliteStore.memory();
    const security = new SecurityService(store, "pepper");
    const administrator = security.createUser("Administrator", "administrator");
    const agent = security.createUser("Agent", "agent");

    expect(() => security.enforceMediaQuota(security.principalForUser(administrator.id), { modality: "video" })).not.toThrow();
    expect(() => security.enforceMediaQuota(security.principalForUser(agent.id), { modality: "video" })).toThrow("Media quota is not configured");
  });

  it("enforces media job, concurrency, and credit-budget quotas", () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper");
    const user = security.createUser("Creator", "agent");
    security.setQuota(user.id, {
      maxRequestsPerMinute: 20, maxPromptChars: 1000, maxOutputTokens: 100, maxQueueDepth: 5,
      media: { maxJobsPerWindow: 3, windowHours: 24, maxConcurrentJobs: 2, creditBudgetCents: 10 },
    });
    const principal = security.principalForUser(user.id);
    const now = new Date().toISOString();
    const enqueue = (id: string): void => { store.createMediaJob({ id, routeId: "image", modality: "image", status: "queued", params: { prompt: "x" }, enqueuedAt: now, createdByUserId: user.id }); };
    const complete = (id: string, costCents: number): void => {
      store.updateMediaJob(id, { status: "completed", completedAt: now, artifactId: `art-${id}` });
      store.appendMediaCredit({ id: `ledger-${id}`, userId: user.id, jobId: id, modality: "image", costCents, createdAt: now });
    };
    // Concurrency cap: two in-flight jobs, a third submit is denied.
    enqueue("job-1"); enqueue("job-2");
    expect(() => security.enforceMediaQuota(principal, { modality: "image" })).toThrow("concurrent-job");
    // Completing frees the concurrent slot; costs accumulate against the budget.
    complete("job-1", 2); complete("job-2", 3);
    enqueue("job-3"); enqueue("job-4"); enqueue("job-5");
    // Window cap: three non-terminal jobs (job-3..5) reach maxJobsPerWindow.
    expect(() => security.enforceMediaQuota(principal, { modality: "image" })).toThrow("job quota");
    // Credit budget: spent 2+3+6+1+0 = 12 > 10 once everything is terminal.
    complete("job-3", 6); complete("job-4", 1); complete("job-5", 0);
    expect(() => security.enforceMediaQuota(principal, { modality: "image" })).toThrow("credit budget");
    store.close();
  });
});
