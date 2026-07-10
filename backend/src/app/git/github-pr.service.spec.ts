import { describe, expect, it } from 'vitest';
import { GithubPrService, parseGithubRepoUrl } from './github-pr.service';

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
    const { impl } = fakeFetch([
      { status: 403, body: { message: 'Resource not accessible' } },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    await expect(svc.openPullRequest('SECRET', prArgs)).rejects.toThrow(
      /403.*Resource not accessible/,
    );
    await expect(svc.openPullRequest('SECRET', prArgs)).rejects.not.toThrow(
      /SECRET/,
    );
  });
});

describe('GithubPrService.closePullRequest', () => {
  it('PATCHes state=closed with the token only in the Authorization header', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { number: 9, state: 'closed' } }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    await svc.closePullRequest('TOK123', { owner: 'acme', repo: 'app', number: 9 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/app/pulls/9');
    expect(calls[0].init?.method).toBe('PATCH');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer TOK123');
    expect(String(calls[0].init?.body)).not.toContain('TOK123');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ state: 'closed' });
  });

  it('throws with GitHub status + detail (never the token) on a non-OK response', async () => {
    const { impl } = fakeFetch([
      { status: 403, body: { message: 'Resource not accessible' } },
    ]);
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
    expect(await svc.listBranches('T', 'acme', 'app')).toEqual([
      'main',
      'develop',
    ]);
    // A short first page (< 100) means no second request.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(
      '/repos/acme/app/branches?per_page=100&page=1',
    );
  });

  it('throws with the GitHub status (never the token) on a non-OK response', async () => {
    const { impl } = fakeFetch([
      { status: 403, body: { message: 'forbidden' } },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    await expect(svc.listBranches('TOK', 'acme', 'app')).rejects.toThrow(
      /403.*forbidden/,
    );
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
        body: [
          { id: 42, config: { url: 'https://api.example.com/ingress/github' } },
        ],
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
        body: [
          { id: 42, config: { url: 'https://api.example.com/ingress/github' } },
        ],
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
    const { impl } = fakeFetch([
      { status: 401, body: { message: 'Bad credentials' } },
    ]);
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
