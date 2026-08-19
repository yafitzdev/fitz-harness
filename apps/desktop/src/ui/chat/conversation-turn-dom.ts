export interface DurableUserTurnIdentity {
  messageId: string;
  sequence: number;
  prompt: string;
}

/** Resolves the durable prompt that owns a regenerated run. Steering can put
 * newer user bubbles between the original prompt and the selected answer, so
 * nearest-sibling lookup is not sufficient. */
export function findDurableUserArticle(
  messages: HTMLElement,
  before: HTMLElement,
  runId: string,
  turn: DurableUserTurnIdentity,
): HTMLElement | undefined {
  const precedesSelection = (candidate: HTMLElement) => (
    candidate !== before
    && Boolean(candidate.compareDocumentPosition(before) & Node.DOCUMENT_POSITION_FOLLOWING)
  );
  const byId = messages.querySelector<HTMLElement>(`article.message.user[data-transcript-id="${CSS.escape(turn.messageId)}"]`);
  if (byId && precedesSelection(byId)) return byId;
  const bySequence = messages.querySelector<HTMLElement>(`article.message.user[data-transcript-sequence="${CSS.escape(String(turn.sequence))}"]`);
  if (bySequence && precedesSelection(bySequence)) return bySequence;

  // Live user bubbles predate the host-assigned transcript metadata. Limit the
  // text fallback to this run's turn, then choose the first matching prompt so
  // an identical steering message cannot displace the original user turn.
  let boundary: HTMLElement | undefined;
  let previous = before.previousElementSibling as HTMLElement | null;
  while (previous) {
    if (previous.matches("article.message.assistant") && previous.dataset.runId !== runId) {
      boundary = previous;
      break;
    }
    previous = previous.previousElementSibling as HTMLElement | null;
  }
  let candidate = (boundary?.nextElementSibling ?? messages.firstElementChild) as HTMLElement | null;
  let fallback: HTMLElement | undefined;
  while (candidate && candidate !== before) {
    if (candidate.matches("article.message.user")) {
      fallback = candidate;
      if ((candidate.querySelector<HTMLElement>(".message-body")?.textContent ?? "").trim() === turn.prompt) return candidate;
    }
    candidate = candidate.nextElementSibling as HTMLElement | null;
  }
  return fallback;
}
