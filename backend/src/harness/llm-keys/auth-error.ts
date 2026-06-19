/**
 * Best-effort classifier: does this error message look like an LLM AUTH failure — a revoked/expired
 * API key, a rejected subscription token, a 401? Used to turn a raw engine/chat failure string into a
 * "credentials need rotating" signal (the session relay, the run-failed relay, the system
 * credential-health guard). Deliberately pattern-based over the message text (no provider SDK has a
 * uniform typed error here); WHICH provider + whether it was the subscription token come from the
 * call-site CONTEXT, not the string.
 *
 * Tuned to AUTH specifically — NOT rate limits / quota (a 429, "rate_limit", "overloaded" is a
 * different problem and must not trigger a rotate-keys prompt).
 */

const AUTH_MARKERS: RegExp[] = [
  /\b401\b/,
  /\bunauthorized\b/i,
  /authentication[_\s-]?error/i,
  /invalid[_\s-]?api[_\s-]?key/i,
  /invalid x-api-key/i,
  /incorrect api key/i,
  /\binvalid[_\s-]?(bearer[_\s-]?)?token\b/i,
  /\bexpired\b.*\b(token|key|credential)/i,
  /\b(token|key|credential)\b.*\bexpired\b/i,
  /\brevoked\b/i,
  /permission[_\s-]?error/i,
  /\bforbidden\b/i,
  /\b403\b/,
  /oauth[_\s-]?token.*(expired|invalid|revoked|reused)/i,
  /could not (find|load|refresh).*(credential|token)/i,
];

// Guard against rate-limit / overload strings that may co-mention "token" — those are NOT auth.
const NOT_AUTH_MARKERS: RegExp[] = [
  /\b429\b/,
  /rate[_\s-]?limit/i,
  /\bquota\b/i,
  /\boverloaded\b/i,
  /too many requests/i,
];

/** True when the message looks like an authentication/credential failure (not a rate limit). */
export function isAuthError(message: string | undefined | null): boolean {
  if (!message) return false;
  if (NOT_AUTH_MARKERS.some((re) => re.test(message))) return false;
  return AUTH_MARKERS.some((re) => re.test(message));
}
