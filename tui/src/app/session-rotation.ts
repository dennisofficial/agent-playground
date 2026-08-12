import { EHarnessVariant } from '../domain/message.js';
import {
  contextWallStub,
  renderRotationHandoff,
  type RotationSections,
} from '../domain/rotation-handoff.js';
import { EHandoffKind, type SeedHandoff } from '../domain/thread-handoff.js';
import { ESessionEndReason } from '../generated/prisma/enums.js';
import type { EngineSession, Job, Thread } from '../generated/prisma/client.js';
import type { SessionRepository } from '../store/session.repository.js';
import type { AccountRotatorService } from './account-rotator.service.js';
import type { ContextFolderService } from './context-folder.service.js';
import type { ConversationStore } from './conversation.store.js';
import type { SessionManagerService } from './session-manager.service.js';
import { describeAttachments, gatherAttachments } from './tools/attach.js';
import type { ToolContext } from './tools/tool.js';
import type { RunTurnArgs } from './turn-runner.service.js';

/**
 * Everything a session rotation DOES, as functions over their collaborators — the shape
 * `phase-transition.ts` already uses beside `ThreadSeamService`.
 *
 * They live outside that service for the usual reason (its length) and one specific one: the forced
 * half runs inside `TurnRunnerService`, which must never learn what a tool or a phase is. Both
 * halves end one session and open the next in a single act, which is the invariant this file exists
 * to keep in one place.
 */

/**
 * `rotate`: the agent's own hand-over.
 *
 * Close and open are ONE operation deliberately. Legacy split them — `record_leg_handoff` wrote the
 * text and something else rotated later — which leaves a window where the hand-off exists and the
 * session has not turned over, i.e. an agent that has just declared its context spent going on to
 * spend more of it. There is no such window here: when this resolves, the successor is already open
 * and holding the report.
 */
export async function rotateForHandoff(args: {
  ctx: ToolContext;
  sections: RotationSections;
  attach: readonly string[];
  sessionManagerService: SessionManagerService;
  contextFolderService: ContextFolderService;
  /**
   * `ThreadSeamService.seed`. Reused rather than reimplemented so that a new session's first turn is
   * composed, briefed and tooled by exactly the same path as any other seed — a second composer here
   * would drift the moment a seed grew a section.
   */
  seed: (seed: {
    job: Job;
    thread: Thread;
    cwd: string;
    handoff?: SeedHandoff;
  }) => Promise<void>;
  /**
   * The thread's rendered task list, if anything owns one. **This is the hook ticket 14 wants**:
   * `TaskService.section(threadId)` returns exactly this, empty string included, so wiring it is one
   * argument at the call site in `ThreadSeamService.rotate` and nothing here changes.
   */
  tasks?: () => Promise<string>;
}): Promise<string> {
  const { ctx } = args;
  // Gathered BEFORE anything is written: a name that resolves to nothing refuses here, while the
  // agent still holds the turn and can fix it. After the session ends there is nobody to tell.
  const gathered = gatherAttachments({
    contextFolderService: args.contextFolderService,
    jobId: ctx.job.id,
    phase: ctx.phase,
    declared: args.attach,
  });
  const handoff = renderRotationHandoff({
    sections: args.sections,
    ...(args.tasks ? { tasks: await args.tasks() } : {}),
  });

  const current = await args.sessionManagerService.currentSession(ctx.thread);
  const next = await args.sessionManagerService.rotateSession(
    ctx.thread,
    current,
    // The agent chose to hand over; `context_wall` is the forced one, and the two must stay
    // distinguishable in the seam and in anything that later asks how often rotation is voluntary.
    ESessionEndReason.context_pressure,
    handoff,
  );

  await args.seed({
    job: ctx.job,
    // The row the caller is holding still points at the session just retired, and seeding resolves
    // the session to run on from exactly that field — left alone it would mint a THIRD session and
    // deliver the hand-off into it. The successor is `next`, and nothing else about the thread moved.
    thread: { ...ctx.thread, activeSessionId: next.id },
    cwd: ctx.cwd,
    handoff: {
      text: handoff,
      fromRole: ctx.thread.role,
      attachments: gathered.text,
      parts: gathered.parts,
      kind: EHandoffKind.rotation,
    },
  });

  return [
    `Session ${current.ordinal} is closed. Session ${next.ordinal} is open on this same thread — same work, same files — with your hand-off as its first message.`,
    describeAttachments(gathered),
    'Stop here — this session has no further turn.',
  ].join(' · ');
}

/**
 * The context wall: the ONE rotation Atlas forces.
 *
 * Every retry re-sends the same oversized transcript and fails identically, so there is nothing to
 * preserve — unlike an engine crash, where the transcript is intact and restarting in place costs
 * nothing. The successor is seeded with a stub that sends it to its predecessor's transcript rather
 * than a host summary; see `contextWallStub`.
 */
