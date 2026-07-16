import { describe, expect, it, vi } from 'vitest';
import type { JitInjectionRule } from '@workspace/agent-engine';
import {
  buildClaudeOptions,
  type BuildClaudeOptionsParams,
} from './claude-options-builder';
import {
  PLAN_TOOLS,
  REVIEW_TOOLS,
  WORKER_TOOLS,
  WRITER_SUBAGENTS,
} from './agents-registry';
import type { EngineHomeKey } from '../engine-home';
import type { RunEngineArgs } from '../engine.types';
import { agentMessage } from '../../prompt-kit/message';

const KEY: EngineHomeKey = {
  orgId: 'acme',
  repoId: 'atlas',
  jobId: 'feat',
  type: 'build',
};

function build(
  mode: RunEngineArgs['mode'] = 'execute',
  over: Partial<BuildClaudeOptionsParams> = {},
) {
  const args: RunEngineArgs = {
    engine: 'claude',
    task: agentMessage('do it'),
    cwd: '/tmp/wt',
    systemPrompt: agentMessage('persona'),
    sandboxKey: KEY,
    mode,
  };
  const base: BuildClaudeOptionsParams = {
    cwd: '/tmp/wt',
    systemPrompt: args.systemPrompt,
    planMode: mode === 'plan',
    readOnly: mode !== 'execute',
    mode,
    args,
    claudeConfigDir: '/tmp/home/claude',
    skillsStoreRoot: undefined,
    subprocessEnv: { CLAUDE_CONFIG_DIR: '/tmp/home/claude' },
    abortController: new AbortController(),
    captureStderr: () => {},
    sandboxKey: KEY,
    setCapturedPlan: () => {},
    getContextTokens: () => undefined,
  };
  return buildClaudeOptions({ ...base, ...over });
}

describe('buildClaudeOptions', () => {
  it('execute turn: WORKER tools, default permission, writer subagents, 1M beta', () => {
    const o = build('execute', { sessionId: 'sess', model: 'claude-x' });
    expect(o.tools).toBe(WORKER_TOOLS);
    expect(o.permissionMode).toBe('default');
    // The writer subagents are only spawnable on an execute turn.
    for (const name of Object.keys(WRITER_SUBAGENTS))
      expect(o.agents).toHaveProperty(name);
    expect(o.betas).toContain('context-1m-2025-08-07');
    expect((o as { resume?: string }).resume).toBe('sess');
    expect(o.model).toBe('claude-x');
    expect(o.settingSources).toEqual(['user', 'project']);
  });

  it('plan turn: PLAN tools + plan permission mode', () => {
    const o = build('plan');
    expect(o.tools).toBe(PLAN_TOOLS);
    expect(o.permissionMode).toBe('plan');
  });

  it('review turn: REVIEW tools, no writer subagents', () => {
    const o = build('review');
    expect(o.tools).toBe(REVIEW_TOOLS);
    for (const name of Object.keys(WRITER_SUBAGENTS))
      expect(o.agents).not.toHaveProperty(name);
  });

  it('omits resume/model/hooks when absent; adds rich-stream fields when requested', () => {
    const plain = build();
    expect((plain as { resume?: string }).resume).toBeUndefined();
    expect(plain.model).toBeUndefined();
    expect((plain as { includePartialMessages?: boolean }).includePartialMessages).toBeUndefined();

    const rich = build('execute', { richStream: true });
    expect((rich as { includePartialMessages?: boolean }).includePartialMessages).toBe(true);
    expect((rich as { forwardSubagentText?: boolean }).forwardSubagentText).toBe(true);
  });

  it('spreads extraClaudeOptions verbatim (e.g. mcpServers)', () => {
    const mcpServers = { atlasbridge: {} };
    const o = build('execute', { extraClaudeOptions: { mcpServers } });
    expect((o as { mcpServers?: unknown }).mcpServers).toBe(mcpServers);
  });
});

/** Pulls a PostToolUse matcher group's callbacks out of the built `Options` (empty if none registered). */
function postToolUseHooks(
  o: ReturnType<typeof buildClaudeOptions>,
  matcher: string,
): Array<(input: unknown) => Promise<unknown>> {
  const hooks = (
    o as {
      hooks?: {
        PostToolUse?: Array<{
          matcher: string;
          hooks: Array<(input: unknown) => Promise<unknown>>;
        }>;
      };
    }
  ).hooks;
  return (
    hooks?.PostToolUse?.find((g) => g.matcher === matcher)?.hooks ?? []
  );
}

