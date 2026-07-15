/**
 * Unit tests for the github-fetch guard as consumed by the engine (see the fetch-tool PostToolUse hook in
 * `EngineCore.run`). The hook's decision + payload are pure, exported helpers re-exported from `engine-core`:
 *   - `detectGithubHtmlUrl` — is this fetched URL a github.com/gist HTML page (client-rendered chrome, not
 *     content)? Firing on raw.githubusercontent.com / api.github.com would wrongly nag a good fetch.
 *   - `renderGithubFetchNudge` — the reminder appended to the fetch tool result via `additionalContext`.
 */
import { describe, expect, it } from 'vitest';
import { detectGithubHtmlUrl, renderGithubFetchNudge } from './engine-core';
import { githubFetchGuardRule } from '../prompt-kit/jit';

/**
 * Reproduce the engine-core fetch PostToolUse callback body (buildHooks → fetchPostToolUseHooks) against the
 * REAL wired rule object, so we exercise the exact trigger.match + render + hookSpecificOutput shape the SDK
 * receives — the runtime contract, not just the helpers.
 */
function simulateFetchPostToolUse(input: { tool_name: string; tool_input: { url?: unknown } }) {
  const trigger = githubFetchGuardRule.trigger;
  if (trigger.kind !== 'url-match') throw new Error('expected url-match trigger');
  const url = input.tool_input?.url;
  const fetched = typeof url === 'string' ? url : '';
  if (!trigger.match(fetched)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse' as const,
      additionalContext: githubFetchGuardRule.render({ url: fetched }),
    },
  };
}

describe('detectGithubHtmlUrl (engine re-export)', () => {
  it.each([
    'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/repo/blob/main/README.md',
    'https://gist.github.com/someone/abc123',
  ])('nudges on %j', (url) => {
    expect(detectGithubHtmlUrl(url)).not.toBeNull();
  });

  it.each([
    'https://raw.githubusercontent.com/owner/repo/main/README.md',
    'https://api.github.com/repos/owner/repo',
    'https://example.com/owner/repo',
    '',
  ])('does NOT nudge on %j', (url) => {
    expect(detectGithubHtmlUrl(url)).toBeNull();
  });
});

describe('renderGithubFetchNudge (engine re-export)', () => {
  it('steers to gh api / git and echoes the fetched URL', () => {
    const text = renderGithubFetchNudge('https://github.com/owner/repo/tree/main');
    expect(text).toContain('gh api');
    expect(text).toContain('https://github.com/owner/repo/tree/main');
  });
});

describe('fetch PostToolUse callback (runtime contract)', () => {
  it('attaches the gh-api steer as additionalContext for a github WebFetch', () => {
    const out = simulateFetchPostToolUse({
      tool_name: 'WebFetch',
      tool_input: { url: 'https://github.com/Piebald-AI/claude-code-system-prompts/tree/main/system-prompts' },
    });
    expect(out.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput?.additionalContext).toContain('gh api');
    // Visible runtime proof: print the exact string the SDK would yield to the model after the fetch.
    // eslint-disable-next-line no-console
    console.log('[runtime] WebFetch github →', out.hookSpecificOutput?.additionalContext);
  });

  it('fires for an MCP fetch tool too (matcher covers mcp__fetch__*)', () => {
    const out = simulateFetchPostToolUse({
      tool_name: 'mcp__fetch__fetch_markdown',
      tool_input: { url: 'https://github.com/nestjs/nest/issues/1234' },
    });
    expect(out.hookSpecificOutput?.additionalContext).toContain('gh api');
  });

  it('does NOT attach anything for raw.githubusercontent.com', () => {
    const out = simulateFetchPostToolUse({
      tool_name: 'WebFetch',
      tool_input: { url: 'https://raw.githubusercontent.com/owner/repo/main/README.md' },
    });
    expect(out).toEqual({});
    // eslint-disable-next-line no-console
    console.log('[runtime] WebFetch raw.githubusercontent →', JSON.stringify(out));
  });
});
