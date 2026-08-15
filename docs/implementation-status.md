# Infrastructure implementation status

## Implemented in the initial bulk pass

- pnpm TypeScript monorepo with build, typecheck, and test commands.
- Versioned protocol types for recipes, routes, lifecycle state, events, and initial Chat Completions requests.
- Engine adapter contract and registry.
- Route resolver.
- Strict single-GPU owner-fair scheduler shared by chat generation, media generation,
  recipe tests, and VRAM-bearing model activation/warmup. Queue admission,
  cancellation, failure, and completion are persisted in one GPU-work ledger;
  unfinished work is marked interrupted after host restart. A per-data-root host
  ownership lock prevents a second Fitz host process from creating an independent
  GPU queue. Waiting work rotates across owners while preserving FIFO within each
  owner, so one user's burst cannot monopolize the host. CPU/RAM-only preparation
  may remain concurrent because it cannot activate a model or consume model VRAM.
- Single-Default lifecycle policy with asynchronous host-start/desktop-open warm-up, pinned residency, safe recipe switching, local-media displacement/restoration, and force-unload plus dedicated-runtime termination when the hosting desktop closes.
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
  administrator/agent/consumer roles, owner-scoped Smart/Fast cloud connections, media-route grants,
  quotas, device revocation, audit history, and bootstrap-administrator provisioning.
- Versioned native Pi coding-agent runs with durable run state, sequenced text/tool events, project-rooted coding tools, and background execution
  across client disconnects, cancellation, owner isolation, JSON event replay, resumable SSE via
  `after` or `Last-Event-ID`, and interrupted-run recovery after host restart.
- Fitz-owned agent runtime boundary and an opt-in Pi SDK 0.83.0 adapter using in-memory Pi sessions,
  restricted tool allowlists, event translation, cancellation, and native-run integration.
- Consolidated Pi implementation: all Fitz-owned Pi code (runtime adapter, delegation policy,
  registry-backed `PiPackageService`, pinned SDK version) lives in `packages/agent-pi`; its public
  surface exports from the index, while the host only wires runtime paths, the approval gate, and the
  session reader.
- Cross-session conversation lookup for the agent: the host's `createSessionReader` serves canonical
  transcripts from the SQLite store to the read-only `fitz_session` tool, registered only when a
  reader is supplied, with truncation-safe formatting and reader-failure handling.
- Unified dev data root: `FITZ_DATA_ROOT` derives database, pi packages, logs, and cache from one
  root (repo-contained `data/` in dev); the legacy `data/fitz-ninfer.db` store was migrated into
  `data/database/fitz.db` once and the migration tooling has since been removed.
- Build-first dev scripts with a port guard: `pnpm dev` / `pnpm dev:fake` compile workspace
  packages before starting the watch host, share one data root, and refuse to start when another
  host already answers on the port.
- Owner-scoped projects and sessions, ordered canonical transcripts, native run/session binding,
  user-over-role tool policies, secure-default approval requests, durable decisions, audit events,
  Pi pre-execution blocking, desktop Full access/Ask first/Read only selection, and inline approval UI.
- Fitz-owned token estimation and context budgeting, canonical-session reconstruction, injectable
  summarization, deterministic initial compaction, recent-message preservation, and durable
  compaction transcript records.
- Electron 43 shell with sandboxing, context isolation, Node-disabled renderer, restrictive CSP,
  an application navigation controller for access-gated page transitions and generalized nested
  back/forward history, path-limited IPC fetch proxy, main-process device credentials, and a bundled
  CommonJS preload.
- Desktop conversation state is separated from renderer composition: dedicated controllers own
  new-chat/session materialization, transcript/run/media restoration, inspector scoping, context
  estimation, and compaction.
- Initial desktop UI with project/task sidebar, transcript view, composer, route selector, lifecycle
  feedback, native run polling/replay, and project/session creation.
- Unified Hosting with a host-owned consumer gateway, opt-in Tailscale Funnel lifecycle, one-step
  consumer/API-key creation, rotation/revocation/removal, per-user usage summaries and time-of-day
  activity, and bounded desktop reconnect/backoff. Recipients enter only URL plus API key.
- Versioned canonical `fitz.config.json` for non-secret operational settings, with validation,
  atomic writes, external-edit watching, legacy migration, secret rejection, an Advanced editor,
  and new-chat route/effort defaults. Runtime records and credentials remain SQLite/OS-secured.
- Owner-scoped artifact metadata and content storage with SHA-256 integrity metadata and size bounds,
  strict MIME classification, defensive content headers, and a desktop artifact panel with inert text,
  allowlisted media, sandboxed PDF preview, upload, and binary fallback.
