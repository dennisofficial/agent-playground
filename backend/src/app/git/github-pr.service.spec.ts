import { describe, expect, it } from 'vitest';
import { GithubPrService, parseGithubRepoUrl } from './github-pr.service';

type Call = { url: string; init?: RequestInit };

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
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
      { status: 201, body: { html_url: 'https://github.com/acme/app/pull/9', number: 9 } },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    const res = await svc.openPullRequest('TOK123', prArgs);
    expect(res).toEqual({ url: 'https://github.com/acme/app/pull/9', number: 9, existing: false });
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
      { status: 422, body: { message: 'A pull request already exists for acme:atlas/gate-abcd.' } },
      { status: 200, body: [{ html_url: 'https://github.com/acme/app/pull/4', number: 4 }] },
    ]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    const res = await svc.openPullRequest('TOK', prArgs);
    expect(res).toEqual({ url: 'https://github.com/acme/app/pull/4', number: 4, existing: true });
  });

  it('throws with GitHub status + detail (never the token) on other errors', async () => {
    const { impl } = fakeFetch([{ status: 403, body: { message: 'Resource not accessible' } }]);
    const svc = new GithubPrService();
    svc.fetchImpl = impl;
    await expect(svc.openPullRequest('SECRET', prArgs)).rejects.toThrow(/403.*Resource not accessible/);
    await expect(svc.openPullRequest('SECRET', prArgs)).rejects.not.toThrow(/SECRET/);
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

describe('parseGithubRepoUrl', () => {
  it('parses owner/repo and drops .git; null on non-github', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/app.git')).toEqual({ owner: 'acme', repo: 'app' });
    expect(parseGithubRepoUrl('https://gitlab.com/a/b')).toBeNull();
  });
});
