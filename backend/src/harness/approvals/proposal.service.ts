import { Inject, Injectable, Optional } from '@nestjs/common';
import { BoardStore, type BoardStatus } from '../memory/board-store';
import { PlanStore } from '../memory/plan-store';
import {
  PROPOSAL_PRESENTER,
  type PlanProposalPresenter,
} from './proposal-presenter.port';

/**
 * The shared plan-proposal core — the guard ladder + the CAS flip + the outbound `present()` hop,
 * extracted from `ProposePlanTool` so BOTH the lead's `propose_plan` tool AND the Atlas pipeline
 * runner drive plan-approval through ONE path (neither calls `presenter.present()` raw). The
 * caller-specific authority check (the tool's teamLead gate) stays at the caller; this owns only the
 * board/plan state machine:
 *   status ∈ {planning, awaiting_approval} → plans attached + all lead-approved → CAS
 *   planning→awaiting_approval → present via PROPOSAL_PRESENTER (or the chat-words fallback).
 *
 * The presenter is `@Optional` (TUI/headless binds none — `presented: 'no-surface'`); a thrown
 * `present()` degrades to `presented: 'failed'` and never leaves partial board state (the CAS already
 * committed, so a re-propose just re-presents).
 */
export type ProposeOutcome =
  | { ok: false; kind: 'missing' }
  | { ok: false; kind: 'bad-status'; status: BoardStatus }
  | { ok: false; kind: 'no-plans' }
  | { ok: false; kind: 'pending-approval'; pending: string[] }
  | { ok: false; kind: 'cas-lost'; now?: BoardStatus }
  | {
      ok: true;
      presented: 'posted' | 'no-surface' | 'failed';
      planCount: number;
      error?: string;
    };

@Injectable()
export class ProposalService {
  constructor(
    private readonly board: BoardStore,
    private readonly plans: PlanStore,
    @Optional()
    @Inject(PROPOSAL_PRESENTER)
    private readonly presenter?: PlanProposalPresenter,
  ) {}

  /** True when there's a presenter bound (the chat-words fallback otherwise). */
  get hasPresenter(): boolean {
    return !!this.presenter;
  }

  /**
   * Run the plan-proposal pipeline for a ticket: guard, CAS planning→awaiting_approval (skipped when
   * already awaiting_approval — the re-propose path), then present the approval card. Returns a
   * discriminated outcome the caller renders/acts on; never throws on a presenter failure.
   */
  async propose(opts: {
    team: string;
    taskId: number;
    summary: string;
    proposedBy: string;
    surfaceId: string;
  }): Promise<ProposeOutcome> {
    const { team, taskId } = opts;
    const task = await this.board.get(team, taskId);
    if (!task) return { ok: false, kind: 'missing' };
    if (task.status !== 'planning' && task.status !== 'awaiting_approval')
      return { ok: false, kind: 'bad-status', status: task.status };
    const plans = await this.plans.listForTask(team, taskId);
    if (plans.length === 0) return { ok: false, kind: 'no-plans' };
    const pending = plans
      .filter((p) => p.leadStatus !== 'approved')
      .map((p) => p.employee);
    if (pending.length) return { ok: false, kind: 'pending-approval', pending };

    // CAS planning → awaiting_approval (a concurrent double-propose loses). Re-propose path
    // (already awaiting_approval): skip the flip, just re-present — a duplicate card is harmless.
    if (task.status === 'planning') {
      const flipped = await this.board.transition(team, taskId, 'planning', {
        status: 'awaiting_approval',
      });
      if (!flipped) {
        const now = await this.board.get(team, taskId);
        return { ok: false, kind: 'cas-lost', now: now?.status };
      }
    }

    if (!this.presenter)
      return { ok: true, presented: 'no-surface', planCount: plans.length };
    try {
      await this.presenter.present({
        team,
        taskId,
        title: task.title,
        summary: opts.summary,
        proposedBy: opts.proposedBy,
        surfaceId: opts.surfaceId,
        plans: plans.map((p) => ({ employee: p.employee, planMd: p.planMd })),
      });
      return { ok: true, presented: 'posted', planCount: plans.length };
    } catch (err) {
      return {
        ok: true,
        presented: 'failed',
        planCount: plans.length,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
