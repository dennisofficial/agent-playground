import type { EEngine, EPhaseKind, EThreadRole } from '../generated/prisma/enums.js';
import { EThreadStatus } from '../generated/prisma/enums.js';
import {
  attentionFor,
  EAttentionScope,
  type Attention,
  type AttentionFacts,
} from './attention.js';
import { affords, elasticColumn } from './list-columns.js';
import { hasUnseen } from './read-state.js';
import { engineFor, roleLabel } from './role-engine.js';

/**
 * The thread list is a TIMELINE, not a pool of workers: a rotation retires a session, and a finished
 * thread stays as the record of a leg. So the shaping here is mostly about reading history — which
 * phase a thread belonged to, what it was, and whether it is one of the one or two rows still live.
 *
 * What a row SAYS about itself is not decided here: `attention.ts` owns the two channels, and a
 * thread row is the same function a job row runs, given one thread's facts.
 */

/** `  ▸ ` + `● ` — the caret and the read-state dot, which every list page pays for identically. */
export const GUTTER = 6;
const MARGIN = 2;
const ROLE = { min: 12, max: 26 };

/**
 * The facts a row draws — structural, so `domain/` never learns what a repository row looks like.
 * `engine` is nullable because a thread that has not opened a session yet has not frozen one, and
 * both timestamps are nullable because a thread may have neither been spoken in nor ever opened.
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
  lastMessageAt: Date | null;
  lastSeenAt: Date | null;
};

export type ThreadListRow = {
  id: string;
  role: EThreadRole;
  label: string;
  engine: string;
  messages: string;
  sessions: string;
  attention: Attention;
  /**
   * The job's cursor points here — where a `⏎` on the job lands. It is NOT an attention state (an
   * open thread owes you a reply whether or not the job is pointing at it), so it stopped competing
   * for the status column and became weight on the name instead.
   */
  active: boolean;
  /** Position in the flat cursor order. Phase headers are labels, not rows, so they have no index. */
  index: number;
};

export type PhaseGroupView = {
  phaseId: string;
  label: string;
  threads: ThreadListRow[];
};

/**
 * One thread's five facts.
 *
 * `openThreadCount` is 1 or 0 — a thread is its own open-ness — which is what lets the identical
 * function roll a job up by counting the threads that answered 1. Two of the five have no source
 * yet: there is no `Transition` row to make a proposal pending, and no `Job.prNumber` to ship. They
 * are false rather than absent, and the derived state simply never occurs until they land.
 */
export function threadFacts(args: {
  thread: Pick<ThreadListSource, 'id' | 'status' | 'lastMessageAt' | 'lastSeenAt'>;
  runningThreadIds: readonly string[];
  proposalPending?: boolean;
}): AttentionFacts {
  const { thread } = args;
  const closed = thread.status === EThreadStatus.closed;
  return {
    turnRunning: args.runningThreadIds.includes(thread.id),
    proposalPending: args.proposalPending ?? false,
    openThreadCount: closed ? 0 : 1,
    unseen: hasUnseen({ lastMessageAt: thread.lastMessageAt, lastSeenAt: thread.lastSeenAt }),
    hasPullRequest: false,
  };
}

/**
 * Precedence lives in `attentionFor` and nowhere else — this is the adapter, not a second table.
 *
 * A closed thread cannot be working (its session ended with it) and cannot hold a proposal, so its
 * facts fall through to "nothing open", which at thread scope is spelled `closed`.
 */
export function threadAttention(args: {
  thread: Pick<ThreadListSource, 'id' | 'status' | 'lastMessageAt' | 'lastSeenAt'>;
  runningThreadIds: readonly string[];
  proposalPending?: boolean;
}): Attention {
  return attentionFor({
    facts: threadFacts(args),
    scope: EAttentionScope.thread,
  });
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
  /** Threads holding a pending proposal. Empty until ticket 08 gives `Transition` a row. */
  proposalThreadIds?: readonly string[];
}): { groups: PhaseGroupView[]; order: ThreadListRow[] } {
  const groups = new Map<string, PhaseGroupView>();
  const order: ThreadListRow[] = [];

  for (const thread of args.threads) {
    const row: ThreadListRow = {
      id: thread.id,
      role: thread.role,
      label: roleLabel(thread.role),
      // The engine column is per-thread via its SESSIONS — what it actually ran on, not what the
      // role table says today. Only a thread that has never opened one falls back to the binding.
      engine: thread.engine ?? engineFor(thread.role),
      messages: messagesLabel(thread.messageCount),
      sessions: sessionsLabel(thread.sessionCount),
      attention: threadAttention({
        thread,
        runningThreadIds: args.runningThreadIds,
        proposalPending: args.proposalThreadIds?.includes(thread.id) ?? false,
      }),
      active: thread.id === args.activeThreadId,
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
 *
 * Twelve, not nine: the spinner moved OFF the dot and into this column, so the widest thing it now
 * has to hold is `⠹ working…` rather than `working…`.
 */
const STATE = 12;

const FORMS: readonly ThreadsColumns[] = [
  { engine: 9, messages: 10, sessions: 12, state: STATE },
  { engine: 9, messages: 10, sessions: 0, state: STATE },
  { engine: 9, messages: 0, sessions: 0, state: STATE },
  { engine: 0, messages: 0, sessions: 0, state: STATE },
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
