import {
  notLastOpenThreadRefusal,
  firstRoleFor,
} from '../domain/phase-advance.js';
import { nextPhasesFor, phaseLabel } from '../domain/phase-spec.js';
import type { SeedHandoff } from '../domain/thread-handoff.js';
import {
  EThreadCondition,
  ETransitionStatus,
  type EPhaseKind,
} from '../generated/prisma/enums.js';
import type { Job, Phase, Thread } from '../generated/prisma/client.js';
import type { JobRepository } from '../store/job.repository.js';
import type { ThreadRepository } from '../store/thread.repository.js';
import type {
  TransitionRepository,
  TransitionRow,
} from '../store/transition.repository.js';
import type { ContextFolderService } from './context-folder.service.js';
import type { SessionManagerService } from './session-manager.service.js';
import {
  EMissingAttachment,
  gatherAttachments,
  type GatheredAttachments,
} from './tools/attach.js';
import type { ToolContext } from './tools/tool.js';

/**
 * The mechanics of a phase proposal, as functions over their collaborators rather than as a second
 * service — the shape `tools/attach.ts` already uses here.
 *
 * They live outside `ThreadSeamService` for length alone, and they must stay outside its DI: a
 * service that confirmed a proposal would need the seam to seed the new thread, and the seam needs
 * confirmation for the automatic exits. That is the cycle the seam exists to hold together.
 */

/** Everything the proposal writes. Nothing about the job has moved when this resolves. */
export async function raisePhaseProposal(args: {
  jobRepository: JobRepository;
  transitionRepository: TransitionRepository;
  contextFolderService: ContextFolderService;
  ctx: ToolContext;
  kind: EPhaseKind;
  reason: string;
  handoff: string;
  attach: readonly string[];
}): Promise<TransitionRow> {
  const { ctx } = args;
  // Belt to the schema's braces, as on `advance_thread`: a stale tool list, or a transport that
  // rendered the enum less faithfully, would otherwise propose an edge this phase does not offer.
  if (!nextPhasesFor(ctx.phase).includes(args.kind)) {
    throw new Error(
      `the ${phaseLabel(ctx.phase)} phase does not propose ${phaseLabel(args.kind)} — it proposes ${nextPhasesFor(ctx.phase).map(phaseLabel).join(', ')}`,
    );
  }

  const refusal = notLastOpenThreadRefusal({
    phase: ctx.phase,
    callerThreadId: ctx.thread.id,
    openThreadIds: await args.jobRepository.openThreadIdsInPhase(ctx.thread.phaseId),
  });
  if (refusal) throw new Error(refusal);

  // The third gate, and the only one that touches disk: read the declaration against the phase being
  // ENTERED — whose floor the successor gets — and throw on a name that resolves to nothing. Here
  // rather than after the write, because a proposal Dennis confirms into a thread that was handed
  // half of what it was promised is exactly the silent failure `attach` exists to prevent, and the
  // agent still has this turn to fix a typo. Delivery time re-reads and TOLERATES; see below.
  gatherAttachments({
    contextFolderService: args.contextFolderService,
    jobId: ctx.job.id,
    phase: args.kind,
    declared: args.attach,
  });

  return args.transitionRepository.raise({
    jobId: ctx.job.id,
    fromPhaseId: ctx.thread.phaseId,
    raisedByThreadId: ctx.thread.id,
    to: args.kind,
    reason: args.reason,
    handoff: args.handoff,
    attach: args.attach,
  });
}

/**
 * A decided proposal is never decided twice. Several TUIs on one database is normal, so a second
 * terminal's overlay may be showing a row that is already answered — and a re-confirm would append
 * a second phase for one ask.
 */
export async function requirePending(args: {
  transitionRepository: TransitionRepository;
  transitionId: string;
}): Promise<TransitionRow> {
  const transition = await args.transitionRepository.findById(args.transitionId);
  if (!transition) throw new Error(`no transition ${args.transitionId}`);
  if (transition.status !== ETransitionStatus.pending) {
    throw new Error(`this proposal was already ${transition.status}`);
  }
  return transition;
}

/** What a confirmation created: the phase, its first thread, and who handed over to it. */
export type MaterialisedPhase = {
  job: Job;
  phase: Phase;
  thread: Thread;
  /** The thread that proposed it, now closed. Null only where nothing raised it from a thread. */
  proposer: Thread | null;
};

/**
 * Everything ENTERING a phase writes, in the order it must happen — the one implementation, shared
 * by the confirmation below and by the human's start-a-phase verb.
 *
 * The proposer is closed FIRST, for the reason `advance_thread` closes before it opens: a thread
 * that has said it is finished must never keep working beside its successor. Phases never return,
 * so this is not a call and nothing is suspended — there is no stack, because a stack would have to
 * survive a human confirmation that may be hours away.
 *
 * `proposer` is null where nobody handed over: a job whose last thread has closed is a job Dennis
 * re-enters himself, and there is nothing to close and no hand-off to carry.
 */
