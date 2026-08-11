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
  /** App-managed platform runtimes (for example the NInfer Linux VHDX). */
  runtimeRoot: string;
  /** Per-run pre-flight snapshots of the workspace, used to restore after a bad run. */
  snapshotsDir: string;
  /** Content-addressed artifact payloads. SQLite stores metadata only. */
  artifactsDir: string;
  /** Coordinated SQLite + artifact snapshots and pre-restore rollback copies. */
  backupsDir: string;
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
    runtimeRoot: resolve(environment.FITZ_RUNTIME_ROOT ?? join(llmRoot, "runtimes")),
    snapshotsDir: resolve(environment.FITZ_SNAPSHOTS_DIR ?? join(dataRoot, "snapshots")),
    artifactsDir: resolve(environment.FITZ_ARTIFACTS_DIR ?? join(dataRoot, "artifacts")),
    backupsDir: resolve(environment.FITZ_BACKUPS_DIR ?? join(dataRoot, "backups")),
  };
}

function defaultDataRoot(environment: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") return join(environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Fitz Codex");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Fitz Codex");
  return join(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "fitz-codex");
}
