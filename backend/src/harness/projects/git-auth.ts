/**
 * Per-invocation git auth for HTTPS GitHub remotes — pure helpers, no Nest.
 *
 * The token rides in `GIT_CONFIG_*` environment variables (git ≥2.31), the env-var form of
 * `-c http.<prefix>.extraheader=…` (the actions/checkout pattern): it never appears in process
 * argv (`ps`), in `.git/config`, or in the remote URL. Residual exposure is the child process
 * environment only.
 */

/** True for the only URL shape token auth applies to. Everything else (file:// fixtures, ssh) gets
 * no auth env. */
const isHttpsGithub = (gitUrl: string): boolean =>
  gitUrl.startsWith('https://github.com/');

/** Auth env for one git invocation against `gitUrl`, or {} when auth doesn't apply. */
export function gitAuthEnv(
  gitUrl: string,
  token: string | undefined,
): Record<string, string> {
  if (!token || !isHttpsGithub(gitUrl)) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/** Owner/repo from an HTTPS GitHub URL (`.git` suffix tolerated). Throws on anything else. */
export function parseGithubRepo(gitUrl: string): {
  owner: string;
  repo: string;
} {
  const m = gitUrl.match(
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  );
  if (!m) {
    throw new Error(`Not an HTTPS GitHub repo URL: ${gitUrl}`);
  }
  return { owner: m[1], repo: m[2] };
}

/** Compare a repo origin URL with a registered URL, tolerating a trailing `.git`/slash. */
export function sameGitUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/\.git$/, '').replace(/\/+$/, '');
  return norm(a) === norm(b);
}
