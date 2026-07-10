import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  DEFAULT_CLAUDE_OAUTH_CONFIG,
  exchangeCode,
  generatePkce,
  refresh,
} from './claude-oauth.client';

const BASE64URL_ONLY = /^[A-Za-z0-9_-]+$/;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generatePkce', () => {
  it('derives the challenge as base64url(sha256(verifier)), and verifier/state are base64url', () => {
    const { verifier, challenge, state } = generatePkce();
    const expectedChallenge = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe(expectedChallenge);
    expect(verifier).toMatch(BASE64URL_ONLY);
    expect(state).toMatch(BASE64URL_ONLY);
  });

  it('mints fresh material on every call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });
});

describe('buildAuthorizeUrl', () => {
  it('targets the claude.com/cai host by default and carries every required param', () => {
    const url = new URL(
      buildAuthorizeUrl(DEFAULT_CLAUDE_OAUTH_CONFIG, {
        challenge: 'chal123',
        state: 'state456',
      }),
    );
    expect(url.host).toBe('claude.com');
    expect(url.pathname).toBe('/cai/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(
      DEFAULT_CLAUDE_OAUTH_CONFIG.clientId,
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(
      DEFAULT_CLAUDE_OAUTH_CONFIG.redirectUri,
    );
    expect(url.searchParams.get('scope')).toBe(
      DEFAULT_CLAUDE_OAUTH_CONFIG.scopes,
    );
    expect(url.searchParams.get('code_challenge')).toBe('chal123');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state456');
    expect(url.searchParams.get('code')).toBe('true');
  });
});

describe('exchangeCode', () => {
  it('POSTs the authorization_code grant and parses the token response', async () => {
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      expect(url).toBe(DEFAULT_CLAUDE_OAUTH_CONFIG.tokenUrl);
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      });
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        grant_type: 'authorization_code',
        code: 'the-code',
        state: 'the-state',
        redirect_uri: DEFAULT_CLAUDE_OAUTH_CONFIG.redirectUri,
        client_id: DEFAULT_CLAUDE_OAUTH_CONFIG.clientId,
        code_verifier: 'the-verifier',
      });
      return jsonResponse(200, {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
        scope: 'user:profile user:inference',
        account: { subscription_type: 'pro', email_address: 'dev@example.com' },
        organization: { name: 'Acme' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const before = Date.now();
    const tokens = await exchangeCode(DEFAULT_CLAUDE_OAUTH_CONFIG, {
      code: 'the-code',
      verifier: 'the-verifier',
      state: 'the-state',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tokens.accessToken).toBe('at-1');
    expect(tokens.refreshToken).toBe('rt-1');
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(
      Date.now() + 3600 * 1000 + 1000,
    );
    expect(tokens.scopes).toBe('user:profile user:inference');
    expect(tokens.subscriptionType).toBe('pro');
    expect(tokens.accountEmail).toBe('dev@example.com');
    expect(tokens.organization).toBe('Acme');
  });

  it('splits a pasted code#state and passes only the bare code to the token endpoint', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.code).toBe('the-code');
      return jsonResponse(200, {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 60,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await exchangeCode(DEFAULT_CLAUDE_OAUTH_CONFIG, {
      code: 'the-code#the-state',
      verifier: 'v',
      state: 'the-state',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws when the code fragment state does not match the stashed state', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      exchangeCode(DEFAULT_CLAUDE_OAUTH_CONFIG, {
        code: 'the-code#other-state',
        verifier: 'v',
        state: 'the-state',
      }),
    ).rejects.toThrow(/state mismatch/);
  });

  it('throws on a non-2xx response without leaking the body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(400, { error: 'invalid_grant' })),
    );
    await expect(
      exchangeCode(DEFAULT_CLAUDE_OAUTH_CONFIG, {
        code: 'c',
        verifier: 'v',
        state: 's',
      }),
    ).rejects.toThrow(/400/);
  });

  it('throws when the response is missing required fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(200, { access_token: 'at' })),
    );
    await expect(
      exchangeCode(DEFAULT_CLAUDE_OAUTH_CONFIG, {
        code: 'c',
        verifier: 'v',
        state: 's',
      }),
    ).rejects.toThrow(/missing/);
  });
});

describe('refresh', () => {
  it('POSTs the refresh_token grant and returns a rotated token set', async () => {
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      expect(url).toBe(DEFAULT_CLAUDE_OAUTH_CONFIG.tokenUrl);
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        grant_type: 'refresh_token',
        refresh_token: 'old-refresh',
        client_id: DEFAULT_CLAUDE_OAUTH_CONFIG.clientId,
      });
      return jsonResponse(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 7200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tokens = await refresh(DEFAULT_CLAUDE_OAUTH_CONFIG, {
      refreshToken: 'old-refresh',
    });
    expect(tokens.accessToken).toBe('new-access');
    expect(tokens.refreshToken).toBe('new-refresh');
  });
});
