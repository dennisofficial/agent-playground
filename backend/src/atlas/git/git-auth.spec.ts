import { describe, expect, it } from 'vitest';
import { gitAuthEnv, isHttpsGithub, parseGithubRepo, sameGitUrl } from './git-auth';

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

  it('returns {} for non-https remotes (file://, ssh) and when no token', () => {
    expect(gitAuthEnv('file:///tmp/origin.git', 'tok')).toEqual({});
    expect(gitAuthEnv('git@github.com:acme/app.git', 'tok')).toEqual({});
    expect(gitAuthEnv('https://github.com/acme/app', undefined)).toEqual({});
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