export async function enterPhase(args: {
  jobRepository: JobRepository;
  threadRepository: ThreadRepository;
  sessionManagerService: SessionManagerService;
  jobId: string;
  to: EPhaseKind;
  /** The thread handing over, where one is. Closed and stamped before the phase is appended. */
  proposer: Thread | null;
  /** Its last word, kept on the closed row. Null where nobody wrote one. */
  handoff: string | null;
}): Promise<{ job: Job; phase: Phase; thread: Thread }> {
  const job = await args.jobRepository.findById(args.jobId);
  if (!job) throw new Error(`no job ${args.jobId}`);

  const role = firstRoleFor(args.to);
  if (!role) {
    throw new Error(`the ${phaseLabel(args.to)} phase hosts no threads to open`);
  }

  if (args.proposer) {
    await args.sessionManagerService.closeThread(args.proposer);
    // Every close path stamps a condition, or a closed row is one you have to read a transcript to
    // interpret. `phase_advanced` is Atlas's to stamp for `advance_thread`'s reason — it is true
    // because the phase moved, not because the agent said so — and the hand-off is the thread's own
    // last word, kept here because the copy it delivered lives in a thread in the NEXT phase.
    await args.threadRepository.recordOutcome({
      threadId: args.proposer.id,
      condition: EThreadCondition.phase_advanced,
      ...(args.handoff ? { resolution: args.handoff } : {}),
    });
  }

  const phase = await args.jobRepository.appendPhase({
    jobId: job.id,
    kind: args.to,
  });
  // `openThread` joins the job's CURRENT phase — the highest ordinal, which is the row just
  // appended — and stamps `Job.activeThreadId` on the way, so the cursor follows the work.
  const thread = await args.sessionManagerService.openThread(job.id, role);

  return { job, phase, thread };
}

/**
 * A confirmation, which is `enterPhase` plus the one thing only a proposal has: a row to mark
 * decided. Split that way so the human's start-a-phase runs the identical writes rather than a
 * second, drifting copy of them — the difference between the two is a Transition row, and nothing
 * else.
 */
export async function materialiseTransition(args: {
  jobRepository: JobRepository;
  threadRepository: ThreadRepository;
  transitionRepository: TransitionRepository;
  sessionManagerService: SessionManagerService;
  transition: TransitionRow;
}): Promise<MaterialisedPhase> {
  const { transition } = args;
  const proposer = transition.raisedByThreadId
    ? await args.threadRepository.findById(transition.raisedByThreadId)
    : null;

  const entered = await enterPhase({
    jobRepository: args.jobRepository,
    threadRepository: args.threadRepository,
    sessionManagerService: args.sessionManagerService,
    jobId: transition.jobId,
    to: transition.to,
    proposer,
    handoff: transition.handoff,
  });

  await args.transitionRepository.confirm({
    id: transition.id,
    createdPhaseId: entered.phase.id,
  });

  return { ...entered, proposer };
}

/**
 * The material crossing the boundary, read off disk as it stands NOW.
 *
 * The floor is the DESTINATION phase's, not the proposer's: the successor is entering `to`, and what
 * it must not start without is what that phase shares — a builder needs `specs/`, however it got
 * there. Read at both raise and confirm rather than cached between them, because hours pass in
 * between and the successor should get the files it is actually going to work on.
 */
export function transitionAttachments(args: {
  contextFolderService: ContextFolderService;
  transition: Pick<TransitionRow, 'jobId' | 'to' | 'attach'>;
}): GatheredAttachments {
  return gatherAttachments({
    contextFolderService: args.contextFolderService,
    jobId: args.transition.jobId,
    phase: args.transition.to,
    declared: args.transition.attach,
    // Reports rather than refuses, unlike the seam that took the declaration. This runs on Dennis's
    // `y`, hours later, with no agent left to fix a name — a file somebody tidied up in between must
    // reach the successor as a MISSING marker, not strand the job on a confirmation that throws.
    onMissing: EMissingAttachment.report,
  });
}

/**
 * A hand-off is attributed or it is not delivered as one: `successorSeed` names who wrote it so the
 * reader can weigh it. Nothing raises a thread-less proposal today (`gate` has no caller), and one
 * that did would want its own framing rather than a borrowed role — so the new thread opens on the
 * phase's own words instead.
 */
export function transitionSeedHandoff(args: {
  transition: TransitionRow;
  proposer: Thread | null;
  attachments: GatheredAttachments;
}): SeedHandoff | null {
  if (!args.transition.handoff || !args.proposer) return null;
  return {
    text: args.transition.handoff,
    fromRole: args.proposer.role,
    attachments: args.attachments.text,
    // Stored as rows on the successor's first message, so the transcript can chip them.
    parts: args.attachments.parts,
  };
}
