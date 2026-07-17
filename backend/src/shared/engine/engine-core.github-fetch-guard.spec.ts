import { describe, expect, it } from 'vitest';
import { githubFetchGuardRule } from '../prompt-kit/jit';
import { detectGithubHtmlUrl, renderGithubFetchNudge } from './engine-core';

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
      tool_input: {
        url: 'https://github.com/Piebald-AI/claude-code-system-prompts/tree/main/system-prompts',
      },
    });
    expect(out.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput?.additionalContext).toContain('gh api');
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
      tool_input: {
        url: 'https://raw.githubusercontent.com/owner/repo/main/README.md',
      },
    });
    expect(out).toEqual({});
    console.log('[runtime] WebFetch raw.githubusercontent →', JSON.stringify(out));
  });
});
