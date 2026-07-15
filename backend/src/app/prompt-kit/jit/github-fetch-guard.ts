/**
 * prompt-kit / jit — the github.com fetch guard (content for the `github-fetch-guard` JIT rule).
 *
 * GitHub's web UI (repo/tree/blob/issue/PR/discussion/gist pages) is a client-rendered React app: a plain page
 * fetch — the native `WebFetch` or an MCP `fetch` tool — comes back as navigation chrome and feature-flag JSON,
 * NOT the file/issue/PR content the agent actually wanted. So when a fetch tool pulls a github.com HTML page,
 * append a reminder pointing it at the authenticated `gh`/git tooling that IS baked into the sandbox. Mirrors
 * `svc-nudge.ts`: a pure matcher + a pure render fn; the engine owns the PostToolUse delivery wiring.
 */

/**
 * The SDK `PostToolUse` matcher for every URL-fetch tool this guard watches: the native `WebFetch` plus every
 * tool exposed by the `fetch` MCP server (`mcp__fetch__fetch_html` / `_markdown` / `_readable` / …). The `.*`
 * is load-bearing — a matcher of only exact-match characters is compared as an exact string and would match no
 * MCP tool, so `mcp__fetch__.*` (a regex) is required to reach the whole server (Claude Code hook-matcher rules).
 */
export const FETCH_TOOL_MATCHER = 'WebFetch|mcp__fetch__.*';

/**
 * Does this URL point at a github.com HTML page whose content a plain fetch can't see? Returns a short host
 * label for a hit, or null. Fires only for the human-facing web UI hosts (`github.com`, `www.github.com`,
 * `gist.github.com`); deliberately does NOT fire for the hosts that already return real content/data —
 * `raw.githubusercontent.com` (raw file bytes), `api.github.com` (the REST/JSON API), `codeload.github.com`
 * (archive downloads), `objects.githubusercontent.com` (release/LFS assets). Unparseable input → null.
 */
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

/** The github-fetch reminder appended to a matching fetch tool result via PostToolUse `additionalContext`. */
export function renderGithubFetchNudge(url: string): string {
  const shown = url.length > 160 ? `${url.slice(0, 157)}…` : url;
  return `[github-fetch reminder] You just fetched a GitHub web page (\`${shown}\`) — ${GITHUB_FETCH_TEXT}`;
}
