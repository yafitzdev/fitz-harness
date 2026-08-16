# Session forensics

Every Fitz chat has a durable `sessionId`. It is a lookup key, not a serialized copy of the chat. The host now exposes the complete session-rooted diagnostic document at:

```text
GET /api/v1/sessions/:sessionId/forensics
```

The response is `{ data: SessionForensicsBundle }`. It joins the session and project metadata, the complete transcript (including reasoning entries), every linked agent run and plan (including isolated workers discovered through their durable parent-run link), all run events, tool approvals and safety records, media jobs and events, request usage, queue/lifecycle evidence, audit events, legacy queue rows, GPU work, and normalized inference-boundary evidence. Artifact metadata is always included; immutable artifact bytes are included as base64 by default and can be omitted with `?includeArtifactContent=false`. `?download=true` adds a download filename.

The `fitz_session` tool supports the same data through sections:

- `overview` for counts, run status, and coverage;
- `transcript` for the paginated conversation (the default);
- `runs`, `evidence`, `artifacts`, `media`, and `audit` for focused diagnosis;
- `all` for the complete bundle, with `includeArtifactContent=true` when bytes are required.

The scheduler records an engine-neutral evidence row at admission and start, appends every normalized delta as it arrives (with sequence and timestamp), and writes a terminal completion/failure/cancellation snapshot. Requests that are rejected by a full/closed queue or arrive already aborted also receive a terminal evidence fact. On host restart, queued/running evidence is marked `interrupted` with `host_restarted`; any deltas already observed remain in the bundle, so a missing final response is explicit rather than ambiguous.

The coverage field is intentional. Fitz-owned normalized requests, deltas, errors, engine snapshots, transcripts, artifacts, and lifecycle records are captured. Managed engine handles expose a bounded, secret-redacted process-log ring, which is recorded as `best-effort`; provider wire payloads and logs from a remote/external process that does not expose that ring remain `not-captured`. The bundle says this explicitly instead of implying that absence is proof of non-execution.
