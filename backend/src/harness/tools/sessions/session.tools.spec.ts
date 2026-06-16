import { makeEmployee } from '@harness/employees/employee.testing';
import { EWorkerEngineName } from '@harness/engines/worker-engine.port';
import type { Identity } from '../../domain/identity';
import {
  CheckSessionTool,
  CreateSessionTool,
  ReplySessionTool,
} from './session.tools';

/**
 * The create_session side of the approval gate: an execute-mode session is checked against the
 * SAME executeRefusal as reply_session (a fresh session must not bypass the flip guard), and a
 * board link is validated at creation. The guard matrix itself lives in
 * session-runner.service.spec.ts; here the runner is mocked.
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

function makeTool(opts: {
  refusal?: string | null;
  boardTask?:
    | { id: number; title?: string; description?: string; sharedSlug?: string }
    | undefined;
  plan?: { planMd: string } | undefined;
  engine?: EWorkerEngineName;
  note?: { id: number; body: string } | undefined;
  worktreeShared?: string; // the worktree's existing sharedBranch (for the drift guard)
}) {
  const created: Record<string, unknown>[] = [];
  const sessions = {
    create: vi.fn((input: Record<string, unknown>) => {
      created.push(input);
      return Promise.resolve({ id: 'sess-001' });
    }),
  };
  const runner = {
    executeRefusal: vi.fn(() => Promise.resolve(opts.refusal ?? null)),
    runSessionTurn: vi.fn(
      (_id: string, _message: string, _parentChatTrace?: unknown) =>
        Promise.resolve(),
    ),
  };
  const ensureShared = vi.fn(async (_id: string, name: string) => `shared/${name}`);
  const worktrees = {
    get: () => ({
      id: 'wt-001',
      path: '/tmp/wt',
      sharedBranch: opts.worktreeShared,
    }),
    ensureShared,
    sharedBranchName: (s: string) => `shared/${s}`,
  };
  const alex = makeEmployee({ id: 'alex', name: 'Alex', engine: opts.engine });
  const employees = {
    byId: () => alex,
    fallbackOwner: () => alex,
    context: () => ({ team: 'local', roster: 'Alex — backend engineer' }),
  };
  const board = {
    get: vi.fn(() => Promise.resolve(opts.boardTask)),
    transition: vi.fn(() => Promise.resolve(undefined)),
  };
  const plans = {
    get: vi.fn(() => Promise.resolve(opts.plan)),
    setExecuteContext: vi.fn(() => Promise.resolve(undefined)),
  };
  const notes = { get: vi.fn(() => Promise.resolve(opts.note)) };
  const tool = new CreateSessionTool(
    sessions as never,
    runner as never,
    worktrees as never,
    employees as never,
    board as never,
    plans as never,
    notes as never,
  );
  return { tool, created, runner, board, plans, notes, ensureShared };
}

describe('create_session × the approval gate', () => {
  it('refuses an execute-mode open when the runner refuses, creating nothing', async () => {
    const { tool, created, runner } = makeTool({ refusal: 'needs approval' });
    const out = await tool.execute(
      { worktreeId: 'wt-001', task: 'build it', mode: 'execute' },
      ctx,
    );
    expect(out).toContain("Can't open an execute session: needs approval");
    expect(created).toHaveLength(0);
    expect(runner.executeRefusal).toHaveBeenCalledWith(
      'T1',
      undefined,
      'wt-001',
    );
  });

  it('plan-mode opens are never gated', async () => {
    const { tool, created, runner } = makeTool({ refusal: 'needs approval' });
    const out = await tool.execute(
      { worktreeId: 'wt-001', task: 'plan it', mode: 'plan' },
      ctx,
    );
    expect(out).toContain('Opened sess-001');
    expect(created).toHaveLength(1);
    expect(runner.executeRefusal).not.toHaveBeenCalled();
  });

  it('frames a non-Claude (Codex) plan turn with the structured plan-mode prompt', async () => {
    const { tool, runner } = makeTool({ engine: EWorkerEngineName.CODEX });
    await tool.execute(
      { worktreeId: 'wt-001', task: 'add rate limiting', mode: 'plan' },
      ctx,
    );
    const opening = runner.runSessionTurn.mock.calls[0]?.[1] as string;
    // Codex has no native plan ceremony, so the posture is established in the prompt.
    expect(opening).toContain('PLAN MODE');
    expect(opening).toContain('READ-ONLY');
    expect(opening).toContain('**Files to touch**');
    expect(opening).toContain('add rate limiting'); // the raw task rides in as the ticket
  });

  it('leaves a Claude plan turn on the raw task (its native plan mode does the ceremony)', async () => {
    const { tool, runner } = makeTool({ engine: EWorkerEngineName.CLAUDE });
    await tool.execute(
      { worktreeId: 'wt-001', task: 'add rate limiting', mode: 'plan' },
      ctx,
    );
    expect(runner.runSessionTurn.mock.calls[0]?.[1]).toBe('add rate limiting');
  });

  it('validates the board link and threads it onto the session', async () => {
    const missing = makeTool({ boardTask: undefined });
    expect(
      await missing.tool.execute(
        { worktreeId: 'wt-001', task: 't', mode: 'plan', board_task_id: 42 },
        ctx,
      ),
    ).toContain('No board task #42');

    const linked = makeTool({ boardTask: { id: 7 }, refusal: null });
    const out = await linked.tool.execute(
      { worktreeId: 'wt-001', task: 't', mode: 'execute', board_task_id: 7 },
      ctx,
    );
    expect(out).toContain('board #7');
    expect(linked.runner.executeRefusal).toHaveBeenCalledWith('T1', 7, 'wt-001');
    expect(linked.created[0]?.boardTaskId).toBe(7);
  });

  it('Option B: an execute session seeds the engine with the attached plan, not the brief task', async () => {
    const { tool, created, runner } = makeTool({
      boardTask: { id: 7, title: 'Wire auth', description: 'cookie sessions' },
      plan: { planMd: 'PLAN: add the auth middleware.' },
      refusal: null,
    });
    await tool.execute(
      {
        worktreeId: 'wt-001',
        task: 'go execute #7',
        mode: 'execute',
        board_task_id: 7,
      },
      ctx,
    );
    // The stored session.task stays the brief (for list_sessions)...
    expect(created[0]?.task).toBe('go execute #7');
    // ...but the engine's opening message is the enriched plan handoff + the brief as a note.
    const opening = runner.runSessionTurn.mock.calls[0]?.[1];
    expect(opening).toContain('PLAN: add the auth middleware.');
    expect(opening).toContain('Wire auth');
    expect(opening).toContain('go execute #7');
  });

  it('derives the shared branch from the ticket slug when set', async () => {
    const { tool, ensureShared } = makeTool({
      boardTask: { id: 7, title: 'API', sharedSlug: 'payment-flow' },
      refusal: null,
    });
    await tool.execute(
      { worktreeId: 'wt-001', task: 'go', mode: 'execute', board_task_id: 7 },
      ctx,
    );
    expect(ensureShared).toHaveBeenCalledWith('wt-001', 'payment-flow');
  });

  it('defaults the shared branch to ticket-N for standalone work', async () => {
    const { tool, ensureShared } = makeTool({
      boardTask: { id: 7, title: 'API' },
      refusal: null,
    });
    await tool.execute(
      { worktreeId: 'wt-001', task: 'go', mode: 'execute', board_task_id: 7 },
      ctx,
    );
    expect(ensureShared).toHaveBeenCalledWith('wt-001', 'ticket-7');
  });

  it('drift guard: refuses an execute open when the worktree is on a different shared branch than the ticket lands on', async () => {
    const { tool, created } = makeTool({
      boardTask: { id: 7, title: 'API', sharedSlug: 'payment-flow' },
      refusal: null,
      worktreeShared: 'shared/something-else',
    });
    const out = await tool.execute(
      { worktreeId: 'wt-001', task: 'go', mode: 'execute', board_task_id: 7 },
      ctx,
    );
    expect(out).toContain('shared/something-else');
    expect(out).toContain('shared/payment-flow');
    expect(created).toHaveLength(0); // never opened
  });

  it('falls back to the plain task when an execute session has no attached plan', async () => {
    const { tool, runner } = makeTool({
      boardTask: { id: 7, title: 'Wire auth' },
      plan: undefined,
      refusal: null,
    });
    await tool.execute(
      {
        worktreeId: 'wt-001',
        task: 'just do it',
        mode: 'execute',
        board_task_id: 7,
      },
      ctx,
    );
    expect(runner.runSessionTurn.mock.calls[0]?.[1]).toBe('just do it');
  });

  it('inlines self-review findings by id into the opening message (review_note_id fallback path)', async () => {
    const { tool, runner, notes } = makeTool({
      boardTask: { id: 7, title: 'Wire auth' },
      plan: undefined,
      refusal: null,
      note: { id: 42, body: 'Null check missing in handler.' },
    });
    await tool.execute(
      {
        worktreeId: 'wt-001',
        task: 'fix the self-review note',
        mode: 'execute',
        board_task_id: 7,
        review_note_id: 42,
      },
      ctx,
    );
    expect(notes.get).toHaveBeenCalledWith('T1', 7, 42);
    const opening = runner.runSessionTurn.mock.calls[0]?.[1] as string;
    expect(opening).toContain('SELF-REVIEW FINDINGS TO ADDRESS (note #42)');
    expect(opening).toContain('Null check missing in handler.');
  });

  it('threads the chat-turn trace pointer through to the first session turn (Langfuse link)', async () => {
    const { tool, runner } = makeTool({ engine: EWorkerEngineName.CLAUDE });
    const parentChatTrace = { traceId: 'abc123', spanId: 'def456' };
    await tool.execute(
      { worktreeId: 'wt-001', task: 'add rate limiting', mode: 'plan' },
      { ...ctx, parentChatTrace },
    );
    // 3rd arg of runSessionTurn is the parent-chat-trace pointer (for the session-turn observation).
    expect(runner.runSessionTurn.mock.calls[0]?.[2]).toEqual(parentChatTrace);
  });
});

describe('reply_session × review_note_id templating (the recommended fix path)', () => {
  function makeReply(opts: {
    session?: Record<string, unknown>;
    note?: { id: number; body: string };
  }) {
    const sessions = { get: vi.fn(() => Promise.resolve(opts.session)) };
    const replySession = vi.fn(
      (_id: string, _message: string, _mode?: unknown, _trace?: unknown) =>
        Promise.resolve({ ok: true }),
    );
    const runner = { replySession };
    const notes = { get: vi.fn(() => Promise.resolve(opts.note)) };
    const tool = new ReplySessionTool(
      sessions as never,
      runner as never,
      notes as never,
    );
    return { tool, replySession, notes };
  }

  const liveSession = {
    id: 'sess-1',
    ownerBot: 'alex',
    team: 'T1',
    boardTaskId: 7,
  };

  it('prepends the findings note body to the outgoing message', async () => {
    const { tool, replySession, notes } = makeReply({
      session: liveSession,
      note: { id: 42, body: 'Fix the null check.' },
    });
    await tool.execute(
      { sessionId: 'sess-1', message: 'addressing the note', review_note_id: 42 },
      ctx,
    );
    expect(notes.get).toHaveBeenCalledWith('T1', 7, 42);
    const sent = replySession.mock.calls[0]?.[1] as string;
    expect(sent).toContain('SELF-REVIEW FINDINGS TO ADDRESS (note #42)');
    expect(sent).toContain('Fix the null check.');
    expect(sent).toContain('addressing the note');
  });

  it('no-ops the templating when the note id is unknown', async () => {
    const { tool, replySession } = makeReply({
      session: liveSession,
      note: undefined,
    });
    await tool.execute(
      { sessionId: 'sess-1', message: 'plain message', review_note_id: 99 },
      ctx,
    );
    expect(replySession.mock.calls[0]?.[1]).toBe('plain message');
  });
});

describe('check_session × the displayed engine tier', () => {
  function makeCheckTool(session: Record<string, unknown>) {
    const sessions = {
      get: vi.fn(() => Promise.resolve(session)),
      latest: vi.fn(() => Promise.resolve(session)),
    };
    const runner = { getSessionActivity: vi.fn(() => Promise.resolve('')) };
    const alex = makeEmployee({ id: 'alex', name: 'Alex' }); // Claude
    const employees = {
      byId: () => alex,
      fallbackOwner: () => alex,
      context: () => ({ team: 'local', roster: 'Alex — backend engineer' }),
    };
    return new CheckSessionTool(
      sessions as never,
      runner as never,
      employees as never,
    );
  }

  it('renders a Claude investigate session on the Opus tier (not the Sonnet execute model)', async () => {
    const tool = makeCheckTool({
      id: 'sess-001',
      ownerBot: 'alex',
      mode: 'investigate',
      engine: EWorkerEngineName.CLAUDE,
      status: 'idle',
      lastReport: 'the answer',
      lastReportKind: 'text',
      worktreeId: 'wt-001',
      turns: 1,
      task: 'how does the gate work?',
    });
    const out = await tool.execute({ sessionId: 'sess-001' }, ctx);
    expect(out).toContain('investigate on claude-opus-4-8');
    expect(out).not.toContain('claude-sonnet-4-6');
  });
});
