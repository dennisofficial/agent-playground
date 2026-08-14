import { EDelegateStatus, isParented, type EngineEvent } from './message.js';

/**
 * What the thread's delegates are doing, derived from frames that belong to nobody else.
 *
 * A delegate is a run this thread SPAWNED and does not itself perform — a subagent, a backgrounded
 * shell, a workflow. Its frames arrive interleaved on this thread's stream because there is only one
 * stream, and for a long time that transport accident was taken for authorship: every tool the
 * delegate called was persisted as a message of the parent's, so a thread that delegated a fifteen-file
 * sweep in order NOT to read fifteen files ended up with all fifteen reads in its scrollback.
 *
 * The rule this module exists to hold: **a delegate's work is counted, never quoted.** What survives is
 * one line per delegate — what it is, how far along, how it ended — hanging off the tool call that
 * spawned it, which is a message the parent really did produce. Nothing here is persisted; the
 * delegate's report comes back as that tool call's RESULT, which is, and which is the only part of a
 * delegate's run the parent actually consumed.
 *
 * Pure and keyed rather than a class, so the whole join can be table-tested: the frames arrive under
 * two different identities (`task_id` from the SDK's task bookkeeping, `parent_tool_use_id` from the
 * delegate's own output) and reconciling them is the only hard part.
 */

export type Delegate = {
  /** The SDK's task id — the identity every task frame carries, and the map key. */
  taskId: string;
  /**
   * The spawning tool call's id, which is what the transcript block is keyed by. Absent for a task the
   * SDK reports without one (nothing does today; ambient housekeeping tasks would).
   */
  toolUseId?: string;
  /** `Explore`, `general-purpose`… Absent for a backgrounded shell, which has no agent type. */
  agentType?: string;
  /** `local_agent`, `local_bash`, `local_workflow` — the SDK's own word for what kind of run this is. */
  taskType?: string;
  description: string;
  background: boolean;
  status: EDelegateStatus;
  /** Calls the delegate has made. Counted from its own frames, so it is live from the first one. */
  toolUses: number;
  lastTool?: string;
  /** The SDK's periodic gist, when `agentProgressSummaries` is on. */
  progress?: string;
  /** How it ended, in its own words. Set when it settles. */
  outcome?: string;
  startedAt: number;
  endedAt?: number;
  /**
   * The delegate's OWN context occupancy — a different window from the parent's, which is exactly why
   * these readings must never reach the composer's meter. Shown on its row instead, where the number
   * is about the agent it actually measures.
   */
  contextTokens?: number;
  contextLimit?: number;
};

/**
 * The live delegate set for one thread. An ordered array rather than a Map because it is rendered in
 * spawn order and read far more often than it is written, and because `useSyncExternalStore` compares
 * by identity — one array to replace is one repaint.
 */
export type Delegates = readonly Delegate[];

export const NO_DELEGATES: Delegates = [];

/** Only these can name a delegate. Everything else on the stream belongs to the thread itself. */
export function isDelegateEvent(event: EngineEvent): boolean {
  switch (event.kind) {
    case 'task_started':
    case 'task_progress':
    case 'task_settled':
    case 'background_tasks':
      return true;
    // Every tagged kind, via one predicate in `message.ts` — the list used to be spelled out here and
    // omitted prose, which is exactly the shape of bug an enumeration invites. See `isParented`.
    default:
      return isParented(event);
  }
}

/**
 * One frame → the delegate set it changes. Returns the SAME array when nothing changed, so a store can
 * skip the notify and the renderer can skip the frame.
 *
 * `now` is passed rather than read, because this is `domain/`: the elapsed time on a delegate's row is
 * the only clock in the join, and a table test that cannot fix it is a test of the wall clock.
 */
