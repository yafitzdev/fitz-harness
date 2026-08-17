type Json = Record<string, any>;

export interface SessionQueryApi {
  (path: string, method?: string, body?: unknown): Promise<Json>;
}

export interface TranscriptQueryPage {
  hasEarlier?: boolean;
  estimatedContextTokens?: number;
}

export interface TranscriptQueryResponse {
  data: Json[];
  page: TranscriptQueryPage;
}

/**
 * Desktop adapter for the canonical session query endpoint. The host owns the
 * query contract; this function only translates its transcript page into the
 * shape consumed by the existing transcript window.
 */
export async function querySessionTranscript(
  api: SessionQueryApi,
  sessionId: string,
  options: { before?: number; limit?: number } = {},
): Promise<TranscriptQueryResponse> {
  const params = new URLSearchParams({ section: "transcript" });
  if (options.before !== undefined) params.set("before", String(options.before));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const response = await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}/query?${params.toString()}`);
  const result = isRecord(response.data) ? response.data : {};
  const page = isRecord(result.page) ? result.page : {};
  const estimatedContextTokens = Number(page.estimatedContextTokens);
  return {
    data: Array.isArray(result.transcript) ? result.transcript : [],
    page: {
      hasEarlier: page.direction === "backward" && page.hasMore === true,
      ...(Number.isFinite(estimatedContextTokens) && estimatedContextTokens >= 0 ? { estimatedContextTokens } : {}),
    },
  };
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
