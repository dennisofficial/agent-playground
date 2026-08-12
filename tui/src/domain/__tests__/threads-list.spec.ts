import { describe, expect, it } from 'bun:test';
import {
  EEngine,
  EPhaseKind,
  EThreadRole,
  EThreadStatus,
} from '../../generated/prisma/enums.js';
import {
  EThreadState,
  messagesLabel,
  phaseLabel,
  sessionsLabel,
  threadList,
  threadState,
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
    ...fields,
  };
}

describe('threadState', () => {
  const activeThreadId = 'thread-1';

  it('calls a closed thread closed even while the job still points at it', () => {
    expect(
      threadState({
        thread: { id: 'thread-1', status: EThreadStatus.closed },
        activeThreadId,
        runningThreadIds: [],
      }),
    ).toBe(EThreadState.closed);
  });

  it('lets a running turn outrank the cursor', () => {
    expect(
      threadState({
        thread: { id: 'thread-1', status: EThreadStatus.active },
        activeThreadId,
        runningThreadIds: ['thread-1'],
      }),
    ).toBe(EThreadState.working);
  });

  it('marks the cursor thread active', () => {
    expect(
      threadState({
        thread: { id: 'thread-1', status: EThreadStatus.active },
        activeThreadId,
        runningThreadIds: [],
      }),
    ).toBe(EThreadState.active);
  });

  it('leaves an open sibling merely open', () => {
    expect(
      threadState({
        thread: { id: 'thread-2', status: EThreadStatus.active },
        activeThreadId,
        runningThreadIds: [],
      }),
    ).toBe(EThreadState.open);
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

    expect(order.map((row) => row.stateLabel)).toEqual(['closed', 'closed', 'closed', 'working…']);
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

  it('never returns a negative role column, however small the terminal gets', () => {
    for (const width of [0, 1, 10, 20]) {
      expect(threadsLayout(width).role).toBeGreaterThanOrEqual(3);
    }
  });

  it('caps the role so a wide terminal does not stretch one column across the screen', () => {
    expect(threadsLayout(400).role).toBe(26);
  });
});
