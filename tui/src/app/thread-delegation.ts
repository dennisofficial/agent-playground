import { agentRolesFor, phaseLabel } from '../domain/phase-spec.js';
import { roleLabel } from '../domain/role-engine.js';
import { EHandoffKind, type SeedHandoff } from '../domain/thread-handoff.js';
import {
  completedReply,
  cursorAfterClose,
  delegatedReply,
  lastOpenThreadRefusal,
  resolutionReport,
} from '../domain/thread-delegation.js';
import type { TaskView } from '../domain/tasks.js';
import { EThreadCondition, type EThreadRole } from '../generated/prisma/enums.js';
import type { Job, Thread } from '../generated/prisma/client.js';
import type { JobRepository } from '../store/job.repository.js';
import type { ThreadRepository } from '../store/thread.repository.js';
import type { ContextFolderService } from './context-folder.service.js';
import type { SessionManagerService } from './session-manager.service.js';
import { describeAttachments, gatherAttachments } from './tools/attach.js';
import type { ToolContext } from './tools/tool.js';

/**
 * The mechanics of delegation and of closing, as functions over their collaborators rather than as a
 * second service — the shape `phase-transition.ts` already uses, and for the same reason: a service
 * that opened a thread would need the seam to seed it, and the seam needs this to open one.
 *
 * What is NOT here is the turn. Firing one needs the tool list, and building the tool list needs the
 * thing that fires turns; that loop is the seam's whole reason to exist, so both functions take the
 * turn they want as a callback and stay ignorant of how it is fired.
 */

/** What every one of these verbs does with the thread it just created. */
type SeedThread = (seeded: {
  job: Job;
  thread: Thread;
  cwd: string;
  handoff: SeedHandoff;
}) => Promise<void>;

/**
 * `advance_thread`: close the caller, open exactly ONE successor, carry the hand-off, move the
 * cursor. No confirmation — a thread boundary is not a human boundary.
 *
 * Closed before opened, deliberately. The invariant worth protecting is that a thread which has
 * said it is finished never keeps working beside its successor; a failure in between leaves a job
 * whose cursor points at a closed thread, which the human can see and step past.
 */
export async function advanceToSuccessor(args: {
  threadRepository: ThreadRepository;
  sessionManagerService: SessionManagerService;
  contextFolderService: ContextFolderService;
  ctx: ToolContext;
  role: EThreadRole;
  handoff: string;
  attach: readonly string[];
  seed: SeedThread;
  /**
   * `TaskService.carryForward`. A callback for the reason `seed` is one — this file knows what a
   * hand-off carries, not who owns the list — and optional because absent has to be a legal state:
   * a caller with no task store still has to be able to advance a thread, and absent means the
   * successor starts with an empty list rather than that the boundary fails.
   */
  carryTasks?: (moved: {
    fromThreadId: string;
    toThreadId: string;
  }) => Promise<{ tasks: readonly TaskView[]; section: string }>;
}): Promise<string> {
  const { ctx } = args;
  requireHostedRole({ phase: ctx.phase, role: args.role });

  const gathered = gatherAttachments({
    contextFolderService: args.contextFolderService,
    jobId: ctx.job.id,
    phase: ctx.phase,
    declared: args.attach,
  });

  await args.sessionManagerService.closeThread(ctx.thread);
  // The hand-off IS this thread's own last word, so it is what the row keeps. `handed_off` is
  // Atlas's to stamp rather than the agent's to claim: it is true because a successor exists.
  await args.threadRepository.recordOutcome({
    threadId: ctx.thread.id,
    condition: EThreadCondition.handed_off,
    resolution: args.handoff,
  });
  // Joins the phase the job is already in and becomes `Job.activeThreadId` — opening a thread
  // never moves the job, and the cursor follows the work.
  const successor = await args.sessionManagerService.openThread(
    ctx.job.id,
    args.role,
  );

  // The plan travels with the work. Copied BEFORE the seed and not described to it afterwards: the
  // successor's first turn can call `task_update` the moment it reads the list, so the rows have to
  // be in the store by the time that message is composed, not merely by the time it is answered.
  const carried = args.carryTasks
    ? await args.carryTasks({
        fromThreadId: ctx.thread.id,
        toThreadId: successor.id,
      })
    : { tasks: [], section: '' };

  await args.seed({
    job: ctx.job,
    thread: successor,
    cwd: ctx.cwd,
    handoff: {
      text: args.handoff,
      fromRole: ctx.thread.role,
      attachments: gathered.text,
      // The manifest rides along so the successor's first message stores the files as rows and the
      // transcript can draw a chip per file. The wire form is composed back from these at send.
      parts: gathered.parts,
      ...(carried.section ? { tasks: carried.section } : {}),
    },
  });

  return [
    `This thread is closed. A ${roleLabel(args.role)} thread is open with your hand-off and is now the job's active thread.`,
    describeAttachments(gathered),
    describeCarriedTasks(carried.tasks.length),
    'Stop here — you have no further turn in this thread.',
  ]
    .filter((part) => part.length > 0)
    .join(' · ');
}

/**
 * Said back to the OUTGOING agent, because it is the one thing about the hand-off it cannot predict.
 * Silent where nothing moved — an empty list is not news, and "0 tasks carried" would read as a
 * failure rather than as an agent that never wrote a plan.
 */
function describeCarriedTasks(count: number): string {
  if (count === 0) return '';
  return `your ${count} unfinished ${count === 1 ? 'task' : 'tasks'} went with it, renumbered as its own`;
}

