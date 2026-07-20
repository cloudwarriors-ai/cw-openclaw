/** Recursively remove credentials and direct PII before tool data crosses a boundary. */

const SENSITIVE_KEY_RE =
  /(?:^|_)(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|set-cookie|access_token|refresh_token|client_secret)(?:$|_)/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(?<![\w-])(?:\+\d{1,3}[ .-]?)?(?:\(?\d{3}\)?[ .-])\d{3}[ .-]\d{4}(?![\w-])/g;
const BEARER_RE = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi;
const COOKIE_RE = /\b(?:access_token|refresh_token|sessionid|csrftoken)=[^;\s]+/gi;
const NAMED_SECRET_RE =
  /\b(password|passwd|secret|token|api[_-]?key|authorization|cookie)\b\s*[:=]\s*([^\s,;]+)/gi;

export function redactText(value: string, maxLength = 20_000): string {
  const redacted = value
    .replace(BEARER_RE, "[REDACTED_AUTH]")
    .replace(COOKIE_RE, "[REDACTED_COOKIE]")
    .replace(NAMED_SECRET_RE, (_match, name: string) => `${name}=[REDACTED]`)
    .replace(EMAIL_RE, "[REDACTED_EMAIL]")
    .replace(PHONE_RE, "[REDACTED_PHONE]");
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...[truncated]` : redacted;
}

export function redactValue(
  value: unknown,
  options: { maxStringLength?: number; depth?: number } = {},
): unknown {
  const maxStringLength = options.maxStringLength ?? 20_000;
  const depth = options.depth ?? 0;
  if (depth > 12) return "[REDACTED_DEPTH]";
  if (typeof value === "string") return redactText(value, maxStringLength);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, { maxStringLength, depth: depth + 1 }));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_RE.test(key)
        ? "[REDACTED]"
        : redactValue(item, { maxStringLength, depth: depth + 1 });
    }
    return result;
  }
  return value;
}
