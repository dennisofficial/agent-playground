import { describe, expect, it } from 'vitest';
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
