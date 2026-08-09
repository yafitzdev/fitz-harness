# Fitz runtime contract

This document describes the current executable contract. It is intentionally exact: unsupported
older hosts, alternate queue semantics, and best-effort fallbacks are not part of the design.

## Desktop and host handshake

- The desktop accepts only the exact `PROTOCOL_VERSION` and `HOST_CONTRACT_VERSION` exported by
  `@fitz/protocol`.
- A healthy process on the configured port with a different contract is rejected. The desktop does
  not silently reuse it or translate between contracts.
- API failures under `/api/v1` use the versioned Fitz error envelope. OpenAI-shaped endpoints retain
  their OpenAI error shape.

## Work lanes

Fitz has two bounded execution lanes:

| Lane | Work | Concurrency | Waiting capacity |
|---|---|---:|---:|
| Local GPU | agent model calls, direct chat, local media, recipe tests, model warmup | **1** | 256 |
| Remote cloud | media generation executed by remote providers | 4 | 64 |

The local GPU concurrency of one is a hard invariant, not a tuning default. A second local request
cannot load or execute a model until the active request releases the lane. This protects a single-GPU
host even when many devices or users submit concurrently.

The outer native-agent queue is also bounded at 256 tasks. It runs up to four independent Pi state
machines concurrently, with one active state machine per authenticated owner by default. Their model
subrequests still enter the single local-GPU lane. Mutating tools acquire a fair exclusive lease keyed
by the canonical workspace root, so separate projects can progress concurrently while commands and
edits against the same project never interleave. Read-only and media tools do not take this lease.
Per-user security quotas are evaluated at admission. A full lane rejects synchronously with a retryable
`429 resource_busy` response instead of returning an accepted stream that fails later or accepting
unbounded work into memory. Capacity responses include `Retry-After` so clients can back off without
inventing retry timing.

Waiting work is owner-fair. Each lane preserves FIFO order within one authenticated owner, while
round-robin selection across owners prevents one user's burst from monopolizing a shared host. The
same policy applies to agent state-machine admission and to underlying inference work. When
authentication is disabled, local submissions intentionally share one owner bucket.

Remote media never acquires a local lifecycle lease and cannot evict a resident local model. It uses a
separate bounded lane because provider requests consume network connections and paid-provider capacity,
but not local VRAM.

## Queue identity, visibility, and cancellation

- Every local or remote work item has one stable id and one trusted owner/session/run context.
- Internal Pi model calls carry that context through authenticated localhost-only headers. External
  agent endpoints never receive these headers.
- `GET /api/v1/work/queue` is the single user-facing queue view. Internal Pi model calls are folded
  into their parent agent task instead of appearing as duplicate rows. Positions reflect the current
  owner-fair service order and every item includes its enqueue time.
- Queued and active work can be cancelled. Cancellation requested during task startup is latched and
  applied as soon as the stream exists.
- Host shutdown closes admission, durably marks queued and active agent work interrupted/resumable,
  cancels active media providers, awaits media event consumers and artifact finalizers, and only then
  stops the scheduler, lifecycle manager, subscriptions, and SQLite. `SIGINT` and `SIGTERM` invoke this
  same bounded close path.

## Desktop host boundary

- All Electron-main-to-host traffic uses one typed client. It validates request paths and methods,
  reads the current device credential once per request, and distinguishes cancellation, retryable
  timeout, and retryable network failure.
- Ordinary API calls have a 30-second deadline, artifact materialization has 120 seconds, and explicit
  cold-start recipe/media diagnostics have ten minutes. There are no unbounded desktop requests.
- Destroying the renderer aborts its outstanding host call so a closed window cannot retain network,
  memory, or host-side response work.

## Durability and recovery

- Native agent requests and their event checkpoints are durable before execution. Client request ids
  make creation safe to retry.
- Media jobs are inserted into SQLite before scheduler admission and use the same UUID in storage,
  queue events, provider execution, and artifact ownership. A storage failure therefore cannot launch
  orphaned provider or GPU work. If the bounded lane is full, that same record becomes terminal with
  `queue_capacity`, and the rejection response includes its job id for inspection or retry.
- After restart, incomplete agent and media work is marked interrupted. Continuation is request-level:
  completed tools are treated as applied, uncertain in-flight effects require review, and the requested
  outcome can resume without claiming token-for-token model continuation.
- Artifact bytes live in the content-addressed artifact store. SQLite contains transactional metadata
  and opaque object references only.

## Long conversations

- The desktop initially loads the newest 250 transcript entries and pages older history backward on
  demand. The DOM keeps a bounded render window rather than mounting an unbounded task history.
- Context compaction creates durable checkpoints. Subsequent model requests read the latest checkpoint
  plus only post-checkpoint transcript rows, so context preparation does not rescan the full historical
  transcript on every turn.
- Reasoning is stored for UI recovery but is never replayed into the model as conversation content.

## Canonical local filesystem

- Mutable application state lives below the configured Fitz data root.
- Engine repositories and model payloads live below `%USERPROFILE%\.llm`.
- Recipe configuration stores adapter-specific typed fields. The UI does not expose arbitrary JSON or
  hidden adapter aliases.