describe('onJitInjection (decision d6)', () => {
  it('svc-nudge: fires once with the tool_use_id echoed, iff postToolUseContext produces additionalContext', async () => {
    const onJitInjection =
      vi.fn<(inj: { toolUseId: string; rule: JitInjectionRule; text: string }) => void>();
    const o = build('execute', {
      hooks: { postToolUseContext: () => 'nudge this' },
      onJitInjection,
    });
    const [hook] = postToolUseHooks(o, 'Bash');
    const out = await hook({
      tool_use_id: 'tu_1',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm dev' },
    });
    expect(
      (out as { hookSpecificOutput?: { additionalContext?: string } })
        .hookSpecificOutput?.additionalContext,
    ).toBe('nudge this');
    expect(onJitInjection).toHaveBeenCalledTimes(1);
    expect(onJitInjection).toHaveBeenCalledWith({
      toolUseId: 'tu_1',
      rule: 'svc-nudge',
      text: 'nudge this',
    });
  });

  it('svc-nudge: NOT called when postToolUseContext returns null (no additionalContext delivered)', async () => {
    const onJitInjection = vi.fn();
    const o = build('execute', {
      hooks: { postToolUseContext: () => null },
      onJitInjection,
    });
    const [hook] = postToolUseHooks(o, 'Bash');
    const out = await hook({
      tool_use_id: 'tu_1',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(out).toEqual({});
    expect(onJitInjection).not.toHaveBeenCalled();
  });

  it('install-awareness: fires once with the tool_use_id echoed, iff the bridge resolves text', async () => {
    const onJitInjection = vi.fn();
    const o = build('execute', {
      bridgeCall: vi.fn(async () => 'install-nudge'),
      onJitInjection,
    });
    const [hook] = postToolUseHooks(o, 'Bash');
    const out = await hook({
      tool_use_id: 'tu_2',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm add eslint' },
    });
    expect(
      (out as { hookSpecificOutput?: { additionalContext?: string } })
        .hookSpecificOutput?.additionalContext,
    ).toBe('install-nudge');
    expect(onJitInjection).toHaveBeenCalledTimes(1);
    expect(onJitInjection).toHaveBeenCalledWith({
      toolUseId: 'tu_2',
      rule: 'install-awareness',
      text: 'install-nudge',
    });
  });

  it('install-awareness: NOT called on a non-install command (guard returns {})', async () => {
    const onJitInjection = vi.fn();
    const o = build('execute', {
      bridgeCall: vi.fn(async () => 'install-nudge'),
      onJitInjection,
    });
    const [hook] = postToolUseHooks(o, 'Bash');
    const out = await hook({
      tool_use_id: 'tu_2',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    });
    expect(out).toEqual({});
    expect(onJitInjection).not.toHaveBeenCalled();
  });

  it('github-fetch-guard: fires once with the tool_use_id echoed, for a github.com HTML fetch', async () => {
    const onJitInjection = vi.fn();
    const o = build('execute', { onJitInjection });
    const [hook] = postToolUseHooks(o, 'WebFetch|mcp__fetch__.*');
    const out = await hook({
      tool_use_id: 'tu_3',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://github.com/owner/repo/tree/main' },
    });
    const additionalContext = (
      out as { hookSpecificOutput?: { additionalContext?: string } }
    ).hookSpecificOutput?.additionalContext;
    expect(additionalContext).toContain('gh api');
    expect(onJitInjection).toHaveBeenCalledTimes(1);
    expect(onJitInjection).toHaveBeenCalledWith({
      toolUseId: 'tu_3',
      rule: 'github-fetch-guard',
      text: additionalContext,
    });
  });

  it('github-fetch-guard: NOT called for a non-github fetch (guard returns {})', async () => {
    const onJitInjection = vi.fn();
    const o = build('execute', { onJitInjection });
    const [hook] = postToolUseHooks(o, 'WebFetch|mcp__fetch__.*');
    const out = await hook({
      tool_use_id: 'tu_3',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://raw.githubusercontent.com/owner/repo/main/README.md' },
    });
    expect(out).toEqual({});
    expect(onJitInjection).not.toHaveBeenCalled();
  });
});
