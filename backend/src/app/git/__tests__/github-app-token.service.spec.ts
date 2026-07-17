import type { EnvService } from '@core/config/env/env.service';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GitHubAppTokenService } from '../github-app-token.service';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function fakeEnv(overrides: Record<string, string | undefined> = {}): EnvService {
  const map: Record<string, string | undefined> = {
    GITHUB_APP_CLIENT_ID: 'Iv1.testclient',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: privateKey,
    ...overrides,
  };
  return { get: (k: string) => map[k] } as unknown as EnvService;
}

type Call = { url: string; init?: RequestInit };

/** URL-routing fetch stub: matches requests by a substring against a list of {match, responses} routes. */
function routedFetch(
  routes: Array<{
    match: string | RegExp;
    responses: Array<{ status: number; body: unknown }>;
  }>,
) {
  const calls: Call[] = [];
  const counters = new Map<number, number>();
  const impl = ((url: unknown, init?: unknown) => {
    const u = String(url);
    calls.push({ url: u, init: init as RequestInit });
    const routeIdx = routes.findIndex((r) =>
      typeof r.match === 'string' ? u.includes(r.match) : r.match.test(u),
    );
    if (routeIdx === -1) throw new Error(`unrouted fetch: ${u}`);
    const i = counters.get(routeIdx) ?? 0;
    counters.set(routeIdx, i + 1);
    const route = routes[routeIdx];
    const r = route.responses[Math.min(i, route.responses.length - 1)];
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => Promise.resolve(r.body),
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function decodeJwt(jwt: string): {
  header: any;
  payload: any;
  parts: string[];
} {
  const parts = jwt.split('.');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  return { header, payload, parts };
}

function verifyJwtSignature(parts: string[]): boolean {
  const signingInput = `${parts[0]}.${parts[1]}`;
  const verifier = createVerify('RSA-SHA256').update(signingInput);
  return verifier.verify(publicKey, Buffer.from(parts[2], 'base64url'));
}

function bearerJwt(call: Call): string {
  const headers = call.init?.headers as Record<string, string>;
  return headers.Authorization.replace(/^Bearer /, '');
}

describe('GitHubAppTokenService.isConfigured', () => {
  it('true only when a private key AND (client id or app id) are present', () => {
    const svc = new GitHubAppTokenService(fakeEnv());
    expect(svc.isConfigured()).toBe(true);

    const noKey = new GitHubAppTokenService(fakeEnv({ GITHUB_APP_PRIVATE_KEY: undefined }));
    expect(noKey.isConfigured()).toBe(false);

    const noIss = new GitHubAppTokenService(
      fakeEnv({ GITHUB_APP_CLIENT_ID: undefined, GITHUB_APP_ID: undefined }),
    );
    expect(noIss.isConfigured()).toBe(false);
  });
});

describe('GitHubAppTokenService JWT', () => {
  it('signs a well-formed RS256 App JWT: header, claims, and signature all verify', async () => {
    const inFuture = new Date(Date.now() + 60 * 60_000).toISOString();
    const { impl, calls } = routedFetch([
      {
        match: '/access_tokens',
        responses: [{ status: 201, body: { token: 'ghs_abc', expires_at: inFuture } }],
      },
    ]);
    const svc = new GitHubAppTokenService(fakeEnv());
    svc.fetchImpl = impl;

    const before = Math.floor(Date.now() / 1000);
    await svc.getInstallationToken('999');
    const jwt = bearerJwt(calls[0]);
    const { header, payload, parts } = decodeJwt(jwt);

    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload.iss).toBe('Iv1.testclient');
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(payload.iat).toBeGreaterThanOrEqual(before - 65);
    expect(payload.iat).toBeLessThanOrEqual(before - 55);
    expect(verifyJwtSignature(parts)).toBe(true);
  });

  it('falls back to GITHUB_APP_ID as iss when GITHUB_APP_CLIENT_ID is unset', async () => {
    const inFuture = new Date(Date.now() + 60 * 60_000).toISOString();
    const { impl, calls } = routedFetch([
      {
        match: '/access_tokens',
        responses: [{ status: 201, body: { token: 'ghs_abc', expires_at: inFuture } }],
      },
    ]);
    const svc = new GitHubAppTokenService(fakeEnv({ GITHUB_APP_CLIENT_ID: undefined }));
    svc.fetchImpl = impl;
    await svc.getInstallationToken('999');
    const { payload } = decodeJwt(bearerJwt(calls[0]));
    expect(payload.iss).toBe('12345');
  });

  it('accepts raw PEM env values whose newlines are escaped', async () => {
    const inFuture = new Date(Date.now() + 60 * 60_000).toISOString();
    const { impl, calls } = routedFetch([
      {
        match: '/access_tokens',
        responses: [{ status: 201, body: { token: 'ghs_abc', expires_at: inFuture } }],
      },
    ]);
    const svc = new GitHubAppTokenService(
      fakeEnv({ GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n') }),
    );
    svc.fetchImpl = impl;
    await svc.getInstallationToken('999');
    const { parts } = decodeJwt(bearerJwt(calls[0]));
    expect(verifyJwtSignature(parts)).toBe(true);
  });
});

describe('GitHubAppTokenService.getInstallationToken', () => {
  it('mints and returns the token; POSTs the expected URL with a Bearer JWT', async () => {
    const inFuture = new Date(Date.now() + 60 * 60_000).toISOString();
    const { impl, calls } = routedFetch([
      {
        match: '/access_tokens',
        responses: [{ status: 201, body: { token: 'ghs_abc', expires_at: inFuture } }],
      },
    ]);
    const svc = new GitHubAppTokenService(fakeEnv());
    svc.fetchImpl = impl;

    const token = await svc.getInstallationToken('999');
    expect(token).toBe('ghs_abc');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/app/installations/999/access_tokens');
    expect(calls[0].init?.method).toBe('POST');
    expect(bearerJwt(calls[0])).toBeTruthy();
  });

  it('caches within the 55-minute window — only one POST for two calls', async () => {
    const inFuture = new Date(Date.now() + 60 * 60_000).toISOString();
    const { impl, calls } = routedFetch([
      {
        match: '/access_tokens',
        responses: [{ status: 201, body: { token: 'ghs_abc', expires_at: inFuture } }],
      },
    ]);
    const svc = new GitHubAppTokenService(fakeEnv());
    svc.fetchImpl = impl;

    const t1 = await svc.getInstallationToken('999');
    const t2 = await svc.getInstallationToken('999');
    expect(t1).toBe('ghs_abc');
    expect(t2).toBe('ghs_abc');
    expect(calls).toHaveLength(1);
  });

  it('re-mints once the cached token is within 5 minutes of expiry', async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    const { impl, calls } = routedFetch([
      {
        match: '/access_tokens',
        responses: [
          { status: 201, body: { token: 'ghs_first', expires_at: soon } },
          { status: 201, body: { token: 'ghs_second', expires_at: later } },
        ],
      },
    ]);
    const svc = new GitHubAppTokenService(fakeEnv());
    svc.fetchImpl = impl;

    const t1 = await svc.getInstallationToken('999');
    const t2 = await svc.getInstallationToken('999');
    expect(t1).toBe('ghs_first');
    expect(t2).toBe('ghs_second');
    expect(calls).toHaveLength(2);
  });

  it('throws with GitHub status + detail (never the JWT/token) on a non-retryable non-OK response', async () => {
    const { impl } = routedFetch([
      {
        match: '/access_tokens',
        responses: [{ status: 404, body: { message: 'Not Found' } }],
      },
    ]);
    const svc = new GitHubAppTokenService(fakeEnv());
    svc.fetchImpl = impl;
    await expect(svc.getInstallationToken('999')).rejects.toThrow(/404.*Not Found/);
  });
});

describe('GitHubAppTokenService.findInstallationId', () => {
  it('returns null on 404', async () => {
    const { impl } = routedFetch([
      { match: '/installation', responses: [{ status: 404, body: {} }] },
    ]);
    const svc = new GitHubAppTokenService(fakeEnv());
    svc.fetchImpl = impl;
    expect(await svc.findInstallationId('acme')).toBeNull();
  });

  it('returns the installation id as a string on 200', async () => {
    const { impl, calls } = routedFetch([
      {
        match: '/installation',
        responses: [{ status: 200, body: { id: 999 } }],
      },
    ]);
    const svc = new GitHubAppTokenService(fakeEnv());
    svc.fetchImpl = impl;
    expect(await svc.findInstallationId('acme')).toBe('999');
    expect(calls[0].url).toBe('https://api.github.com/orgs/acme/installation');
  });

  it('scopes to a repo when repo is given', async () => {
    const { impl, calls } = routedFetch([
      {
        match: '/installation',
        responses: [{ status: 200, body: { id: 42 } }],
      },
    ]);
    const svc = new GitHubAppTokenService(fakeEnv());
    svc.fetchImpl = impl;
    expect(await svc.findInstallationId('acme', 'app')).toBe('42');
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/app/installation');
  });
});

describe('GitHubAppTokenService.getInstallation', () => {
  it('maps the installation + account on 200; null on 404', async () => {
    const { impl } = routedFetch([
      {
        match: '/app/installations/999',
        responses: [
          {
            status: 200,
            body: {
              id: 999,
              account: { login: 'acme', id: 1, type: 'Organization' },
            },
          },
        ],
      },
    ]);
    const svc = new GitHubAppTokenService(fakeEnv());
    svc.fetchImpl = impl;
    expect(await svc.getInstallation('999')).toEqual({
      id: '999',
      account: { login: 'acme', id: 1, type: 'Organization' },
    });

    const nf = routedFetch([
      {
        match: '/app/installations/998',
        responses: [{ status: 404, body: {} }],
      },
    ]);
    svc.fetchImpl = nf.impl;
    expect(await svc.getInstallation('998')).toBeNull();
  });
});

describe('GitHubAppTokenService.appBotIdentity', () => {
  it('resolves name/email from GET /app then GET /users/<slug>[bot], and memoizes', async () => {
    const { impl, calls } = routedFetch([
      {
        match: /\/app$/,
        responses: [{ status: 200, body: { slug: 'atlas-bot' } }],
      },
      { match: '/users/', responses: [{ status: 200, body: { id: 42 } }] },
    ]);
    const svc = new GitHubAppTokenService(fakeEnv());
    svc.fetchImpl = impl;

    const identity = await svc.appBotIdentity();
    expect(identity).toEqual({
      name: 'atlas-bot[bot]',
      email: '42+atlas-bot[bot]@users.noreply.github.com',
    });
    expect(calls.some((c) => c.url.includes('/users/atlas-bot%5Bbot%5D'))).toBe(true);
    const userCall = calls.find((c) => c.url.includes('/users/atlas-bot%5Bbot%5D'));
    expect(userCall).toBeDefined();
    expect((userCall!.init?.headers as Record<string, string>).Authorization).toBeUndefined();

    const callsBefore = calls.length;
    await svc.appBotIdentity();
    expect(calls).toHaveLength(callsBefore); // memoized — no new calls
  });
});
