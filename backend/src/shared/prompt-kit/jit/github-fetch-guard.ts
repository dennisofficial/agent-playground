
export const FETCH_TOOL_MATCHER = 'WebFetch|mcp__fetch__.*';

export function detectGithubHtmlUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === 'github.com' || host === 'www.github.com') return 'github.com';
  if (host === 'gist.github.com') return 'gist.github.com';
  return null;
}

export const GITHUB_FETCH_TEXT =
  "GitHub's web UI is a client-rendered app, so fetching the page returns navigation chrome and feature-flag " +
  'JSON, NOT the file/issue/PR content you wanted. Use the authenticated tooling baked into the sandbox ' +
  'instead: for file contents, `gh api repos/OWNER/REPO/contents/PATH?ref=REF` or ' +
  '`https://raw.githubusercontent.com/OWNER/REPO/REF/PATH`; to read a whole repo or directory, ' +
  '`git clone --depth 1 <repo>` and read the files; for pull requests, issues, and discussions, ' +
  '`gh pr view` / `gh issue view` / `gh api`. These return the real content, not the rendered page.';

export function renderGithubFetchNudge(url: string): string {
  const shown = url.length > 160 ? `${url.slice(0, 157)}…` : url;
  return `[github-fetch reminder] You just fetched a GitHub web page (\`${shown}\`) — ${GITHUB_FETCH_TEXT}`;
}
