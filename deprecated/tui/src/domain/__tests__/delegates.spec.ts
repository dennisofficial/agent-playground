import { describe, expect, it } from 'bun:test';
import {
  backgroundDelegates,
  delegateFor,
  isDelegateEvent,
  NO_DELEGATES,
  reduceDelegates,
  type Delegates,
} from '../delegates.js';
import { delegateBadge, delegateGist, delegateMeasure, delegateName } from '../delegate-view.js';
import { EDelegateStatus, type EngineEvent } from '../message.js';

/**
 * The join is the whole module: the same run arrives under two different identities, and getting that
 * wrong shows up as a duplicate row or a row that never settles — neither of which throws.
 */

const T0 = 1_000_000;

function fold(events: EngineEvent[], at: number[] = []): Delegates {
  return events.reduce<Delegates>(
    (current, event, index) => reduceDelegates(current, event, at[index] ?? T0),
    NO_DELEGATES,
  );
}

const started: EngineEvent = {
  kind: 'task_started',
  taskId: 'task-1',
  parentToolUseId: 'toolu_parent',
  description: 'Find transcript rendering',
  agentType: 'Explore',
  taskType: 'local_agent',
  background: false,
};

describe('what counts as a delegate frame', () => {
  it('is the task bookends, and a tool frame ONLY when it carries a parent', () => {
    expect(isDelegateEvent(started)).toBe(true);
    expect(
      isDelegateEvent({
        kind: 'tool_call',
        toolUseId: 'a',
        name: 'Grep',
        input: {},
        parentToolUseId: 'toolu_parent',
      }),
    ).toBe(true);
    // This thread's own call. Routing it away would empty the transcript instead of cleaning it.
    expect(isDelegateEvent({ kind: 'tool_call', toolUseId: 'a', name: 'Grep', input: {} })).toBe(
      false,
    );
    expect(isDelegateEvent({ kind: 'text', text: 'hi' })).toBe(false);
  });

  it("is PROSE too, when it carries a parent — a delegate's reasoning is not this thread's", () => {
    expect(isDelegateEvent({ kind: 'thinking', text: 'grepping', parentToolUseId: 'toolu_parent' })).toBe(
      true,
    );
    expect(isDelegateEvent({ kind: 'text', text: 'done', parentToolUseId: 'toolu_parent' })).toBe(true);
    // The thread's own thinking still belongs to it. This is the half a blanket filter would break.
    expect(isDelegateEvent({ kind: 'thinking', text: 'hmm' })).toBe(false);
  });
});

describe('reconciling the two identities', () => {
  it("counts a delegate's calls against the run that made them", () => {
    const delegates = fold([
      started,
      { kind: 'tool_call', toolUseId: 's1', name: 'Grep', input: {}, parentToolUseId: 'toolu_parent' },
      { kind: 'tool_call', toolUseId: 's2', name: 'Read', input: {}, parentToolUseId: 'toolu_parent' },
    ]);
    expect(delegates).toHaveLength(1);
    expect(delegates[0]).toMatchObject({ toolUses: 2, lastTool: 'Read' });
  });

  it('opens ONE row when the delegate speaks before its own start bookend arrives', () => {
    const delegates = fold([
      { kind: 'tool_call', toolUseId: 's1', name: 'Grep', input: {}, parentToolUseId: 'toolu_parent' },
      started,
    ]);
    // Two rows here would be the duplicate the tool-use key exists to prevent — and the second would
    // never settle, because the notification only knows the task id.
    expect(delegates).toHaveLength(1);
    expect(delegates[0]).toMatchObject({ taskId: 'task-1', toolUses: 1, agentType: 'Explore' });
  });

  it('settles a row that a notification names by task id alone', () => {
    const delegates = fold([
      started,
      {
        kind: 'task_settled',
        taskId: 'task-1',
        status: EDelegateStatus.completed,
        summary: '6 files, 2 gaps found',
      },
    ]);
    expect(delegates[0]).toMatchObject({
      status: EDelegateStatus.completed,
      outcome: '6 files, 2 gaps found',
    });
  });

  it("keeps a delegate's own context reading on its row, never on the thread's", () => {
    const delegates = fold([
      started,
      {
        kind: 'usage',
        contextTokens: 11_511,
        contextLimit: 200_000,
        parentToolUseId: 'toolu_parent',
      },
    ]);
    expect(delegates[0]).toMatchObject({ contextTokens: 11_511, contextLimit: 200_000 });
  });

  it('takes the SDK count when it is ahead and keeps its own when it is not', () => {
    const withProgress: EngineEvent = {
      kind: 'task_progress',
      taskId: 'task-1',
      toolUses: 14,
      durationMs: 32_000,
      lastTool: 'Grep',
      summary: 'Analyzing the markdown layer',
    };
    expect(fold([started, withProgress])[0]).toMatchObject({ toolUses: 14 });
    // Our own tally is ahead of a progress frame taken thirty seconds ago; the count must not go back.
    const ahead = fold([
      started,
      { kind: 'task_progress', taskId: 'task-1', toolUses: 1, durationMs: 10 },
      { kind: 'tool_call', toolUseId: 's1', name: 'Grep', input: {}, parentToolUseId: 'toolu_parent' },
      { kind: 'task_progress', taskId: 'task-1', toolUses: 1, durationMs: 20 },
    ]);
    expect(ahead[0]).toMatchObject({ toolUses: 2 });
  });

  it('returns the same array when a frame changed nothing, so the screen does not repaint', () => {
    const one = fold([started]);
    const again = reduceDelegates(one, { kind: 'text', text: 'hi' }, T0);
    expect(again).toBe(one);
  });
});

