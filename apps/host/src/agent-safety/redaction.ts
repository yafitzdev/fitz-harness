/**
 * Content-based secret redaction for tool results.
 *
 * Runs after a tool executes and before the model reads the output, so a leaked
 * credential never enters context even when the model asked for it. Complementary to
 * the path-based blocking in the policy engine: that stops the *read*, this scrubs the
 * *result* (belt and suspenders — e.g. an `env` dump or a config file that slips through).
 */

export type RedactableContent = Array<{ type: string; text?: string }>;

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: "xai-key", pattern: /\bxai-[A-Za-z0-9]{16,}\b/g },
  { name: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "google-oauth", pattern: /\bya29\.[A-Za-z0-9_-]{20,}\b/g },
  { name: "gcp-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "stripe-key", pattern: /\b(?:pk|sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "bearer-token", pattern: /\b(?:Bearer|bearer)\s+[A-Za-z0-9._~+/-]{16,}/g },
  { name: "named-secret", pattern: /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret|authorization|private[_-]?key)\s*[:=]\s*["']?[^\s"'$]+/gi },
];

const REDACTED = "[REDACTED]";

/** Redact known secret shapes from a tool result's text content. Returns the new content or undefined when nothing changed. */
export function redactToolResultContent(content: RedactableContent): RedactableContent | undefined {
  let changed = false;
  const next = content.map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    let text = part.text;
    let hits = 0;
    for (const { pattern } of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      text = text.replace(pattern, (match) => {
        hits += 1;
        return REDACTED;
      });
    }
    if (hits > 0) changed = true;
    return hits > 0 ? { ...part, text } : part;
  });
  return changed ? next : undefined;
}
