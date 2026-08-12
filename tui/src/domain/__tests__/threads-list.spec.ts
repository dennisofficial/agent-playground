import { describe, expect, it } from 'bun:test';
import {
  EEngine,
  EPhaseKind,
  EThreadRole,
  EThreadStatus,
} from '../../generated/prisma/enums.js';
import { EAttentionCourt, EAttentionVerb } from '../attention.js';
import {
  messagesLabel,
  phaseLabel,
  sessionsLabel,
  threadAttention,
  threadFacts,
  threadList,
  threadsLayout,
  type ThreadListSource,
} from '../threads-list.js';

function thread(fields: Partial<ThreadListSource> & { id: string }): ThreadListSource {
  return {
    role: EThreadRole.builder,
    status: EThreadStatus.active,
    phaseId: 'phase-1',
    phaseKind: EPhaseKind.build,
    phaseTitle: null,
    engine: EEngine.claude,
    messageCount: 0,
    sessionCount: 1,
    lastMessageAt: null,
    lastSeenAt: null,
    ...fields,
  };
}

describe('threadFacts', () => {
  it('answers 1 or 0 to “are threads open”, which is what lets a job count them', () => {
    expect(
      threadFacts({ thread: thread({ id: 't1' }), runningThreadIds: [] }).openThreadCount,
    ).toBe(1);
    expect(
      threadFacts({
        thread: thread({ id: 't1', status: EThreadStatus.closed }),
        runningThreadIds: [],
      }).openThreadCount,
    ).toBe(0);
  });

  it('reads unread off the timestamps rather than off who spoke last', () => {
    const facts = threadFacts({
      thread: thread({
        id: 't1',
        lastMessageAt: new Date('2026-08-11T10:00:00Z'),
        lastSeenAt: new Date('2026-08-11T09:00:00Z'),
      }),
      runningThreadIds: [],
    });

    expect(facts.unseen).toBe(true);
  });
});

describe('threadAttention', () => {
  it('calls a closed thread closed even while the job still points at it', () => {
    const attention = threadAttention({
      thread: thread({ id: 'thread-1', status: EThreadStatus.closed }),
      runningThreadIds: [],
    });

    expect(attention.verb).toBe(EAttentionVerb.nothingOpen);
    expect(attention.label).toBe('closed');
    expect(attention.court).toBe(EAttentionCourt.none);
  });

  it('says working… with a spinner while a turn is in flight', () => {
    const attention = threadAttention({
      thread: thread({ id: 'thread-1' }),
      runningThreadIds: ['thread-1'],
    });

    expect(attention.label).toBe('working…');
    expect(attention.spinner).toBe(true);
  });

  it('lets a proposal outrank a running turn even on one row', () => {
    const attention = threadAttention({
      thread: thread({ id: 'thread-1' }),
      runningThreadIds: ['thread-1'],
      proposalPending: true,
    });

    expect(attention.label).toBe('confirm');
  });

  it('asks for a reply on an open, quiet thread', () => {
    expect(threadAttention({ thread: thread({ id: 't2' }), runningThreadIds: [] }).label).toBe(
      'reply',
    );
  });
});

