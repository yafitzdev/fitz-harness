# Fitz Codex — Product and Technical Design

Status: initial architecture specification  
Target platform: Windows 11 host and desktop clients, with iOS/Android clients to follow  
Working repository name: `fitz-codex`  

> **Naming note:** “Fitz Codex” is a working project name. The product is inspired by the interaction quality of the Codex desktop application, but it is not affiliated with or endorsed by OpenAI. Before public distribution, use original branding and avoid confusing use of third-party trademarks or assets.

## 1. Executive summary

Fitz Codex is a local-first, Codex-style agent application and a general-purpose inference control plane.

It has two equally important responsibilities:

1. Deliver a polished agent experience: persistent conversations, streaming responses, model selection, tool activity, compaction, attachments, diffs, and a rich artifact/media panel.
2. Host and manage local LLM engines: install or register engines, define model launch recipes, load models on demand, route requests through stable aliases, queue work, evict idle models, and expose authenticated APIs to local and remote clients.

The first inference engine is NInfer because it is highly optimized for the validated Qwen checkpoints and this PC. NInfer is not hard-wired into the product. Future engines—llama.cpp, vLLM, and other checkpoint- or hardware-specific runtimes—must fit behind the same adapter contract.

The first agent engine is based on Pi’s embeddable SDK. Pi is used to avoid reimplementing the basic agent loop, streaming, tool execution, cancellation, extensions, and model communication. Fitz Codex owns the product policy around Pi: context construction, Codex-derived compaction, session persistence, permissions, model routing, and the entire user interface.

The host application exposes a stable OpenAI-compatible API as well as a richer application-native agent protocol. Individual inference engines remain bound to loopback and may start on temporary ports. Remote access is off by default and uses a protected API-key consumer gateway published through Tailscale Funnel. NInfer and host administration are never exposed directly to the public Internet.

The desktop application is expected to use Electron and a React/TypeScript renderer. A lightweight host service runs independently of the visible window so remote users can submit requests while the desktop UI is closed. Models remain unloaded until needed.

## 2. Product principles

### 2.1 Local-first and private by default

- Model artifacts, prompts, transcripts, files, and tool execution remain on the host unless a user explicitly configures an external service.
- Engine ports bind to loopback.
- Remote connectivity uses a private authenticated network.
- Public Internet exposure is not a default or required operating mode.

### 2.2 Stable consumer experience, replaceable engines

- Clients select stable routes such as `default-agent`, `fast`, `best`, or `vision`.
- Clients do not select executable paths, engine builds, ports, artifacts, or raw launch flags.
- An administrator can change the recipe behind a route without reconfiguring clients.
- Engine-specific quirks are isolated inside adapters and recipe capability declarations.

### 2.3 Models consume resources only when useful

- The host control service is lightweight and may remain running.
- Inference instances and their model allocations are started on demand.
- Idle eviction is configurable globally, per playbook, per recipe, and eventually per route.
- The scheduler avoids thrashing when requests alternate between models.

### 2.4 Polished for nontechnical consumers

- A consumer should not need to understand NInfer, llama.cpp, WSL, CUDA, ports, API keys, playbooks, or recipes.
- A remote user installs the application, enters the host URL plus API key, and chats.
- Technical controls are role-gated and absent from the consumer UI.

### 2.5 Inspectable and recoverable

- Every engine launch has a rendered command, lifecycle log, health state, and failure reason.
- Full conversation history is retained even after compaction.
- Configuration is exportable without secrets.
- Failed model loads, crashes, and interrupted streams produce actionable state rather than silent corruption.

### 2.6 Selective reuse, not accidental coupling

- Pi is an implementation behind a Fitz-owned agent interface.
- Codex’s open-source local compaction behavior is adapted behind a Fitz-owned context manager.
- Tailscale is integrated behind a connectivity interface.
- The desktop renderer communicates only with Fitz protocols, not directly with Pi, NInfer, or engine processes.

## 3. Confirmed scope

### 3.1 Required user experience

- Codex-style conversation-first desktop experience.
- Persistent project/task sidebar.
- Streaming assistant output.
- Clear rendering of tool activity, approvals, commands, files, and diffs.
- Stop, steer, retry, and follow-up behavior.
- Model selector with simple consumer-facing options and richer administrator controls.
- Automatic context compaction that is close to seamless during long sessions.
- Right-side artifact/media panel capable of rendering common media and project outputs.
- Separate administrator and consumer experiences in the same application.

### 3.2 Required inference management

- Engine adapters.
- Playbooks and recipes.
- Stable routes and defaults.
- On-demand loading.
- Configurable TTL and eviction policies.
- Queueing and single-GPU scheduling.
- Health checks and process supervision.
- Resource budgeting, including a configurable GPU reserve for Windows applications.
- OpenAI-compatible serving from the Fitz host.
- Remote consumption through integrated Tailscale connectivity.

### 3.3 Explicitly unnecessary for the first product

- Pull request tab.
- Scheduled tasks tab.
- Sites tab.
- Cloud-agent orchestration.
- Organization/team administration beyond simple local users and roles.
- A public plugin marketplace or plugin browser.
- Full feature parity with Codex Desktop.
- Public unauthenticated model serving.
- Continuous batching comparable to vLLM when the selected engine does not support it.
- Multi-host distributed inference in the first release.

## 4. Terminology and domain model

The following terms are normative.

### 4.1 Engine adapter

Code that knows how to validate, launch, monitor, communicate with, and stop one family of inference engines.

Examples:

- `ninfer`
- `llama-cpp`
- `vllm`
- `generic-openai-compatible`

An adapter is product code. It is not a user-created model configuration.

### 4.2 Playbook

A configured installation of an engine for a particular environment or hardware profile.

Examples:

- “NInfer current CUDA build on this RTX host”
- “llama.cpp CUDA build in Ubuntu WSL”
- “vLLM Docker deployment on Linux”

A playbook defines shared execution behavior, installation paths, version identity, environment, capability defaults, and lifecycle behavior. It contains one or more recipes.

### 4.3 Recipe

