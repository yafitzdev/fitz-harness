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

## Cross-session lookup

The context manager injects only the current session's history. When the user refers to an earlier
conversation, the agent reads it with the read-only `fitz_session` tool, which the host wires to the
same canonical store (`createSessionReader` in `apps/host/src/session-reader.ts`). The store is the
single source of truth for conversation history; Pi's own session store is never used for it.
