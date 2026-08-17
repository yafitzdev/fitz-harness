# Session query

Fitz has one read-only `SessionQueryService` contract for history and forensic
evidence. Its source of truth is the existing canonical SQLite transcript,
agent-run, inference-evidence, media, artifact, audit, and lifecycle stores;
the query service does not create a second session database.

The service is used by:

- `GET /api/v1/sessions/:sessionId/query`
- the legacy transcript and forensics endpoints
- the `fitz_session` agent tool
- future inspector/export consumers

Queries select a bounded section (`transcript`, `overview`, `runs`, `evidence`,
`artifacts`, `media`, `audit`, or `all`) and use sequence cursors for transcript
pagination. Owner filtering is applied in the service, not left to individual
consumers. Results include the canonical raw transcript entries, a reduced
agent-friendly snapshot, and explicit pagination metadata.

Artifact bytes are opt-in and only enabled for the `artifacts` and `all`
sections. This keeps normal diagnosis metadata-only while retaining the
complete export path when a caller explicitly requests it.

Projections and checkpoints are intentionally not introduced here. If query
latency later requires indexes or materialized views, they must accelerate this
contract while the canonical event records remain authoritative and rebuildable.
