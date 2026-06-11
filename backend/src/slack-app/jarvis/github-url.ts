/** Mirrors the admin API edge (api/admin/dto/project.dto.ts) — HTTPS GitHub only, token auth
 * doesn't work over ssh, and the worktree layer validates the same. */
const GITHUB_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+?(\.git)?$/;

/**
 * Pull a GitHub repo URL out of free-form Slack message text. Jarvis reads RAW event text (it
 * runs before the surface's mrkdwn translation), so URLs usually arrive auto-linked as
 * `<https://github.com/o/r>` or `<url|label>` — unwrap, trim trailing punctuation, validate
 * full-string. Returns undefined when no valid repo URL is present.
 */
export function extractGithubUrl(text: string): string | undefined {
  const match = /https:\/\/github\.com\/[^\s<>|]+/.exec(text);
  if (!match) return undefined;
  const candidate = match[0].replace(/[>.,;:!?)\]]+$/, '');
  return GITHUB_URL.test(candidate) ? candidate : undefined;
}
