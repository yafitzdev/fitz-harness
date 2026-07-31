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
- Host APIs:
  - `GET /health`
  - `GET /v1/models`
  - `POST /v1/chat/completions` (streaming SSE and non-streaming)
  - `GET /api/v1/events`
  - basic management status, route update, and instance stop endpoints
- Optional development administrator-token guard.

## Intentionally deferred for refinement or later milestones

- NInfer live parity testing and service switchover. The adapter exists but has not touched the live service.
- Full JSON Schema/OpenAPI generation and exhaustive request compatibility.
- Multi-user authentication, device pairing, permissions, quotas, and audit policy.
- Native agent event protocol, Pi integration, transcripts, tools, and compaction.
- Tailscale connectivity.
- Electron and consumer UI.
- Production logging, metrics, diagnostics bundles, and secret storage.
- Backpressure limits and retained stream replay for active completions.
