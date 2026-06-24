import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atlasAgentHomeBase } from './engine-home';

/**
 * Materialize a Codex SUBSCRIPTION home — an isolated CODEX_HOME owning its own `auth.json` (the
 * ChatGPT-plan credential), so a subscription run reads it instead of an API key. A clean-room
 * minimal rewrite of v1's `codex-subscription-home.ts`: no team/agent fan-out, no config.toml
 * materializer — just the auth.json the CLI needs. Idempotent (rewritten each turn). NEVER the
 * developer's personal ~/.codex.
 *
 * `secret` is the raw `auth.json` blob (or a token the caller already wrapped into one). Returns the
 * absolute CODEX_HOME path to pass through as the subprocess's CODEX_HOME.
 */
export function ensureCodexAuthHome(
  root: string | undefined,
  sandboxKey: string,
  secret: string,
): string {
  const safeKey = sandboxKey.replace(/[^a-z0-9_-]/gi, '_') || 'default';
  const home = join(atlasAgentHomeBase(root), safeKey, 'codex-sub');
  mkdirSync(home, { recursive: true });
  // Accept either a full auth.json blob or a bare token; wrap a bare token defensively.
  const authJson = secret.trim().startsWith('{')
    ? secret
    : JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: secret } });
  writeFileSync(join(home, 'auth.json'), authJson, { mode: 0o600 });
  return home;
}