A launchable model configuration within a playbook.

A recipe combines:

- Model artifact.
- Model identity.
- Context and cache settings.
- Engine flags.
- Sampling defaults.
- Resource expectations.
- Health checks.
- Capability declarations.
- Lifecycle and eviction policy.

Examples:

- “Qwen 3.6 35B A3B, NInfer MTP4, 100K context”
- “Qwen 27B GGUF Q4_K_M, llama.cpp, 64K context”

### 4.4 Route

A stable consumer-facing model name that resolves to a recipe.

Examples:

- `default-agent`
- `fast`
- `best`
- `compatible`
- `vision`

A route may later contain fallback recipes, per-user overrides, or routing policy. Routes are the public contract. Recipes are administrator implementation details.

### 4.5 Instance

A live process created from a recipe. An instance has runtime state, a process identity, a loopback endpoint, metrics, leases, and logs.

### 4.6 Lease

A temporary claim preventing an instance from being evicted. Active generations, compactions, queued same-recipe work, and explicit administrator holds create leases.

### 4.7 Host

The PC that runs the Fitz control service, Pi agent runtime, inference engines, models, and persistent data.

### 4.8 Consumer

A user or device that connects to the host to chat or call the API without managing engines.

## 5. System architecture

```text
┌──────────────────────────────── Client surfaces ────────────────────────────────┐
│                                                                                 │
│  Host desktop UI      Remote Windows UI      iPhone/Samsung client or PWA       │
│                                                                                 │
└────────────────────────────────────┬────────────────────────────────────────────┘
                                     │ HTTPS/WSS over Tailscale
                                     ▼
┌──────────────────────────── Fitz host control plane ─────────────────────────────┐
│                                                                                 │
│  Identity and roles      Native agent API       OpenAI-compatible gateway       │
│  Sessions and artifacts  Route resolver         Request validation              │
│  Queue and scheduler     Lifecycle manager      Metrics and audit log            │
│  Playbook management     Connectivity manager   Configuration store              │
│                                                                                 │
└───────────────┬─────────────────────────────┬────────────────────────────────────┘
                │                             │
                ▼                             ▼
┌────────────────────────────┐   ┌───────────────────────────────────────────────┐
│ Agent runtime              │   │ Engine instances                             │
│                            │   │                                               │
│ Fitz agent protocol        │   │ NInfer       llama.cpp       future engines  │
│ Pi adapter                 │   │ loopback     loopback        loopback         │
│ Context manager            │   │ on demand    on demand       on demand        │
│ Codex-derived compaction   │   │                                               │
│ Curated tools/extensions   │   └───────────────────────────────────────────────┘
└────────────────────────────┘
```

### 5.1 Process boundaries on the current PC

The current hardware environment uses Windows 11 and Ubuntu WSL. The initial process design should be:

1. **Fitz Desktop** — Electron application on Windows.
2. **Fitz Host** — lightweight service, preferably running where Pi and the engines run; initially Ubuntu WSL.
3. **Fitz Connectivity** — Tailscale integration, implemented through an adapter. It may use the installed Tailscale daemon initially and a bundled `tsnet` sidecar when appropriate.
4. **Engine instances** — NInfer, llama.cpp, or another adapter-controlled process in WSL/Linux/Windows/Docker.

The visible desktop window is not the service lifecycle owner. Closing the window must not stop remote access or unload an active generation. The host service should start automatically and consume little memory when no engine is loaded.

### 5.2 Stable and unstable endpoints

Stable endpoints:

- Local Fitz API address.
- Private Tailscale HTTPS address.
- Route names.
- Native agent protocol version.

Unstable/internal endpoints:

- Engine process ports.
- Engine process IDs.
- Model artifact paths.
- Engine-specific API keys.
- Generated launch commands.

Clients must never persist or depend on unstable/internal endpoints.

## 6. Repository and package structure

The initial implementation should use a TypeScript monorepo. Exact tooling can be selected during scaffolding, but the intended boundaries are:

```text
fitz-codex/
├── apps/
│   ├── desktop/                 Electron shell and React renderer
│   ├── host/                    Long-running host service
│   └── mobile/                  Reserved for later shared/mobile shell
├── packages/
│   ├── protocol/                Versioned DTOs and event schemas
│   ├── agent-core/              Fitz-owned agent abstraction and policy
│   ├── agent-pi/                Pi SDK adapter
│   ├── context/                 Token budgets and compaction
│   ├── inference-core/          Playbooks, recipes, routes, scheduler
│   ├── engine-ninfer/           NInfer adapter
│   ├── engine-llama-cpp/        llama.cpp adapter
│   ├── engine-generic-openai/   Generic compatible-server adapter
│   ├── connectivity/            Tailscale and local connectivity abstractions
│   ├── storage/                 SQLite repositories and migrations
│   ├── security/                Identity, tokens, roles, policy
│   ├── media/                   Artifact metadata and renderer registry
│   └── ui/                      Shared React components and theme
├── services/
│   └── tailscale-sidecar/       Optional Go/tsnet helper
├── docs/
├── fixtures/
├── scripts/
└── DESIGN.md
```

The renderer must import protocol and UI packages, but not engine adapters or Pi. The host may import engine and agent packages. Engine-specific dependencies must not leak into common packages.

## 7. Agent architecture and Pi boundary

### 7.1 Why Pi is used

Pi’s SDK already provides:

- Programmatic agent sessions.
- Model selection and switching.
- Streaming event subscriptions.
- Prompting, steering, and follow-up messages.
- Tool execution.
- Cancellation.
- Image inputs.
- Persistent session mechanisms.
- Extensions, skills, and prompt resources.
- Existing NInfer-compatible model communication.

These features save substantial implementation time.

### 7.2 What Fitz owns

Pi must remain behind an adapter. Fitz owns:

- Public session and event schemas.
- Persistent user/project/task organization.
- Model routes and route selection.
- Context budgets.
- Compaction policy and prompts.
- Tool permission policy.
- Transcript and artifact persistence.
- User-visible error mapping.
- Retry and failover policy.
- UI state.

