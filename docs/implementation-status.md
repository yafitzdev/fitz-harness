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
- Versioned native Pi coding-agent runs with durable run state, sequenced text/tool events, project-rooted coding tools, and background execution
  across client disconnects, cancellation, owner isolation, JSON event replay, resumable SSE via
  `after` or `Last-Event-ID`, and interrupted-run recovery after host restart.
- Fitz-owned agent runtime boundary and an opt-in Pi SDK 0.83.0 adapter using in-memory Pi sessions,
  restricted tool allowlists, event translation, cancellation, and native-run integration.
- Owner-scoped projects and sessions, ordered canonical transcripts, native run/session binding,
  user-over-role tool policies, secure-default approval requests, durable decisions, audit events,
  Pi pre-execution blocking, desktop Full access/Ask first/Read only selection, and inline approval UI.
- Fitz-owned token estimation and context budgeting, canonical-session reconstruction, injectable
  summarization, deterministic initial compaction, recent-message preservation, and durable
  compaction transcript records.
- Electron 43 shell with sandboxing, context isolation, Node-disabled renderer, restrictive CSP,
  navigation controls, path-limited IPC fetch proxy, main-process device credentials, and a bundled
  CommonJS preload.
- Initial desktop UI with project/task sidebar, transcript view, composer, route selector, lifecycle
  feedback, native run polling/replay, and project/session creation.
- Tailscale state detection and opt-in private HTTPS Serve management, one-time hashed pairing codes,
  pairing redemption into revocable device credentials, and bounded desktop reconnect/backoff.
- Owner-scoped artifact metadata and content storage with SHA-256 integrity metadata and size bounds,
  strict MIME classification, defensive content headers, and a desktop artifact panel with inert text,
  allowlisted media, sandboxed PDF preview, upload, and binary fallback.
- Windows NSIS desktop packaging, packaged-main smoke mode, GitHub release update checks/downloads,
  portable host zip with bundled Node runtime, optional user-logon scheduled task scripts, and a
  Windows CI packaging/smoke workflow.
- Generic external OpenAI-compatible and managed llama.cpp engine adapters sharing an authenticated
  streaming transport, with environment-resolved credentials, process lifecycle control, and HTTP/SSE fixtures.
- Main-branch CI plus unit, security-boundary, failure, spawned-process integration, compiled HTTP
  end-to-end, packaged executable, and restart-recovery test coverage.
- Host APIs:
  - `GET /health`
  - `GET /v1/models`
  - `POST /v1/chat/completions` (streaming SSE and non-streaming)
  - `GET /api/v1/events`
  - native agent run submission, history, cancellation, event replay, and SSE endpoints
  - basic management status, route update, and instance stop endpoints
  - administrator user, device, grant, quota, revocation, and audit endpoints
- Required-by-default production device authentication with a single-use local bootstrap, encrypted
  desktop credentials, remote pairing, and an optional development-only administrator-token guard.

## Intentionally deferred for refinement or later milestones

- Full JSON Schema/OpenAPI generation and exhaustive request compatibility.
- Persistent/distributed rate windows.
- Pi tool execution gating against the durable approval service and model-assisted summary quality.
- Tailscale installation/onboarding on the target machine and live tailnet validation.
- Desktop UX refinement, richer event rendering, and accessibility polish.
- OS-backed secret storage.
- Backpressure limits and retained stream replay for active completions.
