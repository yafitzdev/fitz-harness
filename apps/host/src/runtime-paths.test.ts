import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adoptLegacyDataRoot, assertExternalInferenceRegistry, resolveRuntimePaths } from "./runtime-paths.js";

describe("Fitz runtime paths", () => {
  it("uses the managed Linux registry by default on Windows", () => {
    const paths = resolveRuntimePaths({ LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" });
    expect(paths.llmRoot).toBe("\\\\wsl.localhost\\Fitz-Inference\\opt\\fitz\\llm");
    expect(paths.engineRoot).toBe("\\\\wsl.localhost\\Fitz-Inference\\opt\\fitz\\llm\\engines");
    expect(paths.modelRoot).toBe("\\\\wsl.localhost\\Fitz-Inference\\opt\\fitz\\llm\\models");
    expect(paths.ggufModelRoot).toBe("\\\\wsl.localhost\\Fitz-Inference\\opt\\fitz\\llm\\models\\gguf");
    expect(paths.environmentRoot).toBe("\\\\wsl.localhost\\Fitz-Inference\\opt\\fitz\\llm\\environments");
    expect(paths.runtimeRoot).toBe("C:\\Users\\tester\\AppData\\Local\\Fitz Harness\\runtimes");
  });

  it("keeps mutable host state and Pi packages outside the installation", () => {
    const paths = resolveRuntimePaths({ LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local", FITZ_LLM_ROOT: "C:\\Users\\tester\\llm" });
    expect(paths.dataRoot).toContain("Fitz Harness");
    expect(paths.databasePath).toContain("database");
    expect(paths.piAgentDir).toContain("pi");
    expect(paths.artifactsDir).toContain("artifacts");
    expect(paths.backupsDir).toContain("backups");
    expect(paths.engineRoot).toBe("C:\\Users\\tester\\llm\\engines");
    expect(paths.modelRoot).toBe("C:\\Users\\tester\\llm\\models");
    expect(paths.ggufModelRoot).toBe("C:\\Users\\tester\\llm\\models\\gguf");
    expect(paths.environmentRoot).toBe("C:\\Users\\tester\\llm\\environments");
    expect(paths.runtimeRoot).toBe("C:\\Users\\tester\\AppData\\Local\\Fitz Harness\\runtimes");
  });

  it("derives the whole inference registry from one overridable root", () => {
    const paths = resolveRuntimePaths({ FITZ_DATA_ROOT: "D:\\fitz-data", FITZ_PI_AGENT_DIR: "D:\\pi", FITZ_LLM_ROOT: "D:\\llm", FITZ_MODEL_ROOT: "D:\\ignored" });
    expect(paths).toMatchObject({
      dataRoot: "D:\\fitz-data",
      databasePath: "D:\\fitz-data\\database\\fitz.db",
      piAgentDir: "D:\\pi",
      llmRoot: "D:\\llm",
      engineRoot: "D:\\llm\\engines",
      modelRoot: "D:\\llm\\models",
      ggufModelRoot: "D:\\llm\\models\\gguf",
      environmentRoot: "D:\\llm\\environments",
    });
  });

  it("rejects an inference registry inside the application checkout", () => {
    expect(() => assertExternalInferenceRegistry("C:\\src\\fitz-harness\\.runtime", "C:\\src\\fitz-harness"))
      .toThrow("must live outside");
    expect(() => assertExternalInferenceRegistry("C:\\registries\\fitz", "C:\\src\\fitz-harness"))
      .not.toThrow();
  });

  it("atomically adopts a legacy data root only when the canonical root is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "fitz-harness-data-root-"));
    const legacyRoot = join(root, "legacy");
    const canonicalRoot = join(root, "canonical");
    try {
      mkdirSync(legacyRoot);
      writeFileSync(join(legacyRoot, "fitz.config.json"), "preserved", "utf8");

      expect(adoptLegacyDataRoot(legacyRoot, canonicalRoot)).toBe(true);
      expect(existsSync(legacyRoot)).toBe(false);
      expect(readFileSync(join(canonicalRoot, "fitz.config.json"), "utf8")).toBe("preserved");
      expect(adoptLegacyDataRoot(legacyRoot, canonicalRoot)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
