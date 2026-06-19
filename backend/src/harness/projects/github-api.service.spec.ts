import { GithubApiService } from './github-api.service';

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

const args = {
  owner: 'dennis',
  repo: 'app',
  head: 'shared/payment-flow',
  base: 'main',
  title: 'Payment flow',
  body: 'three-employee feature',
};

describe('GithubApiService.openPullRequest', () => {
  it('creates a PR and sends the required headers', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 201,
        body: { html_url: 'https://github.com/dennis/app/pull/7', number: 7 },
      },
    ]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    const res = await api.openPullRequest('TOK', args);
    expect(res).toEqual({
      url: 'https://github.com/dennis/app/pull/7',
      number: 7,
      existing: false,
    });
    expect(calls[0].url).toBe('https://api.github.com/repos/dennis/app/pulls');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer TOK');
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(headers['User-Agent']).toBe('agent-playground');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      title: 'Payment flow',
      head: 'shared/payment-flow',
      base: 'main',
      body: 'three-employee feature',
    });
  });

  it('returns the existing open PR on 422 already-exists (idempotent)', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 422,
        body: {
          errors: [
            {
              message:
                'A pull request already exists for dennis:shared/payment-flow.',
            },
          ],
        },
      },
      {
        status: 200,
        body: [{ html_url: 'https://github.com/dennis/app/pull/3', number: 3 }],
      },
    ]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    const res = await api.openPullRequest('TOK', args);
    expect(res).toEqual({
      url: 'https://github.com/dennis/app/pull/3',
      number: 3,
      existing: true,
    });
    expect(calls[1].url).toContain('head=dennis%3Ashared%2Fpayment-flow');
    expect(calls[1].url).toContain('state=open');
  });

  it('surfaces other failures with status + GitHub message, never the token', async () => {
    const { impl } = fakeFetch([
      { status: 404, body: { message: 'Not Found' } },
    ]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    await expect(api.openPullRequest('SECRET_TOK', args)).rejects.toThrow(
      /GitHub refused the pull request \(404\): Not Found/,
    );
    await expect(api.openPullRequest('SECRET_TOK', args)).rejects.not.toThrow(
      /SECRET_TOK/,
    );
  });
});

describe('GithubApiService.listOpenPullRequests', () => {
  const listArgs = { owner: 'dennis', repo: 'app' };

  const fakePr = (n: number, draft = false) => ({
    number: n,
    title: `PR ${n}`,
    html_url: `https://github.com/dennis/app/pull/${n}`,
    user: { login: 'contributor' },
    head: { ref: `feature/${n}` },
    base: { ref: 'main' },
    draft,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  });

  it('maps the GitHub response to PullRequestSummary objects and sends required headers', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: [fakePr(7), fakePr(3, true)] },
    ]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    const res = await api.listOpenPullRequests('TOK', listArgs);
    expect(res).toHaveLength(2);
    expect(res[0]).toEqual({
      number: 7,
      title: 'PR 7',
      url: 'https://github.com/dennis/app/pull/7',
      author: 'contributor',
      headBranch: 'feature/7',
      baseBranch: 'main',
      draft: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });
    expect(res[1].draft).toBe(true);
    expect(calls[0].url).toContain(
      'https://api.github.com/repos/dennis/app/pulls',
    );
    expect(calls[0].url).toContain('state=open');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer TOK');
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(headers['User-Agent']).toBe('agent-playground');
  });

  it('returns an empty array when the repo has no open PRs', async () => {
    const { impl } = fakeFetch([{ status: 200, body: [] }]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    expect(await api.listOpenPullRequests('TOK', listArgs)).toEqual([]);
  });

  it('surfaces failures with status + GitHub message, never the token', async () => {
    const { impl } = fakeFetch([
      { status: 403, body: { message: 'Must have push access' } },
    ]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    await expect(
      api.listOpenPullRequests('SECRET_TOK', listArgs),
    ).rejects.toThrow(
      /GitHub refused the pull request list \(403\): Must have push access/,
    );
    await expect(
      api.listOpenPullRequests('SECRET_TOK', listArgs),
    ).rejects.not.toThrow(/SECRET_TOK/);
  });
});

describe('GithubApiService.updatePullRequest', () => {
  it('PATCHes the PR with title + body', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { number: 7 } }]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    await api.updatePullRequest('TOK', {
      owner: 'dennis',
      repo: 'app',
      number: 7,
      title: 'payment-flow',
      body: '#7 A — x\n\n#8 B — y',
    });
    expect(calls[0].url).toBe('https://api.github.com/repos/dennis/app/pulls/7');
    expect(calls[0].init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      title: 'payment-flow',
      body: '#7 A — x\n\n#8 B — y',
    });
  });

  it('throws a token-free error on failure', async () => {
    const { impl } = fakeFetch([{ status: 403, body: { message: 'no access' } }]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    await expect(
      api.updatePullRequest('SECRET_TOK', {
        owner: 'dennis',
        repo: 'app',
        number: 7,
        title: 'x',
      }),
    ).rejects.toThrow(/GitHub refused the PR update \(403\): no access/);
    await expect(
      api.updatePullRequest('SECRET_TOK', {
        owner: 'dennis',
        repo: 'app',
        number: 7,
        title: 'x',
      }),
    ).rejects.not.toThrow(/SECRET_TOK/);
  });
});

