# Context management

Fitz, rather than Pi or an inference engine, owns the context budget for native session runs. The
host rebuilds history from the canonical transcript, adds the new turn, and budgets it against the
resolved recipe's context window. The initial policy compacts at 80%, reserves 8,192 output tokens,
and preserves roughly half the remaining input budget for recent messages.

The first token estimator uses a conservative character heuristic. The summarizer is an injectable
interface; the default implementation produces a deterministic, bounded transcript summary so the
pipeline is testable without loading another model. A later refinement can replace it with a
model-assisted summarizer without changing host or storage contracts.

Every compaction is retained as a canonical `compaction` transcript entry with its summary, original
message count, compacted count, estimated input tokens, and effective budget. The original incoming
turn remains canonical even though the runtime receives the compacted prompt.

The checkpoint's `throughSequence` covers only messages represented by its summary. Tool and
reasoning activity has a separate `activityThroughSequence`, so retiring large tool outputs does
not discard recent conversation messages or repeatedly trigger compaction. Empty checkpoints
written by the older implementation are ignored when reconstructing history.
Repeated automatic compactions merge the previous checkpoint's recorded conversation instead of
nesting its JSON as a new user request. This preserves the original goal across compactions.
An oversized turn is rejected before saving a checkpoint if its message and summary cannot fit.

Saved attachment references are resolved again when preparing historical messages, including
follow-ups, regenerated responses, restart recovery and manual compaction. Original transcript
text remains concise. Removed uploads are represented as unavailable instead of blocking the chat.

## Cross-session lookup

The context manager injects only the current session's history. When the user refers to an earlier
conversation, the agent reads it with the read-only `fitz_session` tool, which the host wires to the
shared `SessionQueryService`. The service reads the same canonical store used by the HTTP query,
transcript, and forensics routes. Fitz remains the single source of truth for conversation history;
Pi's own session store is never used for it.