export async function rotateOnContextWall(args: {
  /** The turn that hit the wall. Its `brief`, `tools` and `cwd` are the successor's, unchanged. */
  turn: RunTurnArgs;
  session: EngineSession;
  sessionManagerService: SessionManagerService;
  /** `TurnRunnerService.run`, deliberately not awaited by the caller — see below. */
  run: (turn: RunTurnArgs) => void;
}): Promise<void> {
  // A session that never got an engine id has no transcript to abandon: the very first request was
  // too big, and rotating would open a fresh leg only to fail the same way, forever.
  if (!args.session.engineSessionId) return;

  const stub = contextWallStub({
    threadId: args.turn.thread.id,
    ordinal: args.session.ordinal,
  });
  const next = await args.sessionManagerService.rotateSession(
    args.turn.thread,
    args.session,
    ESessionEndReason.context_wall,
    stub,
  );
  // Fired, not awaited: this runs while the failed turn is still finishing, and the new turn queues
  // behind it on the thread's own lane. Awaiting it here would be a turn waiting on its successor.
  args.run({
    ...args.turn,
    session: next,
    prompt: stub,
    harnessVariant: EHarnessVariant.handoff,
  });
}

/**
 * A session with a credential resolved onto it. Only a session in this state can run a turn, so the
 * turn path takes this rather than `EngineSession` and the compiler carries the guarantee instead of
 * every reader re-checking for null.
 */
export type RunningSession = EngineSession & { accountId: string };

/**
 * The whole turn boundary in one answer: the live session, the account it runs on, and null when it
 * cannot run at all.
 *
 * Null is the DECLINED turn — no credential to run on — and the reason is put on the store as it is
 * decided, because the two go together and a caller that had to remember to do it separately would
 * eventually forget on one of the paths.
 */
export async function resolveForTurn(args: {
  sessionRepository: SessionRepository;
  sessionManagerService: SessionManagerService;
  accountRotatorService: AccountRotatorService;
  store: ConversationStore;
  threadId: string;
  session: EngineSession;
}): Promise<RunningSession | null> {
  const live = await sessionForTurn(args);
  if (live.accountId === null) {
    args.store.setNoAccount(
      await args.sessionManagerService.whyNoAccount(live.engine),
    );
    return null;
  }
  // Cleared here rather than only on open: adding an account has to take effect on the next ⏎, not
  // on a reload.
  args.store.setNoAccount(null);
  return { ...live, accountId: live.accountId };
}

/**
 * Which session and which account a turn actually runs on, resolved at the turn boundary.
 *
 * Both answers can have moved since the caller looked. `rotate` retires a session mid-turn and the
 * UI keeps its copy; another terminal on the same thread rotates without telling this one at all —
 * and resuming a retired leg would re-open precisely the context the rotation existed to leave
 * behind.
 *
 * The account is RESOLVED here rather than fixed when the session opened, because a session may hold
 * none: a job can be created before any credential exists, and forgetting an account nulls the
 * pointer of every session that was on it. Both are ordinary states, and this is the boundary that
 * settles them — the same boundary rotation already moves at.
 */
export async function sessionForTurn(args: {
  sessionRepository: SessionRepository;
  sessionManagerService: SessionManagerService;
  accountRotatorService: AccountRotatorService;
  store: ConversationStore;
  threadId: string;
  session: EngineSession;
}): Promise<EngineSession> {
  // Null means the thread has no open session — a closed thread being read. Nothing to correct.
  const live = (await args.sessionRepository.currentForThread(args.threadId)) ?? args.session;

  if (live.accountId === null) return adoptAnAccount({ ...args, live });

  // Accounts rotate at a turn BOUNDARY when the active one is near its wall, so no work is lost.
  const outcome = await args.accountRotatorService.considerRotation({
    sessionId: live.id,
    accountId: live.accountId,
    engine: live.engine,
  });
  if (outcome.kind !== 'rotated') return live;

  args.store.notice(
    `switched to ${outcome.to.label} · ${outcome.from.label} hit its 5-hour limit`,
  );
  return { ...live, accountId: outcome.to.id };
}

/**
 * A session holding no credential picks one now and keeps it. Stamped rather than resolved per turn
 * so the meters, the chip and the ledger all name the same account for the work that follows — and so
 * a rotation has something to rotate FROM.
 *
 * Still null on the way out when there is nothing to pick. That is not an error: it is the state the
 * conversation renders as "no account selected", and the next turn asks again.
 */
async function adoptAnAccount(args: {
  sessionRepository: SessionRepository;
  sessionManagerService: SessionManagerService;
  live: EngineSession;
}): Promise<EngineSession> {
  const { live } = args;
  const chosen = await args.sessionManagerService.usableAccount(live.engine);
  if (!chosen) return live;

  await args.sessionRepository.setAccount({
    sessionId: live.id,
    accountId: chosen.id,
  });
  return { ...live, accountId: chosen.id };
}
