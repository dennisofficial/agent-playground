import { Injectable } from '@nestjs/common';
import {
  ETransitionScope,
  ETransitionSource,
  ETransitionStatus,
  type EPhaseKind,
} from '../generated/prisma/enums.js';
import type { Transition } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

/**
 * A proposal, with its `attach` column decoded once here rather than at every reader.
 *
 * The column is Json because the list is the agent's and has no schema worth a table; decoding it
 * at the boundary is what keeps `Prisma.JsonValue` — and the type guard it needs — out of the
 * service, the overlay and the tests.
 */
export type TransitionRow = Omit<Transition, 'attach'> & {
  attach: readonly string[];
};

/** A proposal as the job and thread lists need it: who is waiting, and where. */
export type PendingProposal = {
  id: string;
  jobId: string;
  raisedByThreadId: string;
};

@Injectable()
export class TransitionRepository {
  constructor(private readonly prismaService: PrismaService) {}

  /**
   * Raise a proposal. This is the whole of what `advance_phase` writes — nothing about the job
   * moves, which is the point: the row IS the ask, and it outlives the turn, the session and the
   * process that raised it.
   */
  async raise(args: {
    jobId: string;
    fromPhaseId: string;
    raisedByThreadId: string;
    to: EPhaseKind;
    reason: string;
    handoff: string;
    attach: readonly string[];
  }): Promise<TransitionRow> {
    const created = await this.prismaService.transition.create({
      data: {
        jobId: args.jobId,
        fromPhaseId: args.fromPhaseId,
        raisedByThreadId: args.raisedByThreadId,
        to: args.to,
        scope: ETransitionScope.phase,
        reason: args.reason,
        handoff: args.handoff,
        attach: [...args.attach],
        raisedBy: ETransitionSource.agent,
        status: ETransitionStatus.pending,
      },
    });
    return decode(created);
  }

  async findById(id: string): Promise<TransitionRow | null> {
    const found = await this.prismaService.transition.findUnique({ where: { id } });
    return found === null ? null : decode(found);
  }

  /**
   * What is waiting on the human, oldest first — the overlay's query, and the reason the model is
   * indexed on `[jobId, status]`. Several are possible in principle (two phases, two proposals is
   * not reachable today); oldest first so the queue is answered in the order it formed.
   */
  async pendingForJob(jobId: string): Promise<TransitionRow[]> {
    const rows = await this.prismaService.transition.findMany({
      where: { jobId, status: ETransitionStatus.pending },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(decode);
  }

  /**
   * Every pending proposal in the store, as the pair the LISTS need — which job is waiting, and
   * which thread is waiting in it.
   *
   * Two columns rather than a job id alone, because a job row's condition is the union of its
   * THREADS' facts (`jobAttention`) and there is exactly one attention table in the app. Handing the
   * lists a job id would make them invent a job-level `proposalPending` fact and re-derive a
   * precedence that `attentionFor` already owns.
   *
   * Unscoped on purpose: the jobs list spans projects, and one query for the whole screen beats one
   * per row. It is small — a pending row exists only between an agent asking and Dennis answering.
   */
  async pendingProposals(): Promise<PendingProposal[]> {
    const rows = await this.prismaService.transition.findMany({
      where: { status: ETransitionStatus.pending },
      select: { id: true, jobId: true, raisedByThreadId: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.flatMap((row) =>
      row.raisedByThreadId === null
        ? // A gate-raised proposal has no thread to colour, and nothing raises one today. It is
          // dropped from the LIST signal rather than faked onto a thread, which would point the
          // human at a conversation that has nothing to do with the ask.
          []
        : [{ id: row.id, jobId: row.jobId, raisedByThreadId: row.raisedByThreadId }],
    );
  }

  /**
   * Confirmed, with the phase the confirmation created. `createdPhaseId` is what makes the phase log
   * and the transition log one audit of the route actually walked — including the turns not taken.
   */
  async confirm(args: { id: string; createdPhaseId: string }): Promise<void> {
    await this.prismaService.transition.update({
      where: { id: args.id },
      data: {
        status: ETransitionStatus.confirmed,
        createdPhaseId: args.createdPhaseId,
        decidedAt: new Date(),
      },
    });
  }

  /**
   * Declined rows are KEPT, with the reason. "Atlas asked to build three times and I said no" is
   * recorded nowhere else, and it is the data that would later say a trigger is mistuned — deleting
   * a decline throws away the only evidence that would remove an ask.
   */
  async decline(args: { id: string; reason?: string }): Promise<void> {
    await this.prismaService.transition.update({
      where: { id: args.id },
      data: {
        status: ETransitionStatus.declined,
        ...(args.reason === undefined ? {} : { declineReason: args.reason }),
        decidedAt: new Date(),
      },
    });
  }
}

/**
 * Json in, `string[]` out. Anything that is not a string is dropped rather than thrown on: the
 * column is written by this file alone, so a foreign shape means a hand-edited database, and a
 * proposal that cannot be read at all would be worse than one that lost an attachment.
 */
function decode(transition: Transition): TransitionRow {
  const { attach, ...rest } = transition;
  return {
    ...rest,
    attach: Array.isArray(attach)
      ? attach.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}