describe('the background membership level', () => {
  it('marks what it holds, and never settles what it omits', () => {
    const delegates = fold([
      started,
      {
        kind: 'background_tasks',
        tasks: [{ taskId: 'task-1', taskType: 'local_agent', description: 'Find transcript' }],
      },
      // The level empties the instant the notification lands. Retiring on absence would race that
      // bookend and kill rows still working — a foreground delegate never appears here at all.
      { kind: 'background_tasks', tasks: [] },
    ]);
    expect(delegates[0]).toMatchObject({
      background: true,
      status: EDelegateStatus.running,
    });
  });

  it('learns about work it never saw start — a task inherited from a resumed session', () => {
    const delegates = fold([
      {
        kind: 'background_tasks',
        tasks: [{ taskId: 'task-9', taskType: 'local_bash', description: 'pnpm test' }],
      },
    ]);
    expect(delegates[0]).toMatchObject({
      taskId: 'task-9',
      background: true,
      description: 'pnpm test',
    });
  });
});

describe('what each surface asks for', () => {
  it('gives the panel only background work that is still running', () => {
    const delegates = fold([
      started,
      {
        kind: 'background_tasks',
        tasks: [{ taskId: 'task-1', taskType: 'local_agent', description: 'Find transcript' }],
      },
      {
        kind: 'task_started',
        taskId: 'task-2',
        parentToolUseId: 'toolu_other',
        description: 'A foreground sweep',
        agentType: 'Explore',
        taskType: 'local_agent',
        background: false,
      },
    ]);
    // The foreground one is excluded: the block that spawned it is already on screen, spinning.
    expect(backgroundDelegates(delegates).map((d) => d.taskId)).toEqual(['task-1']);

    const settled = reduceDelegates(
      delegates,
      { kind: 'task_settled', taskId: 'task-1', status: EDelegateStatus.completed },
      T0,
    );
    expect(backgroundDelegates(settled)).toEqual([]);
  });

  it('gives a transcript block the delegate it spawned, by tool-use id', () => {
    const delegates = fold([started]);
    expect(delegateFor(delegates, 'toolu_parent')).toMatchObject({ taskId: 'task-1' });
    expect(delegateFor(delegates, 'toolu_unrelated')).toBeUndefined();
  });
});

describe('how a delegate reads', () => {
  it('names itself, measures itself, and quotes its own gist', () => {
    const delegates = fold([
      started,
      {
        kind: 'task_progress',
        taskId: 'task-1',
        toolUses: 14,
        durationMs: 32_000,
        lastTool: 'Grep',
        summary: 'Analyzing the markdown layer',
      },
    ]);
    const delegate = delegates[0]!;
    expect(delegateName(delegate)).toBe('Explore agent');
    expect(delegateMeasure(delegate, T0 + 32_000)).toBe('14 tools · 32s · Grep');
    expect(delegateGist(delegate)).toBe('“Analyzing the markdown layer”');
  });

  it('leads with `background`, because it changes what the next block means', () => {
    const delegates = fold([
      started,
      {
        kind: 'background_tasks',
        tasks: [{ taskId: 'task-1', taskType: 'local_agent', description: 'Find transcript' }],
      },
    ]);
    expect(delegateMeasure(delegates[0]!, T0)).toStartWith('background · ');
    expect(delegateBadge(delegates[0]!, T0 + 134_000)).toBe('Find transcript rendering · 2m 14s');
  });

  it('drops the present-tense gist once it has settled, and says how it ended', () => {
    const delegates = fold([
      started,
      { kind: 'task_progress', taskId: 'task-1', toolUses: 3, durationMs: 1, summary: 'Reading' },
      { kind: 'task_settled', taskId: 'task-1', status: EDelegateStatus.failed },
    ]);
    expect(delegateGist(delegates[0]!)).toBeUndefined();
    expect(delegateMeasure(delegates[0]!, T0)).toContain('failed');
  });

  it('freezes the clock where the run ended, not where the reader is looking', () => {
    const delegates = fold(
      [started, { kind: 'task_settled', taskId: 'task-1', status: EDelegateStatus.completed }],
      [T0, T0 + 5_000],
    );
    expect(delegateMeasure(delegates[0]!, T0 + 900_000)).toContain('5s');
  });
});