describe('GithubApiService.commentOnPullRequest', () => {
  it('posts to the issues/comments endpoint with the body', async () => {
    const { impl, calls } = fakeFetch([{ status: 201, body: { id: 1 } }]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    await api.commentOnPullRequest('TOK', {
      owner: 'dennis',
      repo: 'app',
      number: 7,
      body: 'integration findings',
    });
    expect(calls[0].url).toBe(
      'https://api.github.com/repos/dennis/app/issues/7/comments',
    );
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      body: 'integration findings',
    });
  });

  it('throws a token-free error on failure', async () => {
    const { impl } = fakeFetch([
      { status: 403, body: { message: 'no access' } },
    ]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    await expect(
      api.commentOnPullRequest('SECRET_TOK', {
        owner: 'dennis',
        repo: 'app',
        number: 7,
        body: 'x',
      }),
    ).rejects.toThrow(/GitHub refused the PR comment \(403\): no access/);
    await expect(
      api.commentOnPullRequest('SECRET_TOK', {
        owner: 'dennis',
        repo: 'app',
        number: 7,
        body: 'x',
      }),
    ).rejects.not.toThrow(/SECRET_TOK/);
  });
});

describe('GithubApiService.listBranches', () => {
  const listArgs = { owner: 'dennis', repo: 'app' };

  const fakeBranch = (name: string, isProtected = false) => ({
    name,
    protected: isProtected,
  });

  it('paginates and concatenates a full first page with a short second page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) =>
      fakeBranch(`b${i}`, i === 0),
    );
    const secondPage = [fakeBranch('b100'), fakeBranch('b101', true)];
    const { impl, calls } = fakeFetch([
      { status: 200, body: firstPage },
      { status: 200, body: secondPage },
    ]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    const res = await api.listBranches('TOK', listArgs);

    expect(res).toHaveLength(102);
    expect(res[0]).toEqual({ name: 'b0', protected: true });
    expect(res[101]).toEqual({ name: 'b101', protected: true });

    // Exactly two pages fetched (the short second page stops the loop).
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(
      'https://api.github.com/repos/dennis/app/branches?per_page=100&page=1',
    );
    expect(calls[1].url).toBe(
      'https://api.github.com/repos/dennis/app/branches?per_page=100&page=2',
    );
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer TOK');
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(headers['User-Agent']).toBe('agent-playground');
  });

  it('stops after a single short page', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: [fakeBranch('main', true), fakeBranch('dev')] },
    ]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    const res = await api.listBranches('TOK', listArgs);
    expect(res).toEqual([
      { name: 'main', protected: true },
      { name: 'dev', protected: false },
    ]);
    expect(calls).toHaveLength(1);
  });

  it('surfaces failures with status + GitHub message, never the token', async () => {
    const { impl } = fakeFetch([
      { status: 404, body: { message: 'Not Found' } },
    ]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    await expect(api.listBranches('SECRET_TOK', listArgs)).rejects.toThrow(
      /GitHub refused the branch list \(404\): Not Found/,
    );
    await expect(api.listBranches('SECRET_TOK', listArgs)).rejects.not.toThrow(
      /SECRET_TOK/,
    );
  });
});

describe('GithubApiService.pickAutoBase', () => {
  const repoArgs = { owner: 'dennis', repo: 'app' };

  it('returns dev when dev exists (first candidate wins)', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { name: 'dev' } }]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    const res = await api.pickAutoBase('TOK', repoArgs, 'main');
    expect(res).toBe('dev');
    // Only one probe — dev short-circuits.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://api.github.com/repos/dennis/app/branches/dev',
    );
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer TOK');
  });

  it('falls through dev/develop to staging when only staging exists', async () => {
    const { impl, calls } = fakeFetch([
      { status: 404, body: { message: 'Branch not found' } },
      { status: 404, body: { message: 'Branch not found' } },
      { status: 200, body: { name: 'staging' } },
    ]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    const res = await api.pickAutoBase('TOK', repoArgs, 'main');
    expect(res).toBe('staging');
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe(
      'https://api.github.com/repos/dennis/app/branches/dev',
    );
    expect(calls[1].url).toBe(
      'https://api.github.com/repos/dennis/app/branches/develop',
    );
    expect(calls[2].url).toBe(
      'https://api.github.com/repos/dennis/app/branches/staging',
    );
  });

  it('falls back to projectDefault when no candidate exists', async () => {
    const { impl, calls } = fakeFetch([
      { status: 404, body: { message: 'Branch not found' } },
    ]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    const res = await api.pickAutoBase('TOK', repoArgs, 'main');
    expect(res).toBe('main');
    // All three candidates probed, then fallback.
    expect(calls).toHaveLength(3);
  });

  it('surfaces non-404 probe failures with status + message, never the token', async () => {
    const { impl } = fakeFetch([
      { status: 403, body: { message: 'no access' } },
    ]);
    const api = new GithubApiService();
    api.fetchImpl = impl;
    await expect(
      api.pickAutoBase('SECRET_TOK', repoArgs, 'main'),
    ).rejects.toThrow(
      /GitHub couldn't probe branch dev on dennis\/app \(403\): no access/,
    );
    await expect(
      api.pickAutoBase('SECRET_TOK', repoArgs, 'main'),
    ).rejects.not.toThrow(/SECRET_TOK/);
  });
});
