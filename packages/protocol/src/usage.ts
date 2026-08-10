export type UsageKind = "chat" | "image" | "video" | "audio";
export type UsageStatus = "completed" | "failed" | "cancelled" | "interrupted";

/** One immutable, terminal request fact. Provider token fields stay nullable:
 * a missing usage trailer is unknown usage, never zero usage. */
export interface RequestUsageRecord {
  id: string;
  kind: UsageKind;
  status: UsageStatus;
  routeId: string;
  recipeId?: string;
  playbookId?: string;
  adapter?: string;
  modelId?: string;
  ownerUserId?: string;
  sessionId?: string;
  runId?: string;
  executionLane: "gpu" | "cloud";
  enqueuedAt: string;
  startedAt?: string;
  firstOutputAt?: string;
  completedAt: string;
  queueWaitMs?: number;
  ttftMs?: number;
  generationMs?: number;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  creditCostCents?: number;
  errorCode?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface UsageTotals {
  requests: number;
  successful: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokenReportedRequests: number;
  mediaJobs: number;
  creditCostCents: number;
  averageQueueWaitMs?: number;
  averageTtftMs?: number;
  averageDurationMs?: number;
}

export interface UsageTimelineBucket {
  timestamp: string;
  requests: number;
  failed: number;
  interrupted: number;
  mediaJobs: number;
  promptTokens: number;
  completionTokens: number;
}

export interface UsageBreakdownRow {
  key: string;
  label: string;
  requests: number;
  failed: number;
  interrupted: number;
  totalTokens: number;
  averageTtftMs?: number;
  averageDurationMs?: number;
}

export interface UsageReport {
  from: string;
  to: string;
  bucket: "hour" | "day";
  totals: UsageTotals;
  timeline: UsageTimelineBucket[];
  routes: UsageBreakdownRow[];
  recipes: UsageBreakdownRow[];
  modalities: UsageBreakdownRow[];
}
