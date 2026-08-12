import type { EEngine, EPhaseKind, EThreadRole } from '../generated/prisma/enums.js';
import { EThreadStatus } from '../generated/prisma/enums.js';
import { affords, elasticColumn } from './list-columns.js';
import { engineFor, roleLabel } from './role-engine.js';

/**
 * The thread list is a TIMELINE, not a pool of workers: a rotation retires a session, and a finished
 * thread stays as the record of a leg. So the shaping here is mostly about reading history — which
 * phase a thread belonged to, what it was, and whether it is one of the one or two rows still live.
 */

/** `  ▸ ` + `⏺ ` — the caret and the state dot, which every list page pays for identically. */
export const GUTTER = 6;
const MARGIN = 2;
const ROLE = { min: 12, max: 26 };

/**
 * What a row says about itself. Four states, not a boolean pair, because "closed" and "not the
 * cursor" are different facts and the row draws them differently.
 */
export enum EThreadState {
  /** A turn is in flight in this thread right now. */
  working = 'working',
  /** The job's cursor points here — where a `⏎` on the job lands. */
  active = 'active',
  /** Open, but not where the job is pointing. */
  open = 'open',
  /** History. Readable, never writable. */
  closed = 'closed',
}

/**
 * The facts a row draws — structural, so `domain/` never learns what a repository row looks like.
 * `engine` is nullable because a thread that has not opened a session yet has not frozen one.
 */
export type ThreadListSource = {
  id: string;
  role: EThreadRole;
  status: EThreadStatus;
  phaseId: string;
  phaseKind: EPhaseKind;
  phaseTitle: string | null;
  engine: EEngine | null;
  messageCount: number;
  sessionCount: number;
};

export type ThreadListRow = {
  id: string;
  role: EThreadRole;
  label: string;
  engine: string;
  messages: string;
  sessions: string;
  state: EThreadState;
  stateLabel: string;
  /** Position in the flat cursor order. Phase headers are labels, not rows, so they have no index. */
  index: number;
};

export type PhaseGroupView = {
  phaseId: string;
  label: string;
  threads: ThreadListRow[];
};

/**
 * Precedence, and why: a closed thread cannot be working (its session was ended with it), so history
 * is decided first. A live turn then outranks the cursor — `working…` is a thing happening, `ACTIVE`
 * is only a pointer, and when both are true the one worth a spinner is the turn.
 */
export function threadState(args: {
  thread: Pick<ThreadListSource, 'id' | 'status'>;
  activeThreadId: string | null;
  runningThreadIds: readonly string[];
}): EThreadState {
  if (args.thread.status === EThreadStatus.closed) return EThreadState.closed;
  if (args.runningThreadIds.includes(args.thread.id)) return EThreadState.working;
  if (args.thread.id === args.activeThreadId) return EThreadState.active;
  return EThreadState.open;
}

const STATE_LABELS: Record<EThreadState, string> = {
  [EThreadState.working]: 'working…',
  // Shouted, because it is the one row the job returns to on its own — the rest you have to choose.
  [EThreadState.active]: 'ACTIVE',
  [EThreadState.open]: 'open',
  [EThreadState.closed]: 'closed',
};

export function stateLabel(state: EThreadState): string {
  return STATE_LABELS[state];
}

/** A phase's own title if it was given one, else the kind — spelled without its underscores. */
export function phaseLabel(phase: { kind: EPhaseKind; title: string | null }): string {
  return phase.title ?? phase.kind.replace(/_/g, ' ');
}

export function messagesLabel(count: number): string {
  return `${count} msg${count === 1 ? '' : 's'}`;
}

export function sessionsLabel(count: number): string {
  return `${count} session${count === 1 ? '' : 's'}`;
}

/**
 * Phases are headers, not nodes: the cursor walks THREADS, and the phase a thread belongs to is a
 * caption above it. Grouping is by first-seen phase id rather than by comparing to the previous row,
 * so a list that arrives out of order groups correctly instead of drawing the same phase twice.
 *
 * The caller supplies the order (the repository sorts by phase ordinal, then `createdAt`) — this
 * preserves it, because a timeline that re-sorts itself is no longer a timeline.
 */
export function threadList(args: {
  threads: readonly ThreadListSource[];
  activeThreadId: string | null;
  runningThreadIds: readonly string[];
}): { groups: PhaseGroupView[]; order: ThreadListRow[] } {
  const groups = new Map<string, PhaseGroupView>();
  const order: ThreadListRow[] = [];

  for (const thread of args.threads) {
    const state = threadState({
      thread,
      activeThreadId: args.activeThreadId,
      runningThreadIds: args.runningThreadIds,
    });
    const row: ThreadListRow = {
      id: thread.id,
      role: thread.role,
      label: roleLabel(thread.role),
      // The engine column is per-thread via its SESSIONS — what it actually ran on, not what the
      // role table says today. Only a thread that has never opened one falls back to the binding.
      engine: thread.engine ?? engineFor(thread.role),
      messages: messagesLabel(thread.messageCount),
      sessions: sessionsLabel(thread.sessionCount),
      state,
      stateLabel: stateLabel(state),
      index: order.length,
    };
    order.push(row);

    const group = groups.get(thread.phaseId);
    if (group) {
      group.threads.push(row);
      continue;
    }
    groups.set(thread.phaseId, {
      phaseId: thread.phaseId,
      label: phaseLabel({ kind: thread.phaseKind, title: thread.phaseTitle }),
      threads: [row],
    });
  }

  return { groups: [...groups.values()], order };
}

export type ThreadsLayout = {
  role: number;
  engine: number;
  messages: number;
  sessions: number;
  state: number;
};

type ThreadsColumns = Omit<ThreadsLayout, 'role'>;

/** Last resort: a row with no role on it identifies nothing, so every other column goes first. */
const MINIMAL: ThreadsColumns = { engine: 0, messages: 0, sessions: 0, state: 0 };

/**
 * Longest-first, exactly as `jobsLayout` does it. The session count goes before the engine because
 * `2 sessions` is a detail you can get by opening the thread, while the engine is the fact that makes
 * a mixed-engine job legible at a glance. The state column is the last thing to go: without it the
 * list cannot answer the question it exists to answer.
 */
const FORMS: readonly ThreadsColumns[] = [
  { engine: 9, messages: 10, sessions: 12, state: 9 },
  { engine: 9, messages: 10, sessions: 0, state: 9 },
  { engine: 9, messages: 0, sessions: 0, state: 9 },
  { engine: 0, messages: 0, sessions: 0, state: 9 },
  MINIMAL,
];

export function threadsLayout(width: number): ThreadsLayout {
  for (const form of FORMS) {
    const fixed = GUTTER + form.engine + form.messages + form.sessions + form.state + MARGIN;
    if (affords(width, fixed, ROLE.min)) {
      return { ...form, role: elasticColumn(width, fixed, ROLE) };
    }
  }
  return { ...MINIMAL, role: Math.max(3, width - GUTTER - MARGIN) };
}
