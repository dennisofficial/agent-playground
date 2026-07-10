const MASK = '***REDACTED***';

/**
 * Secret-shaped substrings inside an otherwise-benign string. Applied in order to every string leaf
 * BEFORE key-name-based redaction, so a secret buried in prose (a stack trace, a rendered file) is still
 * caught even though its enclosing object key is innocuous (e.g. `text`, `stdout`).
 */
const STRING_PATTERNS: RegExp[] = [
  // OpenAI-style keys.
  /sk-[A-Za-z0-9_-]{20,}/g,
  // GitHub tokens (classic + fine-grained PAT prefixes).
  /gh[oprsu]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // AWS access key ids.
  /AKIA[A-Z0-9]{16}/g,
  // JWTs.
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Connection strings with inline creds — mask only the `user:pass@` portion, keep scheme + host.
  /\w+:\/\/[^:@/\s]+:[^@/\s]+@/g,
  // PEM private key blocks (whole block, DOTALL via [\s\S]).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Generic key/secret/token/password assignments — keep the prefix (key name + operator), mask the value.
  /("?(?:api[_-]?key|secret|token|password)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi,
];

function redactString(value: string): string {
  let out = value;
  for (const pattern of STRING_PATTERNS) {
    // The connection-string pattern must keep the scheme; the generic assignment pattern must keep its
    // prefix group — every other pattern replaces the whole match outright.
    if (pattern.source.startsWith('\\w+:\\/\\/')) {
      out = out.replace(pattern, (m) => `${m.slice(0, m.indexOf('://') + 3)}${MASK}@`);
    } else if (pattern.source.startsWith('("?(?:api')) {
      out = out.replace(pattern, (_m, prefix: string) => `${prefix}${MASK}`);
    } else {
      out = out.replace(pattern, MASK);
    }
  }
  return out;
}

const SECRET_KEY_PATTERN = /^(api[_-]?key|secret|token|password)$/i;

/**
 * Recursively redact secret-shaped values out of `value` before it is ever serialized back to a caller —
 * the single choke point every mcp-reader tool result passes through. Deep-clones arrays/plain objects,
 * string-scans every string leaf, and additionally blanks the VALUE of any object key that looks like a
 * secret field name (even if its value didn't match a pattern, e.g. an opaque token). Cycle-safe.
 */
export function redactSecrets(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key) && typeof v === 'string') {
      out[key] = MASK;
    } else {
      out[key] = redactSecrets(v, seen);
    }
  }
  return out;
}
