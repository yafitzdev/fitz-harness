import type { EditUserTurnRequest, EditedUserTurn, RegeneratedAssistantTurn, TranscriptEntryRecord } from "@fitz/protocol";
import type { SqliteStore } from "@fitz/storage";

export type ConversationTurnErrorCode =
  | "assistant-not-found"
  | "run-active"
  | "not-latest-assistant"
  | "transcript-not-found"
  | "user-message-not-found"
  | "prompt-unavailable";

export class ConversationTurnError extends Error {
  constructor(readonly code: ConversationTurnErrorCode, message: string) {
    super(message);
    this.name = "ConversationTurnError";
  }
}

export interface ConversationContextEstimator {
  estimateSession(sessionId: string): number;
}

/**
 * Owns mutations to durable conversation turns. A caller either receives the
 * complete post-mutation state or the transcript remains unchanged.
 */
export class ConversationTurnService {
  constructor(
    private readonly store: SqliteStore,
    private readonly context: ConversationContextEstimator,
  ) {}

  regenerateLatestAssistant(sessionId: string, runId: string): RegeneratedAssistantTurn {
    return this.store.withImmediateTransaction(() => {
      const run = this.store.getAgentRun(runId);
      if (!run || run.sessionId !== sessionId) {
        throw new ConversationTurnError("assistant-not-found", "Assistant response not found");
      }

      const active = this.store.latestSessionAgentRun(sessionId);
      if (active?.status === "running" || active?.status === "queued") {
        throw new ConversationTurnError("run-active", "Wait for the current response before regenerating");
      }

      const entries = allTranscriptEntries(this.store, sessionId);
      const latestAnswer = entries.findLast(isFinalAssistantMessage);
      if (latestAnswer?.content.runId !== runId) {
        throw new ConversationTurnError("not-latest-assistant", "Only the latest assistant response can be regenerated");
      }

      const firstRunEntry = entries.findIndex((entry) => entry.content.runId === runId);
      if (firstRunEntry < 0) {
        throw new ConversationTurnError("transcript-not-found", "Assistant response transcript not found");
      }

      let userIndex = firstRunEntry - 1;
      while (userIndex >= 0 && !isUserMessage(entries[userIndex]!)) userIndex -= 1;
      const userEntry = entries[userIndex];
      const prompt = typeof userEntry?.content.text === "string" ? userEntry.content.text.trim() : "";
      if (!userEntry || !prompt) {
        throw new ConversationTurnError("prompt-unavailable", "The prompt for this response is unavailable");
      }

      const removedTranscriptEntries = this.store.deleteTranscriptFrom(sessionId, userEntry.sequence);
      if (removedTranscriptEntries < 1) {
        throw new ConversationTurnError("transcript-not-found", "Assistant response transcript not found");
      }
      const replacement = this.#appendReplacement(sessionId, userEntry, prompt);
      return {
        prompt,
        messageId: replacement.id,
        sequence: replacement.sequence,
        removedTranscriptEntries,
        estimatedContextTokens: this.context.estimateSession(sessionId),
      };
    });
  }

  editUserTurn(sessionId: string, request: EditUserTurnRequest): EditedUserTurn {
    return this.store.withImmediateTransaction(() => {
      const active = this.store.latestSessionAgentRun(sessionId);
      if (active?.status === "running" || active?.status === "queued") {
        throw new ConversationTurnError("run-active", "Wait for the current response before editing");
      }

      const entries = allTranscriptEntries(this.store, sessionId);
      const target = findUserMessage(entries, request);
      if (!target) throw new ConversationTurnError("user-message-not-found", "The message to edit was not found");
      const prompt = request.text.trim();
      if (!prompt) throw new ConversationTurnError("prompt-unavailable", "The replacement message cannot be empty");
      const removedTranscriptEntries = this.store.deleteTranscriptFrom(sessionId, target.sequence);
      if (removedTranscriptEntries < 1) throw new ConversationTurnError("transcript-not-found", "The message to edit is no longer present");
      const replacement = this.#appendReplacement(sessionId, target, prompt);
      return { prompt, messageId: replacement.id, sequence: replacement.sequence, removedTranscriptEntries, estimatedContextTokens: this.context.estimateSession(sessionId) };
    });
  }

  #appendReplacement(sessionId: string, target: TranscriptEntryRecord, prompt: string): TranscriptEntryRecord {
    const { runId: _runId, eventSequence: _eventSequence, ...retainedContent } = target.content;
    return this.store.appendTranscriptEntry({
      id: target.id,
      sessionId,
      kind: "message",
      role: "user",
      content: { ...retainedContent, text: prompt },
      createdAt: new Date().toISOString(),
    });
  }
}

function isFinalAssistantMessage(entry: TranscriptEntryRecord): boolean {
  return entry.kind === "message" && entry.role === "assistant" && entry.content.phase === "final";
}

function isUserMessage(entry: TranscriptEntryRecord): boolean {
  return entry.kind === "message" && entry.role === "user";
}

function findUserMessage(entries: TranscriptEntryRecord[], request: EditUserTurnRequest): TranscriptEntryRecord | undefined {
  if (request.messageId) {
    const exact = entries.find((entry) => entry.id === request.messageId);
    return exact && isUserMessage(exact) ? exact : undefined;
  }
  if (request.sequence !== undefined) {
    const exact = entries.find((entry) => entry.sequence === request.sequence);
    return exact && isUserMessage(exact) ? exact : undefined;
  }
  if (request.originalText !== undefined) {
    return entries.findLast((entry) => isUserMessage(entry) && entry.content.text === request.originalText);
  }
  return entries.findLast(isUserMessage);
}

function allTranscriptEntries(store: SqliteStore, sessionId: string): TranscriptEntryRecord[] {
  const entries: TranscriptEntryRecord[] = [];
  let after = 0;
  while (true) {
    const page = store.transcriptAfter(sessionId, after, 1_000);
    entries.push(...page);
    if (page.length < 1_000) return entries;
    after = page.at(-1)!.sequence;
  }
}
