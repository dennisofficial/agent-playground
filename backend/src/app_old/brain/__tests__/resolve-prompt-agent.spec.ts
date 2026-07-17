import type { Message, TurnEnvelope } from '@shared/domain';
import { Agent } from '@shared/prompt-kit/system';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadRole } from '../../thread-kind/__tests__/spec';
import { AgentSessionManager } from '../agent-session-manager.service';

const JOB_ID = 'th-agent-001';

function stimulusStub(fields: Partial<TurnEnvelope>): TurnEnvelope {
  return {
    message: {
      id: 'st1',
      orgId: 'T-AGENT',
      repoId: 'repo-agent',
      jobId: JOB_ID,
      receivedAt: '2026-07-15T12:00:00.000Z',
      type: 'user',
    } as unknown as Message,
    id: 'st1',
    orgId: 'T-AGENT',
    repoId: 'repo-agent',
    jobId: JOB_ID,
    body: 'body',
    author: { id: 'U1', displayName: 'Dennis' },
    replyRoute: { surfaceId: 'web', jobRef: JOB_ID },
    receivedAt: new Date('2026-07-15T12:00:00Z'),
    ...fields,
  };
}

function makeManager(threadRole: ReturnType<typeof vi.fn>) {
  const driverStore = { threadRole };
  const inert = {} as never;
  const manager = new AgentSessionManager(
    inert, // store
    driverStore as never, // driverStore
    inert,
    inert,
    inert,
    inert, // autoMerge, memory, approvals, lifecycle
    inert, // engineRunner
    inert, // turnRegistry
    inert,
    inert,
    inert, // planReview, dispatcher, surface
    inert, // sandboxRows
    inert, // stimulusRows
    inert, // stimulusStore
    inert,
    inert,
    inert,
    inert,
    inert,
    inert,
    inert, // turnHarness…creds
    inert, // mcp
    inert, // election
    inert,
    inert,
    inert,
    inert, // turnRecovery…git
    inert, // prompts (PromptService)
    inert, // threadInput (ThreadInputService)
    inert, // liveVerificationJudge (LIVE_VERIFICATION_JUDGE)
    inert, // usage (OauthUsageService)
    inert, // selfSufficiency (SelfSufficiencyToolsService, added by #268)
  );
  return manager;
}

function callResolvePromptAgent(
  manager: AgentSessionManager,
  stimulus: TurnEnvelope,
): Promise<Agent> {
  return (
    manager as unknown as {
      resolvePromptAgent: (s: TurnEnvelope) => Promise<Agent>;
    }
  ).resolvePromptAgent(stimulus);
}

describe('AgentSessionManager.resolvePromptAgent — the turn-seam stage-persona selection', () => {
  it('a stimulus with no resumeThreadId (a plain planning turn) resolves to PLANNING', async () => {
    const threadRole = vi.fn();
    const manager = makeManager(threadRole);

    const agent = await callResolvePromptAgent(
      manager,
      stimulusStub({ resumeThreadId: undefined }),
    );

    expect(agent).toBe(Agent.PLANNING);
    expect(threadRole).not.toHaveBeenCalled();
  });

  it('a resumeThreadId pointing at a post_build thread resolves to POST_BUILD', async () => {
    const threadRole = vi.fn().mockResolvedValue('post_build' satisfies ThreadRole);
    const manager = makeManager(threadRole);

    const agent = await callResolvePromptAgent(
      manager,
      stimulusStub({ resumeThreadId: 'thr-pb-1' }),
    );

    expect(agent).toBe(Agent.POST_BUILD);
    expect(threadRole).toHaveBeenCalledWith('thr-pb-1');
  });

  it('a resumeThreadId pointing at a ci thread resolves to CI', async () => {
    const threadRole = vi.fn().mockResolvedValue('ci' satisfies ThreadRole);
    const manager = makeManager(threadRole);

    const agent = await callResolvePromptAgent(
      manager,
      stimulusStub({ resumeThreadId: 'thr-ci-1' }),
    );

    expect(agent).toBe(Agent.CI);
    expect(threadRole).toHaveBeenCalledWith('thr-ci-1');
  });

  it('a resumeThreadId pointing at a planning thread still resolves to PLANNING', async () => {
    const threadRole = vi.fn().mockResolvedValue('planning' satisfies ThreadRole);
    const manager = makeManager(threadRole);

    const agent = await callResolvePromptAgent(
      manager,
      stimulusStub({ resumeThreadId: 'thr-main-1' }),
    );

    expect(agent).toBe(Agent.PLANNING);
  });

  it('falls back to PLANNING when the thread row lookup throws/rejects (a gone or unreadable row)', async () => {
    const threadRole = vi.fn().mockRejectedValue(new Error('row gone'));
    const manager = makeManager(threadRole);

    const agent = await callResolvePromptAgent(
      manager,
      stimulusStub({ resumeThreadId: 'thr-missing' }),
    );

    expect(agent).toBe(Agent.PLANNING);
  });

  it('falls back to PLANNING when the thread row lookup resolves null (row gone, no throw)', async () => {
    const threadRole = vi.fn().mockResolvedValue(null);
    const manager = makeManager(threadRole);

    const agent = await callResolvePromptAgent(
      manager,
      stimulusStub({ resumeThreadId: 'thr-gone' }),
    );

    expect(agent).toBe(Agent.PLANNING);
  });
});
