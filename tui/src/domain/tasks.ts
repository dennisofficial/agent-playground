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
 * A rotation keeps the SAME thread, so the numbers below are the ones already in the store and
 * `task_update` still takes them. A SUCCESSOR is a different case with a different answer — see
 * `carriedTasks`, which copies the rows rather than describing them.
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

/** What a declared carry resolved to: the rows the successor gets, and the numbers that got it wrong. */
export type CarriedTasks = {
  /** Renumbered from 1, in the order they were NAMED. Empty is an ordinary answer. */
  carried: TaskView[];
  /** Declared numbers that resolved to nothing carryable, in the order given. */
  ignored: number[];
};

/**
 * What an `advance_thread` successor inherits: the tasks the outgoing agent NAMED, as its own list.
 *
 * The original rule was that tasks do not cross a thread boundary at all, and the reason given was
 * sound as far as it went — a successor handed `#3` could not update a row that lives on somebody
 * else's thread. But the conclusion did not follow: the fix for numbers that do not resolve is to
 * make them resolve, not to drop the plan. A hand-off is prose, and prose is exactly the wrong
 * shape for a checklist — the successor re-derives a list that already existed, and the panel above
 * the composer goes blank on the one boundary where the work visibly continues.
 *
 * So the rows are COPIED and renumbered from 1: the numbers are the successor's own, `task_update`
 * takes them, and nothing points across a thread.
 *
 * **Declared, not inferred**, which is the half `attach` already got right. Atlas cannot tell a
 * task that is genuinely next from one the thread learned was unnecessary and never got round to
 * retiring, and carrying the whole remainder by default drags a stale plan through every successor
 * for the rest of the job. The agent has just written a paragraph about where the work stands; it
 * is the only party that knows which lines of its list survived that paragraph.
 *
 * **Unfinished only.** A completed task is history, and history is what the hand-off prose is for;
 * inheriting a planner's finished list would show a builder work it never did, on the one panel
 * whose whole job is to say where the work is now. Naming one is `ignored` rather than refused, for
 * the same reason the whole subsystem never throws. Statuses are otherwise preserved — a task left
 * `in_progress` is the piece that was in flight, and that is precisely the row to point at.
 *
 * Named order wins over list order. Naming `[4, 3]` is a re-sequence, and there is no way to read it
 * as anything else; a hand-off that reorders what remains costs nothing to honour.
 */
export function carriedTasks(args: {
  tasks: readonly TaskView[];
  /** The `carry` argument — ordinals in THIS thread's numbering. */
  declared: readonly number[];
}): CarriedTasks {
  const carryable = new Map(
    args.tasks
      .filter(
        (task) =>
          task.status === ETaskStatus.pending || task.status === ETaskStatus.in_progress,
      )
      .map((task) => [task.ordinal, task]),
  );

  const carried: TaskView[] = [];
  const ignored: number[] = [];
  // Deduped as it goes: naming `#3` twice is a slip, and two rows with the same text would be a
  // plan the successor has to reconcile before it can start.
  const taken = new Set<number>();

  for (const ordinal of args.declared) {
    if (taken.has(ordinal)) continue;
    taken.add(ordinal);
    const task = carryable.get(ordinal);
    if (!task) {
      ignored.push(ordinal);
      continue;
    }
    carried.push({ ...task, ordinal: carried.length + 1 });
  }

  return { carried, ignored };
}

/**
 * The same list as a section of the SEED, so the successor knows the plan without spending a
 * `task_list` to find it.
 *
 * Says plainly that the numbers are its own, because the one thing that would make this worse than
 * nothing is a successor that treats an inherited plan as a record it may not touch.
 */
