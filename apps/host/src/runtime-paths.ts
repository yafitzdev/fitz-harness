import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface FitzRuntimePaths {
  dataRoot: string;
  databasePath: string;
  piAgentDir: string;
  logsDir: string;
  cacheDir: string;
  llmRoot: string;
  engineRoot: string;
  modelRoot: string;
}

export function resolveRuntimePaths(environment: NodeJS.ProcessEnv = process.env): FitzRuntimePaths {
  const dataRoot = resolve(environment.FITZ_DATA_ROOT ?? defaultDataRoot(environment));
  const llmRoot = resolve(environment.FITZ_LLM_ROOT ?? join(homedir(), ".llm"));
  return {
    dataRoot,
    databasePath: resolve(join(dataRoot, "database", "fitz.db")),
    piAgentDir: resolve(environment.FITZ_PI_AGENT_DIR ?? join(dataRoot, "pi")),
    logsDir: resolve(environment.FITZ_LOGS_DIR ?? join(dataRoot, "logs")),
    cacheDir: resolve(environment.FITZ_CACHE_DIR ?? join(dataRoot, "cache")),
    llmRoot,
    engineRoot: resolve(environment.FITZ_ENGINE_ROOT ?? join(llmRoot, "engines")),
    modelRoot: resolve(environment.FITZ_MODEL_ROOT ?? join(llmRoot, "models")),
  };
}

function defaultDataRoot(environment: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") return join(environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Fitz Codex");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Fitz Codex");
  return join(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "fitz-codex");
}
