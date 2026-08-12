import { EContextSignal } from '../domain/context-nudge.js';
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
    // The stored reading is a percentage of the BUDGET, written once per turn. The signal is not
    // stored with it: the canary is a claim about the last few turns of a live conversation, and a
    // reopened thread has none until the next turn produces one.
    store.setContextPercent(
      session.contextPercent === null
        ? null
        : { percent: session.contextPercent, signal: EContextSignal.budget },
    );
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

  // It moved, and it moved off US: the cursor was on this thread the last time we looked and is on
  // another now. A cursor that was already elsewhere is somebody else's frontier — the human is
  // reading this thread on purpose, and following would take the page away from him.
  if (
    cursorThreadId &&
    cursorThreadId !== args.lastCursorThreadId &&
    cursorThreadId !== open.thread.id &&
    args.lastCursorThreadId === open.thread.id
  ) {
    const moved = await deps.threadRepository.findById(cursorThreadId);
    if (moved) return { cursorThreadId, moved, refreshed: null };
  }

  // Same thread, changed row. `closed` is a SNAPSHOT taken when the conversation opened, and a
  // self-advance closes the caller mid-turn — so without this the composer stays writable in a
  // thread that has already ended. Re-opened rather than patched: closing also ends the session and
  // takes the tools away, and re-reading is the one path that gets all three right.
  const current = await deps.threadRepository.findById(open.thread.id);
  const closed = current?.status === EThreadStatus.closed;
  if (current && closed !== open.closed) {
    const refreshed = await loadConversation(deps, {
      job,
      thread: current,
      cwd: open.cwd,
    });
    return { cursorThreadId, moved: null, refreshed };
  }

  return { cursorThreadId, moved: null, refreshed: null };
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
