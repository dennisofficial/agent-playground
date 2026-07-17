export function isHttpsGithub(gitUrl: string): boolean {
  return gitUrl.startsWith('https://github.com/');
}

export function gitAuthEnv(gitUrl: string, token: string | undefined): Record<string, string> {
  if (!isHttpsGithub(gitUrl)) return {};
  if (!token) {
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

export function parseGithubRepo(gitUrl: string): {
  owner: string;
  repo: string;
} {
  const m = gitUrl.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`Not an HTTPS GitHub repo URL: ${gitUrl}`);
  return { owner: m[1], repo: m[2] };
}

export function sameGitUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/\.git$/, '').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
