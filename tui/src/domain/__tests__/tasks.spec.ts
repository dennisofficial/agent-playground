import { describe, expect, it } from 'bun:test';
import { ETaskStatus } from '../../generated/prisma/enums.js';
import {
  NO_TASKS,
  checklistView,
  clipTaskText,
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

describe('checklistView', () => {
  it('shows everything when it fits, and counts what is done', () => {
    const view = checklistView({ tasks: PLAN, maxRows: 6 });
    expect(view.rows).toHaveLength(3);
    expect(view.progress).toBe('1/3 done');
    expect(view.hiddenAbove).toBe(0);
    expect(view.hiddenBelow).toBe(0);
  });

  // The panel obeys the same rule the transcript render does: retired tasks are gone from the view
  // and gone from the count, and the numbers around them do not move.
  it('drops retired tasks from the rows and from the count', () => {
    const view = checklistView({
      tasks: [...PLAN, task({ ordinal: 4, text: 'abandoned', status: ETaskStatus.deleted })],
      maxRows: 6,
    });
    expect(view.rows.map((row) => row.ordinal)).toEqual([1, 2, 3]);
    expect(view.progress).toBe('1/3 done');
  });

  it('is empty for an empty list, so the panel disappears rather than sits there blank', () => {
    const view = checklistView({ tasks: [], maxRows: 6 });
    expect(view.rows).toHaveLength(0);
    expect(view.progress).toBeNull();
  });

  // The window is anchored on the work, not on the top of the list.
  it('windows a long list one row above the live task', () => {
    const long = Array.from({ length: 10 }, (_, index) =>
      task({
        ordinal: index + 1,
        status: index < 5 ? ETaskStatus.completed : ETaskStatus.pending,
      }),
    );
    const view = checklistView({ tasks: long, maxRows: 3 });
    expect(view.rows.map((row) => row.ordinal)).toEqual([5, 6, 7]);
    expect(view.hiddenAbove).toBe(4);
    expect(view.hiddenBelow).toBe(3);
  });

  it('keeps the window full at the end of a finished list', () => {
    const long = Array.from({ length: 5 }, (_, index) =>
      task({ ordinal: index + 1, status: ETaskStatus.completed }),
    );
    const view = checklistView({ tasks: long, maxRows: 3 });
    expect(view.rows.map((row) => row.ordinal)).toEqual([3, 4, 5]);
    expect(view.hiddenBelow).toBe(0);
    expect(view.progress).toBe('5/5 done');
  });

  it('never renders more rows than it was given room for', () => {
    expect(checklistView({ tasks: PLAN, maxRows: 0 }).rows).toHaveLength(0);
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
