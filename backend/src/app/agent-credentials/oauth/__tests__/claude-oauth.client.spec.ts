import {
  buildAuthorizeUrl,
  exchangeCode,
  parseTokenSet,
  tokenSetToBlob,
} from '../claude-oauth.client';

describe('buildAuthorizeUrl', () => {
  it('sets PKCE + manual-code params', () => {
    const url = new URL(buildAuthorizeUrl({ challenge: 'CH', state: 'ST' }));
    expect(url.origin + url.pathname).toBe('https://claude.com/cai/oauth/authorize');
    expect(url.searchParams.get('code_challenge')).toBe('CH');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('ST');
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});

describe('exchangeCode', () => {
  it('rejects a pasted code whose fragment state does not match', async () => {
    await expect(
      exchangeCode({ code: 'abc#wrongstate', verifier: 'v', state: 'rightstate' }),
    ).rejects.toThrow(/state mismatch/);
  });
});

describe('parseTokenSet', () => {
  it('extracts tokens, expiry, plan and email', () => {
    const t = parseTokenSet({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      scope: 'user:inference',
      account: { subscription_type: 'max', email_address: 'x@y.com' },
    });
    expect(t.accessToken).toBe('at');
    expect(t.refreshToken).toBe('rt');
    expect(t.subscriptionType).toBe('max');
    expect(t.accountEmail).toBe('x@y.com');
    expect(t.expiresAt).toBeGreaterThan(Date.now());
  });

  it('throws when required fields are missing', () => {
    expect(() => parseTokenSet({ access_token: 'at' })).toThrow();
  });
});

describe('tokenSetToBlob', () => {
  it('splits the scope string into an array under claudeAiOauth', () => {
    const blob = tokenSetToBlob({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 123,
      scopes: 'a b c',
    });
    expect(blob.claudeAiOauth.scopes).toEqual(['a', 'b', 'c']);
    expect(blob.claudeAiOauth.accessToken).toBe('at');
    expect(blob.claudeAiOauth.expiresAt).toBe(123);
  });
});