- Artifact payloads are immutable content-addressed objects outside SQLite. Coordinated online backups
  capture the database and every referenced object behind one mutation boundary, validate SQLite plus
  object checksums before publication, and stage a confirmed restore before the next database open.
  Administration exposes integrity scans, race-free orphan collection, optional global storage quota,
  backup creation, and rollback-preserving restore. Active delivery leases prevent garbage collection
  from deleting an object while HTTP is streaming it.
- SQLite remains a compatibility façade while configuration, inference telemetry, identity/access,
  workspace/transcript/artifact metadata, agent runs, media, safety recovery, and settings each own
  their domain SQL. Host identity/access and safety administration routes are separately registered.
- Generalized image, video, and audio generation pipeline with capability-aware recipes and routes,
  durable submit/poll/cancel jobs, sequenced replayable events, queue/lifecycle leases, crash recovery,
  cancellation, progress, and per-kind artifact size limits.
- OpenAI-shaped image and video gateways plus connection templates for OpenAI-compatible media, fal,
  and Replicate. Local GPU work is permanently single-slot; remote provider jobs use an independent
  bounded cloud lane and never acquire a local lifecycle lease or evict a resident local model.
  Provider URLs are downloaded into Fitz-owned artifacts, and orphaned paid jobs are cancelled
  best-effort on restart.
- Local media engines include a deterministic GPU-free fake adapter and a ComfyUI adapter/playbook for
  manually provisioned MiniMax H3 video and MiniMax Music 3 audio generation. H3 is video-only at the
  routing layer while retaining synchronized audio in its MP4; Music 3 exclusively owns local audio. Agent media
  tools enforce route grants, Ask-first approval, and job/credit quotas without waiting inside the
  serialized agent slot.
- Large media artifacts support MIME-safe Inspector previews and RFC 7233 single-byte-range delivery
  with `206`/`416`, `Accept-Ranges`, and kind-aware image/audio/video caps.
- The portable Windows host smoke now boots the bundled server from a clean data root, registers a fake
  image recipe, runs route → queue → media adapter → artifact persistence, validates the returned PNG,
  and verifies a ranged artifact response. This guards schema and media wiring in the shipped bundle,
  not only source-level tests.
- Desktop Inspector binary previews: chat file links and agent tool rows now open images, PDFs, audio,
  and video in place — the main process resolves known binary extensions to base64 payloads with their
  MIME type (10 MB cap) instead of rejecting NUL bytes, and the Inspector renders images inline, PDFs in
  a blob-URL frame for Chromium's viewer (intentionally unsandboxed because the sandbox attribute
  disables the PDF viewer plugin and blanks the preview), and audio/video with inline controls.
- Tabbed Inspector with the artifact repository as a persistent view behind a header button: the
  Inspector itself is content only — its rounded-square bubble tab bar lives in the workspace
  header, above the panel, growing rightward from the inspector's left edge, and the repository is
  no longer a tab. The right of the header carries the raw↔rendered toggle (revealed only for
  markdown and HTML docs), `+` (new empty tab), `< >` (deferred fullscreen preview), and `H` (the
  sidebar button, a mirror of the sidebar titlebar icon), which toggles the panel open and closed —
  tabs and the active view survive a close, so reopening returns to the same doc, and the
  repository is the panel's home view when nothing is open. Closing the last doc tab falls back to
  the artifact view. The
  repository grows with every file the agent produces (registered the moment a file appears in the
  conversation, no click needed — streaming partials are superseded by the complete path, and chat
  references are replaced by their resolved absolute path once inspected) plus the current session's
  uploads, and every file, upload, URL, and pasted image/PDF opens as its own closable tab (middle-click
  closes a tab) with per-tab preview state restored on switch. Repository rows and each tab's tooltip
  always show project-relative paths.
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
- Required-by-default production device authentication with a single-use local administrator
  bootstrap, encrypted desktop credentials, revocable remote API keys, and an optional
  development-only administrator-token guard.

## Intentionally deferred for refinement or later milestones

- Full JSON Schema/OpenAPI generation and exhaustive request compatibility.
- Persistent/distributed rate windows.
- Model-assisted summary quality (the summarizer is an injectable interface; the shipped default is deterministic).
- Bundling/licensing Tailscale on the host PC. The current product controls an installed, signed-in
  daemon entirely from Hosting; recipients never install Tailscale.
- Live paid-provider media validation with a user-owned fal or Replicate credential, and a real local
  MiniMax H3/ComfyUI generation after the engine, weights, and required custom nodes are provisioned.
- Desktop UX refinement, richer event rendering, and accessibility polish.
- OS-backed secret storage.
- Retained stream replay for OpenAI-shaped active completions.
