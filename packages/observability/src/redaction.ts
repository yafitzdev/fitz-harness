const SENSITIVE_KEY = /authorization|cookie|api.?key|token|secret|password|credential/i;

export function redactSecrets<T>(value: T): T {
  return redact(value, new WeakSet<object>()) as T;
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(nested, seen);
  }
  seen.delete(value);
  return output;
}
