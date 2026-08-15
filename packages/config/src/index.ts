import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const FITZ_CONFIG_VERSION = 1 as const;
export type HostingProvider = "tailscale-funnel";
export type EffortLevel = "light" | "normal" | "high";

export interface FitzConfigDocument {
  version: typeof FITZ_CONFIG_VERSION;
  hosting: {
    enabled: boolean;
    provider: HostingProvider;
    startAtLogin: boolean;
    publicPort: 443 | 8443 | 10000;
    gatewayPort: number;
  };
  defaults: {
    route: string;
    effort: EffortLevel;
  };
  users: {
    defaultRole: "consumer";
    defaultQuota: {
      requestsPerMinute: number;
      promptCharacters: number;
      outputTokens: number;
      queueDepth: number;
    };
  };
  storage: {
    artifactQuotaBytes: number | null;
    mediaArtifactLimits: Partial<Record<"image" | "video" | "audio", number>>;
  };
  interface: Record<string, unknown>;
  inference: {
    engineRoot: string | null;
    reserveVramMiB: number;
    agentConcurrency: number;
    agentConcurrencyPerUser: number;
  };
  /** Extensible non-secret settings. Credential material is rejected here. */
  settings: Record<string, unknown>;
}

export interface FitzConfigPatch {
  hosting?: Partial<FitzConfigDocument["hosting"]>;
  defaults?: Partial<FitzConfigDocument["defaults"]>;
  users?: {
    defaultRole?: "consumer";
    defaultQuota?: Partial<FitzConfigDocument["users"]["defaultQuota"]>;
  };
  storage?: {
    artifactQuotaBytes?: number | null;
    mediaArtifactLimits?: Partial<Record<"image" | "video" | "audio", number>>;
  };
  interface?: Record<string, unknown>;
  inference?: Partial<FitzConfigDocument["inference"]>;
  settings?: Record<string, unknown>;
}

export interface FitzConfigServiceOptions {
  path: string;
  defaults?: FitzConfigPatch;
}

// Match credential-shaped names without rejecting legitimate counters such as
// outputTokens or non-secret tuning fields such as tokenBudget.
const SENSITIVE_KEY = /(secret|password|credential|(?:api|auth|access|private|signing|encryption).?key|pepper|token$|bearer$|cookie$|authorization$)/i;

/** Versioned, schema-validated, atomically persisted source of truth for every
 * non-secret Fitz setting. Runtime records and credentials deliberately live
 * outside this document. */
export class FitzConfigService {
  readonly path: string;
  readonly existed: boolean;
  #document: FitzConfigDocument;
  #watcher: FSWatcher | undefined;
  #reloadTimer: NodeJS.Timeout | undefined;

  constructor(options: FitzConfigServiceOptions) {
    this.path = resolve(options.path);
    this.existed = existsSync(this.path);
    const base = defaultFitzConfig();
    const supplied = options.defaults ? mergeDocument(base, options.defaults) : base;
    this.#document = this.existed ? parseFitzConfig(readFileSync(this.path, "utf8")) : validateFitzConfig(supplied);
    if (!this.existed) this.#persist(this.#document);
  }