export function carriedTaskSection(tasks: readonly TaskView[]): string {
  if (tasks.length === 0) return '';
  return [
    '# Your task list',
    '',
    'The tasks the thread before you chose to hand on, renumbered and now YOURS — `task_update`',
    'takes these numbers, and `task_create` adds to them. It is not everything that was on its',
    'list: what it finished, and what it decided you should not do, are not here. The hand-off',
    'above is where that is written.',
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

/**
 * A row's place on the rail the checklist draws down its left edge.
 *
 * A ROLE, not a glyph: which character each one is drawn as is the renderer's business, and keeping
 * the decision here is what lets the whole rail — including the part that depends on tasks nobody
 * can see — be table-tested without a terminal.
 *
 * `continues` is the load-bearing one. The window is smaller than most plans, so the rail has to
 * distinguish "the list ends here" from "the list carries on past the edge of what I am showing you"
 * — a cap that lied about the end of a fifteen-step plan would be worse than no rail at all.
 */
export enum ESpineMark {
  /** Where the work is. The one row the panel exists to point at. */
  live = 'live',
  /** The rail runs past the window at this end. */
  continues = 'continues',
  /** The list genuinely starts here. */
  head = 'head',
  /** The list genuinely ends here. */
  tail = 'tail',
  /** A row with list on both sides of it. */
  through = 'through',
}

export type ChecklistRow = {
  ordinal: number;
  text: string;
  status: ETaskStatus;
  mark: ESpineMark;
  /**
   * Tasks off the window at THIS row's end, 0 on any row that is not a boundary — so the count is
   * drawn in the gutter the rail already occupies rather than on a row of its own. A whole row spent
   * printing `+3` is what made the old panel six rows tall.
   */
  hidden: number;
};

/**
 * The task the panel is ANCHORED on: the first thing running, or what is up next if nothing is.
 *
 * `in_progress` beats position, because an agent that starts task #4 before #3 is telling you where
 * it actually is. `null` once everything is done — there is no live work to point at, and the rail
 * says so by having no `▶` on it rather than by pointing at a finished row.
 *
 * The anchor is where the WINDOW sits, which is a different question from which rows are marked
 * live: nothing in Atlas holds the list to one running task at a time (`task_update` sets one row
 * and clears nothing; a Codex plan arrives with whatever statuses it was written with), so several
 * rows can be running at once and every one of them is marked. See `checklistView`.
 */
export function liveTask(tasks: readonly TaskView[]): TaskView | null {
  return (
    tasks.find((task) => task.status === ETaskStatus.in_progress) ??
    tasks.find((task) => task.status === ETaskStatus.pending) ??
    null
  );
}

/**
 * The checklist as the SCREEN needs it: a bounded window onto the plan, each row already knowing
 * where it sits on the rail and what it is hiding.
 *
 * Bounded because the panel sits above the composer and a fifteen-step plan would eat the
 * conversation it is describing. Anchored on the live task rather than on the top, because "what is
 * happening now" is the only reason to glance at it — the finished half is reassurance and scrolls
 * away first. A finished plan anchors on its END instead, so the last thing the panel does before it
 * has nothing left to say is show the work closing out.
 */
export function checklistView(args: {
  tasks: readonly TaskView[];
  maxRows: number;
}): ChecklistRow[] {
  const visible = visibleTasks(args.tasks);
  if (visible.length === 0 || args.maxRows <= 0) return [];

  const live = liveTask(visible);
  const anchor = live === null ? visible.length - 1 : visible.indexOf(live);
  // The last row that must be reachable: with several tasks running, the window tries to hold the
  // whole running span rather than only the one it is anchored on.
  const lastRunning = visible.reduce(
    (last, task, index) => (task.status === ETaskStatus.in_progress ? index : last),
    anchor,
  );

  // One row of finished work above the anchor, so the window reads as a position in a list rather
  // than as a list. It is a courtesy, and it yields twice: to a second running task that would
  // otherwise fall off the bottom, and to the anchor itself, which a one-row window would scroll
  // off in favour of the finished task above it. Clamped at the end too, so the last window is full
  // rather than short.
  const courtesy = Math.max(0, anchor - 1);
  const wanted = lastRunning > courtesy + args.maxRows - 1 ? anchor : courtesy;
  const start = Math.max(
    0,
    Math.min(
      Math.max(wanted, anchor - args.maxRows + 1),
      Math.max(0, visible.length - args.maxRows),
    ),
  );
  const rows = visible.slice(start, start + args.maxRows);
  const below = visible.length - start - rows.length;

  return rows.map((task, index) => {
    const atTop = index === 0;
    const atEnd = index === rows.length - 1;
    return {
      ...task,
      // Every running row is marked, not just the anchor — a second `in_progress` drawn in the
      // pending grey would be the one thing this panel must never do, which is show work that is
      // happening as work that has not started.
      mark: spineMark({
        live: task === live || task.status === ETaskStatus.in_progress,
        atTop,
        atEnd,
        above: start,
        below,
      }),
      // Summed, because a one-row window is both ends at once and "+N you cannot see" is the honest
      // answer there — two counts in one gutter cell would not be.
      hidden: (atTop ? start : 0) + (atEnd ? below : 0),
    };
  });
}

function spineMark(args: {
  live: boolean;
  atTop: boolean;
  atEnd: boolean;
  above: number;
  below: number;
}): ESpineMark {
  // The live row keeps its own mark at a boundary — the count still renders beside it, so nothing is
  // lost by letting "where the work is" outrank "where the window ends".
  if (args.live) return ESpineMark.live;
  if ((args.atTop && args.above > 0) || (args.atEnd && args.below > 0)) {
    return ESpineMark.continues;
  }
  if (args.atTop) return ESpineMark.head;
  if (args.atEnd) return ESpineMark.tail;
  return ESpineMark.through;
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
