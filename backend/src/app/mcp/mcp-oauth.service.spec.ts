import type { EnvService } from '@core/config/env/env.service';
import type { Repository } from 'typeorm';
import { describe, expect, it } from 'vitest';
import type { McpServerEntity } from '../persistence/entities';
import { McpOAuthService, NEEDS_REAUTH } from './mcp-oauth.service';
import { McpServerStore } from './mcp-server.store';

const KEY = 'c'.repeat(64);

/** Minimal in-memory repository (same shape as the store/resolver specs). */
class FakeRepo {
  rows: McpServerEntity[] = [];
  create(p: Partial<McpServerEntity>): McpServerEntity {
    return { ...p } as McpServerEntity;
  }
  async save(row: McpServerEntity): Promise<McpServerEntity> {
    const i = this.rows.findIndex(
      (r) => r.org_id === row.org_id && r.scope === row.scope && r.name === row.name,
    );
    if (i >= 0) this.rows[i] = row;
    else this.rows.push(row);
    return row;
  }
  async findOne({ where }: { where: Partial<McpServerEntity> }): Promise<McpServerEntity | null> {
    return this.rows.find((r) => this.match(r, where)) ?? null;
  }
  async find({
    where,
  }: {
    where: Partial<McpServerEntity> | Partial<McpServerEntity>[];
  }): Promise<McpServerEntity[]> {
    const conds = Array.isArray(where) ? where : [where];
    return this.rows.filter((r) => conds.some((c) => this.match(r, c)));
  }
  async delete(): Promise<void> {}
  private match(r: McpServerEntity, where: Partial<McpServerEntity>): boolean {
    return Object.entries(where).every(
      ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
    );
  }
}

function make(): { svc: McpOAuthService; store: McpServerStore } {
  const repo = new FakeRepo();
  const env = {
    get: (k: string) =>
      k === 'SECRETS_ENCRYPTION_KEY'
        ? KEY
        : k === 'BACKEND_HOST'
          ? 'http://localhost:4002'
          : undefined,
  } as EnvService;
  const store = new McpServerStore(repo as unknown as Repository<McpServerEntity>, env);
  return { svc: new McpOAuthService(store, env), store };
}

/** Create a persisted oauth server row and set its `oauth_enc` blob, returning the raw entity. */
async function seedOAuthRow(
  store: McpServerStore,
  svc: McpOAuthService,
  blob: Record<string, unknown>,
): Promise<McpServerEntity> {
  await store.write('org1', '*', 'jira', {
    transport: 'sse',
    url: 'https://mcp.example.com/sse',
    authKind: 'oauth',
  });
  await store.writeOAuthBlob('org1', '*', 'jira', blob, {
    validationError: null,
  });
  return (await store.rawRow('org1', '*', 'jira'))!;
}

