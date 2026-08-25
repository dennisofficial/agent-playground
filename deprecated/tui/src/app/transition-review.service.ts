import { Injectable } from '@nestjs/common';
import type { AttachmentPart } from '../domain/attachments.js';
import type { ContextFileRef } from '../domain/phase-spec.js';
import type { EPhaseKind } from '../generated/prisma/enums.js';
import { JobRepository } from '../store/job.repository.js';
import {
  TransitionRepository,
  type PendingProposal,
  type TransitionRow,
} from '../store/transition.repository.js';
import { ContextFolderService } from './context-folder.service.js';
import { transitionAttachments } from './phase-transition.js';

/** Everything the confirm overlay draws for one proposal, read at the moment it opens. */
export type TransitionReview = {
  transition: TransitionRow;
  /** The phase being LEFT. Null for a job's first phase, which has nothing behind it. */
  from: EPhaseKind | null;
  /** What will actually cross the boundary — the destination's floor plus the agent's list. */
  attached: readonly ContextFileRef[];
  /** The same files with their bodies, so the overlay can show the plan it is approving. */
  parts: readonly AttachmentPart[];
};

/**
 * The READ side of a proposal — what the overlay needs to show one, and what the lists need to say
 * one exists. The writes stay on `ThreadSeamService`: confirming creates a phase, opens a thread and
 * seeds it, and seeding is the seam's own act.
 *
 * A separate class rather than three more methods on the seam because these touch disk on a human's
 * keypress and nothing else in the seam does — and because the seam is a mutually-recursive knot
 * held at exactly its size on purpose. Nothing here writes, so there is no cycle to hold.
 */
@Injectable()
export class TransitionReviewService {
  constructor(
    private readonly transitionRepository: TransitionRepository,
    private readonly jobRepository: JobRepository,
    private readonly contextFolderService: ContextFolderService,
  ) {}

  /** Which jobs and threads are waiting on a keypress — one query for the whole jobs page. */
  async pendingProposals(): Promise<PendingProposal[]> {
    return this.transitionRepository.pendingProposals();
  }

  /**
   * The proposal in full, including the bodies of the files it carries.
   *
   * Read HERE and not with the pending list: the list runs on every turn boundary on three pages,
   * and inlining a plan's worth of markdown into each of those reads would be paid for constantly to
   * be shown almost never. This runs once, when the overlay actually opens.
   *
   * The files are gathered exactly as the confirmation will gather them — same function, same
   * destination-phase floor — so what Dennis reads is what the successor gets, not an approximation
   * of it. A file that has been tidied away since the proposal shows as a MISSING chip rather than
   * silently shortening the review.
   */
  async review(transitionId: string): Promise<TransitionReview | null> {
    const transition = await this.transitionRepository.findById(transitionId);
    if (!transition) return null;

    const gathered = transitionAttachments({
      contextFolderService: this.contextFolderService,
      transition,
    });

    return {
      transition,
      from: await this.phaseKind({ jobId: transition.jobId, phaseId: transition.fromPhaseId }),
      attached: gathered.attached,
      parts: gathered.parts,
    };
  }

  /**
   * The kind of one phase of a job, off the job's own phase list. There is no find-by-phase-id on
   * `JobRepository` and this is the only caller that wants one — a job holds a handful of phases, so
   * the list is the cheaper thing to reuse than a new query is to add.
   */
  private async phaseKind(args: {
    jobId: string;
    phaseId: string | null;
  }): Promise<EPhaseKind | null> {
    if (args.phaseId === null) return null;
    const phases = await this.jobRepository.listPhases(args.jobId);
    return phases.find((phase) => phase.id === args.phaseId)?.kind ?? null;
  }
}
