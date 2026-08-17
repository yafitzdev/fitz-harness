import type { SessionForensicsBundle } from "./forensics.js";
import type { ProjectRecord, SessionRecord, TranscriptEntryRecord } from "./collaboration.js";

/** Rebuildable read model metadata. Canonical transcript rows remain the source
 * of truth; this projection only makes bounded counts/checkpoint boundaries
 * cheap to inspect and can always be rebuilt from those rows. */
export interface SessionProjection {
  sessionId: string;
  version: number;
  sourceRevision: number;
  sourceTranscriptSequence: number;
  transcriptEntryCount: number;
  messageCount: number;
  reasoningCount: number;
  toolCallCount: number;
  toolResultCount: number;
  compactionCount: number;
  latestCompactionSequence?: number;
  latestCompactionThroughSequence?: number;
  updatedAt: string;
}

/** The durable sections that can be queried from a session. */
export type SessionQuerySection =
  | "overview"
  | "transcript"
  | "runs"
  | "evidence"
  | "artifacts"
  | "media"
  | "audit"
  | "all";

/** Reduced transcript form used by agents and other bounded consumers. */
export interface SessionQueryMessage {
  sequence: number;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
}

export interface SessionQuerySnapshot {
  title: string;
  status: string;
  updatedAt: string;
  messages: SessionQueryMessage[];
  projection?: SessionProjection;
  forensics?: SessionForensicsBundle;
}

export interface SessionQueryRequest {
  sessionId: string;
  section?: SessionQuerySection;
  /** Forward pagination cursor for transcript reads. */
  after?: number;
  /** Reverse pagination cursor for transcript reads. */
  before?: number;
  limit?: number;
  includeArtifactContent?: boolean;
  /** The host supplies this from the authenticated run; callers never choose it to cross users. */
  ownerUserId?: string;
}

export interface SessionQueryPage {
  direction: "forward" | "backward" | "none";
  limit: number;
  returned: number;
  hasMore: boolean;
  /** HTTP/UI adapters may attach the host's current context estimate. */
  estimatedContextTokens?: number;
  after?: number;
  before?: number;
  nextAfter?: number;
  nextBefore?: number;
}

export interface SessionQueryResult {
  session: SessionRecord;
  project?: ProjectRecord;
  section: SessionQuerySection;
  /** Raw canonical entries for API/UI consumers that need the original record. */
  transcript: TranscriptEntryRecord[];
  /** Reduced bounded form for agents and text-oriented consumers. */
  snapshot: SessionQuerySnapshot;
  page: SessionQueryPage;
}

/** One query contract shared by storage, HTTP, UI adapters, and agent tools. */
export interface SessionQueryService {
  query(request: SessionQueryRequest): Promise<SessionQueryResult | undefined>;
}
