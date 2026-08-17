import type { PiSessionReader } from "@fitz/agent-pi";
import type { SessionQueryService } from "@fitz/protocol";

/**
 * Compatibility adapter for the Pi runtime. Querying itself belongs to the
 * shared SessionQueryService; this adapter only preserves the Pi callback
 * shape while the agent package migrates to the common contract.
 */
export function createSessionReader(service: SessionQueryService): PiSessionReader {
  return async (sessionId, lookup) => {
    const result = await service.query({
      sessionId,
      ...(lookup?.after !== undefined ? { after: lookup.after } : { after: 0 }),
      ...(lookup?.limit !== undefined ? { limit: lookup.limit } : {}),
      ...(lookup?.section !== undefined ? { section: lookup.section } : {}),
      ...(lookup?.includeArtifactContent !== undefined ? { includeArtifactContent: lookup.includeArtifactContent } : {}),
      ...(lookup?.ownerUserId !== undefined ? { ownerUserId: lookup.ownerUserId } : {}),
    });
    return result?.snapshot;
  };
}