The desktop renderer must never consume raw Pi event objects. `agent-pi` translates Pi events into versioned Fitz events.

### 7.3 Avoiding compaction lock-in

Before relying on Pi’s highest-level session API, inspect where Pi owns message mutation and compaction. Prefer composition or lower-level APIs. If Pi does not provide sufficient hooks, maintain a small, documented patch or fork rather than allowing Pi’s internal compaction behavior to define Fitz semantics.

Any fork should:

- Remain shallow.
- Contain isolated commits.
- Include upstream version pins.
- Have tests proving Fitz compaction still works after upgrades.
- Avoid unrelated modifications.

### 7.4 Agent protocol

The UI-facing protocol should represent semantic events such as:

- `turn.started`
- `assistant.text.delta`
- `assistant.reasoning.summary`
- `tool.started`
- `tool.output.delta`
- `tool.completed`
- `approval.requested`
- `file.changed`
- `artifact.available`
- `compaction.started`
- `compaction.completed`
- `model.loading`
- `model.ready`
- `queue.position`
- `turn.completed`
- `turn.failed`

The protocol should support resumable event sequence numbers so a remote client can reconnect without losing the visible state of an active turn.

## 8. Context management and Codex-derived compaction

### 8.1 Source and licensing

Codex’s local compaction implementation is available in the Apache-2.0-licensed `openai/codex` repository. Fitz may adapt the behavior and prompt structure while preserving required notices and attribution. OpenAI’s remote `/responses/compact` service is not part of this plan.

### 8.2 Separation of transcript and working context

Compaction must never destroy the canonical transcript.

- **Canonical transcript:** append-only record of user messages, assistant messages, tool calls, outputs, approvals, file references, and compaction events.
- **Working context:** materialized prompt sent to the active model.
- **Compaction summary:** generated continuation state that replaces older items only in the working context.

A user can always inspect pre-compaction history even though the model no longer receives all of it.

### 8.3 Compaction trigger

The trigger is configurable and based on estimated prepared-prompt usage, not merely visible chat text.

The initial policy for 100K-context recipes should reserve space for:

- System and agent instructions.
- Tool definitions.
- The compaction request.
- The compaction response.
- At least one meaningful subsequent agent turn.

An initial automatic trigger around 75–80% is reasonable, but it must be expressed as a budget calculation rather than a permanent magic number. Per-recipe capability data provides the actual context limit.

Compaction may occur:

- Before a new turn.
- During a long agent turn when supported safely.
- Manually from the UI.
- Before a model switch if required by policy.

### 8.4 Summary contract

The compaction prompt should instruct the active model to preserve:

- User goal and current request.
- Explicit requirements and prohibitions.
- Decisions and their rationale.
- Completed work.
- Current execution state.
- Important files, symbols, and paths.
- Commands and tests already run.
- Failures, diagnostics, and unresolved risks.
- Pending tasks and the exact next action.
- User preferences relevant to future work.
- Any information that would be expensive or impossible to rediscover.

The result should be structured enough to validate but natural enough for models to use effectively. Avoid requiring JSON unless evaluation demonstrates a benefit; malformed structured output must not make a session unrecoverable.

### 8.5 Recent-history retention

After compaction, the working context should contain:

1. Initial/system context as required by the active model.
2. The compaction summary.
3. A configurable number of recent messages or the active user turn.
4. Any required tool state or file snapshots.

The exact ordering should follow validated Codex local behavior where applicable.

### 8.6 Failure behavior

- Never replace working history with an empty or obviously invalid summary.
- Keep the pre-compaction working state until the summary is accepted.
- Retry only with bounded attempts.
- If compaction fails due to capacity, attempt an emergency reduced-input summary.
- Surface a recoverable error and offer a new task with a generated handoff if compaction cannot succeed.
- Record compaction diagnostics without exposing hidden reasoning.

### 8.7 Compaction observability

Consumers see a subtle “Context compacted” event. Administrators or debug mode may inspect:

- Trigger reason.
- Estimated tokens before and after.
- Summary generation duration.
- Model and recipe used.
- Retained message counts.
- Failure/retry information.

## 9. Inference management model

### 9.1 Adapter contract

Each engine adapter should implement a contract conceptually equivalent to:

```ts
interface EngineAdapter {
  validatePlaybook(playbook: Playbook): Promise<ValidationReport>;
  validateRecipe(recipe: Recipe): Promise<ValidationReport>;
  inspectCapabilities(recipe: Recipe): Promise<EngineCapabilities>;
  estimateResources(recipe: Recipe): Promise<ResourceEstimate>;
  buildLaunchSpec(recipe: Recipe, allocation: PortAllocation): Promise<LaunchSpec>;
  start(spec: LaunchSpec): Promise<InstanceHandle>;
  waitUntilReady(instance: InstanceHandle, signal: AbortSignal): Promise<ReadyInfo>;
  createClient(instance: InstanceHandle): InferenceClient;
  stop(instance: InstanceHandle, mode: StopMode): Promise<StopReport>;
  inspect(instance: InstanceHandle): Promise<InstanceInspection>;
}
```

Launch commands must be represented as executable plus argument array, not a shell-concatenated string. Environment variables are a separate map. This avoids quoting bugs and command injection.

### 9.2 Generic adapter

The generic OpenAI-compatible adapter enables early support for unknown engines with:

- Start executable/command definition.
- Working directory.
- Environment references.
- Health URL.
- Models URL.
- Base URL.
- Authentication mode.
- Shutdown/process matching rules.
- Declared capabilities.

Dedicated adapters add structured flags, safer validation, resource estimates, richer lifecycle verification, and request translation.

### 9.3 Example playbook/recipe representation

This example is illustrative rather than a final schema:

```yaml
playbook:
  id: ninfer-current-wsl
  name: NInfer — current WSL build
  adapter: ninfer
  environment: wsl:Ubuntu
  executable: /path/to/ninfer-serve
  workingDirectory: /path/to/ninfer-checkout
  versionPolicy:
    gitRevision: optional-pinned-revision
    binarySha256: optional-pinned-hash
  defaults:
    host: 127.0.0.1
    requestLogging: metadata

recipes:
  - id: qwen36-35b-a3b-mtp4-100k
    displayName: Qwen 3.6 35B A3B
    artifact: /path/to/model.ninfer
    contextTokens: 100000
    arguments:
      kvDtype: int8
      speculativeMode: mtp
      draftTokens: 4
      lmHeadDraft: true
      thinking: false
    capabilities:
      chatCompletions: true
      streaming: true
      toolCalls: declared-after-validation
      responseFormat: false
      minP: false
      maxConcurrentGenerations: 1
    resources:
      reserveVramMiB: 2048
    lifecycle:
      loadPolicy: onDemand
      idleTtlSeconds: 300
      minimumResidencySeconds: 30
```

Secrets are referenced by secret ID and never stored inline in an exportable recipe.

## 10. NInfer baseline and migration constraints

The existing NInfer evaluation must not be repeated. A validated handoff established the following baseline:

- Recommended historical checkout: `/root/ninfer-latest-8aa4988`
- Git revision: `8aa49883deabfee4a660801455a1be5483155e5a`
- Historical server binary SHA-256: `2e930381f5bb6166c296e58304a5a46cb150e6cb2c1937362cad206829eeb5d2`
- Validated 35B artifact: `/root/ninfer-bd265a3/models-v2/qwen3_6_35b_a3b.ninfer`
- Artifact SHA-256: `1fb9ea0b5b8561e49d9604115ec89e5d9f2b6f6434e32c37c57fffd480a325d2`
- Speculative mode: MTP4, not DFlash.
- Current-build flag form: `--spec mtp --draft-tokens 4`.
- NInfer supports one active generation at a time.
- Unsupported/problematic request fields include `response_format` and `min_p`.

Subsequent local setup work may have installed newer/general-purpose NInfer locations and both 27B and 35B recipes with 100K context. The first implementation session must inventory the actual current installation and import it; do not assume the historical checkout above remains the desired general installation.

The old production checkout at `/root/ninfer` must remain untouched because another project has frozen attestation configuration pointing to it.

Initial Fitz policies already selected by the user:

- Both current NInfer models use a 100K context target.
- Reserve approximately 2 GB of VRAM for Windows and other applications, configurable after real observation.
- Use on-demand loading and idle eviction.
- Preserve the validated latest/current NInfer recipe semantics rather than reverting to the old CLI flag form.

The Fitz adapter should replace the current standalone supervisor only after parity tests prove that launch, health, request forwarding, eviction, and cleanup behave correctly.

## 11. Routes and model selection

### 11.1 Consumer model catalog

`GET /v1/models` and the native app model selector expose allowed routes, not every internal recipe.

Example routes:

```text
default-agent → NInfer / Qwen 35B MTP4
fast          → NInfer / Qwen 27B
compatible    → llama.cpp / selected GGUF
vision        → future vision-capable recipe
```

### 11.2 Defaults

Defaults may exist at multiple levels:

1. Host default route.
2. User default route.
3. Project default route.
4. Session-selected route.

The most specific permitted value wins. A user may only select routes granted to that user.

### 11.3 Model switching

The UI should make switching feel like Codex:

- Model control is visible near the composer.
- Consumer view shows friendly route/model names and concise capability information.
- Administrator view can reveal the resolved playbook and recipe.
- Switching during an idle session updates subsequent turns.
- Switching during generation is either queued for the next turn or requires explicit cancellation.
- If switching requires engine eviction/loading, the UI streams lifecycle progress.
- The canonical transcript remains stable across a switch.
- Context policy decides whether to compact/rebuild before the next model turn.

## 12. Scheduler and lifecycle manager

### 12.1 Instance states

Every instance has exactly one primary state:

```text
UNLOADED
PREPARING
LOADING
READY
BUSY
DRAINING
EVICTING
FAILED
```

Representative transitions:

```text
UNLOADED → PREPARING → LOADING → READY → BUSY → READY
READY → DRAINING → EVICTING → UNLOADED
PREPARING | LOADING | READY | BUSY | EVICTING → FAILED
FAILED → PREPARING (bounded/manual recovery)
FAILED → UNLOADED (cleanup completed)
```

State changes are persisted as events and broadcast to interested clients.

### 12.2 Load flow

1. Resolve requested route.
2. Authorize the route for the caller.
3. Validate request against recipe capabilities and user quotas.
4. Enqueue request.
5. If a compatible instance is ready, acquire a lease.
6. Otherwise drain/evict an incompatible idle instance.
7. Verify process termination, socket release, and resource cleanup.
8. Allocate internal port and credentials.
9. Generate launch specification.
10. Start instance.
11. Poll engine health and model identity.
12. Mark ready and dispatch queued request.
13. Stream normalized events.
14. Release active-generation lease.
15. Start or resume idle TTL when no leases remain.

### 12.3 Eviction policies

Supported policies:

- `immediate`: unload as soon as the last lease ends.
- `idle-ttl`: unload after a configurable idle duration.
- `memory-pressure`: remain loaded until the system needs resources.
- `scheduled`: load/retain only during configured windows.
- `never`: remain loaded until manually stopped.
- `manual`: never auto-load; administrator starts it explicitly.

Initial default: on-demand load with idle TTL.

### 12.4 TTL semantics

The idle timer starts only when:

- No generation is active.
- No compaction is active.
- No same-recipe request is queued.
- No explicit lease exists.
- The instance is healthy and ready.

The timer is canceled when a new compatible request arrives. Configuration changes are applied predictably: shortening TTL may evict immediately if the elapsed idle time already exceeds the new value.

### 12.5 Anti-thrashing controls

- Minimum residency duration.
- Model-switch cooldown.
- Queue lookahead for the currently loaded recipe.
- Maximum wait before fairness overrides affinity.
- Optional preferred/default recipe bias.
- Explicit administrator “pin loaded” lease.

### 12.6 Queue policy

The first implementation may use a single host-wide queue because the GPU supports one NInfer generation at a time. The queue should nevertheless model:

- User identity.
- Route and resolved recipe.
- Priority.
- Enqueue time.
- Cancellation.
- Maximum queue length.
- Fairness across users.
- Estimated load/switch state.

Do not promise an exact wait time until measurements support it. Show queue position and current lifecycle state.

### 12.7 Resource policy

Resource policy includes:

- Reserved GPU memory, initially 2 GB.
- Expected recipe VRAM.
- Minimum free system RAM.
- Maximum concurrent engine instances.
- Load refusal when safety margins cannot be met.
- Optional Windows foreground-application pressure signals later.

Resource estimates are advisory; post-launch inspection verifies actual conditions.

## 13. APIs

### 13.1 OpenAI-compatible data plane

Initial endpoints:

```text
GET  /health
GET  /v1/models
POST /v1/chat/completions
```

Potential later endpoint:

```text
POST /v1/responses
```

The gateway performs:

- Authentication.
- Route resolution.
- Request-size validation.
- Capability validation.
- Field normalization.
- Queueing.
- Engine lifecycle acquisition.
- Stream translation.
- Usage normalization.
- Error normalization.
- Audit/metrics emission.

Unsupported fields should normally produce a clear 400 response rather than being silently ignored. A recipe may explicitly declare safe field stripping for compatibility.

### 13.2 Native application API

The native API covers concepts absent from Chat Completions:

- Users, API keys/devices, and usage.
- Projects and sessions.
- Turns and resumable streams.
- Tool calls and approvals.
- Compaction.
- Files, diffs, attachments, and artifacts.
- Route availability.
- Queue and engine status.
- Consumer preferences.

Use HTTPS plus WebSocket or SSE for streaming. Choose one primary transport after prototyping reconnection semantics. Protocol messages require versioning and event sequence numbers.

### 13.3 Management API

Administrator-only operations include:

- CRUD for playbooks, recipes, and routes.
- Validation and dry-run launch rendering.
- Start, stop, drain, retry, and pin instance.
- Lifecycle settings and TTL.
- Logs and diagnostics.
- User/route/tool permissions.
- Import/export.
- Update checks.

Management endpoints must not become accessible merely because a caller can reach the host through Tailscale. Authorization is separate from network reachability.

### 13.4 Internal engine API

Engine endpoints and credentials are generated internally and never returned to consumers. The gateway may use Chat Completions, Responses, or an engine-native protocol behind the adapter.

## 14. Tailscale and remote access

### 14.1 Required outcome

A permitted user can use the host’s agent and LLM from another PC, an iPhone, or an Android phone while away from the home Wi-Fi. No router port forwarding is required. NInfer is not publicly exposed.

### 14.2 Connectivity architecture

```text
Remote client (no Tailscale installation)
    ↓ public TLS
Tailscale Funnel on the owner PC
    ↓ loopback-only proxy
Fitz consumer gateway (API-key required)
    ↓ loopback
Fitz Host API
    ↓ loopback
Managed engine instance
```

### 14.3 “Baked in” requirement

Tailscale is a first-class product feature, not a README-only prerequisite. Host settings must provide:

- Enable/disable remote access.
- Installed-daemon detection and status.
- Public HTTPS URL.
- Connectivity status.
- Copy URL and one-time API-key flow.
- Authorized-user list.
- Connection test.
- Clear diagnostics.
- Revoke access.

The connectivity package integrates with the installed Tailscale daemon/CLI and owns only Fitz's
Funnel listener. It must never reset unrelated Funnel configuration. A bundled transport may be
evaluated later, subject to licensing and update/security ownership.

### 14.4 Mobile reality

Recipients use ordinary HTTPS, so desktop and future mobile clients require no VPN entitlement,
Tailscale account, or Tailscale application. They need only the URL and API key supplied by the host.

### 14.5 Tailscale identity and application identity

Use defense in depth:

1. Tailscale Funnel supplies Internet transport and TLS on the owner PC.
2. Fitz authenticates every request with a revocable API key and maps it to a consumer.
3. The loopback gateway exposes only consumer operations and rejects privileged credentials.

Rate-limit identities must never trust caller-supplied forwarding headers.

### 14.6 Funnel is explicit and off by default

The Hosting switch is the only normal control that creates public exposure. It targets the protected
gateway, requires application API keys, is auditable and revocable, and is disabled by default.

## 15. Identity, roles, and permissions

Initial roles:

### 15.1 Host administrator

- Manage playbooks, recipes, routes, engines, users, and settings.
- View technical logs and metrics.
- Approve raw flags and executable paths.
- Grant tools and project access.

### 15.2 Trusted agent user

- Use permitted routes.
- Create projects and sessions.
- Use a configured set of agent tools.
- Access explicitly granted workspaces.
- View personal artifacts and history.

### 15.3 Chat consumer

- Use permitted routes.
- Chat and attach supported media.
- View personal history.
- No shell, arbitrary filesystem access, engine management, or raw logs by default.

The girlfriend account should initially be a chat consumer unless specific agent capabilities are intentionally granted.

Permissions should be capability-based internally, even if the UI presents roles. Examples:

- `route.use:<route-id>`
- `project.read:<project-id>`
- `tool.shell`
- `tool.files.write`
- `playbook.manage`
- `instance.control`
- `logs.view`

## 16. Data and storage

### 16.1 Database

Use SQLite initially. It provides transactions, migrations, indexing, backup, and portability without requiring a separate database server.

Expected entities:

- `users`
- `devices`
- `pairing_codes`
- `projects`
- `sessions`
- `turns`
- `messages`
- `tool_events`
- `compactions`
- `attachments`
- `artifacts`
- `playbooks`
- `recipes`
- `routes`
- `route_targets`
- `instances`
- `leases`
- `inference_requests`
- `settings`
- `audit_events`

Large binaries remain in a managed content directory and are referenced by database metadata and hashes.

### 16.2 Transcript model

Conversation records should be append-only where practical. Corrections create new events rather than silently rewriting history. A materialized session view may be rebuilt from events.

### 16.3 Secrets

Secrets include:

