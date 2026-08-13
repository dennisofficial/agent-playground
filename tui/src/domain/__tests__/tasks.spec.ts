import { describe, expect, it } from 'bun:test';
import { ETaskStatus } from '../../generated/prisma/enums.js';
import {
  NO_TASKS,
  checklistView,
  clipTaskText,
  ESpineMark,
  liveTask,
  nextOrdinal,
  renderTaskList,
  taskCreatedReply,
  taskListSection,
  taskUpdatedReply,
  tasksFromPlan,
  unknownTaskReply,
  visibleTasks,
  type TaskView,
} from '../tasks.js';

function task(fields: Partial<TaskView> & { ordinal: number }): TaskView {
  return { text: `task ${fields.ordinal}`, status: ETaskStatus.pending, ...fields };
}

const PLAN: TaskView[] = [
  task({ ordinal: 1, text: 'Wire the composer', status: ETaskStatus.completed }),
  task({ ordinal: 2, text: 'Render the checklist', status: ETaskStatus.in_progress }),
  task({ ordinal: 3, text: 'Test the exclusion' }),
];

describe('renderTaskList', () => {
  it('renders legacy’s line format, which the agent parses back into a number', () => {
    expect(renderTaskList(PLAN)).toBe(
      [
        '#1 [completed] Wire the composer',
        '#2 [in_progress] Render the checklist',
        '#3 [pending] Test the exclusion',
      ].join('\n'),
    );
  });

  it('tells an empty list what to do about it', () => {
    expect(renderTaskList([])).toBe(NO_TASKS);
  });

  // Deleted is a status, not a row delete: it stops rendering and keeps its number.
  it('hides deleted rows without renumbering the ones around them', () => {
    const withDeleted = [...PLAN, task({ ordinal: 2, status: ETaskStatus.deleted })];
    expect(visibleTasks(withDeleted)).toHaveLength(3);
    expect(renderTaskList([PLAN[0]!, task({ ordinal: 2, status: ETaskStatus.deleted }), PLAN[2]!])).toBe(
      ['#1 [completed] Wire the composer', '#3 [pending] Test the exclusion'].join('\n'),
    );
  });

  it('renders a list of only deleted rows as empty', () => {
    expect(renderTaskList([task({ ordinal: 1, status: ETaskStatus.deleted })])).toBe(NO_TASKS);
  });
});

describe('taskListSection', () => {
  it('carries the rendered list into a hand-off', () => {
    const section = taskListSection(PLAN);
    expect(section).toContain('# Your task list');
    expect(section).toContain('#2 [in_progress] Render the checklist');
  });

  // Empty rather than a heading over nothing — the seed already has enough sections.
  it('is empty when there is nothing to carry', () => {
    expect(taskListSection([])).toBe('');
    expect(taskListSection([task({ ordinal: 1, status: ETaskStatus.deleted })])).toBe('');
  });
});

describe('replies', () => {
  it('answers an unknown number instead of failing the turn', () => {
    expect(unknownTaskReply(7)).toBe('No task #7 — call task_list.');
  });

  it('says what changed and then shows the whole list', () => {
    expect(taskCreatedReply({ added: 1, tasks: PLAN })).toStartWith('Added 1 task.');
    expect(taskCreatedReply({ added: 3, tasks: PLAN })).toStartWith('Added 3 tasks.');
    expect(
      taskUpdatedReply({ ordinal: 2, status: ETaskStatus.completed, tasks: PLAN }),
    ).toStartWith('#2 → completed');
    expect(taskUpdatedReply({ ordinal: 2, status: ETaskStatus.completed, tasks: PLAN })).toContain(
      '#3 [pending]',
    );
  });
});

describe('nextOrdinal', () => {
  it('starts at 1 and never recycles a deleted number', () => {
    expect(nextOrdinal([])).toBe(1);
    expect(nextOrdinal(PLAN)).toBe(4);
    expect(nextOrdinal([task({ ordinal: 9, status: ETaskStatus.deleted })])).toBe(10);
  });
});

