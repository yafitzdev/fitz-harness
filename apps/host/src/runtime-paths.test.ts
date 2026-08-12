import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRuntimePaths } from "./runtime-paths.js";

describe("Fitz runtime paths", () => {
  it("uses the managed Linux registry by default on Windows", () => {
    const paths = resolveRuntimePaths({ LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" });
    expect(paths.llmRoot).toBe("\\\\wsl.localhost\\Fitz-Inference\\opt\\fitz\\llm");
    expect(paths.engineRoot).toBe("\\\\wsl.localhost\\Fitz-Inference\\opt\\fitz\\llm\\engines");
    expect(paths.modelRoot).toBe("\\\\wsl.localhost\\Fitz-Inference\\opt\\fitz\\llm\\models");
    expect(paths.ggufModelRoot).toBe("\\\\wsl.localhost\\Fitz-Inference\\opt\\fitz\\llm\\models\\gguf");
    expect(paths.environmentRoot).toBe("\\\\wsl.localhost\\Fitz-Inference\\opt\\fitz\\llm\\environments");
    expect(paths.runtimeRoot).toBe("C:\\Users\\tester\\AppData\\Local\\Fitz Codex\\runtimes");
  });

  it("keeps mutable host state and Pi packages outside the installation", () => {
    const paths = resolveRuntimePaths({ LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local", FITZ_LLM_ROOT: "C:\\Users\\tester\\llm" });
    expect(paths.dataRoot).toContain("Fitz Codex");
    expect(paths.databasePath).toContain("database");
    expect(paths.piAgentDir).toContain("pi");
    expect(paths.artifactsDir).toContain("artifacts");
    expect(paths.backupsDir).toContain("backups");
    expect(paths.engineRoot).toBe("C:\\Users\\tester\\llm\\engines");
    expect(paths.modelRoot).toBe("C:\\Users\\tester\\llm\\models");
    expect(paths.ggufModelRoot).toBe("C:\\Users\\tester\\llm\\models\\gguf");
    expect(paths.environmentRoot).toBe("C:\\Users\\tester\\llm\\environments");
    expect(paths.runtimeRoot).toBe("C:\\Users\\tester\\AppData\\Local\\Fitz Codex\\runtimes");
  });

  it("derives the database from the data root and allows canonical roots to be overridden", () => {
    const paths = resolveRuntimePaths({ FITZ_DATA_ROOT: "D:\\fitz-data", FITZ_PI_AGENT_DIR: "D:\\pi", FITZ_LLM_ROOT: "D:\\llm", FITZ_MODEL_ROOT: "D:\\models" });
    expect(paths).toMatchObject({ dataRoot: "D:\\fitz-data", databasePath: "D:\\fitz-data\\database\\fitz.db", piAgentDir: "D:\\pi", llmRoot: "D:\\llm", modelRoot: "D:\\models", ggufModelRoot: "D:\\models\\gguf" });
  });
});
