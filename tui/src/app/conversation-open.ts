import {
  EContextSignal,
  pressureBand,
  type ContextReading,
} from '../domain/context-nudge.js';
import { budgetFor, windowPercent } from '../domain/usage.js';
import type { SessionRef } from '../domain/seam.js';
import { EThreadStatus } from '../generated/prisma/enums.js';
import type { EngineSession, Job, Thread } from '../generated/prisma/client.js';
import type { JobRepository } from '../store/job.repository.js';
import type { MessageRepository } from '../store/message.repository.js';
import type { SessionRepository } from '../store/session.repository.js';
import type { ThreadRepository } from '../store/thread.repository.js';
import type { TurnRepository } from '../store/turn.repository.js';
import type { AccountUsageService } from './account-usage.service.js';
import type { ContextFolderService } from './context-folder.service.js';
import type { ConversationStoreRegistry } from './conversation-store.registry.js';
import type { PhaseBriefService } from './phase-brief.service.js';
import type { SessionManagerService } from './session-manager.service.js';
import type { ThreadSeamService } from './thread-seam.service.js';
import type { AtlasTool } from './tools/tool.js';
import type { TurnRunnerService } from './turn-runner.service.js';

/**
 * What it takes to HAVE a conversation open, and to notice that it has moved under you.
 *
 * Outside `ConversationService` for the reason `phase-transition.ts` is outside the seam: the
 * service is the DI holder and the thing the UI calls, and both of these are functions of their
 * collaborators. `ConversationService` would otherwise be the only file in `app/` where reading one
 * screen does not tell you what the class does.
 */

export type OpenConversation = {
  job: Job;
  thread: Thread;
  session: EngineSession;
  sessions: SessionRef[];
  cwd: string;
  contextRoot: string;
  /** Closed threads are a RECORD, not a place to work. Nothing to do with other terminals. */
  closed: boolean;
  /**
   * The phase's standing instructions, on every turn's system prompt. Resolved once here rather than
   * per turn in the runner: it costs a read, and a thread never moves phase.
   */
  brief: string;
  /**
   * Atlas's tools for this thread — the gated list, resolved with the brief and for the same reason.
   * A closed thread gets none: it is a record, not a place to work, and a `advance_thread` on
   * history would open a successor to a thread that already had one.
   */
  tools: readonly AtlasTool[];
};

/** Everything the two functions below reach for. Assembled once by the service that injects them. */
export type ConversationDeps = {
  jobRepository: JobRepository;
  threadRepository: ThreadRepository;
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  turnRepository: TurnRepository;
  sessionManagerService: SessionManagerService;
  turnRunnerService: TurnRunnerService;
  contextFolderService: ContextFolderService;
  accountUsageService: AccountUsageService;
  phaseBriefService: PhaseBriefService;
  threadSeamService: ThreadSeamService;
  stores: ConversationStoreRegistry;
};