  read(): FitzConfigDocument { return structuredClone(this.#document); }

  reload(): FitzConfigDocument {
    this.#document = parseFitzConfig(readFileSync(this.path, "utf8"));
    return this.read();
  }

  preview(patch: FitzConfigPatch): FitzConfigDocument {
    rejectSensitiveValues(patch);
    if ((patch as Record<string, unknown>).version !== undefined && (patch as Record<string, unknown>).version !== FITZ_CONFIG_VERSION) {
      throw new Error(`Unsupported Fitz configuration version: ${String((patch as Record<string, unknown>).version)}`);
    }
    return validateFitzConfig(mergeDocument(this.#document, patch));
  }

  update(patch: FitzConfigPatch): FitzConfigDocument {
    const next = this.preview(patch);
    this.#persist(next);
    this.#document = next;
    return this.read();
  }

  get<T>(key: string): T | undefined {
    if (SENSITIVE_KEY.test(key)) return undefined;
    if (key === "artifactStorageQuotaBytes") return (this.#document.storage.artifactQuotaBytes ?? undefined) as T | undefined;
    if (key === "mediaArtifactLimits") return this.#document.storage.mediaArtifactLimits as T;
    if (key === "engineRoot") return (this.#document.inference.engineRoot ?? undefined) as T | undefined;
    return this.#document.settings[key] as T | undefined;
  }

  set(key: string, value: unknown): void {
    if (SENSITIVE_KEY.test(key)) throw new Error(`Sensitive setting ${key} cannot be written to fitz.config.json`);
    if (key === "artifactStorageQuotaBytes") { this.update({ storage: { artifactQuotaBytes: requireNullablePositiveInteger(value, key) } }); return; }
    if (key === "mediaArtifactLimits") { this.update({ storage: { mediaArtifactLimits: requireMediaLimits(value) } }); return; }
    if (key === "engineRoot") { this.update({ inference: { engineRoot: requireNullableString(value, key) } }); return; }
    this.update({ settings: { ...this.#document.settings, [key]: value } });
  }

  delete(key: string): boolean {
    if (SENSITIVE_KEY.test(key)) return false;
    if (key === "artifactStorageQuotaBytes") { const present = this.#document.storage.artifactQuotaBytes !== null; this.update({ storage: { artifactQuotaBytes: null } }); return present; }
    if (key === "mediaArtifactLimits") { const present = Object.keys(this.#document.storage.mediaArtifactLimits).length > 0; this.update({ storage: { mediaArtifactLimits: {} } }); return present; }
    if (key === "engineRoot") { const present = this.#document.inference.engineRoot !== null; this.update({ inference: { engineRoot: null } }); return present; }
    if (!(key in this.#document.settings)) return false;
    const settings = { ...this.#document.settings };
    delete settings[key];
    this.update({ settings });
    return true;
  }

  migrateLegacySettings(settings: Readonly<Record<string, unknown>>): FitzConfigDocument {
    if (this.existed) return this.read();
    const safe = Object.fromEntries(Object.entries(settings).filter(([key]) => !SENSITIVE_KEY.test(key)));
    const patch: FitzConfigPatch = { settings: safe };
    if ("artifactStorageQuotaBytes" in safe) patch.storage = { ...(patch.storage ?? {}), artifactQuotaBytes: requireNullablePositiveInteger(safe.artifactStorageQuotaBytes, "artifactStorageQuotaBytes") };
    if ("mediaArtifactLimits" in safe) patch.storage = { ...(patch.storage ?? {}), mediaArtifactLimits: requireMediaLimits(safe.mediaArtifactLimits) };
    if ("engineRoot" in safe) patch.inference = { engineRoot: requireNullableString(safe.engineRoot, "engineRoot") };
    for (const key of ["artifactStorageQuotaBytes", "mediaArtifactLimits", "engineRoot"]) delete safe[key];
    return this.update(patch);
  }

  watch(listener: (document: FitzConfigDocument) => void, onError?: (error: unknown) => void): () => void {
    this.#watcher?.close();
    this.#watcher = watch(dirname(this.path), { persistent: false }, (_event, filename) => {
      if (filename && filename !== this.path.split(/[\\/]/).at(-1)) return;
      if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
      this.#reloadTimer = setTimeout(() => {
        try {
          const previous = JSON.stringify(this.#document);
          const next = this.reload();
          if (JSON.stringify(next) !== previous) listener(next);
        } catch (error) { onError?.(error); }
      }, 100);
    });
    return () => { if (this.#reloadTimer) clearTimeout(this.#reloadTimer); this.#reloadTimer = undefined; this.#watcher?.close(); this.#watcher = undefined; };
  }

  #persist(document: FitzConfigDocument): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.part`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try { renameSync(temporary, this.path); }
    catch (error) {
      // Preserve the complete temporary document for manual recovery, but do
      // not let memory advance past the durable source of truth.
      throw error;
    }
  }
}

export function defaultFitzConfig(): FitzConfigDocument {
  return {
    version: FITZ_CONFIG_VERSION,
    hosting: { enabled: false, provider: "tailscale-funnel", startAtLogin: false, publicPort: 443, gatewayPort: 8790 },
    defaults: { route: "default", effort: "normal" },
    users: { defaultRole: "consumer", defaultQuota: { requestsPerMinute: 10, promptCharacters: 200_000, outputTokens: 32_768, queueDepth: 2 } },
    storage: { artifactQuotaBytes: null, mediaArtifactLimits: {} },
    interface: {},
    inference: { engineRoot: null, reserveVramMiB: 2048, agentConcurrency: 4, agentConcurrencyPerUser: 1 },
    settings: {},
  };
}

export function defaultFitzConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  const dataRoot = environment.FITZ_DATA_ROOT
    ?? (process.platform === "win32"
      ? join(environment.LOCALAPPDATA ?? join(environment.USERPROFILE ?? process.cwd(), "AppData", "Local"), "Fitz Codex")
      : join(environment.XDG_DATA_HOME ?? join(environment.HOME ?? process.cwd(), ".local", "share"), "fitz-codex"));
  return resolve(dataRoot, "fitz.config.json");
}

export function parseFitzConfig(source: string): FitzConfigDocument {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch (error) { throw new Error(`fitz.config.json is not valid JSON: ${errorMessage(error)}`); }
  return validateFitzConfig(value);
}

export function validateFitzConfig(value: unknown): FitzConfigDocument {
  if (!isRecord(value)) throw new Error("fitz.config.json must contain an object");
  rejectSensitiveValues(value);
  assertKnownKeys(value, ["version", "hosting", "defaults", "users", "storage", "interface", "inference", "settings"], "configuration");
  if (value.version !== FITZ_CONFIG_VERSION) throw new Error(`Unsupported Fitz configuration version: ${String(value.version)}`);
  const document = value as unknown as FitzConfigDocument;
  if (!isRecord(document.hosting) || typeof document.hosting.enabled !== "boolean" || document.hosting.provider !== "tailscale-funnel") throw new Error("Invalid hosting configuration");
  assertKnownKeys(document.hosting, ["enabled", "provider", "startAtLogin", "publicPort", "gatewayPort"], "hosting");
  if (typeof document.hosting.startAtLogin !== "boolean" || ![443, 8443, 10000].includes(document.hosting.publicPort) || !validPort(document.hosting.gatewayPort)) throw new Error("Invalid hosting ports or startup setting");
  if (!isRecord(document.defaults) || !["default", "fast", "smart"].includes(document.defaults.route) || !["light", "normal", "high"].includes(document.defaults.effort)) throw new Error("Invalid chat defaults");
  assertKnownKeys(document.defaults, ["route", "effort"], "defaults");
  if (!isRecord(document.users) || document.users.defaultRole !== "consumer" || !isRecord(document.users.defaultQuota)) throw new Error("Invalid user defaults");
  assertKnownKeys(document.users, ["defaultRole", "defaultQuota"], "users");
  assertKnownKeys(document.users.defaultQuota, ["requestsPerMinute", "promptCharacters", "outputTokens", "queueDepth"], "users.defaultQuota");
  for (const [key, number] of Object.entries(document.users.defaultQuota)) if (!positiveInteger(number)) throw new Error(`Invalid default user quota: ${key}`);
  if (!isRecord(document.storage) || !(document.storage.artifactQuotaBytes === null || positiveInteger(document.storage.artifactQuotaBytes)) || !isRecord(document.storage.mediaArtifactLimits)) throw new Error("Invalid storage configuration");
  assertKnownKeys(document.storage, ["artifactQuotaBytes", "mediaArtifactLimits"], "storage");
  requireMediaLimits(document.storage.mediaArtifactLimits);
  if (!isRecord(document.interface) || !isRecord(document.inference) || !isRecord(document.settings)) throw new Error("Invalid interface, inference, or settings configuration");
  assertKnownKeys(document.inference, ["engineRoot", "reserveVramMiB", "agentConcurrency", "agentConcurrencyPerUser"], "inference");
  if (!(document.inference.engineRoot === null || typeof document.inference.engineRoot === "string") || !nonNegativeInteger(document.inference.reserveVramMiB) || !positiveInteger(document.inference.agentConcurrency) || !positiveInteger(document.inference.agentConcurrencyPerUser)) throw new Error("Invalid inference configuration");
  assertJsonValue(document.interface, "interface");
  assertJsonValue(document.settings, "settings");
  return structuredClone(document);
}

function mergeDocument(base: FitzConfigDocument, patch: FitzConfigPatch): FitzConfigDocument {
  return {
    ...base,
    ...patch,
    version: FITZ_CONFIG_VERSION,
    hosting: { ...base.hosting, ...(patch.hosting ?? {}) },
    defaults: { ...base.defaults, ...(patch.defaults ?? {}) },
    users: { ...base.users, ...(patch.users ?? {}), defaultQuota: { ...base.users.defaultQuota, ...(patch.users?.defaultQuota ?? {}) } },
    storage: { ...base.storage, ...(patch.storage ?? {}), mediaArtifactLimits: patch.storage?.mediaArtifactLimits === undefined ? base.storage.mediaArtifactLimits : { ...patch.storage.mediaArtifactLimits } },
    interface: patch.interface === undefined ? base.interface : { ...patch.interface },
    inference: { ...base.inference, ...(patch.inference ?? {}) },
    settings: patch.settings === undefined ? base.settings : { ...patch.settings },
  };
}

function rejectSensitiveValues(value: unknown, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((nested, index) => rejectSensitiveValues(nested, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const qualified = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEY.test(key)) throw new Error(`Secrets are not allowed in fitz.config.json (${qualified})`);
    rejectSensitiveValues(nested, qualified);
  }
}
function requireMediaLimits(value: unknown): Partial<Record<"image" | "video" | "audio", number>> { if (!isRecord(value)) throw new Error("mediaArtifactLimits must be an object"); assertKnownKeys(value, ["image", "video", "audio"], "storage.mediaArtifactLimits"); const result: Partial<Record<"image" | "video" | "audio", number>> = {}; for (const key of ["image", "video", "audio"] as const) { const item = value[key]; if (item !== undefined) { if (!positiveInteger(item)) throw new Error(`${key} media artifact limit must be a positive integer`); result[key] = item; } } return result; }
function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void { const known = new Set(allowed); for (const key of Object.keys(value)) if (!known.has(key)) throw new Error(`Unknown ${path} setting: ${key}`); }
function assertJsonValue(value: unknown, path: string): void { if (value === null || typeof value === "string" || typeof value === "boolean") return; if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers`); return; } if (Array.isArray(value)) { value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`)); return; } if (isRecord(value)) { for (const [key, nested] of Object.entries(value)) assertJsonValue(nested, `${path}.${key}`); return; } throw new Error(`${path} must contain only JSON values`); }
function requireNullablePositiveInteger(value: unknown, name: string): number | null { if (value === undefined || value === null) return null; if (!positiveInteger(value)) throw new Error(`${name} must be a positive integer or null`); return value; }
function requireNullableString(value: unknown, name: string): string | null { if (value === undefined || value === null) return null; if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string or null`); return value; }
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function nonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function validPort(value: unknown): value is number { return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65_535; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
