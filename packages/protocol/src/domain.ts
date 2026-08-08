export const PROTOCOL_VERSION = "1" as const;

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

export interface Recipe {
  id: string;
  playbookId: string;
  displayName: string;
  adapter: string;
  modelId: string;
  contextTokens: number;
  capabilities: EngineCapabilities;
  lifecycle: RecipeLifecyclePolicy;
  configuration: Readonly<Record<string, unknown>>;
}

export type EngineConnectionMode = "managed" | "external";
export type EngineRuntime = "windows" | "wsl";

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
  wslDistribution?: string;
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
