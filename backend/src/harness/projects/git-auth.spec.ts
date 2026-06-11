import { gitAuthEnv, parseGithubRepo, sameGitUrl } from './git-auth';

describe('gitAuthEnv', () => {
  it('builds the GIT_CONFIG_* extraheader env for https github URLs', () => {
    const env = gitAuthEnv('https://github.com/dennis/repo.git', 'TOKEN123');
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    const expected = Buffer.from('x-access-token:TOKEN123').toString('base64');
    expect(env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${expected}`);
  });

  it('returns {} for non-github URLs (file:// fixtures, ssh) and missing tokens', () => {
    expect(gitAuthEnv('file:///tmp/origin.git', 'TOKEN')).toEqual({});
    expect(gitAuthEnv('git@github.com:dennis/repo.git', 'TOKEN')).toEqual({});
    expect(gitAuthEnv('https://github.com/dennis/repo.git', undefined)).toEqual(
      {},
    );
  });
});

describe('parseGithubRepo', () => {
  it('extracts owner/repo, tolerating .git and a trailing slash', () => {
    expect(parseGithubRepo('https://github.com/dennis/my-app.git')).toEqual({
      owner: 'dennis',
      repo: 'my-app',
    });
    expect(parseGithubRepo('https://github.com/org/repo')).toEqual({
      owner: 'org',
      repo: 'repo',
    });
    expect(parseGithubRepo('https://github.com/org/repo/')).toEqual({
      owner: 'org',
      repo: 'repo',
    });
  });

  it('rejects non-github and malformed URLs', () => {
    for (const bad of [
      'file:///tmp/x.git',
      'git@github.com:o/r.git',
      'https://gitlab.com/o/r',
      'https://github.com/only-owner',
    ]) {
      expect(() => parseGithubRepo(bad)).toThrow(
        /Not an HTTPS GitHub repo URL/,
      );
    }
  });
});

describe('sameGitUrl', () => {
  it('treats .git and trailing-slash variants as the same repo', () => {
    expect(
      sameGitUrl('https://github.com/o/r.git', 'https://github.com/o/r'),
    ).toBe(true);
    expect(
      sameGitUrl('https://github.com/o/r/', 'https://github.com/o/r'),
    ).toBe(true);
    expect(
      sameGitUrl('https://github.com/o/r', 'https://github.com/o/other'),
    ).toBe(false);
  });
});
