import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atlasAgentHomeBase, safeHomeKey } from './engine-home';

/**
 * The deterministic CODEX_HOME path for a sandbox key — the ONE place the overlay's location is
 * computed, so the writer ({@link ensureCodexAuthHome}) and the post-run reader ({@link readCodexAuthHome})
 * never drift. Idempotent mkdir (the CLI won't create a deep custom path itself).
 */
export function codexAuthHomeDir(root: string | undefined, sandboxKey: string): string {
  const home = join(atlasAgentHomeBase(root), safeHomeKey(sandboxKey), 'codex-sub');
  mkdirSync(home, { recursive: true });
  return home;
}

/**
 * Read the overlay `auth.json` back after a turn. Codex rewrites this file IN PLACE when it refreshes
 * its short-lived tokens from the `refresh_token`, so the post-run content may differ from what we wrote
 * at turn start — the caller diffs it against the input secret to detect a refresh worth persisting.
 * Returns `null` when the file is absent/unreadable (nothing to persist).
 */
export function readCodexAuthHome(root: string | undefined, sandboxKey: string): string | null {
  try {
    return readFileSync(join(codexAuthHomeDir(root, sandboxKey), 'auth.json'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Thrown when the Codex subscription secret isn't a usable `auth.json`. Carries an ACTIONABLE message
 * so the failure surfaces as an onboarding problem ("re-run codex login") instead of a serde error
 * four layers down in the Codex binary (`missing field 'id_token' at line 1 column N`).
 */
export class CodexAuthInvalidError extends Error {
  constructor(reason: string) {
    super(
      `Codex subscription credential is invalid: ${reason}. ` +
        `Re-run 'codex login' (ChatGPT plan) and re-store the FULL contents of ~/.codex/auth.json ` +
        `as the Codex secret — it must include tokens.id_token, tokens.access_token and tokens.refresh_token.`,
    );
    this.name = 'CodexAuthInvalidError';
  }
}

/**
 * Validate that a blob is a Codex `auth.json` the CLI can actually deserialize. Codex's Rust
 * `TokenData` struct requires `tokens.id_token` (a JWT) — a blob missing it fails DEEP in the binary
 * with an opaque `missing field 'id_token'`. We front-run that here with a clear message. An
 * `OPENAI_API_KEY`-only blob (no `tokens`) is also valid; we only demand the token fields when a
 * `tokens` object is present but incomplete, or when NEITHER auth path exists.
 */
export function assertValidCodexAuthJson(parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CodexAuthInvalidError('not a JSON object');
  }
  const obj = parsed as { OPENAI_API_KEY?: unknown; tokens?: unknown };
  const hasApiKey = typeof obj.OPENAI_API_KEY === 'string' && obj.OPENAI_API_KEY.length > 0;
  const tokens = obj.tokens;

  // API-key-only blob is a complete auth path on its own.
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

/**
 * Materialize a Codex SUBSCRIPTION home — an isolated CODEX_HOME owning its own `auth.json` (the
 * ChatGPT-plan credential), so a subscription run reads it instead of an API key. A clean-room
 * minimal rewrite of v1's `codex-subscription-home.ts`: no team/agent fan-out, no config.toml
 * materializer — just the auth.json the CLI needs. Idempotent (rewritten each turn). NEVER the
 * developer's personal ~/.codex.
 *
 * `secret` is the raw `auth.json` blob. It is VALIDATED before write so an incomplete blob (the
 * classic: a stale login missing `tokens.id_token`) fails with {@link CodexAuthInvalidError} up front
 * rather than as an opaque Codex-binary serde error mid-turn. Returns the absolute CODEX_HOME path to
 * pass through as the subprocess's CODEX_HOME.
 *
 * NOTE: there is no "bare token" form — a valid Codex subscription credential is ALWAYS the full
 * auth.json object (it needs id_token + access_token + refresh_token together). A single opaque token
 * cannot be wrapped into a usable auth.json.
 */
export function ensureCodexAuthHome(
  root: string | undefined,
  sandboxKey: string,
  secret: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new CodexAuthInvalidError('not valid JSON (expected the full auth.json object)');
  }
  assertValidCodexAuthJson(parsed);

  const home = codexAuthHomeDir(root, sandboxKey);
  writeFileSync(join(home, 'auth.json'), secret, { mode: 0o600 });
  return home;
}
