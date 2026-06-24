import { describe, expect, it } from 'vitest';
import { applyClaudeAuth } from './claude-auth';

describe('applyClaudeAuth', () => {
  it('api_key mode overrides ANTHROPIC_API_KEY when a key is present', () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'ambient' };
    applyClaudeAuth(env, { mode: 'api_key', apiKey: 'turn-key' });
    expect(env.ANTHROPIC_API_KEY).toBe('turn-key');
  });

  it('api_key mode with no key leaves the ambient env (dev fallback)', () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'ambient' };
    applyClaudeAuth(env, { mode: 'api_key' });
    expect(env.ANTHROPIC_API_KEY).toBe('ambient');
  });

  it('subscription mode sets the OAuth token AND strips the API/auth keys (precedence safety)', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'ambient',
      ANTHROPIC_AUTH_TOKEN: 'auth',
    };
    applyClaudeAuth(env, { mode: 'subscription', secret: 'oauth-tok' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-tok');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('undefined auth is a no-op', () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'ambient' };
    applyClaudeAuth(env, undefined);
    expect(env.ANTHROPIC_API_KEY).toBe('ambient');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
