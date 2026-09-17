import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FitzConfigService, parseFitzConfig } from "./index.js";

describe("FitzConfigService", () => {
  it("creates, validates, patches, and reloads the canonical document", () => {
    const path = join(mkdtempSync(join(tmpdir(), "fitz-config-")), "fitz.config.json");
    const service = new FitzConfigService({ path });
    expect(service.read().defaults).toEqual({ route: "default", effort: "normal" });
    service.update({ hosting: { enabled: true }, defaults: { effort: "high" } });
    expect(parseFitzConfig(readFileSync(path, "utf8"))).toMatchObject({ hosting: { enabled: true }, defaults: { effort: "high" } });
    expect(new FitzConfigService({ path }).read().hosting.enabled).toBe(true);
  });

  it("keeps secrets out and migrates only non-secret legacy settings", () => {
    const path = join(mkdtempSync(join(tmpdir(), "fitz-config-")), "fitz.config.json");
    const service = new FitzConfigService({ path });
    expect(() => service.update({ settings: { apiKey: "secret" } })).toThrow(/Secrets are not allowed/);
    expect(() => service.update({ interface: { panels: [{ apiToken: "secret" }] } })).toThrow(/Secrets are not allowed/);
    expect(() => service.set("security.authPepper", "secret")).toThrow(/Sensitive setting/);
  });

  it("accepts a full canonical document but rejects unknown schema fields", () => {
    const path = join(mkdtempSync(join(tmpdir(), "fitz-config-")), "fitz.config.json");
    const service = new FitzConfigService({ path });
    expect(service.preview(service.read() as never)).toEqual(service.read());
    expect(() => service.preview({ hosting: { mysteryPort: 42 } } as never)).toThrow(/Unknown hosting setting/);
    expect(() => parseFitzConfig(JSON.stringify({ ...service.read(), mystery: true }))).toThrow(/Unknown configuration setting/);
  });

  it("maps supported scalar settings and rejects the retired mutable engine root", () => {
    const path = join(mkdtempSync(join(tmpdir(), "fitz-config-")), "fitz.config.json");
    const service = new FitzConfigService({ path });
    service.set("artifactStorageQuotaBytes", 1024);
    service.set("mediaArtifactLimits", { image: 100 });
    expect(() => service.set("engineRoot", "D:\\engines")).toThrow(/FITZ_LLM_ROOT/);
    expect(service.read()).toMatchObject({ storage: { artifactQuotaBytes: 1024, mediaArtifactLimits: { image: 100 } } });
    expect(service.get("artifactStorageQuotaBytes")).toBe(1024);
  });

  it("accepts and strips the historical engineRoot field", () => {
    const path = join(mkdtempSync(join(tmpdir(), "fitz-config-")), "fitz.config.json");
    const service = new FitzConfigService({ path });
    const legacy = service.read() as ReturnType<FitzConfigService["read"]> & { inference: ReturnType<FitzConfigService["read"]>["inference"] & { engineRoot: string } };
    legacy.inference.engineRoot = "D:\\legacy-engines";
    expect(parseFitzConfig(JSON.stringify(legacy)).inference).not.toHaveProperty("engineRoot");
  });

  it("defaults older documents to no language-server providers and validates provider descriptors", () => {
    const path = join(mkdtempSync(join(tmpdir(), "fitz-config-")), "fitz.config.json");
    const service = new FitzConfigService({ path });
    const legacy = { ...service.read() } as Record<string, unknown>;
    delete legacy.lsp;
    expect(parseFitzConfig(JSON.stringify(legacy)).lsp).toEqual({ providers: [] });
    expect(() => service.update({ lsp: { providers: [{ id: "bad", command: "server", args: [], extensionToLanguage: { ts: "typescript" } }] } })).toThrow(/Invalid lsp extension/);
    expect(() => service.update({ lsp: { providers: [{ id: "ts", command: "typescript-language-server", args: ["--stdio"], extensionToLanguage: { ".ts": "typescript" }, requestTimeoutMs: 0 }] } })).toThrow(/requestTimeoutMs/);
    service.update({ lsp: { providers: [{ id: "ts", command: "typescript-language-server", args: ["--stdio"], extensionToLanguage: { ".ts": "typescript" } }] } });
    expect(service.read().lsp.providers[0]).toMatchObject({ id: "ts", command: "typescript-language-server" });
  });

  it("observes validated external edits", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "fitz-config-")), "fitz.config.json");
    const service = new FitzConfigService({ path });
    const changed = new Promise<string>((resolve) => {
      const stop = service.watch((document) => { stop(); resolve(document.defaults.effort); });
    });
    const document = service.read();
    document.defaults.effort = "high";
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
    await expect(changed).resolves.toBe("high");
  });
});
