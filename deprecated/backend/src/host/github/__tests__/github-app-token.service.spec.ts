import type { OctokitSdk } from '@lib/esm/octokit.provider';
import { generateKeyPairSync } from 'node:crypto';
import { GithubAppTokenService } from '../github-app-token.service';

/** Build the real Octokit SDK bag the way the OCTOKIT_SDK provider does (dynamic import of the ESM pkgs). */
async function loadSdk(): Promise<OctokitSdk> {
  const [rest, retry, throttling, authApp, requestError] = await Promise.all([
    import('@octokit/rest'),
    import('@octokit/plugin-retry'),
    import('@octokit/plugin-throttling'),
    import('@octokit/auth-app'),
    import('@octokit/request-error'),
  ]);
  return {
    AtlasOctokit: rest.Octokit.plugin(
      retry.retry,
      throttling.throttling,
    ) as unknown as OctokitSdk['AtlasOctokit'],
    createAppAuth: authApp.createAppAuth,
    RequestError: requestError.RequestError,
  };
}

let sdk: OctokitSdk;
beforeAll(async () => {
  sdk = await loadSdk();
});

// auth-app's JWT signer requires a PKCS#8 key.
const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ENV: Record<string, string> = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_SLUG: 'atlas',
  GITHUB_APP_PRIVATE_KEY: PEM,
};

/** Route Octokit's fetch by URL to canned JSON responses. */
function stubFetch(routes: Array<{ match: string; status?: number; body: unknown }>) {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    const hit = routes.find((r) => u.includes(r.match));
    const status = hit?.status ?? 200;
    return new Response(JSON.stringify(hit?.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function makeService(routes: Array<{ match: string; status?: number; body: unknown }>) {
  const env = { get: (k: string) => ENV[k] };
  const service = new GithubAppTokenService(env as never, sdk);
  service.fetchImpl = stubFetch(routes) as never;
  return service;
}

const TOKEN_BODY = {
  token: 'ghs_installation',
  expires_at: '2999-01-01T00:00:00Z',
  permissions: {},
  repository_selection: 'all',
};

describe('appSlug', () => {
  it('returns the slug from env without any network call', () => {
    const service = makeService([]);
    expect(service.appSlug()).toBe('atlas');
  });
});

describe('getInstallationToken', () => {
  it('mints an installation token via auth-app', async () => {
    const service = makeService([{ match: '/access_tokens', body: TOKEN_BODY }]);
    expect(await service.getInstallationToken('100')).toBe('ghs_installation');
  });
});

describe('getInstallation', () => {
  it('maps the installation to { id, accountLogin }', async () => {
    const service = makeService([
      { match: '/app/installations/100', body: { id: 100, account: { login: 'acme' } } },
    ]);
    expect(await service.getInstallation('100')).toEqual({ id: '100', accountLogin: 'acme' });
  });

  it('returns null on 404', async () => {
    const service = makeService([{ match: '/app/installations/999', status: 404, body: {} }]);
    expect(await service.getInstallation('999')).toBeNull();
  });
});

describe('appBotIdentity', () => {
  it('builds {slug}[bot] with the noreply email from the bot user id', async () => {
    const service = makeService([{ match: '/users/', body: { id: 55, login: 'atlas[bot]' } }]);
    expect(await service.appBotIdentity()).toEqual({
      name: 'atlas[bot]',
      email: '55+atlas[bot]@users.noreply.github.com',
    });
  });
});
