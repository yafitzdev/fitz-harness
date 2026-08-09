import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRuntimePaths } from "./runtime-paths.js";

describe("Fitz runtime paths", () => {
  it("uses the hidden user LLM directory by default", () => {
    const paths = resolveRuntimePaths({ LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" });
    expect(paths.llmRoot).toBe(resolve(homedir(), ".llm"));
    expect(paths.engineRoot).toBe(resolve(homedir(), ".llm", "engines"));
    expect(paths.modelRoot).toBe(resolve(homedir(), ".llm", "models"));
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
  });

  it("derives the database from the data root and allows canonical roots to be overridden", () => {
    const paths = resolveRuntimePaths({ FITZ_DATA_ROOT: "D:\\fitz-data", FITZ_PI_AGENT_DIR: "D:\\pi", FITZ_LLM_ROOT: "D:\\llm" });
    expect(paths).toMatchObject({ dataRoot: "D:\\fitz-data", databasePath: "D:\\fitz-data\\database\\fitz.db", piAgentDir: "D:\\pi", llmRoot: "D:\\llm" });
  });
});
