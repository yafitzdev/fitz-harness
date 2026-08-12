# Local model residency

Fitz has one deterministic local-text policy: the host owns one **Default** recipe, keeps it resident, and admits one local generation at a time. There is no configurable preload list, parked-engine pool, sleep-mode cache, or second resident text engine.

## Roles

| Role | Owner | Execution | Visibility |
| --- | --- | --- | --- |
| `default` | Host administrator | One local engine/model | Chat picker |
| `smart` | Each consumer | That consumer's cloud API | Chat picker, only when configured |
| `fast` | Each consumer | That consumer's cloud API | Chat picker and subagent workers, only when configured |

Choosing Default, Fast, or Smart in the chat composer is an instant request setting. It does not probe, warm, or switch an engine. Changing the host's Default recipe is a separate administrator action: Fitz persists the new target immediately and queues its warm-up behind existing local GPU work.

## Startup and steady state

1. Host startup and each local desktop-open event resolve the configured Default recipe, verify that it is a local text adapter, pin it as desired state, and queue an asynchronous warm-up.
2. The warm-up prepares and launches that recipe through the same owner-fair local GPU lane used by inference. The first request can share the in-progress activation.
3. Once ready, Default remains resident regardless of its recipe's idle-TTL setting.
4. Every local model call enters the local GPU lane. Its concurrency is always one, even if an engine supports continuous batching or a recipe advertises a larger generation limit.
5. Up to four Pi agent state machines may make progress concurrently, with one active state machine per owner by default. Only their local model calls serialize.

Cloud Smart and Fast calls use the independent cloud lane. They create no local lifecycle lease, consume no host VRAM, and cannot displace Default. When an owner has no Fast binding, Fitz does not expose the delegation tool and rejects an explicit subagent request before inference.

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
- Exactly one local generation may execute.
- Default is the only host-owned text route and must resolve to a local text recipe.
- Smart and Fast bindings are scoped to the authenticated owner and can reference only recipes discovered from that owner's connection.
- Fast is selectable in chat and also powers subagents; it cannot execute without an owner-scoped cloud binding.
- Route selection never starts a model.
- Local media restores Default before later local text work starts.
- Desktop shutdown ends with no Fitz-owned model in VRAM and no running Fitz inference distribution.

The policy is implemented by `UserRouteResolver` in `apps/host/src/user-route-resolver.ts`, `InferenceScheduler` in `packages/inference-core/src/scheduler.ts`, and the pinned recipe state in `packages/inference-core/src/lifecycle-manager.ts`.
