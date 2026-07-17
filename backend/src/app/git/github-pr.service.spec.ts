import { describe, expect, it } from 'vitest';
import {
  GithubPrService,
  RateLimitedError,
  mapMergeStateStatus,
  parseGithubRepoUrl,
} from './github-pr.service';

type Call = { url: string; init?: RequestInit };

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

type HeaderResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Simulate a body-less 304: `res.json()` rejects to prove the cached path never calls it. */
  throwOnJson?: boolean;
};

/** Fake fetch whose responses expose a real `.get`-able `headers` (a Map), for the ETag/rate-limit paths. */
function fakeFetchWithHeaders(responses: HeaderResponse[]) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Map(Object.entries(r.headers ?? {})),
      json: async () => {
        if (r.throwOnJson) throw new Error('no body on 304');
        return r.body;
      },
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const pullDetailBody = {
  html_url: 'https://github.com/acme/app/pull/7',
  number: 7,
  state: 'open',
  mergeable_state: 'clean',
  head: { sha: 'abc123', ref: 'atlas/feature' },
};

const prArgs = {
  owner: 'acme',
  repo: 'app',
  head: 'atlas/gate-abcd',
  base: 'main',
  title: 'Atlas v2 gate',
  body: 'gate body',
  draft: true,
};

describe('GithubPrService.openPullRequest', () => {
  it('creates a draft PR with the required headers; token only in Authorization', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 201,
        body: { html_url: 'https://github.com/acme/app/pull/9', number: 9 },
      },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    const res = await svc.openPullRequest('TOK123', prArgs);
    expect(res).toEqual({
      url: 'https://github.com/acme/app/pull/9',
      number: 9,
      existing: false,
    });
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/app/pulls');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer TOK123');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(headers['User-Agent']).toBe('atlas');
    // The token must NOT appear in the request body.
    expect(String(calls[0].init?.body)).not.toContain('TOK123');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      title: 'Atlas v2 gate',
      head: 'atlas/gate-abcd',
      base: 'main',
      body: 'gate body',
      draft: true,
    });
  });

  it('returns the existing open PR on a 422 already-exists (idempotent)', async () => {
    const { impl } = fakeFetch([
      {
        status: 422,
        body: {
          message: 'A pull request already exists for acme:atlas/gate-abcd.',
        },
      },
      {
        status: 200,
        body: [{ html_url: 'https://github.com/acme/app/pull/4', number: 4 }],
      },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    const res = await svc.openPullRequest('TOK', prArgs);
    expect(res).toEqual({
      url: 'https://github.com/acme/app/pull/4',
      number: 4,
      existing: true,
    });
  });

  it('throws with GitHub status + detail (never the token) on other errors', async () => {
    const { impl } = fakeFetch([{ status: 403, body: { message: 'Resource not accessible' } }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    await expect(svc.openPullRequest('SECRET', prArgs)).rejects.toThrow(
      /403.*Resource not accessible/,
    );
    await expect(svc.openPullRequest('SECRET', prArgs)).rejects.not.toThrow(/SECRET/);
  });
});

describe('GithubPrService.closePullRequest', () => {
  it('PATCHes state=closed with the token only in the Authorization header', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { number: 9, state: 'closed' } }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    await svc.closePullRequest('TOK123', {
      owner: 'acme',
      repo: 'app',
      number: 9,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/app/pulls/9');
    expect(calls[0].init?.method).toBe('PATCH');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer TOK123');
    expect(String(calls[0].init?.body)).not.toContain('TOK123');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      state: 'closed',
    });
  });

  it('throws with GitHub status + detail (never the token) on a non-OK response', async () => {
    const { impl } = fakeFetch([{ status: 403, body: { message: 'Resource not accessible' } }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    await expect(
      svc.closePullRequest('SECRET', { owner: 'acme', repo: 'app', number: 9 }),
    ).rejects.toThrow(/403.*Resource not accessible/);
    await expect(
      svc.closePullRequest('SECRET', { owner: 'acme', repo: 'app', number: 9 }),
    ).rejects.not.toThrow(/SECRET/);
  });
});

describe('GithubPrService.mergePullRequest', () => {
  it('PUTs merge_method + sha and returns {ok:true,sha} on 200; token only in Authorization', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { sha: 'abc' } }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    const res = await svc.mergePullRequest('TOK123', {
      owner: 'o',
      repo: 'r',
      number: 7,
      method: 'squash',
      sha: 'HEAD',
    });
    expect(res).toEqual({ ok: true, sha: 'abc' });
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/pulls/7/merge');
    expect(calls[0].init?.method).toBe('PUT');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer TOK123');
    expect(String(calls[0].init?.body)).not.toContain('TOK123');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      merge_method: 'squash',
      sha: 'HEAD',
    });
  });

  it('omits the sha key from the body when no sha is passed', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { sha: 'abc' } }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    await svc.mergePullRequest('TOK', {
      owner: 'o',
      repo: 'r',
      number: 7,
      method: 'merge',
    });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({ merge_method: 'merge' });
    expect('sha' in body).toBe(false);
  });

  it("maps a 405 'not mergeable' to reason:'not_mergeable'", async () => {
    const { impl } = fakeFetch([
      { status: 405, body: { message: 'Pull Request is not mergeable' } },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    const res = await svc.mergePullRequest('SECRET', {
      owner: 'o',
      repo: 'r',
      number: 7,
      method: 'squash',
    });
    expect(res).toEqual({
      ok: false,
      reason: 'not_mergeable',
      status: 405,
      message: 'Pull Request is not mergeable',
    });
    expect(JSON.stringify(res)).not.toContain('SECRET');
  });

  it("maps a 405 containing 'already merged' to reason:'already_merged'", async () => {
    const { impl } = fakeFetch([
      { status: 405, body: { message: 'Pull Request X is already merged' } },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    const res = await svc.mergePullRequest('TOK', {
      owner: 'o',
      repo: 'r',
      number: 7,
      method: 'squash',
    });
    expect(res).toMatchObject({ ok: false, reason: 'already_merged' });
  });

  it("maps a 409 to reason:'sha_mismatch'", async () => {
    const { impl } = fakeFetch([{ status: 409, body: { message: 'sha wonky' } }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    const res = await svc.mergePullRequest('TOK', {
      owner: 'o',
      repo: 'r',
      number: 7,
      method: 'squash',
    });
    expect(res).toMatchObject({
      ok: false,
      reason: 'sha_mismatch',
      status: 409,
    });
  });

  it("maps a 422 to reason:'method_disallowed'", async () => {
    const { impl } = fakeFetch([
      { status: 422, body: { message: 'Merge method squash is not allowed' } },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    const res = await svc.mergePullRequest('TOK', {
      owner: 'o',
      repo: 'r',
      number: 7,
      method: 'squash',
    });
    expect(res).toMatchObject({
      ok: false,
      reason: 'method_disallowed',
      status: 422,
    });
  });

  it("maps any other status to reason:'other'", async () => {
    const { impl } = fakeFetch([{ status: 500, body: { message: 'boom' } }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    const res = await svc.mergePullRequest('SECRET', {
      owner: 'o',
      repo: 'r',
      number: 7,
      method: 'squash',
    });
    expect(res).toMatchObject({ ok: false, reason: 'other', status: 500 });
    expect(JSON.stringify(res)).not.toContain('SECRET');
  });
});

describe('GithubPrService.deleteBranch', () => {
  it('resolves on a 204/200 (DELETE the ref)', async () => {
    const { impl, calls } = fakeFetch([{ status: 204, body: {} }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    await expect(
      svc.deleteBranch('TOK', {
        owner: 'o',
        repo: 'r',
        branch: 'atlas/feature',
      }),
    ).resolves.toBeUndefined();
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/git/refs/heads/atlas/feature');
    expect(calls[0].init?.method).toBe('DELETE');
  });

  it('encodes each ref path segment without flattening branch slashes', async () => {
    const { impl, calls } = fakeFetch([{ status: 204, body: {} }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    await svc.deleteBranch('TOK', {
      owner: 'o',
      repo: 'r',
      branch: 'atlas/feature space',
    });
    expect(calls[0].url).toBe(
      'https://api.github.com/repos/o/r/git/refs/heads/atlas/feature%20space',
    );
  });

  it('swallows a 404 (branch already gone)', async () => {
    const { impl } = fakeFetch([{ status: 404, body: {} }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    await expect(
      svc.deleteBranch('TOK', {
        owner: 'o',
        repo: 'r',
        branch: 'atlas/feature',
      }),
    ).resolves.toBeUndefined();
  });

  it('swallows a 422 (unprocessable, e.g. already deleted by GitHub auto-delete)', async () => {
    const { impl } = fakeFetch([{ status: 422, body: {} }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    await expect(
      svc.deleteBranch('TOK', {
        owner: 'o',
        repo: 'r',
        branch: 'atlas/feature',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects on a 500', async () => {
    const { impl } = fakeFetch([{ status: 500, body: { message: 'boom' } }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    await expect(
      svc.deleteBranch('TOK', {
        owner: 'o',
        repo: 'r',
        branch: 'atlas/feature',
      }),
    ).rejects.toThrow(/500/);
  });
});

describe('GithubPrService.getRepo', () => {
  it('maps a repo and returns null on 404/403', async () => {
    const ok = fakeFetch([
      {
        status: 200,
        body: {
          full_name: 'acme/app',
          owner: { login: 'acme' },
          name: 'app',
          html_url: 'https://github.com/acme/app',
          default_branch: 'main',
          private: true,
          description: 'x',
        },
      },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = ok.impl;
    expect(await svc.getRepo('T', 'acme', 'app')).toMatchObject({
      fullName: 'acme/app',
      defaultBranch: 'main',
      private: true,
    });

    const nf = fakeFetch([{ status: 404, body: {} }]);
    svc.fetchImpl = nf.impl;
    expect(await svc.getRepo('T', 'acme', 'missing')).toBeNull();
  });
});

describe('GithubPrService.listBranches', () => {
  it('returns branch names and stops when a page is short of the page size', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: [{ name: 'main' }, { name: 'develop' }] },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    expect(await svc.listBranches('T', 'acme', 'app')).toEqual(['main', 'develop']);
    // A short first page (< 100) means no second request.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/repos/acme/app/branches?per_page=100&page=1');
  });

  it('throws with the GitHub status (never the token) on a non-OK response', async () => {
    const { impl } = fakeFetch([{ status: 403, body: { message: 'forbidden' } }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    await expect(svc.listBranches('TOK', 'acme', 'app')).rejects.toThrow(/403.*forbidden/);
  });
});

describe('GithubPrService.ensureWebhook', () => {
  const args = {
    owner: 'acme',
    repo: 'app',
    url: 'https://api.example.com/ingress/github',
    secret: 'S3CR',
    events: ['workflow_run', 'check_run'],
  };

  it('creates a hook when none matches the url', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: [] },
      { status: 201, body: { id: 1 } },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    const outcome = await svc.ensureWebhook('TOK', args);
    expect(outcome).toBe('created');
    expect(calls).toHaveLength(2);
    expect(calls[1].init?.method).toBe('POST');
    expect(calls[1].url).toBe('https://api.github.com/repos/acme/app/hooks');
    const body = JSON.parse(String(calls[1].init?.body));
    expect(body).toEqual({
      config: {
        url: args.url,
        content_type: 'json',
        secret: args.secret,
        insecure_ssl: '0',
      },
      events: args.events,
      active: true,
    });
  });

  it('updates (PATCHes) an existing hook matched by config.url', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: [{ id: 42, config: { url: 'https://api.example.com/ingress/github' } }],
      },
      { status: 200, body: { id: 42 } },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    const outcome = await svc.ensureWebhook('TOK', args);
    expect(outcome).toBe('updated');
    expect(calls).toHaveLength(2);
    expect(calls[1].init?.method).toBe('PATCH');
    expect(calls[1].url).toBe('https://api.github.com/repos/acme/app/hooks/42');
  });

  it("returns 'no-scope' on a 403 listing hooks (only one fetch made)", async () => {
    const { impl, calls } = fakeFetch([
      { status: 403, body: { message: 'Resource not accessible' } },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    expect(await svc.ensureWebhook('TOK', args)).toBe('no-scope');
    expect(calls).toHaveLength(1);
  });

  it("returns 'no-scope' on a 403 creating the hook", async () => {
    const { impl } = fakeFetch([
      { status: 200, body: [] },
      { status: 403, body: {} },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    expect(await svc.ensureWebhook('TOK', args)).toBe('no-scope');
  });

  it("returns 'no-scope' on a 403 patching an existing hook", async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        body: [{ id: 42, config: { url: 'https://api.example.com/ingress/github' } }],
      },
      { status: 403, body: {} },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    expect(await svc.ensureWebhook('TOK', args)).toBe('no-scope');
  });

  it("returns 'error' on a 500 listing hooks", async () => {
    const { impl } = fakeFetch([{ status: 500, body: {} }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    expect(await svc.ensureWebhook('TOK', args)).toBe('error');
  });
});

describe('GithubPrService.getAuthenticatedUser', () => {
  it('returns the parsed user on an ok response', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: { login: 'octocat', id: 583231, name: 'The Octocat' },
      },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    expect(await svc.getAuthenticatedUser('TOK123')).toEqual({
      login: 'octocat',
      id: 583231,
      name: 'The Octocat',
    });
    expect(calls[0].url).toBe('https://api.github.com/user');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer TOK123');
  });

  it('returns null on a non-OK (401) response; the token never appears in output', async () => {
    const { impl } = fakeFetch([{ status: 401, body: { message: 'Bad credentials' } }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    const result = await svc.getAuthenticatedUser('SECRET');
    expect(result).toBeNull();
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});

describe('parseGithubRepoUrl', () => {
  it('parses owner/repo and drops .git; null on non-github', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/app.git')).toEqual({
      owner: 'acme',
      repo: 'app',
    });
    expect(parseGithubRepoUrl('https://gitlab.com/a/b')).toBeNull();
  });
});

const pd = { owner: 'acme', repo: 'app', number: 7 };

describe('GithubPrService conditional GET (ETag + rate-limit)', () => {
  it('sends no If-None-Match first, then If-None-Match on the second call for the same url', async () => {
    const { impl, calls } = fakeFetchWithHeaders([
      { status: 200, body: pullDetailBody, headers: { etag: 'W/"v1"' } },
      { status: 200, body: pullDetailBody, headers: { etag: 'W/"v1"' } },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;

    await svc.getPullDetail('TOK', pd);
    const firstHeaders = calls[0].init?.headers as Record<string, string>;
    expect(firstHeaders['If-None-Match']).toBeUndefined();

    await svc.getPullDetail('TOK', pd);
    const secondHeaders = calls[1].init?.headers as Record<string, string>;
    expect(secondHeaders['If-None-Match']).toBe('W/"v1"');
  });

  it('returns the cached PullDetail on a 304 without calling res.json()', async () => {
    const { impl } = fakeFetchWithHeaders([
      { status: 200, body: pullDetailBody, headers: { etag: 'W/"v1"' } },
      { status: 304, body: undefined, throwOnJson: true },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;

    const first = await svc.getPullDetail('TOK', pd);
    const second = await svc.getPullDetail('TOK', pd);
    expect(second).toEqual(first);
    expect(second.mergeableState).toBe('clean');
    expect(second.headSha).toBe('abc123');
  });

  it('a 403 with x-ratelimit-remaining:0 trips isRateLimited and short-circuits the next call', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 120);
    const { impl, calls } = fakeFetchWithHeaders([
      {
        status: 403,
        body: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
      },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;

    await expect(svc.getPullDetail('TOK', pd)).rejects.toThrow();
    expect(svc.isRateLimited()).toBe(true);

    const before = calls.length;
    // No cache entry exists → a subsequent poll GET throws RateLimitedError without fetching.
    await expect(svc.getPullState('TOK', pd)).rejects.toBeInstanceOf(RateLimitedError);
    expect(calls.length).toBe(before);
  });

  it('serves the cache while rate-limited when an entry exists (no extra fetch)', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 120);
    const { impl, calls } = fakeFetchWithHeaders([
      { status: 200, body: pullDetailBody, headers: { etag: 'W/"v1"' } },
      {
        status: 403,
        body: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
      },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;

    await svc.getPullDetail('TOK', pd); // 200 → cache stored
    await expect(
      svc.listCheckRuns('TOK', { owner: 'acme', repo: 'app', ref: 'x' }),
    ).rejects.toThrow(); // 403 → trips rate limit
    expect(svc.isRateLimited()).toBe(true);

    const before = calls.length;
    const cached = await svc.getPullDetail('TOK', pd); // served from cache, no fetch
    expect(cached.mergeableState).toBe('clean');
    expect(calls.length).toBe(before);
  });

  it('pauses future REST calls when a successful response consumes the last remaining request', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 120);
    const { impl, calls } = fakeFetchWithHeaders([
      {
        status: 200,
        body: pullDetailBody,
        headers: {
          etag: 'W/"v1"',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': reset,
        },
      },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;

    await svc.getPullDetail('TOK', pd);
    expect(svc.isRateLimited()).toBe(true);

    const before = calls.length;
    const cached = await svc.getPullState('TOK', pd);
    expect(cached).toBe('open');
    expect(calls.length).toBe(before);
  });

  it('a 403 secondary-rate-limit message (no headers) also trips isRateLimited', async () => {
    const { impl } = fakeFetchWithHeaders([
      {
        status: 403,
        body: {
          message: 'You have exceeded a secondary rate limit. Please wait...',
        },
      },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;

    await expect(svc.getPullDetail('TOK', pd)).rejects.toThrow();
    expect(svc.isRateLimited()).toBe(true);
  });

  it('a 403 permission error does NOT trip isRateLimited and still throws', async () => {
    const { impl } = fakeFetchWithHeaders([
      {
        status: 403,
        body: { message: 'Resource not accessible by integration' },
      },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;

    await expect(svc.getPullDetail('TOK', pd)).rejects.toThrow(/403/);
    expect(svc.isRateLimited()).toBe(false);
  });
});

describe('GithubPrService.listOpenPullMergeability', () => {
  it('parses and maps GraphQL nodes across two paginated pages', async () => {
    const { impl, calls } = fakeFetchWithHeaders([
      {
        status: 200,
        body: {
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  { number: 1, mergeStateStatus: 'CLEAN', headRefOid: 'sha1' },
                  { number: 2, mergeStateStatus: 'DIRTY', headRefOid: 'sha2' },
                ],
                pageInfo: { endCursor: 'CUR', hasNextPage: true },
              },
            },
          },
        },
      },
      {
        status: 200,
        body: {
          data: {
            repository: {
              pullRequests: {
                nodes: [{ number: 3, mergeStateStatus: 'BLOCKED', headRefOid: null }],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        },
      },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;

    const result = await svc.listOpenPullMergeability('TOK', {
      owner: 'acme',
      repo: 'app',
      base: 'main',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://api.github.com/graphql');
    expect(result).toEqual([
      {
        number: 1,
        mergeStateStatus: 'CLEAN',
        mergeableState: 'clean',
        headSha: 'sha1',
      },
      {
        number: 2,
        mergeStateStatus: 'DIRTY',
        mergeableState: 'dirty',
        headSha: 'sha2',
      },
      {
        number: 3,
        mergeStateStatus: 'BLOCKED',
        mergeableState: 'blocked',
        headSha: null,
      },
    ]);
    // Second request carries the endCursor from page one.
    expect(String(calls[1].init?.body)).toContain('CUR');
  });

  it('a GraphQL 403 rate limit trips isGraphqlRateLimited but not REST isRateLimited', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 120);
    const { impl } = fakeFetchWithHeaders([
      {
        status: 403,
        body: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
      },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;

    await expect(
      svc.listOpenPullMergeability('TOK', {
        owner: 'acme',
        repo: 'app',
        base: 'main',
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(svc.isGraphqlRateLimited()).toBe(true);
    expect(svc.isRateLimited()).toBe(false);
  });

  it('returns a successful GraphQL page that consumes the last point, then pauses future GraphQL calls', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 120);
    const { impl, calls } = fakeFetchWithHeaders([
      {
        status: 200,
        body: {
          data: {
            repository: {
              pullRequests: {
                nodes: [{ number: 1, mergeStateStatus: 'CLEAN', headRefOid: 'sha1' }],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        },
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': reset,
        },
      },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;

    const result = await svc.listOpenPullMergeability('TOK', {
      owner: 'acme',
      repo: 'app',
      base: 'main',
    });
    expect(result).toEqual([
      {
        number: 1,
        mergeStateStatus: 'CLEAN',
        mergeableState: 'clean',
        headSha: 'sha1',
      },
    ]);
    expect(svc.isGraphqlRateLimited()).toBe(true);

    const before = calls.length;
    await expect(
      svc.listOpenPullMergeability('TOK', {
        owner: 'acme',
        repo: 'app',
        base: 'main',
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(calls.length).toBe(before);
  });

  it('does not fetch the next GraphQL page after a successful page consumes the last point', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 120);
    const { impl, calls } = fakeFetchWithHeaders([
      {
        status: 200,
        body: {
          data: {
            repository: {
              pullRequests: {
                nodes: [{ number: 1, mergeStateStatus: 'CLEAN', headRefOid: 'sha1' }],
                pageInfo: { endCursor: 'CUR', hasNextPage: true },
              },
            },
          },
        },
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': reset,
        },
      },
      {
        status: 200,
        body: {
          data: {
            repository: {
              pullRequests: {
                nodes: [{ number: 2, mergeStateStatus: 'DIRTY', headRefOid: 'sha2' }],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        },
      },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;

    await expect(
      svc.listOpenPullMergeability('TOK', {
        owner: 'acme',
        repo: 'app',
        base: 'main',
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(calls).toHaveLength(1);
    expect(svc.isGraphqlRateLimited()).toBe(true);
  });
});

describe('mapMergeStateStatus', () => {
  it('maps GraphQL statuses to the lowercase mergeable_state vocabulary', () => {
    expect(mapMergeStateStatus('CLEAN')).toBe('clean');
    expect(mapMergeStateStatus('DIRTY')).toBe('dirty');
    expect(mapMergeStateStatus('BEHIND')).toBe('behind');
    expect(mapMergeStateStatus('BLOCKED')).toBe('blocked');
    expect(mapMergeStateStatus('UNSTABLE')).toBe('unstable');
    expect(mapMergeStateStatus('HAS_HOOKS')).toBe('has_hooks');
    expect(mapMergeStateStatus('DRAFT')).toBe('draft');
    expect(mapMergeStateStatus('UNKNOWN')).toBe('unknown');
    expect(mapMergeStateStatus(null)).toBe('unknown');
    expect(mapMergeStateStatus(undefined)).toBe('unknown');
    expect(mapMergeStateStatus('something-else')).toBe('unknown');
  });
});
