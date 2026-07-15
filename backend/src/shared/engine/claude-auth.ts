import type { EngineAuth } from './engine.types';

/**
 * Apply a turn's subscription auth to the spawned `claude` CLI's env (mutates in place). The harness
 * ALWAYS runs off a subscription — drive the run via `CLAUDE_CODE_OAUTH_TOKEN`, and STRIP any
 * `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`: both outrank the OAuth token in the CLI's auth
 * precedence, so a stray ambient key would silently win and bill the (ruinously expensive) API.
 */
export function applyClaudeAuth(
  env: Record<string, string | undefined>,
  auth: EngineAuth,
): void {
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CODE_OAUTH_TOKEN = auth.secret;
}