describe('McpOAuthService — signed state', () => {
  it('round-trips a signed state through the real HMAC (verify passes → row lookup is reached)', async () => {
    const { svc, store } = make();
    await seedOAuthRow(store, svc, { nonce: 'n1' });
    // A validly-signed state whose nonce MISMATCHES the row is rejected as replay (proves verify passed).
    const state = svc.signState({
      orgId: 'org1',
      scope: '*',
      name: 'jira',
      nonce: 'WRONG',
    });
    await expect(svc.completeAuthorization(state, 'code')).rejects.toThrow(/stale or replayed/);
  });

  it('rejects a tampered / malformed state before any row lookup', async () => {
    const { svc } = make();
    await expect(svc.completeAuthorization('not-a-real-state', 'code')).rejects.toThrow(
      /invalid oauth state/,
    );
    const good = svc.signState({
      orgId: 'o',
      scope: '*',
      name: 'n',
      nonce: 'x',
    });
    const tampered = good.slice(0, -2) + (good.endsWith('AA') ? 'BB' : 'AA');
    await expect(svc.completeAuthorization(tampered, 'code')).rejects.toThrow(
      /invalid oauth state/,
    );
  });

  it('produces a two-part base64url token', () => {
    const { svc } = make();
    const s = svc.signState({ orgId: 'o', scope: '*', name: 'n', nonce: 'x' });
    expect(s.split('.')).toHaveLength(2);
    expect(s).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

describe('McpOAuthService.currentAccessToken', () => {
  it('returns the stored access token when it is not near expiry (no refresh/network)', async () => {
    const { svc, store } = make();
    const row = await seedOAuthRow(store, svc, {
      tokens: {
        access_token: 'at-valid',
        refresh_token: 'rt',
        expires_in: 3600,
      },
      obtainedAt: Date.now(),
    });
    expect(await svc.currentAccessToken(row)).toBe('at-valid');
  });

  it('treats a token with no stated expiry (and no refresh token) as long-lived', async () => {
    const { svc, store } = make();
    const row = await seedOAuthRow(store, svc, {
      tokens: { access_token: 'at-forever' },
    });
    expect(await svc.currentAccessToken(row)).toBe('at-forever');
  });

  it('does NOT refresh a no-expires_in token still within the conservative default lifetime', async () => {
    const { svc, store } = make();
    const row = await seedOAuthRow(store, svc, {
      tokens: { access_token: 'at-recent', refresh_token: 'rt' },
      obtainedAt: Date.now() - 60_000, // a minute old — well inside the default TTL
    });
    expect(await svc.currentAccessToken(row)).toBe('at-recent');
  });

  it('refreshes a no-expires_in token past the default lifetime when a refresh_token exists', async () => {
    const { svc, store } = make();
    const row = await seedOAuthRow(store, svc, {
      tokens: { access_token: 'at-stale', refresh_token: 'rt' },
      obtainedAt: Date.now() - 60 * 60_000, // an hour old — past the conservative default TTL
    });
    // Inject a fake SDK auth() that rotates the token instead of hitting the network.
    (svc as unknown as { authSdkPromise: Promise<unknown> }).authSdkPromise = Promise.resolve({
      auth: async (provider: { saveTokens: (t: unknown) => Promise<void> }) => {
        await provider.saveTokens({
          access_token: 'at-refreshed',
          refresh_token: 'rt2',
        });
        return 'AUTHORIZED';
      },
    });
    expect(await svc.currentAccessToken(row)).toBe('at-refreshed');
  });

  it('returns null (unconnected) when there are no tokens', async () => {
    const { svc, store } = make();
    const row = await seedOAuthRow(store, svc, {});
    expect(await svc.currentAccessToken(row)).toBeNull();
  });

  it('marks needs-reauth and returns null when expired with no refresh token', async () => {
    const { svc, store } = make();
    const row = await seedOAuthRow(store, svc, {
      tokens: { access_token: 'at-old', expires_in: 1 },
      obtainedAt: Date.now() - 60_000,
    });
    expect(await svc.currentAccessToken(row)).toBeNull();
    expect((await store.rawRow('org1', '*', 'jira'))!.validation_error).toBe(NEEDS_REAUTH);
  });
});

describe('McpOAuthService.refreshForSandbox', () => {
  it('is a cheap no-op (rotated:false) when the repo has no oauth servers', async () => {
    const { svc, store } = make();
    await store.write('org1', 'repo-1', 'plain', {
      transport: 'http',
      url: 'https://x.example.com',
    });
    expect(await svc.refreshForSandbox('org1', 'repo-1')).toEqual({
      rotated: false,
    });
  });
});

describe('McpOAuthService.beginAuthorization', () => {
  it('probes the 401 resource_metadata hint, passes it to auth(), and drops stale cache', async () => {
    const { svc, store } = make();
    await store.write('org1', '*', 'jira', {
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      authKind: 'oauth',
    });
    // Stale cached client + discovery bound to an OLD auth server — a reconnect must NOT reuse them.
    await store.writeOAuthBlob(
      'org1',
      '*',
      'jira',
      {
        clientInformation: { client_id: 'STALE' },
        discoveryState: { authorizationServerUrl: 'https://old.example.com' },
        tokens: { access_token: 'old' },
      },
      { validationError: 'needs re-auth' },
    );

    const RMU = 'https://mcp.example.com/.well-known/oauth-protected-resource/x';
    let seenOpts: { resourceMetadataUrl?: URL } | undefined;
    (svc as unknown as { authSdkPromise: Promise<unknown> }).authSdkPromise = Promise.resolve({
      extractResourceMetadataUrl: (res: Response) => {
        const m = (res.headers.get('WWW-Authenticate') ?? '').match(/resource_metadata="([^"]+)"/);
        return m ? new URL(m[1]) : undefined;
      },
      auth: async (
        provider: { redirectToAuthorization: (u: URL) => void },
        opts: { resourceMetadataUrl?: URL },
      ) => {
        seenOpts = opts;
        provider.redirectToAuthorization(new URL('https://auth.example.com/authorize?x=1'));
        return 'REDIRECT';
      },
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 401,
        headers: { 'WWW-Authenticate': `Bearer resource_metadata="${RMU}"` },
      })) as typeof fetch;
    try {
      const { authorizeUrl } = await svc.beginAuthorization('org1', '*', 'jira');
      expect(authorizeUrl).toContain('auth.example.com');
      // The probed resource_metadata hint reached auth() (so discovery follows it, not the host root).
      expect(seenOpts?.resourceMetadataUrl?.href).toBe(RMU);
      // Stale client + discovery + tokens were dropped by the clean-blob reset.
      const blob = store.readOAuthBlob((await store.rawRow('org1', '*', 'jira'))!);
      expect(blob.clientInformation).toBeUndefined();
      expect(blob.discoveryState).toBeUndefined();
      expect(blob.tokens).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
