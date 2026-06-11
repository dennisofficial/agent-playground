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