describe('liveTask', () => {
  it('points at what is running, not at what is next in line', () => {
    const jumped = [
      task({ ordinal: 1, status: ETaskStatus.completed }),
      task({ ordinal: 2, status: ETaskStatus.pending }),
      task({ ordinal: 3, status: ETaskStatus.in_progress }),
    ];
    expect(liveTask(jumped)?.ordinal).toBe(3);
  });

  it('falls back to the first unstarted task when nothing is running', () => {
    expect(liveTask([task({ ordinal: 1, status: ETaskStatus.completed }), task({ ordinal: 2 })])?.ordinal).toBe(2);
  });

  // No live work is a real answer, and the rail draws it by having no `▶` on it.
  it('is null once every task is done', () => {
    expect(liveTask([task({ ordinal: 1, status: ETaskStatus.completed })])).toBeNull();
  });
});

describe('checklistView', () => {
  it('caps the rail at both ends when the whole plan fits', () => {
    const rows = checklistView({ tasks: PLAN, maxRows: 6 });
    expect(rows.map((row) => row.mark)).toEqual([
      ESpineMark.head,
      ESpineMark.live,
      ESpineMark.tail,
    ]);
    expect(rows.every((row) => row.hidden === 0)).toBe(true);
  });

  // The panel obeys the same rule the transcript render does: retired tasks are gone from the view,
  // and the numbers around them do not move.
  it('drops retired tasks from the rows', () => {
    const rows = checklistView({
      tasks: [...PLAN, task({ ordinal: 4, text: 'abandoned', status: ETaskStatus.deleted })],
      maxRows: 6,
    });
    expect(rows.map((row) => row.ordinal)).toEqual([1, 2, 3]);
  });

  it('is empty for an empty list, so the panel disappears rather than sits there blank', () => {
    expect(checklistView({ tasks: [], maxRows: 6 })).toHaveLength(0);
  });

  // The window is anchored on the work, not on the top of the list.
  it('windows a long list one row above the live task', () => {
    const long = Array.from({ length: 10 }, (_, index) =>
      task({
        ordinal: index + 1,
        status: index < 5 ? ETaskStatus.completed : ETaskStatus.pending,
      }),
    );
    const rows = checklistView({ tasks: long, maxRows: 3 });
    expect(rows.map((row) => row.ordinal)).toEqual([5, 6, 7]);
    expect(rows.map((row) => row.mark)).toEqual([
      ESpineMark.continues,
      ESpineMark.live,
      ESpineMark.continues,
    ]);
  });

  // The count rides the rail's ends: a row of its own is what made the old panel six rows tall.
  it('hangs the hidden counts on the boundary rows and nowhere else', () => {
    const long = Array.from({ length: 10 }, (_, index) =>
      task({
        ordinal: index + 1,
        status: index < 5 ? ETaskStatus.completed : ETaskStatus.pending,
      }),
    );
    expect(checklistView({ tasks: long, maxRows: 3 }).map((row) => row.hidden)).toEqual([4, 0, 3]);
  });

  // The invariant the whole panel rests on: the leading finished row is a nicety, the live row is
  // the point. At maxRows 1 the two compete, and the nicety lost.
  it('keeps the live task in the window at every size', () => {
    const long = Array.from({ length: 12 }, (_, index) =>
      task({ ordinal: index + 1, status: index < 7 ? ETaskStatus.completed : ETaskStatus.pending }),
    );
    for (const maxRows of [1, 2, 3, 4, 5, 12, 20]) {
      const rows = checklistView({ tasks: long, maxRows });
      expect(rows.map((row) => row.ordinal)).toContain(8);
    }
  });

  // A window that is both ends at once has one gutter cell and two counts to put in it.
  it('sums both counts when the window is a single row', () => {
    const long = Array.from({ length: 5 }, (_, index) =>
      task({ ordinal: index + 1, status: index < 2 ? ETaskStatus.completed : ETaskStatus.pending }),
    );
    const rows = checklistView({ tasks: long, maxRows: 1 });
    expect(rows.map((row) => row.ordinal)).toEqual([3]);
    expect(rows[0]?.hidden).toBe(4);
  });

  // A boundary row that is ALSO the live one keeps the arrow; the count renders beside it regardless.
  it('lets the live mark outrank the boundary mark without losing the count', () => {
    const long = Array.from({ length: 6 }, (_, index) =>
      task({ ordinal: index + 1, status: index < 5 ? ETaskStatus.completed : ETaskStatus.pending }),
    );
    const rows = checklistView({ tasks: long, maxRows: 2 });
    expect(rows.map((row) => row.ordinal)).toEqual([5, 6]);
    expect(rows[1]?.mark).toBe(ESpineMark.live);
    expect(rows[0]?.hidden).toBe(4);
  });

  it('anchors on the end of a finished plan, with no live row to point at', () => {
    const long = Array.from({ length: 5 }, (_, index) =>
      task({ ordinal: index + 1, status: ETaskStatus.completed }),
    );
    const rows = checklistView({ tasks: long, maxRows: 3 });
    expect(rows.map((row) => row.ordinal)).toEqual([3, 4, 5]);
    expect(rows.some((row) => row.mark === ESpineMark.live)).toBe(false);
    expect(rows[2]?.mark).toBe(ESpineMark.tail);
  });

  it('never renders more rows than it was given room for', () => {
    expect(checklistView({ tasks: PLAN, maxRows: 0 })).toHaveLength(0);
  });

  // Nothing in Atlas holds the list to one running task: `task_update` sets a row and clears none,
  // and a Codex plan arrives with whatever statuses it was written with.
  describe('when several tasks are running at once', () => {
    const parallel = (running: number[]) =>
      Array.from({ length: 8 }, (_, index) =>
        task({
          ordinal: index + 1,
          status: running.includes(index + 1)
            ? ETaskStatus.in_progress
            : index === 0
              ? ETaskStatus.completed
              : ETaskStatus.pending,
        }),
      );

    it('marks every running row, not just the one it is anchored on', () => {
      const rows = checklistView({ tasks: parallel([2, 3]), maxRows: 4 });
      const live = rows.filter((row) => row.mark === ESpineMark.live).map((row) => row.ordinal);
      expect(live).toEqual([2, 3]);
    });

    // The leading finished row is a courtesy; a second running task outranks it.
    it('gives up the leading finished row to keep the running span in view', () => {
      const rows = checklistView({ tasks: parallel([2, 5]), maxRows: 4 });
      expect(rows.map((row) => row.ordinal)).toEqual([2, 3, 4, 5]);
      expect(rows.filter((row) => row.mark === ESpineMark.live).map((row) => row.ordinal)).toEqual([2, 5]);
    });

    // Past the window's reach the count is the honest answer — it is what the rail's dashes are for.
    it('counts a running task it cannot reach rather than pretending it is not there', () => {
      const rows = checklistView({ tasks: parallel([2, 8]), maxRows: 3 });
      expect(rows.map((row) => row.ordinal)).toEqual([2, 3, 4]);
      expect(rows[2]?.mark).toBe(ESpineMark.continues);
      expect(rows[2]?.hidden).toBe(4);
    });
  });
});