export async function loadConversation(
  deps: ConversationDeps,
  args: { job: Job; thread: Thread; cwd: string },
): Promise<OpenConversation> {
  const { job, thread, cwd } = args;
  // A closed thread is a RECORD, not a place to work. Asking the session manager for a current
  // session would end up minting a fresh one — a junk row on finished history, and an account
  // demanded of someone who only wanted to read a transcript. So it reopens its last session.
  //
  // This is the ONLY thing that makes a conversation unwritable. It used to share the flag with a
  // per-session lock held by another terminal, which is why taking a job over left you looking at
  // a live thread labelled read-only whose composer silently swallowed everything you typed.
  const closed = thread.status === EThreadStatus.closed;
  const session = closed
    ? await lastSession(deps, thread)
    : await deps.sessionManagerService.currentSession(thread);

  const [messages, sessions, lastTurn] = await Promise.all([
    deps.messageRepository.listForThread(thread.id),
    deps.sessionRepository.refsForThread(thread.id),
    deps.turnRepository.lastForThread(thread.id),
  ]);

  // hydrate(), never reset(): this same path is how a RUNNING thread is reopened, and a reset
  // would blank a working agent's spinner, live tail and steer queue.
  const store = deps.stores.hydrate(thread.id, messages, closed, lastTurn);
  if (!deps.turnRunnerService.busy(thread.id)) {
    // Rebuilt from the stored tokens rather than stored ready-made, because two of the three answers
    // depend on tables that may have been retuned since — a budget row edited between sessions has
    // to recolour the history it applies to, not leave it reading against the old one.
    //
    // The signal is not stored at all: the canary is a claim about the last few turns of a LIVE
    // conversation, and a reopened thread has none until the next turn produces one.
    store.setContextReading(storedReading(session));
  }
  // Nothing will be billed to a closed thread's account, so there is nothing to poll for. Nor is
  // there anything to poll WITH when the session holds no credential — and saying so on open, rather
  // than waiting for a turn to be attempted, is the whole point of the state being representable.
  if (!closed) {
    if (session.accountId === null) {
      store.setNoAccount(
        await deps.sessionManagerService.whyNoAccount(session.engine),
      );
    } else {
      store.setNoAccount(null);
      deps.accountUsageService.kick({
        accountId: session.accountId,
        threadId: thread.id,
      });
    }
  }

  const contextRoot = deps.contextFolderService.ensure(job.id);
  const [brief, tools] = await Promise.all([
    deps.phaseBriefService.forPhase({ job, phaseId: thread.phaseId }),
    closed
      ? Promise.resolve([])
      : deps.threadSeamService.toolsFor({ job, thread, cwd }),
  ]);

  return {
    job,
    thread,
    session,
    sessions,
    cwd,
    contextRoot,
    closed,
    brief: brief.instructions,
    tools,
  };
}

/**
 * The last turn's reading, restored. `null` until a session has reported one — the em dash the
 * footer draws for it is honest, where a zero would claim an empty context.
 */
function storedReading(session: EngineSession): ContextReading | null {
  const { contextTokens, contextLimit } = session;
  if (contextTokens === null || contextLimit === null) return null;
  return {
    tokens: contextTokens,
    percent: windowPercent({ tokens: contextTokens, limit: contextLimit }),
    band: pressureBand({
      tokens: contextTokens,
      budget: budgetFor({
        engine: session.engine,
        model: session.model,
        contextLimit,
      }),
    }),
    signal: EContextSignal.budget,
  };
}

/** What one look at the job's cursor found. Null in both fields is the ordinary answer. */
export type CursorSync = {
  /**
   * Where the cursor is NOW. The caller remembers it so the next look can tell a cursor that MOVED
   * from one that merely differs — browsing to a sibling thread by hand must not drag you back to
   * the frontier, and only the difference between two readings can tell those apart.
   */
  cursorThreadId: string | null;
  /** Go here: an agent moved the cursor off the thread you are looking at. */
  moved: Thread | null;
  /** Stay, but on this: the thread you are on changed under you without the cursor moving. */
  refreshed: OpenConversation | null;
};

/**
 * Has the job's cursor moved off the open thread, and is what we are holding still true?
 *
 * Polled on the turn runner's signal rather than pushed, because the move happens inside a tool call
 * in a turn the renderer is not part of: `open_thread` and `complete_thread` write `activeThreadId`
 * from `app/`, and an event channel from a repository up to React would be a second source of truth
 * beside the store the UI already subscribes to.
 */
