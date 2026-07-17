/**
 * Per-invocation git auth for HTTPS GitHub remotes — pure helpers, no Nest. A clean-room rewrite of
 * v1's `projects/git-auth.ts`.
 *
 * The token rides in `GIT_CONFIG_*` environment variables (git ≥2.31), the env-var form of
 * `-c http.<prefix>.extraheader=…` (the actions/checkout pattern): it NEVER appears in process argv
 * (`ps`), in `.git/config`, or in the remote URL. Residual exposure is the child process env only —
 * the auth env is built per `execFile` invocation and discarded, never persisted.
 */

/** True for the only URL shape token auth applies to (https GitHub). file://, ssh get no auth env. */
export function isHttpsGithub(gitUrl: string): boolean {
  return gitUrl.startsWith('https://github.com/');
}

/**
 * Auth env for one git invocation against `gitUrl`, or {} when auth doesn't apply (non-GitHub / non-https).
 *
 * With a per-org token we thread it as an `http.extraheader` (never argv/.git/config). WITHOUT a token, we
 * do NOT return {} — instead we blank the credential-helper list (`credential.helper=`, an empty value
 * resets it), so a missing/expired org token can NEVER silently fall back to the host machine's ambient
 * GitHub credentials (a `gh auth login` session, an osxkeychain/store helper, cached creds). Atlas
 * authenticates with the per-org PAT ONLY: an unauthenticated PRIVATE-repo op then fails loudly (auth
 * required) instead of borrowing whatever the host box is logged into; a public-repo op still works (it
 * needs no credentials). `GIT_TERMINAL_PROMPT=0` (set by the caller) blocks interactive prompts; blanking
 * the helper closes the non-interactive cached-credential path too.
 */
export function gitAuthEnv(gitUrl: string, token: string | undefined): Record<string, string> {
  if (!isHttpsGithub(gitUrl)) return {};
  if (!token) {
    // No per-org token → disable all credential helpers so git can't reach host ambient GitHub creds.
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
    };
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/**
 * App-mode in-sandbox git auth: credentials come from a FILE the host refreshes mid-turn, NOT a baked-in
 * header. Sets a URL-SCOPED git `credential.helper` — `credential.https://github.com.helper` (UNQUOTED url
 * subsection: git splits `section.<subsection>.key` on the first and last dot, so the middle is the url).
 * VERIFIED BY SPIKE: git invokes this helper ONLY for https://github.com URLs — for any other host (e.g. a
 * `git fetch` from evil.com) the helper is NOT called, so the installation token can NEVER leak to a
 * non-GitHub remote. (An UNSCOPED `credential.helper` DID leak the token to evil.com in the spike — hence
 * the url scoping.) The `!`-prefixed shell helper `cat`s the token file on every `get`, so git/push/fetch
 * always reads the current token regardless of turn length.
 */
export function gitCredHelperEnv(gitUrl: string, tokenFilePath: string): Record<string, string> {
  if (!isHttpsGithub(gitUrl)) return {};
  const helper = `!f() { test "$1" = get && { echo username=x-access-token; echo "password=$(cat ${shQuote(tokenFilePath)})"; }; }; f`;
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: helper,
  };
}

/** Owner/repo from an HTTPS GitHub URL (`.git` suffix tolerated). Throws on anything else. */
export function parseGithubRepo(gitUrl: string): {
  owner: string;
  repo: string;
} {
  const m = gitUrl.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`Not an HTTPS GitHub repo URL: ${gitUrl}`);
  return { owner: m[1], repo: m[2] };
}

/** Compare two repo URLs, tolerating a trailing `.git` / slash. */
export function sameGitUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/\.git$/, '').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