describe('clipTaskText', () => {
  it('clips to the cells it has and never pads', () => {
    expect(clipTaskText('short', 20)).toBe('short');
    expect(clipTaskText('exactly ten', 11)).toBe('exactly ten');
    expect(clipTaskText('a task with a long name', 10)).toBe('a task wi…');
    expect(clipTaskText('anything', 1)).toBe('…');
    expect(clipTaskText('anything', 0)).toBe('');
  });
});

describe('tasksFromPlan', () => {
  // Codex sends the whole plan every time and cannot be told not to, so it REPLACES the list.
  it('maps Codex’s update_plan onto the same rows', () => {
    expect(
      tasksFromPlan({
        steps: [
          { step: 'read the code', status: 'completed' },
          { step: 'write the code', status: 'in_progress' },
          { step: 'ship it', status: 'pending' },
          { step: 'a status nobody has seen', status: 'wat' },
        ],
      }),
    ).toEqual([
      { ordinal: 1, text: 'read the code', status: ETaskStatus.completed },
      { ordinal: 2, text: 'write the code', status: ETaskStatus.in_progress },
      { ordinal: 3, text: 'ship it', status: ETaskStatus.pending },
      { ordinal: 4, text: 'a status nobody has seen', status: ETaskStatus.pending },
    ]);
  });
});