- Internal engine API keys.
- Device tokens.
- Tailnet credentials/state.
- Optional external provider keys.

Store secrets using operating-system credential facilities or encrypted service-owned storage. Never place them in exported playbooks, logs, rendered launch commands, Git, or client-visible diagnostics.

### 16.4 Backup and export

Support distinct exports:

- Playbook/recipe/route configuration without secrets.
- User conversation export.
- Redacted diagnostic bundle.
- Full administrator backup with explicit warning and encryption.

## 17. Desktop UX

### 17.1 Layout

The primary layout is:

```text
┌────────────────┬──────────────────────────────┬─────────────────────────┐
│ Task sidebar   │ Conversation                 │ Artifact/media panel    │
│                │                              │                         │
│ Projects       │ Messages                     │ HTML preview            │
│ Tasks          │ Tool activity                │ Images/video/audio      │
│ Search         │ Diffs and approvals          │ PDF/Markdown/code       │
│ Archive        │ Composer and model control   │ File details            │
└────────────────┴──────────────────────────────┴─────────────────────────┘
```

The right panel may be collapsed. Selecting a referenced file or artifact opens it without leaving the conversation.

### 17.2 Task sidebar

Required behavior:

- Group by project/workspace.
- Create, rename, archive, and search tasks.
- Show active generation and unread/failure states.
- Persist selection.
- Support keyboard navigation.
- Later support pinning and branching if useful.

### 17.3 Conversation experience

- Token streaming without excessive layout shift.
- Markdown, code blocks, tables, and links.
- Collapsible tool calls with concise default summaries.
- Clear command and approval presentation.
- Inline diffs and file-change summaries.
- Stop button while generating.
- Steering/follow-up behavior when supported.
- Drag/drop and paste attachments.
- Loading, queued, compacting, and switching states.
- Errors that preserve the composer text and allow retry.

### 17.4 Model control

Consumer control shows:

- Friendly route/model name.
- Optional concise speed/capability description.
- Availability/loading state.

Administrator expansion may show:

- Resolved engine/playbook/recipe.
- Context limit.
- Current residency state.
- Queue implications.
- Advanced request defaults.

### 17.5 Management area

Administrator navigation includes:

- Overview.
- Playbooks.
- Recipes.
- Routes.
- Instances/queue.
- Remote access.
- Users and permissions.
- Logs/diagnostics.
- Settings.

Consumers do not see this navigation.

## 18. Artifact and media panel

### 18.1 Renderer registry

Use a typed renderer registry selected by MIME type, extension, and artifact metadata. Initial renderers:

- Images: PNG, JPEG, WebP, GIF, SVG with safe handling.
- Video: common browser-supported formats with range requests.
- Audio: common browser-supported formats with controls.
- PDF.
- HTML and local web applications.
- Markdown.
- Source code with syntax highlighting.
- Unified/side-by-side diffs.
- Plain text.
- JSON with structured folding.

### 18.2 HTML security

Untrusted HTML must not execute with Electron or host privileges.

- Use sandboxed iframe/webview boundaries.
- Apply restrictive Content Security Policy.
- Disable Node integration.
- Use context isolation.
- Restrict navigation and downloads.
- Proxy files through opaque authorized URLs rather than exposing unrestricted `file://` access.
- Treat localhost application previews separately from static HTML.

### 18.3 Remote media delivery

- Authorize every artifact request.
- Support HTTP range requests for audio/video/PDF.
- Generate thumbnails where useful.
- Enforce size and storage quotas.
- Never reveal arbitrary host filesystem paths to remote consumers.
- Use expiring or session-bound artifact URLs.

## 19. Extensions, tools, and plugins

The initial product does not require a plugin browser.

Use a curated registry of installed Pi extensions/skills and Fitz-native tools. Administrators can enable capabilities per role or user. Consumers see capabilities, not package-management internals.

Initial categories may include:

- Read-only workspace navigation.
- File edits.
- Shell execution.
- Web/browser tools.
- Media generation/viewing.
- Git operations.

Plugin/extension code is trusted host code. Remote users cannot submit arbitrary packages or install commands. A marketplace can be considered only after signing, permissions, updates, and sandboxing have a deliberate design.

## 20. Security model

### 20.1 Threats

- Unauthorized remote inference use.
- Remote execution of arbitrary shell commands.
- Recipe command injection.
- Malicious HTML/artifacts escaping the renderer.
- Secrets appearing in logs or exports.
- Cross-user transcript/artifact access.
- Forged Tailscale identity headers.
- Engine API exposure.
- Denial of service through huge prompts, queues, or attachments.
- Prompt injection causing tools to exceed user permissions.

### 20.2 Controls

- Loopback-only engine binding.
- Private Tailscale transport.
- Application device authentication.
- Per-user capabilities.
- Separate management authorization.
- Executable-plus-argv launch specifications.
- Recipe validation and dry runs.
- Context-isolated Electron renderer.
- Sandboxed artifact rendering.
- Request, queue, token, and attachment limits.
- Tool authorization enforced outside the model.
- Secret redaction.
- Audit events for management and sensitive tool actions.
- CSRF/origin protections for browser-accessible APIs.
- Protocol version validation.

### 20.3 Tool security

The model may request a tool but never grants itself permission. Tool policy is checked using authenticated user, role, project, session, requested action, and host policy.

Default girlfriend/consumer policy:

- No arbitrary shell.
- No arbitrary host filesystem.
- Personal uploads and generated artifacts only.
- Explicitly allowed routes.
- Conservative request and storage quotas.

## 21. Electron decision and packaging

### 21.1 Why Electron

Electron packages Chromium and Node.js with a web-technology interface. It is larger than a native shell but provides:

- Predictable rendering.
- Strong React/TypeScript ecosystem.
- Good streaming-chat and media support.
- Straightforward integration with Node tooling.
- Mature Windows installers and updates.
- A natural environment for a Codex-style web UI.

Tauri is smaller but would still require a separate Node/Pi service and introduces WebView/runtime variation. Installer size is not a critical constraint compared with local model storage and GPU use.

