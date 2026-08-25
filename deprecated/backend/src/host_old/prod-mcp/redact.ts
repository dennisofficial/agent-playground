const MASK = '***REDACTED***';

const STRING_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[oprsu]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\w+:\/\/[^:@/\s]+:[^@/\s]+@/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /("?(?:api[_-]?key|secret|token|password)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}"']+)/gi,
];

function redactString(value: string): string {
  let out = value;
  for (const pattern of STRING_PATTERNS) {
    if (pattern.source.startsWith('\\w+:\\/\\/')) {
      out = out.replace(pattern, (m) => `${m.slice(0, m.indexOf('://') + 3)}${MASK}@`);
    } else if (pattern.source.startsWith('("?(?:api')) {
      out = out.replace(pattern, (_m, prefix: string, value: string) => {
        const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
        return `${prefix}${quote}${MASK}${quote}`;
      });
    } else {
      out = out.replace(pattern, MASK);
    }
  }
  return out;
}

const SECRET_KEY_PATTERN =
  /(^|[_-])(api[_-]?key|secret|token|password)([_-]|$)|(?:apiKey|accessToken|refreshToken|idToken|clientSecret)$/i;

export function redactSecrets(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;

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
