export const USER_ROLES = ["administrator", "agent", "consumer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export type UserStatus = "active" | "disabled";

export interface UserRecord {
  id: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface DeviceAuthenticationRecord extends DeviceRecord {
  tokenHash: string;
  user: UserRecord;
}

export interface MediaQuota {
  maxJobsPerWindow: number; // rolling-window job count, e.g. 20
  windowHours: number; // default 24
  maxConcurrentJobs: number; // default 1 (matches the single queue)
  creditBudgetCents?: number; // cumulative credit cap within the window
}

export interface UserQuota {
  maxRequestsPerMinute: number;
  maxPromptChars: number;
  maxOutputTokens: number;
  maxQueueDepth: number;
  media?: MediaQuota; // absent ⇒ media submits are denied (fail closed)
}

export interface AuditEventRecord {
  id: string;
  timestamp: string;
  actorUserId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  detail: Readonly<Record<string, unknown>>;
}