### 21.2 Electron hardening

- `contextIsolation: true`.
- `nodeIntegration: false` in renderers.
- Minimal typed preload bridge.
- Strict navigation/window-open handlers.
- CSP.
- No direct secrets in renderer state.
- Validate every IPC message.
- Keep engine/process control in the host, not renderer or Electron main process where avoidable.

### 21.3 Distribution modes

One codebase can produce:

- **Client installer:** desktop UI connecting to an existing Fitz host.
- **Host installer:** desktop UI plus host bootstrap/service integration.
- **Portable development build:** for local testing only.

The consumer installer should be a conventional per-user Windows `.exe` installer with shortcuts and uninstall support. Public-quality distribution eventually requires code signing to avoid SmartScreen friction.

### 21.4 Updates

Desktop, host, connectivity sidecar, and protocol versions may update independently. Updates must:

- Preserve configuration and transcripts.
- Run database migrations transactionally.
- Check protocol compatibility.
- Avoid interrupting active generations.
- Roll back or provide recovery when migration fails.

## 22. Host startup and availability

- Host service starts automatically with the user/session or system as selected.
- Desktop window may close independently.
- Tray/status integration shows host and remote-access status.
- No model is loaded merely because the host service starts.
- Active generations prevent accidental service shutdown.
- Sleep behavior is configurable; at minimum, prevent sleep during active generation.
- A powered-off host cannot serve requests. Wake-on-LAN or related features are future work.

For WSL, installation must explicitly configure reliable host startup and networking. Do not assume WSL remains active without a service process. The implementation should test Windows-to-WSL localhost forwarding and fall back to an explicit proxy when required.

## 23. Observability and diagnostics

### 23.1 Metrics

Collect locally:

- Model load duration.
- Time to first token.
- Prompt/prefill duration when reported.
- Decode tokens per second.
- Total request duration.
- Queue wait duration.
- Recipe switches.
- Evictions and reasons.
- Engine crashes/restarts.
- Context usage estimates.
- Compaction duration and before/after estimates.
- GPU VRAM and system RAM where available.

### 23.2 Logging

- Structured JSON logs with request/session correlation IDs.
- Separate host, agent, connectivity, and engine log streams.
- Prompt/response content logging off by default.
- Metadata logging configurable.
- Secrets and authorization headers always redacted.
- Retention and maximum disk usage configurable.

### 23.3 Diagnostics bundle

Administrators can export a redacted bundle containing:

- Application versions.
- Protocol versions.
- Playbook/recipe metadata without secrets.
- Recent lifecycle transitions.
- Health checks.
- Relevant logs.
- OS/WSL/GPU summary.

## 24. Failure handling

### 24.1 Engine fails to load

- Preserve queued requests.
- Mark recipe/instance failed with clear diagnostics.
- Apply bounded automatic retry.
- Use a route fallback only if configured and semantically compatible.
- Notify clients of the changed target.

### 24.2 Engine crashes during generation

- End the stream with a normalized retryable error.
- Clean up the instance.
- Do not silently replay a tool-producing agent request without idempotency protections.
- Offer explicit retry.

### 24.3 Client disconnects

- The host continues or cancels according to session policy.
- Events remain resumable for a retention window.
- Reconnecting clients request events after their last sequence number.

### 24.4 Tailscale unavailable

- Local access continues.
- Host UI shows degraded remote connectivity.
- Remote client receives guided diagnostics rather than engine-specific errors.

### 24.5 Database or migration failure

- Do not start destructive migrations without backup.
- Enter a recoverable maintenance mode.
- Keep engine management disabled if state consistency is uncertain.
- Provide export/recovery instructions.

## 25. Testing strategy

### 25.1 Unit tests

- Route resolution.
- Capability validation.
- TTL calculations.
- Lifecycle state transitions.
- Queue fairness.
- Anti-thrashing behavior.
- Compaction budget calculations.
- Permission evaluation.
- Event translation.
- Launch-spec escaping/argument construction.

### 25.2 Contract tests

- Adapter contract against simulated engines.
- OpenAI-compatible request/stream/error shapes.
- Native agent protocol version fixtures.
- Pi-to-Fitz event translation.
- Tailscale identity/header trust boundary.

### 25.3 Integration tests

- Fake lightweight engine for deterministic lifecycle testing.
- NInfer local smoke tests without repeating model evaluation.
- Start → health → request → idle TTL → stop.
- Recipe switch with queued requests.
- Crash and port-conflict recovery.
- WSL restart/reconnection.
- Compaction followed by continued agent work.

### 25.4 End-to-end tests

- Install host application on Windows.
- Configure/import NInfer playbook.
- Start desktop task and stream response.
- Close desktop UI and submit from remote client.
- Load on demand and evict after TTL.
- Switch routes/models.
- Render HTML, image, video/audio, PDF, Markdown, and diff artifacts.
- Pair and revoke a consumer.
- Reconnect during generation.

### 25.5 Security tests

- Unauthorized route and management access.
- Cross-user artifact/session isolation.
- Header spoofing.
- Malicious recipe arguments.
- Malicious HTML/SVG.
- Oversized uploads/prompts.
- Tool request outside permissions.
- Secret-redaction snapshots.

## 26. Implementation milestones

### Milestone 0 — repository and validated inventory

- Establish monorepo tooling and coding conventions.
- Inventory current NInfer, Pi, model artifacts, launchers, and services.
- Record current paths/versions without modifying `/root/ninfer`.
- Capture the existing on-demand behavior as smoke-test expectations.
- Finalize protocol and persistence choices.

### Milestone 1 — host skeleton and simulated engine

- Host service.
- SQLite and migrations.
- Protocol package.
- Engine adapter interface.
- Fake engine adapter.
- Playbook/recipe/route CRUD.
- Scheduler and lifecycle state machine.
- Stable `/health`, `/v1/models`, and Chat Completions streaming.

### Milestone 2 — NInfer management parity

