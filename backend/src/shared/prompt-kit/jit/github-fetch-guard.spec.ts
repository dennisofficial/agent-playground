/**
 * Unit tests for the github-fetch guard (content for the `github-fetch-guard` JIT rule). Two pure helpers:
 *   - `detectGithubHtmlUrl` — is this a github.com/gist HTML page (client-rendered chrome, not content)? It
 *     must fire for the web-UI hosts and must NOT fire for the hosts that already return real content/data
 *     (raw.githubusercontent.com, api.github.com, …) — a false positive would wrongly nag a good fetch.
 *   - `renderGithubFetchNudge` — the reminder text steering to `gh api`/git.
 */
import { describe, expect, it } from 'vitest';
import {
  detectGithubHtmlUrl,
  renderGithubFetchNudge,
  FETCH_TOOL_MATCHER,
} from './github-fetch-guard';

describe('detectGithubHtmlUrl', () => {
  // github.com / gist HTML pages → SHOULD nudge.
  it.each([
    'https://github.com/Piebald-AI/claude-code-system-prompts/tree/main/system-prompts',
    'https://github.com/anthropics/anthropic-sdk-typescript/blob/main/README.md',
    'https://github.com/nestjs/nest/issues/1234',
    'https://github.com/nestjs/nest/pull/5678',
    'https://github.com/orgs/anthropics/discussions/9',
    'https://www.github.com/foo/bar',
    'https://gist.github.com/someone/abc123',
    'https://github.com/owner/repo',
  ])('nudges on %j', (url) => {
    expect(detectGithubHtmlUrl(url)).not.toBeNull();
  });

  // Hosts that already return real content/data, other hosts, and garbage → must NOT nudge.
  it.each([
    'https://raw.githubusercontent.com/owner/repo/main/README.md',
    'https://api.github.com/repos/owner/repo/contents/path',
    'https://codeload.github.com/owner/repo/tar.gz/main',
    'https://objects.githubusercontent.com/github-production-release-asset/x',
    'https://github.io/some-pages-site',
    'https://mygithub.com.evil.example/owner/repo',
    'https://example.com/github.com/owner/repo',
    'https://developer.mozilla.org/en-US/docs/Web',
    'not a url',
    '',
  ])('does NOT nudge on %j', (url) => {
    expect(detectGithubHtmlUrl(url)).toBeNull();
  });
});

describe('renderGithubFetchNudge', () => {
  it('names the fetched URL and steers to gh api / git / raw', () => {
    const text = renderGithubFetchNudge(
      'https://github.com/owner/repo/tree/main',
    );
    expect(text).toContain('https://github.com/owner/repo/tree/main');
    expect(text).toContain('gh api');
    expect(text).toContain('raw.githubusercontent.com');
    expect(text).toContain('git clone');
  });

  it('truncates an overlong URL so the reminder stays compact', () => {
    const long = `https://github.com/owner/repo/blob/main/${'x'.repeat(300)}`;
    expect(renderGithubFetchNudge(long)).toContain('…');
  });
});

describe('FETCH_TOOL_MATCHER', () => {
  it('is a regex that matches WebFetch and every fetch-MCP tool', () => {
    const re = new RegExp(FETCH_TOOL_MATCHER);
    expect(re.test('WebFetch')).toBe(true);
    expect(re.test('mcp__fetch__fetch_markdown')).toBe(true);
    expect(re.test('mcp__fetch__fetch_readable')).toBe(true);
    expect(re.test('Bash')).toBe(false);
    expect(re.test('WebSearch')).toBe(false);
  });
});
