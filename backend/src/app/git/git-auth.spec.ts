import { describe, expect, it } from 'vitest';
import { gitAuthEnv, gitCredHelperEnv, isHttpsGithub, parseGithubRepo, sameGitUrl } from './git-auth';

describe('gitAuthEnv (token never in argv / config)', () => {
  it('encodes the token as an http.extraheader GIT_CONFIG_* env var', () => {
    const env = gitAuthEnv('https://github.com/acme/app.git', 'ghp_secret');
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    const expected = Buffer.from('x-access-token:ghp_secret').toString('base64');
    expect(env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${expected}`);
  });

  it('does NOT place the raw token anywhere in the env values (only base64 header)', () => {
    const env = gitAuthEnv('https://github.com/acme/app', 'ghp_rawtoken');
    const joined = Object.values(env).join('\n');
    expect(joined).not.toContain('ghp_rawtoken');
  });

  it('returns {} for non-https remotes (file://, ssh) — auth never applies there', () => {
    expect(gitAuthEnv('file:///tmp/origin.git', 'tok')).toEqual({});
    expect(gitAuthEnv('git@github.com:acme/app.git', 'tok')).toEqual({});
  });

  it('with NO token on https github, blanks the credential helper (no host ambient-credential fallback)', () => {
    const env = gitAuthEnv('https://github.com/acme/app', undefined);
    // Not {} — an empty credential.helper resets the helper list so git can't reach host creds.
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    // And it carries no auth header / token.
    expect(Object.values(env).join('\n')).not.toContain('extraheader');
  });

  it('isHttpsGithub only matches https github', () => {
    expect(isHttpsGithub('https://github.com/a/b')).toBe(true);
    expect(isHttpsGithub('https://gitlab.com/a/b')).toBe(false);
  });

  it('parseGithubRepo tolerates a .git suffix and throws on non-github', () => {
    expect(parseGithubRepo('https://github.com/acme/app.git')).toEqual({ owner: 'acme', repo: 'app' });
    expect(() => parseGithubRepo('https://gitlab.com/a/b')).toThrow();
  });

  it('sameGitUrl tolerates trailing .git / slash', () => {
    expect(sameGitUrl('https://github.com/a/b.git', 'https://github.com/a/b/')).toBe(true);
  });
});

describe('gitCredHelperEnv (file-backed, url-scoped)', () => {
  it('sets a url-scoped credential helper that cats the token file on every git invocation', () => {
    const env = gitCredHelperEnv('https://github.com/acme/app.git', '/.atlas/github-token');
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_1).toContain("cat '/.atlas/github-token'");
    expect(env.GIT_CONFIG_VALUE_1).toContain('username=x-access-token');
  });

  it('returns {} for non-github urls — the helper never scopes to a non-GitHub remote', () => {
    expect(gitCredHelperEnv('file:///tmp/x.git', '/.atlas/github-token')).toEqual({});
    expect(gitCredHelperEnv('git@github.com:acme/app.git', '/.atlas/github-token')).toEqual({});
  });
});
