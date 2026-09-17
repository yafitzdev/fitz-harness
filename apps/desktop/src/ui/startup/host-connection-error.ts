const TRANSIENT_HOST_FAILURES = [
  "the local fitz service is still starting",
  "the local fitz service is unavailable",
  "the fitz host could not be reached",
  "the fitz host did not respond",
  "the host did not respond",
];

/** Connection lifecycle failures belong to the app shell. They are not
 * conversation content and must never become durable-looking chat cards. */
export function isTransientHostConnectionFailure(value: unknown): boolean {
  const message = (value instanceof Error ? value.message : String(value)).toLowerCase();
  return TRANSIENT_HOST_FAILURES.some((candidate) => message.includes(candidate));
}