/**
 * `open_thread`: delegate and STAY OPEN. The caller is untouched — no session ended, no status
 * changed — because the answer it is waiting for arrives later, in this same thread, as a message.
 *
 * Opened before seeded and never the other way round: the row and the cursor are what make the new
 * thread addressable, and a seed turn firing against a thread the human cannot reach yet is a turn
 * nobody is watching.
 */
export async function openDelegateThread(args: {
  threadRepository: ThreadRepository;
  sessionManagerService: SessionManagerService;
  contextFolderService: ContextFolderService;
  ctx: ToolContext;
  role: EThreadRole;
  brief: string;
  attach: readonly string[];
  seed: SeedThread;
}): Promise<string> {
  const { ctx } = args;
  requireHostedRole({ phase: ctx.phase, role: args.role });

  const gathered = gatherAttachments({
    contextFolderService: args.contextFolderService,
    jobId: ctx.job.id,
    phase: ctx.phase,
    declared: args.attach,
  });

  // Joins the phase the job is already in and becomes `Job.activeThreadId`, exactly as a successor
  // does — the cursor follows the work, and the work is now over there.
  const opened = await args.sessionManagerService.openThread(
    ctx.job.id,
    args.role,
  );
  // A second write rather than an argument to `openThread`: who is waiting is a fact about
  // DELEGATION, and the session manager's job is the phase and the cursor. The window between the
  // two is one statement in one process, and a row that lost its opener would still be a legal
  // thread — it would simply hand the cursor on by the sibling rule instead of reporting back.
  const thread = await args.threadRepository.setOpenedBy({
    threadId: opened.id,
    openedByThreadId: ctx.thread.id,
  });

  await args.seed({
    job: ctx.job,
    thread,
    cwd: ctx.cwd,
    handoff: {
      text: args.brief,
      fromRole: ctx.thread.role,
      attachments: gathered.text,
      parts: gathered.parts,
      kind: EHandoffKind.delegation,
    },
  });

  return delegatedReply({
    role: args.role,
    attachments: describeAttachments(gathered),
  });
}

/**
 * `complete_thread`: close the caller and hand the cursor on by rule.
 *
 * No phase gate is evaluated here, deliberately — a phase ends when and only when the phase-level
 * advance fires. The refusal above is what makes that safe: the last open thread cannot take this
 * door, so a close can never be the act that empties a phase, and there is never a gate to evaluate.
 */
export async function completeCallerThread(args: {
  jobRepository: JobRepository;
  threadRepository: ThreadRepository;
  sessionManagerService: SessionManagerService;
  ctx: ToolContext;
  condition: EThreadCondition;
  resolution: string;
  /** Fired only into an OPENER — the one thread that was blocked on this answer. */
  report: (reported: { job: Job; thread: Thread; cwd: string; prompt: string }) => Promise<void>;
}): Promise<string> {
  const { ctx } = args;
  // Read BEFORE the close, because after it the caller is no longer one of the phase's open threads
  // and the rule it has to be judged by is about the phase as it stood when it asked.
  const openThreads = await args.threadRepository.openInPhase(ctx.thread.phaseId);
  const refusal = lastOpenThreadRefusal({
    phase: ctx.phase,
    callerThreadId: ctx.thread.id,
    openThreadIds: openThreads.map((thread) => thread.id),
  });
  if (refusal) throw new Error(refusal);

  await args.sessionManagerService.closeThread(ctx.thread);
  // The opener's copy of the resolution is a message in ANOTHER thread, so this row is the only
  // place that says how THIS one ended in its own terms — and a thread that closed with nobody
  // waiting on it would otherwise leave no record of its own conclusion at all.
  await args.threadRepository.recordOutcome({
    threadId: ctx.thread.id,
    condition: args.condition,
    resolution: args.resolution,
  });

  const target = cursorAfterClose({
    closing: ctx.thread,
    openThreads,
  });
  const cursor = target
    ? await args.threadRepository.findById(target.threadId)
    : null;
  // Only ever an addressable thread: the target came out of the open set, and a row that vanished
  // between the two reads leaves the cursor where it was rather than pointing at nothing.
  if (cursor) await args.jobRepository.setActiveThread(ctx.job.id, cursor.id);

  if (cursor && target?.viaOpener) {
    await args.report({
      job: ctx.job,
      thread: cursor,
      cwd: ctx.cwd,
      prompt: resolutionReport({
        fromRole: ctx.thread.role,
        condition: args.condition,
        resolution: args.resolution,
      }),
    });
  }

  return completedReply({
    condition: args.condition,
    cursor: cursor ? { role: cursor.role, viaOpener: target?.viaOpener ?? false } : null,
  });
}

/**
 * Belt to the schema's braces, as on `advance_thread`: the enum makes this unemittable, and a stale
 * tool list or a transport that rendered enums less faithfully would otherwise open a thread the
 * phase does not host.
 *
 * `agentRolesFor`, not `rolesFor`, so the human-only roles are refused here too. The two have to
 * agree or the belt is looser than the braces — an agent that got `generic` past the enum would
 * find nothing here to stop it.
 */
function requireHostedRole(args: {
  phase: ToolContext['phase'];
  role: EThreadRole;
}): void {
  const roles = agentRolesFor(args.phase);
  if (roles.includes(args.role)) return;
  throw new Error(
    `the ${phaseLabel(args.phase)} phase does not host a ${roleLabel(args.role)} thread you may open — you may open ${roles.map(roleLabel).join(', ')}`,
  );
}
