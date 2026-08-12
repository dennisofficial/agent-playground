import { ETaskStatus } from '../generated/prisma/enums.js';

/**
 * A task as everything above the store needs it: a number the agent can name, the text, the state.
 * Not the row — `id`, `threadId` and the timestamps are storage's business, and a render that could
 * see them would eventually print one.
 */
export type TaskView = {
  /** Stable, 1-based, per thread. This is the `#3` the agent writes and reads. */
  ordinal: number;
  text: string;
  status: ETaskStatus;
};

/**
 * What a status is CALLED in the transcript. The agent reads these back in every reply, so they are
 * the enum's own words rather than prose — `[in_progress]` is what it must emit to set one.
 */
const STATUS_LABEL: Record<ETaskStatus, string> = {
  [ETaskStatus.pending]: 'pending',
  [ETaskStatus.in_progress]: 'in_progress',
  [ETaskStatus.completed]: 'completed',
  [ETaskStatus.deleted]: 'deleted',
};

/** Nothing yet — said as an instruction, because an empty list is usually a plan not written. */
export const NO_TASKS = 'No tasks yet — call task_create with your plan.';

/**
 * A deleted task stops RENDERING; it does not stop existing, and it never gives its number back.
 * Renumbering the list would silently repoint every `#3` the agent has already written down — the
 * one way a render-only table could still corrupt a decision.
 */
export function visibleTasks(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter((task) => task.status !== ETaskStatus.deleted);
}

/**
 * `#3 [in_progress] Wire the composer` — copied from legacy verbatim, because it reads well in a
 * transcript and the agent has to be able to parse it back into a number without being taught how.
 *
 * A string rather than JSON for the same reason: this is the tool's whole reply, and the model reads
 * it as prose either way.
 */
export function renderTaskList(tasks: readonly TaskView[]): string {
  const visible = visibleTasks(tasks);
  if (visible.length === 0) return NO_TASKS;
  return visible
    .map((task) => `#${task.ordinal} [${STATUS_LABEL[task.status]}] ${task.text}`)
    .join('\n');
}

/**
 * The list as a section of a ROTATION hand-off, empty when there is nothing to carry.
 *
 * This is the one non-cosmetic consequence of Atlas owning tasks instead of `TodoWrite`: they outlive
 * the session, so the next leg inherits numbers it has never seen and would otherwise call `#3` into
 * a list it believes is empty. A heading and the render — no extra turn, no summary.
 *
 * **Rotation only, and the distinction is load-bearing.** A rotation keeps the SAME thread, so the
 * inherited numbers are still live and `task_update` still takes them. An `advance_thread` successor
 * is a NEW thread with an empty list of its own — seeding it with numbers it cannot update would be
 * a lie, which is why this is not folded into `successorSeed` where it would appear to belong.
 */
export function taskListSection(tasks: readonly TaskView[]): string {
  if (visibleTasks(tasks).length === 0) return '';
  return [
    '# Your task list',
    '',
    'Carried over from the session before you — the numbers are stable, and `task_update` still',
    'takes them.',
    '',
    renderTaskList(tasks),
  ].join('\n');
}

/** Never throws; it answers. The one reply a wrong number gets, and it names the way out. */
export function unknownTaskReply(ordinal: number): string {
  return `No task #${ordinal} — call task_list.`;
}

export function taskCreatedReply(args: {
  added: number;
  tasks: readonly TaskView[];
}): string {
  const noun = args.added === 1 ? 'task' : 'tasks';
  return `Added ${args.added} ${noun}.\n\n${renderTaskList(args.tasks)}`;
}

export function taskUpdatedReply(args: {
  ordinal: number;
  status: ETaskStatus;
  tasks: readonly TaskView[];
}): string {
  return `#${args.ordinal} → ${STATUS_LABEL[args.status]}\n\n${renderTaskList(args.tasks)}`;
}

/** The next number to hand out. Off the highest ever used, so deleting never recycles a number. */
export function nextOrdinal(tasks: readonly TaskView[]): number {
  return tasks.reduce((highest, task) => Math.max(highest, task.ordinal), 0) + 1;
}

export type ChecklistRow = {
  ordinal: number;
  text: string;
  status: ETaskStatus;
};

/**
 * The checklist as the SCREEN needs it: a bounded window, and how much it is hiding either side.
 *
 * Bounded because the panel sits above the composer and a fifteen-step plan would eat the
 * conversation it is describing. Anchored on the first unfinished task rather than on the top,
 * because "what is happening now" is the only reason to glance at it — the finished half is
 * reassurance and scrolls away first.
 */
export type ChecklistView = {
  rows: ChecklistRow[];
  hiddenAbove: number;
  hiddenBelow: number;
  /** `2/5 done`, or null when there is nothing to count. */
  progress: string | null;
};

export function checklistView(args: {
  tasks: readonly TaskView[];
  maxRows: number;
}): ChecklistView {
  const visible = visibleTasks(args.tasks);
  if (visible.length === 0 || args.maxRows <= 0) {
    return { rows: [], hiddenAbove: 0, hiddenBelow: 0, progress: null };
  }

  const done = visible.filter((task) => task.status === ETaskStatus.completed).length;
  const progress = `${done}/${visible.length} done`;
  if (visible.length <= args.maxRows) {
    return { rows: [...visible], hiddenAbove: 0, hiddenBelow: 0, progress };
  }

  // One row of finished work above the live one, so the window reads as a position in a list rather
  // than as a list. Clamped at the end so the last window is full rather than short.
  const active = visible.findIndex((task) => task.status !== ETaskStatus.completed);
  const anchor = active === -1 ? visible.length - args.maxRows : Math.max(0, active - 1);
  const start = Math.min(anchor, visible.length - args.maxRows);
  return {
    rows: visible.slice(start, start + args.maxRows),
    hiddenAbove: start,
    hiddenBelow: visible.length - start - args.maxRows,
    progress,
  };
}

/**
 * One row's text, clipped to the cells it has — never padded.
 *
 * A task is written as a short imperative phrase, so the front of it carries the meaning and an
 * ellipsis at the end costs nothing. Padding is what a COLUMN needs (`fitColumn`); this row has
 * nothing to its right, and trailing spaces would drag the panel's background across the screen.
 */
export function clipTaskText(text: string, width: number): string {
  if (width <= 0) return '';
  const characters = [...text];
  if (characters.length <= width) return text;
  if (width === 1) return '…';
  return `${characters.slice(0, width - 1).join('')}…`;
}

/**
 * Codex's `update_plan`, mapped onto this same list.
 *
 * `update_plan` cannot be turned off — it is the one unconditional tool in Codex's core kit — so the
 * choice is between two checklists rendering to one panel and one. It sends the WHOLE plan every
 * time, which is why this returns texts and statuses rather than edits: the caller replaces the list.
 * Cheap precisely because the list is render-only — a plan arriving from the engine cannot corrupt a
 * decision, because nothing reads it back into one.
 */
export function tasksFromPlan(args: {
  steps: readonly { step: string; status: string }[];
}): TaskView[] {
  return args.steps.map((step, index) => ({
    ordinal: index + 1,
    text: step.step,
    status: planStatus(step.status),
  }));
}

function planStatus(status: string): ETaskStatus {
  if (status === 'in_progress') return ETaskStatus.in_progress;
  // Codex says `completed`; anything it says next is treated as not-started rather than dropped,
  // since a step that vanished from the render would be worse than one shown as pending.
  if (status === 'completed') return ETaskStatus.completed;
  return ETaskStatus.pending;
}
