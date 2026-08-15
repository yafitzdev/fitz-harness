# Local model residency

Fitz has one deterministic local-text policy: the host owns one **Default** recipe and keeps one model-bearing engine resident. A recipe may admit a small bounded batch of generations against that same model; there is no configurable preload list, parked-engine pool, sleep-mode cache, or second resident text engine.

## Roles

| Role | Owner | Execution | Visibility |
| --- | --- | --- | --- |
| `default` | Host administrator | One local engine/model, optionally with recipe-declared local workers | Chat picker |
| `smart` | Each consumer | That consumer's cloud API | Chat picker and the optional concurrent Smart peer, only when configured |
| `fast` | Each consumer | That consumer's cloud API | Chat picker and subagent workers, only when configured |

Choosing Default, Fast, or Smart in the chat composer is an instant request setting. It does not probe, warm, or switch an engine. Changing the host's Default recipe is a separate administrator action: Fitz persists the new target immediately and queues its warm-up behind existing local GPU work.

## Startup and steady state

1. Host startup and each local desktop-open event resolve the configured Default recipe, verify that it is a local text adapter, pin it as desired state, and queue an asynchronous warm-up.
2. The warm-up prepares and launches that recipe through the same owner-fair local GPU lane used by inference. The first request can share the in-progress activation.
3. Once ready, Default remains resident regardless of its recipe's idle-TTL setting.
4. Every local model call enters the local GPU lane. The lane admits at most three calls, while the active recipe's `maxConcurrentGenerations` supplies the stricter per-model limit.
5. Up to four Pi agent state machines may make progress concurrently, with one active state machine per owner by default. Only their local model calls serialize.

Cloud Smart and Fast calls use the independent cloud lane. They create no local lifecycle lease, consume no host VRAM, and cannot displace Default. A Default turn receives the delegation tool only when its selected recipe declares a non-empty worker pool. The local pool belongs to the recipe and is available at every effort level. Cloud delegation ceilings remain effort-dependent and are independent from the request's `maxTokens` output allowance:

| Effort | Default parent | Fast parent | Smart parent |
| --- | --- | --- | --- |
| Light | Up to the recipe's local-worker limit | No children | No children |
| Normal | Up to the recipe's local-worker limit | Up to 2 Fast children | Up to 3 Fast children |
| High | Up to the recipe's local-worker limit | Up to 3 Fast children | Up to 3 Fast children plus 1 optional Smart peer |

The built-in Qwen 3.8 27B NInfer recipe declares a 256,000-token shared context pool, two local workers with 64,000 tokens each, and three concurrent generations. Its implicit main agent receives the remaining 128,000 tokens. NInfer C3 uses one shared model and KV pool; the fixed capacity provides the requested topology while leaving more than 1 GiB of VRAM free on the target GPU at warm idle.

## Agent topology and runtime roles

Agent topology is part of each recipe, not an independent route or model process. Every agent-capable recipe has one implicit main agent. In the Playbooks recipe editor, the administrator configures only the worker count and context per worker; the main agent's context is derived as `min(model context limit, shared context pool - worker allocation)`. The editor displays that result but does not expose a main-agent name, role, or prompt.

Recipe workers are anonymous capacity. A recipe never stores worker roles or instructions. When the main agent delegates a task, it chooses a role identifier such as `researcher`, `reviewer`, or `implementer`. The host resolves that identifier through the global, versioned SQLite role registry and injects the exact registered system instructions, access mode, tool budget, output limit, and output contract. The durable child run snapshots the resolved role version so later registry edits cannot change the meaning of an existing run. Workers cannot delegate again.

The Smart peer is reserved for an independent Smart-tier task that runs concurrently with substantive work by the Smart parent; it is not overflow capacity for Fast research. The runtime admits that peer only after the parent has started an allowed tool task, allowing both calls to execute in the same parallel batch. Broad repository familiarization proactively dispatches only the available Fast children, then the Smart parent performs the overarching analysis and synthesis itself.

## Local media displacement

Local image, video, or audio generation is the only normal operation allowed to displace Default:

1. Existing local text generation finishes.
2. The lifecycle stops Default and loads the selected media recipe.
3. The media job runs to completion, failure, or cancellation.
4. Fitz unloads the media engine and restores the pinned Default recipe before releasing the local GPU lane.
5. Waiting local text work then resumes against Default.

Remote media uses the cloud lane and does not affect Default.

## Shutdown and failure

- The desktop is the hosting plane. Closing it quiesces both work lanes, cancels active work, cancels preparation, force-stops the active local process, and terminates the dedicated `Fitz-Inference` distribution so its page cache and VM commit are released. A pinned target is desired state, not permission to restart during shutdown.
- A failed local generation marks the active instance failed. The next local request replaces it safely.
- An exact local recipe test may temporarily displace Default, but Default is restored before the test completes.
- Resource admission runs before every local activation. Fitz never keeps an extra engine process merely because its files or runtime were previously used.

## Invariants

- Exactly one local model-bearing engine process may be active.
- At most the active recipe's declared generation limit may execute, bounded by the host's three-call local lane.
- Default is the only host-owned text route and must resolve to a local text recipe.
- Smart and Fast bindings are scoped to the authenticated owner and can reference only recipes discovered from that owner's connection.
- Default can spawn only its recipe-declared local workers, at any effort level. Fast can spawn only Fast children. Smart can use Fast children for delegated slices and, at High effort only, the Smart child as a concurrent peer for separate Smart-tier work, within the per-turn maximums above.
- Route selection never starts a model.
- Local media restores Default before later local text work starts.
- Desktop shutdown ends with no Fitz-owned model in VRAM and no running Fitz inference distribution.

The policy is implemented by `UserRouteResolver` in `apps/host/src/user-route-resolver.ts`, `InferenceScheduler` in `packages/inference-core/src/scheduler.ts`, and the pinned recipe state in `packages/inference-core/src/lifecycle-manager.ts`.
