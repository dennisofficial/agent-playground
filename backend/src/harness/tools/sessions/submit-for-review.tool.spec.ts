import { describe, expect, it, vi } from 'vitest';
import type { Identity } from '../../domain/identity';
import type { Session } from '../../sessions/session-registry.port';
import { SubmitForReviewTool } from './submit-for-review.tool';

/**
 * The `submit_for_review` tool: validates the execute session and then FIRE-AND-FORGETS the review
 * pipeline. The regression this locks: the detached invocation now carries a `.catch()`, so an
 * unexpected throw out of reviewOwner is reported (blocked + narrated) instead of vanishing as an
 * unhandled rejection.
 */

const ctx: { identity: Identity } = {
  identity: {
    selfAgent: 'alex',
    team: 'T1',
    project: 'proj',
    participants: ['dennis'],
    speaker: 'dennis',
    surface: 'chan',
    isChannel: true,
  },
};

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    task: 'Build the thing',
    workspaceId: 'ws-1',
    status: 'idle',
    notifyThread: 'dev:root',
    ownerBot: 'alex',
    team: 'T1',
    project: 'proj',
    engine: 'claude',
    mode: 'execute',
    turns: 1,
    boardTaskId: 7,
    ...over,
  } as Session;
}

function makeTool(opts: {
  session?: Session | undefined;
  taskStatus?: string;
  reviewOwner?: () => Promise<unknown>;
}) {
  const session = 'session' in opts ? opts.session : makeSession();
  const sessions = { get: async () => session } as never;
  const board = {
    get: async () =>
      opts.taskStatus === undefined
        ? { id: 7, status: 'executing' }
        : { id: 7, status: opts.taskStatus },
  } as never;
  const reviewOwner = vi.fn(
    opts.reviewOwner ?? (async () => ({ kind: 'complete' })),
  );
  const reportOwnerCrash = vi.fn(
    async (_session: Session, _reason: string) => undefined,
  );
  const reviewPipeline = { reviewOwner, reportOwnerCrash } as never;
  const tool = new SubmitForReviewTool(sessions, reviewPipeline, board);
  return { tool, reviewOwner, reportOwnerCrash };
}

describe('submit_for_review', () => {
  it('fires the review pipeline and returns the running heads-up', async () => {
    const { tool, reviewOwner, reportOwnerCrash } = makeTool({});
    const msg = await tool.execute({ sessionId: 'sess-1' }, ctx);
    expect(reviewOwner).toHaveBeenCalledTimes(1);
    expect(msg).toMatch(/submitted sess-1 \(#7\) for review/i);
    // A clean run never reports a crash.
    await Promise.resolve();
    expect(reportOwnerCrash).not.toHaveBeenCalled();
  });

  it('an unexpected throw out of reviewOwner is caught and reported (no unhandled rejection)', async () => {
    const { tool, reportOwnerCrash } = makeTool({
      reviewOwner: async () => {
        throw new Error('boom');
      },
    });
    await tool.execute({ sessionId: 'sess-1' }, ctx);
    await vi.waitFor(() => expect(reportOwnerCrash).toHaveBeenCalledTimes(1));
    const [session, reason] = reportOwnerCrash.mock.calls[0];
    expect(session.id).toBe('sess-1');
    expect(reason).toMatch(/self-review crashed/i);
  });

  it('rejects a session whose task is no longer executing — and never fires the pipeline', async () => {
    const { tool, reviewOwner } = makeTool({ taskStatus: 'in_review' });
    const msg = await tool.execute({ sessionId: 'sess-1' }, ctx);
    expect(msg).toMatch(/not 'executing'/i);
    expect(reviewOwner).not.toHaveBeenCalled();
  });

  it('accepts a resubmit from self_review (the fix-and-resubmit path)', async () => {
    const { tool, reviewOwner } = makeTool({ taskStatus: 'self_review' });
    const msg = await tool.execute({ sessionId: 'sess-1' }, ctx);
    expect(reviewOwner).toHaveBeenCalledTimes(1);
    expect(msg).toMatch(/submitted sess-1 \(#7\) for review/i);
  });

  it('rejects a session owned by someone else', async () => {
    const { tool, reviewOwner } = makeTool({
      session: makeSession({ ownerBot: 'riley' }),
    });
    const msg = await tool.execute({ sessionId: 'sess-1' }, ctx);
    expect(msg).toMatch(/not your session/i);
    expect(reviewOwner).not.toHaveBeenCalled();
  });
});
