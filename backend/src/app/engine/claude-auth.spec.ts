import { describe, expect, it } from 'vitest';
import { applyClaudeAuth } from './claude-auth';

describe('applyClaudeAuth', () => {
  it('sets the OAuth token AND strips the API/auth keys (precedence safety)', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'ambient',
      ANTHROPIC_AUTH_TOKEN: 'auth',
    };
    applyClaudeAuth(env, { secret: 'oauth-tok' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-tok');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('strips a stray ambient API key even when none was set on the run before', () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'ambient' };
    applyClaudeAuth(env, { secret: 'oauth-tok' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-tok');
  });
});