export function reduceDelegates(
  current: Delegates,
  event: EngineEvent,
  now: number,
): Delegates {
  switch (event.kind) {
    case 'task_started':
      return upsert(current, { taskId: event.taskId, toolUseId: event.parentToolUseId }, now, (found) => ({
        ...found,
        description: event.description || found.description,
        background: event.background || found.background,
        ...(event.agentType === undefined ? {} : { agentType: event.agentType }),
        ...(event.taskType === undefined ? {} : { taskType: event.taskType }),
      }));

    case 'task_progress':
      return upsert(current, { taskId: event.taskId, toolUseId: event.parentToolUseId }, now, (found) => ({
        ...found,
        // The SDK's count is authoritative where it exists — it sees calls this stream never forwards.
        // `Math.max` because our own tally can be ahead of a progress frame taken 30s ago.
        toolUses: Math.max(found.toolUses, event.toolUses),
        ...(event.lastTool === undefined ? {} : { lastTool: event.lastTool }),
        ...(event.summary === undefined ? {} : { progress: event.summary }),
      }));

    case 'task_settled':
      return upsert(
        current,
        { taskId: event.taskId, toolUseId: event.parentToolUseId },
        now,
        (found) => ({
          ...found,
          status: event.status,
          endedAt: found.endedAt ?? now,
          ...(event.summary === undefined ? {} : { outcome: event.summary }),
        }),
      );

    // A LEVEL, so it can only ever ADD what it names and mark backgrounded what it holds. It must not
    // settle the absent: a foreground subagent never appears in this payload at all, and a background
    // one leaves it at the same instant its `task_notification` arrives — retiring on absence would
    // race that bookend and kill rows that are still working.
    case 'background_tasks': {
      let next = current;
      for (const task of event.tasks) {
        next = upsert(next, { taskId: task.taskId }, now, (found) => ({
          ...found,
          background: true,
          description: found.description || task.description,
          ...(found.taskType === undefined ? { taskType: task.taskType } : {}),
        }));
      }
      return next;
    }

    case 'tool_call': {
      const parent = event.parentToolUseId;
      if (parent === undefined) return current;
      return upsert(current, { toolUseId: parent }, now, (found) => ({
        ...found,
        toolUses: found.toolUses + 1,
        lastTool: event.name,
      }));
    }

    case 'usage': {
      const parent = event.parentToolUseId;
      if (parent === undefined) return current;
      return upsert(current, { toolUseId: parent }, now, (found) => ({
        ...found,
        contextTokens: event.contextTokens,
        contextLimit: event.contextLimit,
      }));
    }

    default:
      return current;
  }
}

/**
 * Everything still running, in spawn order — what the panel under the composer draws.
 *
 * Foreground delegates are excluded: the transcript is already showing one, spinning, in the block that
 * spawned it, and a second copy of the same fact below the composer is noise. The panel is for work
 * that has left the reading position.
 */
export function backgroundDelegates(delegates: Delegates): Delegates {
  return delegates.filter(
    (delegate) => delegate.background && delegate.status === EDelegateStatus.running,
  );
}

/**
 * Everything still marked running, marked stopped — what a turn ending means for the work it spawned.
 *
 * The turn ends by closing the session's input, which ends the CLI process, which takes every delegate
 * with it. So after a turn there is nothing running BY DEFINITION, and a row still saying otherwise is
 * the same lie in miniature that the whole background hold exists to prevent: a spinner under the
 * composer for an agent that no longer exists.
 *
 * Reachable in exactly two ways, both of them ends the hold did not choose — the shell cap firing while
 * its task is still live, and an interrupt or crash. The ordinary path settles everything first and
 * finds nothing to retire here.
 */
export function retireRunning(current: Delegates, now: number): Delegates {
  if (!current.some((delegate) => delegate.status === EDelegateStatus.running))
    return current;
  return current.map((delegate) =>
    delegate.status === EDelegateStatus.running
      ? { ...delegate, status: EDelegateStatus.stopped, endedAt: now }
      : delegate,
  );
}

/** The delegate a transcript block spawned, or none — the join the Agent block draws itself from. */
export function delegateFor(delegates: Delegates, toolUseId: string): Delegate | undefined {
  return delegates.find((delegate) => delegate.toolUseId === toolUseId);
}

/**
 * Find by either identity and apply, or append a fresh row.
 *
 * The two identities are the whole problem this module solves. `task_started` knows both; a delegate's
 * own `tool_call` knows only `parent_tool_use_id`; `background_tasks_changed` knows only `task_id`. So a
 * row can be born under either and must be found under either afterwards — matching on task id alone
 * would create a second, duplicate row the first time a delegate's own frame arrived first.
 */
function upsert(
  current: Delegates,
  key: { taskId?: string | undefined; toolUseId?: string | undefined },
  now: number,
  apply: (found: Delegate) => Delegate,
): Delegates {
  const index = current.findIndex(
    (delegate) =>
      (key.taskId !== undefined && delegate.taskId === key.taskId) ||
      (key.toolUseId !== undefined && delegate.toolUseId === key.toolUseId),
  );

  if (index === -1) {
    // Born from whichever frame arrived first, including one that names no task id — a synthetic key
    // off the tool-use id keeps the row addressable until the real one turns up and merges onto it.
    const seed: Delegate = {
      taskId: key.taskId ?? `tool:${key.toolUseId ?? ''}`,
      ...(key.toolUseId === undefined ? {} : { toolUseId: key.toolUseId }),
      description: '',
      background: false,
      status: EDelegateStatus.running,
      toolUses: 0,
      startedAt: now,
    };
    return [...current, apply(seed)];
  }

  const found = current[index] as Delegate;
  const updated = apply(found);
  // A row that learns its other identity keeps it: the next frame under that key must find this row
  // rather than open a duplicate beside it.
  const merged: Delegate =
    key.toolUseId !== undefined && found.toolUseId === undefined
      ? { ...updated, toolUseId: key.toolUseId }
      : key.taskId !== undefined && found.taskId.startsWith('tool:')
        ? { ...updated, taskId: key.taskId }
        : updated;

  if (merged === found) return current;
  const next = [...current];
  next[index] = merged;
  return next;
}
