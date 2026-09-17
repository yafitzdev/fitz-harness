import { homedir } from "node:os";
import { existsSync, renameSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const MANAGED_INFERENCE_DISTRIBUTION = "Fitz-Inference";
const MANAGED_INFERENCE_GUEST_ROOT = "/opt/fitz/llm";

export interface FitzRuntimePaths {
  dataRoot: string;
  databasePath: string;
  piAgentDir: string;
  logsDir: string;
  cacheDir: string;
  llmRoot: string;
  engineRoot: string;
  modelRoot: string;
  /** Physical GGUF payload store managed by the model catalog. */
  ggufModelRoot: string;
  /** Linux language/package environments in the canonical inference registry. */
  environmentRoot: string;
  /** Host-side VM/container infrastructure. This is not part of the logical LLM registry. */
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
  const llmRoot = resolve(environment.FITZ_LLM_ROOT ?? defaultLlmRoot());
  return {
    dataRoot,
    databasePath: resolve(join(dataRoot, "database", "fitz.db")),
    piAgentDir: resolve(environment.FITZ_PI_AGENT_DIR ?? join(dataRoot, "pi")),
    logsDir: resolve(environment.FITZ_LOGS_DIR ?? join(dataRoot, "logs")),
    cacheDir: resolve(environment.FITZ_CACHE_DIR ?? join(dataRoot, "cache")),
    llmRoot,
    engineRoot: resolve(join(llmRoot, "engines")),
    modelRoot: resolve(join(llmRoot, "models")),
    ggufModelRoot: resolve(join(llmRoot, "models", "gguf")),
    environmentRoot: resolve(join(llmRoot, "environments")),
    runtimeRoot: resolve(environment.FITZ_RUNTIME_ROOT ?? join(dataRoot, "runtimes")),
    snapshotsDir: resolve(environment.FITZ_SNAPSHOTS_DIR ?? join(dataRoot, "snapshots")),
    artifactsDir: resolve(environment.FITZ_ARTIFACTS_DIR ?? join(dataRoot, "artifacts")),
    backupsDir: resolve(environment.FITZ_BACKUPS_DIR ?? join(dataRoot, "backups")),
  };
}

/** Enforces the repository/runtime boundary before any registry directories are created. */
export function assertExternalInferenceRegistry(llmRoot: string, applicationRoot: string): void {
  const registry = resolve(llmRoot);
  const application = resolve(applicationRoot);
  const child = relative(application, registry);
  if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) {
    throw new Error(`FITZ_LLM_ROOT must live outside the Fitz Harness application tree: ${registry}`);
  }
}

/** Moves the pre-rename default data directory into the canonical location.
 * Explicit FITZ_DATA_ROOT deployments own their migration and are untouched. */
export function migrateLegacyDataRoot(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.FITZ_DATA_ROOT) return false;
  return adoptLegacyDataRoot(legacyDataRoot(environment), defaultDataRoot(environment));
}

export function adoptLegacyDataRoot(legacyRoot: string, canonicalRoot: string): boolean {
  if (resolve(legacyRoot) === resolve(canonicalRoot) || existsSync(canonicalRoot) || !existsSync(legacyRoot)) return false;
  renameSync(legacyRoot, canonicalRoot);
  return true;
}

function defaultLlmRoot(): string {
  if (process.platform === "win32") {
    return `\\\\wsl.localhost\\${MANAGED_INFERENCE_DISTRIBUTION}${MANAGED_INFERENCE_GUEST_ROOT.replaceAll("/", "\\")}`;
  }
  return join(homedir(), ".llm");
}

function defaultDataRoot(environment: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") return join(environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Fitz Harness");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Fitz Harness");
  return join(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "fitz-harness");
}

function legacyDataRoot(environment: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") return join(environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Fitz Codex");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Fitz Codex");
  return join(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "fitz-codex");
}