export async function syncCursor(
  deps: ConversationDeps,
  args: { open: OpenConversation; lastCursorThreadId: string | null },
): Promise<CursorSync | null> {
  const { open } = args;
  const job = await deps.jobRepository.findById(open.job.id);
  if (!job) return null;
  const cursorThreadId = job.activeThreadId;

  // The thread on screen as it stands NOW. Read before either question below, because whether it is
  // still open is half of both of them.
  const current = await deps.threadRepository.findById(open.thread.id);
  const closedNow = current ? current.status === EThreadStatus.closed : open.closed;

  // The work is not here. Necessary for both reasons to follow, and on its own enough for neither.
  const elsewhere = cursorThreadId !== null && cursorThreadId !== open.thread.id;

  // Reason one: the cursor MOVED off us — it was on this thread the last time we looked and is on
  // another now. A cursor that was already elsewhere is somebody else's frontier — the human is
  // reading this thread on purpose, and following would take the page away from him.
  const cursorMovedOff =
    elsewhere &&
    cursorThreadId !== args.lastCursorThreadId &&
    args.lastCursorThreadId === open.thread.id;

  // Reason two: WE ENDED, and the job went on without us. Reason one cannot see this, because it
  // infers "the work left" from the cursor having been here — and the cursor is frequently NOT here
  // while you watch a thread work: opening a thread by hand takes it, an agent's verbs take it, and
  // nothing ever hands it back to the thread you chose to sit on. `advance_thread` then closes this
  // thread and points the cursor at its successor, which reads as one frontier moving to another and
  // is followed nowhere. That is the whole bug: the transcript stays on a finished thread while the
  // work carries on somewhere the human was never sent.
  //
  // It is the TRANSITION that follows, never the state — `!open.closed` is what keeps this from
  // dragging him out of history he opened deliberately. A closed thread reached from the thread list
  // loads closed, reads the same on every reading, and fires this never.
  const endedUnderUs = elsewhere && closedNow && !open.closed;

  const follow = cursorMovedOff || endedUnderUs;

  // **Never mid-sentence.** Every one of these verbs moves the cursor from INSIDE a tool call, so
  // the thread being left still owes its last paragraph — `advance_thread`'s sign-off, the one
  // sentence that says in plain words where the work went. Following the instant the successor's
  // lane opens takes the page away before that lands, which costs the human the explanation and
  // leaves the thread they were watching permanently unread: `lastSeenAt` writes through only while
  // they are AT the bottom of it, and by then they are somewhere else.
  //
  // So the move is held, not dropped. The memory is pinned to THIS thread, which keeps the
  // two-reading mechanism intact — the turn ending is itself a signal, this runs again, and the move
  // reads as new because our memory never advanced past it. Pinned to the thread rather than left at
  // `lastCursorThreadId` because reason two's evidence does not survive the reading that saw it: the
  // refresh below is about to make `open.closed` true, and the next reading has to recognise the
  // held move as reason one instead.
  const stillTalking = follow && deps.turnRunnerService.busy(open.thread.id);
  const remembered = follow ? open.thread.id : cursorThreadId;

  if (follow && !stillTalking && cursorThreadId) {
    const moved = await deps.threadRepository.findById(cursorThreadId);
    if (moved) return { cursorThreadId, moved, refreshed: null };
  }

  // Same thread, changed row. Two things about it can move under an open conversation, and both are
  // SNAPSHOTS taken when it opened: whether the thread is closed, and where its turns run.
  //
  // `closed` — a self-advance closes the caller mid-turn, so without this the composer stays
  // writable in a thread that has already ended.
  //
  // `cwd` — `enter_worktree` writes `Job.workspacePath` mid-turn, and the conversation is holding
  // the directory it opened with. Without this the tool would create the worktree and every later
  // turn would keep running in the project tree, which is the whole bug the tool exists to fix,
  // relocated one layer up. It cannot be applied any sooner than this: a turn's directory is handed
  // to a subprocess that is already running in it, so a turn boundary is the earliest honest moment.
  //
  // Re-opened rather than patched, for both: closing also ends the session and takes the tools away,
  // moving carries a new `cwd` into the tool context, and re-reading is the one path that gets every
  // one of those right instead of the two somebody remembered.
  if (current) {
    const closed = closedNow;
    // Falling back to the CURRENT cwd when the job records no workspace, rather than to the project
    // path — which is not knowable from here, since this function reads the job and not its project.
    // That is not a gap: nothing clears `workspacePath` on a job somebody has open (`release()` runs
    // on the way to deleting the job), so the null-to-null case is a job that never took a worktree
    // and whose cwd is already the project path.
    const cwd = job.workspacePath ?? open.cwd;
    if (closed !== open.closed || cwd !== open.cwd) {
      const refreshed = await loadConversation(deps, { job, thread: current, cwd });
      return { cursorThreadId: remembered, moved: null, refreshed };
    }
  }

  return { cursorThreadId: remembered, moved: null, refreshed: null };
}

/**
 * The last session a closed thread ran on. `activeSessionId` still points at it — closing a thread
 * ends its session rather than unlinking it, which is what makes the transcript readable after.
 */
async function lastSession(
  deps: ConversationDeps,
  thread: Thread,
): Promise<EngineSession> {
  const session = thread.activeSessionId
    ? await deps.sessionRepository.findById(thread.activeSessionId)
    : null;
  if (!session)
    throw new Error('this thread was closed before it ever ran — nothing to read');
  return session;
}
