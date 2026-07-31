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

export interface EngineCapabilities {
  chatCompletions: boolean;
  streaming: boolean;
  toolCalls: boolean;
  responseFormat: boolean;
  minP: boolean;
  maxConcurrentGenerations: number;
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

export interface Route {
  id: string;
  displayName: string;
  description?: string;
  recipeId: string;
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