describe('threadList', () => {
  const threads = [
    thread({ id: 't1', role: EThreadRole.intake, phaseId: 'p1', phaseKind: EPhaseKind.intake, status: EThreadStatus.closed }),
    thread({ id: 't2', role: EThreadRole.planner, phaseId: 'p2', phaseKind: EPhaseKind.planning, status: EThreadStatus.closed }),
    thread({ id: 't3', role: EThreadRole.plan_review, phaseId: 'p2', phaseKind: EPhaseKind.planning, engine: EEngine.codex, status: EThreadStatus.closed }),
    thread({ id: 't4', role: EThreadRole.builder, phaseId: 'p3', phaseKind: EPhaseKind.build }),
  ];

  it('groups by phase in the order the rows arrive', () => {
    const { groups } = threadList({ threads, activeThreadId: 't4', runningThreadIds: [] });

    expect(groups.map((group) => group.label)).toEqual(['intake', 'planning', 'build']);
    expect(groups[1]?.threads.map((row) => row.id)).toEqual(['t2', 't3']);
  });

  it('gives every thread one index across the whole list, so ↑↓ crosses a phase header', () => {
    const { groups, order } = threadList({ threads, activeThreadId: 't4', runningThreadIds: [] });

    expect(order.map((row) => row.index)).toEqual([0, 1, 2, 3]);
    expect(groups[2]?.threads[0]?.index).toBe(3);
  });

  it('does not draw the same phase twice when a row arrives out of order', () => {
    const shuffled = [threads[0], threads[3], threads[1]].filter(
      (row): row is ThreadListSource => row !== undefined,
    );

    const { groups } = threadList({ threads: shuffled, activeThreadId: null, runningThreadIds: [] });

    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.phaseId)).toEqual(['p1', 'p3', 'p2']);
  });

  it('reads the engine off the thread’s own sessions, mixed engines included', () => {
    const { order } = threadList({ threads, activeThreadId: null, runningThreadIds: [] });

    expect(order.map((row) => row.engine)).toEqual(['claude', 'claude', 'codex', 'claude']);
  });

  it('falls back to the role binding for a thread that never opened a session', () => {
    const { order } = threadList({
      threads: [thread({ id: 't9', role: EThreadRole.master_review, engine: null, sessionCount: 0 })],
      activeThreadId: null,
      runningThreadIds: [],
    });

    expect(order[0]?.engine).toBe(EEngine.codex);
  });

  it('spells a role without its underscores', () => {
    const { order } = threadList({ threads, activeThreadId: null, runningThreadIds: [] });

    expect(order[2]?.label).toBe('plan review');
  });

  it('states each row’s condition', () => {
    const { order } = threadList({ threads, activeThreadId: 't4', runningThreadIds: ['t4'] });

    expect(order.map((row) => row.attention.label)).toEqual([
      'closed',
      'closed',
      'closed',
      'working…',
    ]);
  });

  it('keeps the job’s cursor off the status column — it is a pointer, not a state', () => {
    const { order } = threadList({ threads, activeThreadId: 't4', runningThreadIds: [] });

    expect(order.map((row) => row.active)).toEqual([false, false, false, true]);
    expect(order[3]?.attention.label).toBe('reply');
  });

  it('draws read state on its own channel, beside the verb', () => {
    const { order } = threadList({
      threads: [
        thread({
          id: 't9',
          lastMessageAt: new Date('2026-08-11T10:00:00Z'),
          lastSeenAt: new Date('2026-08-11T09:00:00Z'),
        }),
      ],
      activeThreadId: null,
      runningThreadIds: [],
    });

    expect(order[0]?.attention.unseen).toBe(true);
    expect(order[0]?.attention.label).toBe('reply');
  });

  it('returns nothing at all for a job with no threads', () => {
    const { groups, order } = threadList({ threads: [], activeThreadId: null, runningThreadIds: [] });

    expect(groups).toEqual([]);
    expect(order).toEqual([]);
  });
});

describe('phaseLabel', () => {
  it('prefers a phase’s own title', () => {
    expect(phaseLabel({ kind: EPhaseKind.build, title: 'the second build' })).toBe('the second build');
  });

  it('spells a kind without its underscores', () => {
    expect(phaseLabel({ kind: EPhaseKind.direct_build, title: null })).toBe('direct build');
  });
});

describe('count labels', () => {
  it('does not pluralise one of anything', () => {
    expect(messagesLabel(1)).toBe('1 msg');
    expect(sessionsLabel(1)).toBe('1 session');
  });

  it('pluralises everything else, including none', () => {
    expect(messagesLabel(0)).toBe('0 msgs');
    expect(sessionsLabel(2)).toBe('2 sessions');
  });
});

describe('threadsLayout', () => {
  it('gives every column its width when the terminal can afford it', () => {
    const layout = threadsLayout(120);

    expect(layout.sessions).toBeGreaterThan(0);
    expect(layout.engine).toBeGreaterThan(0);
    expect(layout.state).toBeGreaterThan(0);
  });

  it('drops the session count before the engine', () => {
    const layout = threadsLayout(50);

    expect(layout.sessions).toBe(0);
    expect(layout.engine).toBeGreaterThan(0);
  });

  it('keeps the state column longest — it is the question the list answers', () => {
    const layout = threadsLayout(34);

    expect(layout.messages).toBe(0);
    expect(layout.engine).toBe(0);
    expect(layout.state).toBeGreaterThan(0);
  });

  it('leaves the state column room for the spinner that moved off the dot', () => {
    expect(threadsLayout(120).state).toBeGreaterThanOrEqual('⠹ working…'.length + 1);
  });

  it('never returns a negative role column, however small the terminal gets', () => {
    for (const width of [0, 1, 10, 20]) {
      expect(threadsLayout(width).role).toBeGreaterThanOrEqual(3);
    }
  });

  it('caps the role so a wide terminal does not stretch one column across the screen', () => {
    expect(threadsLayout(400).role).toBe(26);
  });
});
