export const PROTOCOL_VERSION = "1" as const;
/** Exact desktop/host application contract. Unlike the event protocol this is
 * deliberately not backward compatible: a desktop must never drive a stale
 * local host with a different API or persistence contract. */
export const HOST_CONTRACT_VERSION = "4" as const;

/** How inference is funded and scheduled. This deliberately describes the
 * backend, not where the requesting desktop happens to be running. */
export type InferenceExecutionClass = "self_hosted" | "metered_cloud";

/** Transport relationship between one desktop and its Fitz host. It controls
 * trust and presentation only; orchestration never keys off this value. */
export type HostAccessClass = "same_device" | "trusted_remote" | "public_remote";

export const INSTANCE_STATES = [
  "UNLOADED",
  "PREPARING",
  "LOADING",
  "READY",
  "BUSY",
  "DRAINING",
  "EVICTING",
  "FAILED",
] as const;

export type InstanceState = (typeof INSTANCE_STATES)[number];

export type MediaModality = "image" | "video" | "audio";
export type ModalityInput = "text" | "image" | "video" | "audio";

export interface ModalityCapabilities {
  /** Modalities the engine accepts as input (prompt refs / reference editing). */
  input: ModalityInput[];
  /** Modalities the engine can generate. */
  output: MediaModality[];
  /** Generation-specific limits, where the engine declares them. */
  limits?: {
    maxDurationSeconds?: number;
    maxFps?: number;
    maxResolution?: string; // e.g. "768x768", "1280x720", "2560x1440"
    maxRefs?: number; // H3 accepts up to 12 multimodal refs
    maxFrames?: number;
  };
}

export interface EngineCapabilities {
  chatCompletions: boolean;
  streaming: boolean;
  toolCalls: boolean;
  responseFormat: boolean;
  minP: boolean;
  maxConcurrentGenerations: number;
  modalities?: ModalityCapabilities; // absent ⇒ chat-only recipe
}

export interface RecipeLifecyclePolicy {
  loadPolicy: "onDemand" | "manual";
  evictionPolicy: "immediate" | "idle-ttl" | "never" | "manual";
  idleTtlSeconds: number;
  minimumResidencySeconds: number;
}

/** A model relationship used for speculative decoding.  The relationship is
 * deliberately part of the recipe contract rather than an engine's raw
 * command-line arguments: each adapter decides how (or whether) its engine
 * expresses the drafter link. */
export type SpeculativeDecodingStrategy = "draft-model" | "draft-dflash" | "draft-mtp";
export type SpeculativeDrafterSource = "auto" | "manual";

export interface SpeculativeDrafter {
  /** Stable artifact identity, not a route or a user-visible model recipe. */
  id: string;
  modelId: string;
  /** Runtime-visible path supplied to an engine adapter. */
  path: string;
}

interface RecipeSpeculativeDecodingBase {
  maxDraftTokens: number;
  gpuLayers?: number | "all" | "auto";
  source?: SpeculativeDrafterSource;
}

/** Native MTP heads live inside the target model and therefore have no
 * separate drafter artifact. External draft strategies retain an explicit
 * target -> drafter relationship. */
export type RecipeSpeculativeDecoding = RecipeSpeculativeDecodingBase & (
  | { strategy: "draft-mtp"; drafter?: never }
  | { strategy: "draft-model" | "draft-dflash"; drafter: SpeculativeDrafter }
);

export interface Recipe {
  id: string;
  playbookId: string;
  displayName: string;
  adapter: string;
  modelId: string;
  /** Missing only on persisted pre-v4 recipes; native recipes are migrated as
   * self-hosted before policy resolution. */
  executionClass?: InferenceExecutionClass;
  /** Technical context limit exposed by the model/recipe. Runtime agent policy
   * may deliberately use a smaller working window. */
  contextTokens: number;
  capabilities: EngineCapabilities;
  lifecycle: RecipeLifecyclePolicy;
  configuration: Readonly<Record<string, unknown>>;
  /** Optional target -> drafter relationship. Drafters are never standalone
   * recipes or routes. */
  speculativeDecoding?: RecipeSpeculativeDecoding | null;
}

export type EngineConnectionMode = "managed" | "external";
export type EngineRuntime = "linux-managed";

export interface EngineRegistration {
  id: string;
  folderName: string;
  displayName: string;
  connectionMode: EngineConnectionMode;
  runtime: EngineRuntime;
  baseUrl: string;
  healthPath: string;
  launchCommand?: string;
  launchArguments: string[];
  workingDirectory?: string;
  runtimeId?: string;
  createdAt: string;
  updatedAt: string;
}

export type RouteKind = "chat" | "image" | "video" | "audio";

export interface Route {
  id: string;
  displayName: string;
  description?: string;
  recipeId: string;
  /** Defaults to "chat"; media routes are "image" | "video" | "audio". */
  kind?: RouteKind;
  enabled: boolean;
  isDefault?: boolean;
}

export interface ValidationIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ResourceEstimate {
  vramMiB?: number;
  ramMiB?: number;
}

export interface LaunchSpec {
  executable: string;
  args: string[];
  cwd?: string;
  env: Readonly<Record<string, string>>;
  internalHost: string;
  internalPort: number;
}

export interface InstanceSnapshot {
  id?: string;
  recipeId?: string;
  state: InstanceState;
  startedAt?: string;
  lastActivityAt?: string;
  activeLeases: number;
  failureReason?: string;
  /** Resolved product topology for the currently loaded self-hosted model. */
  localAgentTopology?: {
    sharedContextTokens: number;
    orchestratorContextTokens: number;
    workerCount: number;
    workerContextTokens: number;
    totalAllocatedContextTokens: number;
  };
}

export type InferenceRequestStatus =
  | "queued"
  | "started"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface InferenceRequestRecord {
  id: string;
  routeId: string;
  status: InferenceRequestStatus;
  enqueuedAt: string;
  startedAt?: string;
  completedAt?: string;
  errorCode?: string;
}

export type GpuWorkStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Durable admission ledger for the host's single GPU worker. The live queue
 * owns executable closures; SQLite owns enough state to prove ordering and to
 * turn unfinished work into an explicit interrupted record after restart. */
export interface GpuWorkRecord {
  id: string;
  routeId: string;
  kind: "chat" | "media" | "warm";
  status: GpuWorkStatus;
  position: number;
  depth: number;
  enqueuedAt: string;
  startedAt?: string;
  completedAt?: string;
  errorCode?: string;
}
