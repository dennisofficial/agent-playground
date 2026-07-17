import type { EngineAuth } from './engine.types';

export function applyClaudeAuth(env: Record<string, string | undefined>, auth: EngineAuth): void {
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CODE_OAUTH_TOKEN = auth.secret;
}
