import type { EngineAuth } from './engine.types';

/**
 * Apply a turn's auth to the spawned `claude` CLI's env (mutates in place) — rewritten from v1's
 * `applyClaudeAuth`, identical precedence rules:
 * - 'api_key': override `ANTHROPIC_API_KEY` with the run's key when present; otherwise leave the
 *   ambient env (a dev fallback).
 * - 'subscription': drive the run off a Claude plan via `CLAUDE_CODE_OAUTH_TOKEN`, and STRIP any
 *   `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` — both outrank the OAuth token in the CLI's auth
 *   precedence, so a stray ambient key would silently win and bill the API instead.
 */
export function applyClaudeAuth(
  env: Record<string, string | undefined>,
  auth: EngineAuth | undefined,
): void {
  if (auth?.mode === 'subscription') {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    env.CLAUDE_CODE_OAUTH_TOKEN = auth.secret;
  } else if (auth?.mode === 'api_key' && auth.apiKey) {
    env.ANTHROPIC_API_KEY = auth.apiKey;
  }
}
