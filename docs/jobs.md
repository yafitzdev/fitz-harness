# Unified jobs

Fitz exposes one read-only control-plane view for durable background work:

- `GET /api/v1/jobs` lists agent, media, and future maintenance jobs. Filters
  include `kind`, `status`, `sessionId`, and (for administrators) `ownerUserId`.
- `GET /api/v1/jobs/:jobId` returns the normalized lifecycle record.
- `GET /api/v1/jobs/:jobId/events?after=<sequence>` replays compact lifecycle
  events. Detailed agent deltas and media payloads remain in their specialized
  event stores; the common stream intentionally does not duplicate token or
  binary data.

The `jobs` table is an index, not a second source of truth. `agent_runs` and
`media_jobs` retain their specialized request, checkpoint, artifact, and quota
state. Both stores publish creation, queue/start/progress, terminal, and
restart-recovery transitions into the common registry using the same stable id.
Existing rows are backfilled by migration 27. Future maintenance work can use
the same contract without introducing another queue-specific API.

The shared-host gateway permits the read-only job endpoints, so a paired
desktop can inspect work through the same authenticated host boundary.
