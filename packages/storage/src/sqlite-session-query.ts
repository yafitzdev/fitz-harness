import type {
  SessionQueryMessage,
  SessionQueryPage,
  SessionQueryRequest,
  SessionQueryResult,
  SessionQuerySection,
  SessionQueryService,
  SessionQuerySnapshot,
  TranscriptEntryRecord,
} from "@fitz/protocol";
import type { ArtifactRepository } from "./artifact-repository.js";
import type { SqliteStore } from "./sqlite-store.js";

const SECTIONS = new Set<SessionQuerySection>([
  "overview",
  "transcript",
  "runs",
  "evidence",
  "artifacts",
  "media",
  "audit",
  "all",
]);
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1_000;

/**
 * The single read path for session history and forensic evidence.
 *
 * SqliteStore remains the canonical source of truth; this class only composes
 * its already-normalized stores and applies one bounded, owner-aware query
 * contract for HTTP, agent, UI, and export consumers.
 */
export class SqliteSessionQueryService implements SessionQueryService {
  constructor(
    private readonly store: SqliteStore,
    private readonly options: { artifacts?: ArtifactRepository; maxLimit?: number } = {},
  ) {}

  async query(request: SessionQueryRequest): Promise<SessionQueryResult | undefined> {
    validateRequest(request);
    const session = this.store.getSession(request.sessionId);
    if (!session || (request.ownerUserId !== undefined && session.ownerUserId !== request.ownerUserId)) return undefined;
    const section = request.section ?? "transcript";
    const limit = clampLimit(request.limit, this.options.maxLimit ?? MAX_LIMIT);
    const transcript = section === "transcript" ? this.readTranscript(session.id, request, limit) : [];
    let forensics = section === "transcript" ? undefined : this.store.sessionForensics(session.id);
    if (forensics && shouldIncludeArtifactContent(section, request.includeArtifactContent) && this.options.artifacts) {
      forensics = await this.withArtifactContent(forensics);
    }
    const project = session.projectId ? this.store.getProject(session.projectId) : undefined;
    const snapshot: SessionQuerySnapshot = {
      title: session.title,
      status: session.status,
      updatedAt: session.updatedAt,
      messages: transcript.flatMap(toMessages),
      ...(forensics ? { forensics } : {}),
    };
    return {
      session,
      ...(project ? { project } : {}),
      section,
      transcript,
      snapshot,
      page: this.pageFor(session.id, section, request, transcript, limit),
    };
  }

  private readTranscript(sessionId: string, request: SessionQueryRequest, limit: number): TranscriptEntryRecord[] {
    if (request.after !== undefined) return this.store.transcriptAfter(sessionId, request.after, limit);
    return this.store.transcriptBefore(sessionId, request.before ?? Number.MAX_SAFE_INTEGER, limit);
  }

  private pageFor(sessionId: string, section: SessionQuerySection, request: SessionQueryRequest, entries: TranscriptEntryRecord[], limit: number): SessionQueryPage {
    if (section !== "transcript") return { direction: "none", limit, returned: 0, hasMore: false };
    if (request.after !== undefined) {
      const last = entries.at(-1)?.sequence;
      const hasMore = last !== undefined && this.store.transcriptAfter(sessionId, last, 1).length > 0;
      return {
        direction: "forward",
        limit,
        returned: entries.length,
        hasMore,
        after: request.after,
        ...(hasMore && last !== undefined ? { nextAfter: last } : {}),
      };
    }
    const first = entries.at(0)?.sequence;
    const hasMore = first !== undefined && this.store.hasTranscriptBefore(sessionId, first);
    return {
      direction: "backward",
      limit,
      returned: entries.length,
      hasMore,
      before: request.before ?? Number.MAX_SAFE_INTEGER,
      ...(hasMore && first !== undefined ? { nextBefore: first } : {}),
    };
  }

  private async withArtifactContent(bundle: NonNullable<ReturnType<SqliteStore["sessionForensics"]>>): Promise<typeof bundle> {
    const artifacts = await Promise.all(bundle.artifacts.map(async (artifact) => {
      try {
        const content = await this.options.artifacts!.read(artifact.id);
        return content
          ? { ...artifact, contentBase64: Buffer.from(content).toString("base64") }
          : { ...artifact, contentReadError: "content_not_found" };
      } catch (error) {
        return { ...artifact, contentReadError: error instanceof Error ? error.message : String(error) };
      }
    }));
    return {
      ...bundle,
      artifacts,
      coverage: { ...bundle.coverage, artifactContent: "included" },
    };
  }
}

function validateRequest(request: SessionQueryRequest): void {
  if (!request || typeof request.sessionId !== "string" || !request.sessionId.trim()) throw new TypeError("sessionId must be a non-empty string");
  if (request.after !== undefined && (!Number.isSafeInteger(request.after) || request.after < 0)) throw new TypeError("after must be a non-negative integer");
  if (request.before !== undefined && (!Number.isSafeInteger(request.before) || request.before < 1)) throw new TypeError("before must be a positive integer");
  if (request.after !== undefined && request.before !== undefined) throw new TypeError("after and before cannot be combined");
  if (request.section !== undefined && !SECTIONS.has(request.section)) throw new TypeError(`Unknown session query section: ${String(request.section)}`);
  if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1)) throw new TypeError("limit must be a positive integer");
}

function clampLimit(value: number | undefined, maximum: number): number {
  return Math.min(Math.max(1, Math.trunc(value ?? DEFAULT_LIMIT)), Math.max(1, Math.min(maximum, MAX_LIMIT)));
}

function shouldIncludeArtifactContent(section: SessionQuerySection, requested: boolean | undefined): boolean {
  return requested === true && (section === "artifacts" || section === "all");
}

function toMessages(entry: TranscriptEntryRecord): SessionQueryMessage[] {
  const content = entry.content as { text?: unknown; toolName?: unknown; input?: unknown; result?: unknown; summary?: unknown };
  switch (entry.kind) {
    case "message":
      return typeof content.text === "string" && content.text.trim() && entry.role
        ? [{ sequence: entry.sequence, role: mapRole(entry.role), text: content.text }]
        : [];
    case "reasoning":
      return typeof content.text === "string" && content.text.trim()
        ? [{ sequence: entry.sequence, role: "assistant", text: `[reasoning] ${content.text}` }]
        : [];
    case "tool-call":
      return [{ sequence: entry.sequence, role: "tool", text: `[tool] ${typeof content.toolName === "string" ? content.toolName : "unknown"}: ${summarize(content.input)}` }];
    case "tool-result":
      return [{ sequence: entry.sequence, role: "tool", text: `[result] ${summarize(content.result)}` }];
    case "compaction":
      return typeof content.summary === "string" && content.summary.trim()
        ? [{ sequence: entry.sequence, role: "system", text: `[context] ${content.summary}` }]
        : [];
    case "system":
      return typeof content.text === "string" && content.text.trim()
        ? [{ sequence: entry.sequence, role: "system", text: content.text }]
        : [];
    default:
      return [];
  }
}

function mapRole(role: NonNullable<TranscriptEntryRecord["role"]>): SessionQueryMessage["role"] {
  return role === "user" || role === "assistant" || role === "tool" || role === "system" ? role : "system";
}

function summarize(value: unknown, maxChars = 500): string {
  if (value === undefined || value === null) return "(none)";
  let text: string;
  try { text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value); }
  catch { text = String(value); }
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…[truncated]`;
}
