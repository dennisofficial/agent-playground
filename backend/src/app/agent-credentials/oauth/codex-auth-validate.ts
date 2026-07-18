export class CodexAuthInvalidError extends Error {
  constructor(reason: string) {
    super(
      `Codex subscription credential is invalid: ${reason}. ` +
        `Re-run 'codex login' (ChatGPT plan) and paste the FULL contents of ~/.codex/auth.json — ` +
        `it must include tokens.id_token, tokens.access_token and tokens.refresh_token.`,
    );
    this.name = 'CodexAuthInvalidError';
  }
}

/** Validate a pasted `~/.codex/auth.json` blob: either an OPENAI_API_KEY or a complete `tokens` object. */
export function assertValidCodexAuthJson(parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CodexAuthInvalidError('not a JSON object');
  }
  const obj = parsed as { OPENAI_API_KEY?: unknown; tokens?: unknown };
  const hasApiKey = typeof obj.OPENAI_API_KEY === 'string' && obj.OPENAI_API_KEY.length > 0;
  const tokens = obj.tokens;

  if (hasApiKey && (tokens === undefined || tokens === null)) return;

  if (typeof tokens !== 'object' || tokens === null) {
    throw new CodexAuthInvalidError('missing the "tokens" object (and no OPENAI_API_KEY)');
  }
  const t = tokens as Record<string, unknown>;
  const missing = (['id_token', 'access_token', 'refresh_token'] as const).filter(
    (k) => typeof t[k] !== 'string' || (t[k] as string).length === 0,
  );
  if (missing.length > 0) {
    throw new CodexAuthInvalidError(`tokens is missing required field(s): ${missing.join(', ')}`);
  }
}
