# Infrastructure implementation status

## Implemented in the initial bulk pass

- pnpm TypeScript monorepo with build, typecheck, and test commands.
- Versioned protocol types for recipes, routes, lifecycle state, events, and initial Chat Completions requests.
- Engine adapter contract and registry.
- Route resolver.
- Single-generation FIFO scheduler with cancellation and queue events.
- Lifecycle state machine with on-demand loading, recipe switching, leases, minimum residency, and idle TTL eviction.
- Deterministic fake engine adapter.
- Opt-in direct NInfer adapter with validated launch specs, generated per-instance credentials,
  readiness polling, authenticated streaming translation, bounded logs, and graceful/forced stop.
- Spawned-process NInfer adapter integration coverage using an authenticated HTTP/SSE simulator.
- SQLite migrations and repositories for recipes, routes, lifecycle events, settings, and inference-request groundwork.
- Durable inference request status, administrator request history, and startup recovery that marks
  previously queued or running requests as interrupted.
- Pre-launch RAM/VRAM resource policy with NVIDIA telemetry and a configurable 2,048 MiB default
  VRAM reserve, exposed through health and management status.
- Structured HTTP logging with sensitive-header redaction, lifecycle/HTTP metrics, authenticated
  metrics and diagnostic endpoints, and recursive secret redaction for exported diagnostics.
- Required-auth mode with HMAC-SHA-256 device bearer credentials, durable users and devices,
  administrator/agent/consumer roles, per-user route grants and quotas, device revocation, audit
  history, and bootstrap-administrator provisioning.
- Versioned native agent runs with durable run state and sequenced events, background execution
  across client disconnects, cancellation, owner isolation, JSON event replay, resumable SSE via
  `after` or `Last-Event-ID`, and interrupted-run recovery after host restart.
- Fitz-owned agent runtime boundary and an opt-in Pi SDK 0.83.0 adapter using in-memory Pi sessions,
  restricted tool allowlists, event translation, cancellation, and native-run integration.
- Owner-scoped projects and sessions, ordered canonical transcripts, native run/session binding,
  user-over-role tool policies, secure-default approval requests, durable decisions, and audit events.
- Host APIs:
  - `GET /health`
  - `GET /v1/models`
  - `POST /v1/chat/completions` (streaming SSE and non-streaming)
  - `GET /api/v1/events`
  - native agent run submission, history, cancellation, event replay, and SSE endpoints
  - basic management status, route update, and instance stop endpoints
  - administrator user, device, grant, quota, revocation, and audit endpoints
- Optional development administrator-token guard and production required-auth mode.

## Intentionally deferred for refinement or later milestones

- Full JSON Schema/OpenAPI generation and exhaustive request compatibility.
- Interactive device-pairing exchange, encrypted secret storage, and persistent/distributed rate windows.
- Pi tool execution gating against the durable approval service, and compaction.
- Tailscale connectivity.
- Electron and consumer UI.
- OS-backed secret storage.
- Backpressure limits and retained stream replay for active completions.