- NInfer adapter.
- Import current 27B/35B recipes.
- On-demand load.
- Health and model verification.
- Queueing.
- Configurable TTL eviction.
- VRAM reserve policy.
- Process/socket/resource cleanup verification.
- Preserve legacy `/root/ninfer` installation.

### Milestone 3 — desktop chat foundation

- Electron hardening and packaging skeleton.
- Projects/tasks sidebar.
- Conversation stream.
- Composer, stop, retry, and model selector.
- Loading/queue/model-switch states.
- Local host connection.

### Milestone 4 — agent integration and compaction

- Fitz agent protocol.
- Pi adapter.
- Curated tools and approvals.
- Canonical transcript storage.
- Codex-derived local compaction.
- Context meter and compaction events.
- Long-session tests.

### Milestone 5 — protected remote access

- Connectivity adapter.
- Tailscale host setup/status UI.
- Protected HTTPS consumer endpoint.
- Users and revocable API keys.
- Roles and allowed routes.
- Remote reconnect/resume.
- Girlfriend consumer profile.

### Milestone 6 — artifact/media panel

- Renderer registry.
- Code, diff, Markdown, JSON, and text.
- Image, audio, video, and PDF.
- Static HTML and localhost preview.
- Authorized remote delivery and range requests.
- HTML/Electron security tests.

### Milestone 7 — consumer installer pilot

- Client-only Windows installer.
- URL plus API-key onboarding.
- Auto-update plan.
- Code-signing decision.
- Install and usability test on another PC.
- iPhone/Android responsive client prototype.

### Milestone 8 — additional engines

- Generic OpenAI-compatible adapter.
- llama.cpp adapter and GGUF recipes.
- Import/export playbooks.
- Fallback routing.
- Evaluate vLLM adapter requirements.

## 27. Initial acceptance criteria

The first meaningful host release is acceptable when:

1. Fitz starts with no model loaded.
2. A request to `default-agent` starts the correct NInfer recipe automatically.
3. The request streams successfully through the stable Fitz API.
4. NInfer remains private on loopback.
5. A configured idle TTL unloads the model and releases expected GPU memory.
6. A second request reloads it without manual intervention.
7. Switching between 27B and 35B recipes works through routes.
8. Queue state is visible and requests are not lost during a model switch.
9. The desktop window can close while the lightweight host remains available.
10. The old `/root/ninfer` checkout remains untouched.

The first remote-consumer release is acceptable when:

1. A nontechnical user can install the client and enter a URL plus API key.
2. The user can connect away from home Wi-Fi without installing Tailscale.
3. The user sees only permitted routes and consumer features.
4. The user can trigger on-demand loading without knowing it is NInfer.
5. Conversation streams survive an ordinary transient reconnect.
6. The user cannot reach management APIs, raw engine ports, host files, or shell tools without explicit permission.
7. Revoking the device/user prevents subsequent access.

## 28. Locked decisions

These decisions should be treated as current product direction unless explicitly revisited:

- Do not use OpenCode as the application foundation.
- Use Pi as a replaceable agent implementation, not as the public architecture.
- Adapt Codex’s open-source local compaction behavior.
- Use NInfer as the first optimized engine.
- Design for additional optimized engines and llama.cpp recipes from the beginning.
- Use playbooks containing recipes.
- Expose stable routes to consumers.
- Make Fitz itself the API gateway/server.
- Keep engine instances private and lifecycle-managed.
- Support on-demand loading and configurable TTL eviction.
- Treat Tailscale connectivity as a built-in product workflow.
- Do not publicly expose port 18080 or any raw engine port.
- Provide management and consumption planes with role-based UI.
- Consumers do not manage playbooks.
- Use an Electron desktop application unless a prototype reveals a concrete blocker.
- Omit PR, scheduled, Sites, and marketplace features from initial scope.
- Provide a rich sidebar/task experience and media/artifact panel.
- Target simple installation for a nontechnical remote user.

## 29. Open decisions

Resolve these during implementation rather than by assumption:

1. Monorepo package manager/build tooling.
2. Exact location and lifecycle of the host service on Windows/WSL.
3. Initial Tailscale implementation: system daemon/Serve versus bundled tsnet sidecar.
4. WebSocket versus SSE as the primary native stream transport.
5. Whether the Pi integration can replace compaction cleanly without a fork.
6. Canonical token estimator for heterogeneous engines.
7. Exact compaction prompt and recent-history retention after comparative testing.
8. Route fallback semantics for agent/tool calls.
9. Mobile delivery: responsive PWA, Capacitor, or native shell.
10. Product name and original visual identity before distribution.
11. Code-signing and update infrastructure.
12. Whether host administration is local-only initially or permitted remotely for the host administrator.
13. Default consumer quotas and tool capabilities.
14. Wake/sleep behavior for the host PC.

## 30. First-session handoff checklist

A fresh implementation session should begin with the following read-only work:

1. Read this document completely.
2. Inspect the current Git repository state.
3. Inventory the actual current NInfer general installation, binaries, model artifacts, launch scripts, services, ports, and eviction mechanism.
4. Confirm the 27B and 35B route/model identifiers and current 100K-context launch flags.
5. Confirm that `/root/ninfer` is excluded from all modification plans.
6. Inventory the installed Pi package/version and read its SDK, compaction, provider, session, extension, and licensing sources.
7. Record the current Tailscale installation/state without exposing credentials.
8. Propose the concrete Milestone 0/1 scaffold and tests before changing runtime services.

Do not repeat the historical NInfer performance evaluation. Use smoke tests only to prove management parity and integration correctness.

## 31. Product vision

Fitz Codex should feel like a polished personal agent appliance rather than a collection of local-model scripts.

For the administrator, it is a cockpit for optimized local inference: engines, playbooks, recipes, routing, lifecycle, users, and diagnostics.

For a consumer, those concepts disappear. They open a beautiful application, select an allowed model if desired, and chat. If the model is unloaded, the system loads it. If the user is away from home, the private connection works. If the conversation becomes long, compaction preserves continuity. If the agent creates or references media, the artifact panel renders it.

The engine can change. The model can change. The hardware can change. The consumer experience and stable host API should remain coherent.
