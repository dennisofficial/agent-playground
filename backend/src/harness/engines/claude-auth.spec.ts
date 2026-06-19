import { describe, expect, it } from 'vitest';
import { applyClaudeAuth } from './claude.engine';

/** The subprocess-env auth selection — the one place a precedence slip would silently bill the API
 * instead of the workspace's Claude plan. */
describe('applyClaudeAuth', () => {
  it('api_key mode: sets ANTHROPIC_API_KEY, no OAuth token', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' };
    applyClaudeAuth(env, { mode: 'api_key', apiKey: 'sk-ant-123' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-123');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('subscription mode: injects the OAuth token AND strips both API/auth tokens (precedence)', () => {
    // A stray ambient ANTHROPIC_API_KEY would otherwise WIN over the OAuth token and bill the API.
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'sk-ambient',
      ANTHROPIC_AUTH_TOKEN: 'auth-ambient',
      PATH: '/usr/bin',
    };
    applyClaudeAuth(env, { mode: 'subscription', secret: 'oauth-tok' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-tok');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin'); // unrelated env untouched
  });

  it('api_key mode without a key: leaves ambient env as-is (dev/TUI fallback)', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'sk-ambient',
    };
    applyClaudeAuth(env, { mode: 'api_key' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ambient');
  });

  it('undefined auth: no-op (ambient env funds the run)', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'sk-ambient',
    };
    applyClaudeAuth(env, undefined);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ambient');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
