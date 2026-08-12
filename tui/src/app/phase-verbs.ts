import {
  exitsWithoutAsking,
  proposalRaisedReply,
  transitionedReply,
} from '../domain/phase-advance.js';
import type { EPhaseKind } from '../generated/prisma/enums.js';
import type { Phase, Thread } from '../generated/prisma/client.js';
import type { JobRepository } from '../store/job.repository.js';
import type { ThreadRepository } from '../store/thread.repository.js';
import type { TransitionRepository } from '../store/transition.repository.js';
import type { ContextFolderService } from './context-folder.service.js';
import {
  materialiseTransition,
  raisePhaseProposal,
  requirePending,
  transitionAttachments,
  transitionSeedHandoff,
} from './phase-transition.js';
import type { SessionManagerService } from './session-manager.service.js';
import { describeAttachments } from './tools/attach.js';
import type { ToolContext } from './tools/tool.js';
import type { SeedHandoff } from '../domain/thread-handoff.js';
import type { Job } from '../generated/prisma/client.js';

/**
 * The phase half of the seam, as plain functions.
 *
 * These live outside `ThreadSeamService` for length rather than for taste — four tickets' verbs
 * landed in that class and it went past the file cap. They stay functions taking their collaborators
 * as named arguments, deliberately NOT a second service, because a service that confirmed would need
 * the seam in order to seed, and the seam needs confirm for the automatic exits. That is the cycle,
 * and a callback is what keeps it in one class.
 */

/** Seeding is the seam's own act, so callers hand it in rather than reaching for it. */
type Seed = (args: {
  job: Job;
  thread: Thread;
  cwd: string;
  handoff?: SeedHandoff;
}) => Promise<void>;

/**
 * `advance_phase`: raise a proposal, and return. **Nothing transitions here** — the row is the ask,
 * and it outlives the turn, the session and the process, because a parked confirmation is a
 * multi-hour event and a query held open across it is what this design exists to avoid.
 *
 * Where the phase being left exits without asking, that same proposal is confirmed the instant it is
 * raised — written first either way, so an automatic exit leaves the audit a confirmed one leaves,
 * and confirmation has exactly one implementation.
 */
export async function advancePhaseVerb(args: {
  jobRepository: JobRepository;
  transitionRepository: TransitionRepository;
  contextFolderService: ContextFolderService;
  confirm: (args: { transitionId: string; cwd: string }) => Promise<{ phase: Phase; thread: Thread }>;
  ctx: ToolContext;
  kind: EPhaseKind;
  reason: string;
  handoff: string;
  attach: readonly string[];
}): Promise<string> {
  const { ctx } = args;
  // Refuses an attachment that is not there before it writes anything — see `raisePhaseProposal`.
  const transition = await raisePhaseProposal(args);

  // Gathered for the REPLY, so the agent is told what it actually attached and what Atlas could not
  // resolve — the same courtesy `advance_thread` pays, and its last chance to hear it.
  const declared = describeAttachments(
    transitionAttachments({ contextFolderService: args.contextFolderService, transition }),
  );

  if (!exitsWithoutAsking(ctx.phase)) {
    return proposalRaisedReply({ from: ctx.phase, to: args.kind, attachments: declared });
  }

  const { thread } = await args.confirm({ transitionId: transition.id, cwd: ctx.cwd });
  return transitionedReply({
    from: ctx.phase,
    to: args.kind,
    role: thread.role,
    attachments: declared,
  });
}

/**
 * `y`. Create the phase, open its first thread, seed it from the hand-off, close the thread that
 * proposed it.
 */
export async function confirmPhaseVerb(args: {
  jobRepository: JobRepository;
  threadRepository: ThreadRepository;
  transitionRepository: TransitionRepository;
  sessionManagerService: SessionManagerService;
  contextFolderService: ContextFolderService;
  seed: Seed;
  transitionId: string;
  cwd: string;
}): Promise<{ phase: Phase; thread: Thread }> {
  const transition = await requirePending({
    transitionRepository: args.transitionRepository,
    transitionId: args.transitionId,
  });
  const { job, phase, thread, proposer } = await materialiseTransition({
    jobRepository: args.jobRepository,
    threadRepository: args.threadRepository,
    transitionRepository: args.transitionRepository,
    sessionManagerService: args.sessionManagerService,
    transition,
  });

  const attachments = transitionAttachments({
    contextFolderService: args.contextFolderService,
    transition,
  });
  const handoff = transitionSeedHandoff({ transition, proposer, attachments });
  await args.seed({ job, thread, cwd: args.cwd, ...(handoff ? { handoff } : {}) });

  return { phase, thread };
}

/**
 * `n`. The row stays, with the reason — a decline is the data that would later say a trigger is
 * mistuned, and it is recorded nowhere else. Nothing else happens, deliberately: the proposing
 * thread stays open and Dennis says why in the composer he is already looking at, which is a
 * conversation rather than a mechanism.
 */
export async function declinePhaseVerb(args: {
  transitionRepository: TransitionRepository;
  transitionId: string;
  reason?: string;
}): Promise<void> {
  const transition = await requirePending({
    transitionRepository: args.transitionRepository,
    transitionId: args.transitionId,
  });
  await args.transitionRepository.decline({
    id: transition.id,
    ...(args.reason === undefined ? {} : { reason: args.reason }),
  });
}
