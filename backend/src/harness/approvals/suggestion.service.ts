import { Inject, Injectable, Optional } from '@nestjs/common';
import { BoardStore } from '../memory/board-store';
import {
  TASK_SUGGESTION_PRESENTER,
  type TaskSuggestionPresenter,
} from './task-suggestion-presenter.port';

/**
 * The shared task-suggestion core — the twin of {@link ProposalService}. `suggest_task` (and, later,
 * a coding-session's out-of-scope discovery) drive a suggestion through ONE path: CAPTURE the work as
 * a freshly-parked `open` board item (exactly `enqueue_finding`), then PRESENT it to Dennis as a chip
 * via the outbound port. Capture is the durable part and always stands; the chip is best-effort.
 *
 * The presenter is `@Optional` (TUI/headless binds none → `presented: 'no-surface'`); a thrown
 * `present()` degrades to `presented: 'failed'` WITHOUT undoing the capture — the work is on the
 * backlog regardless (the autonomous capture-zone model), so there's nothing partial to roll back.
 * The disposition (Run / Keep / Dismiss) is handled by the surface adapter on the inbound click,
 * exactly as the proposal verdict is.
 */
export type SuggestOutcome =
  | { ok: false; kind: 'create-failed' }
  | {
      ok: true;
      taskId: number;
      presented: 'posted' | 'no-surface' | 'failed';
      error?: string;
    };

@Injectable()
export class SuggestionService {
  constructor(
    private readonly board: BoardStore,
    @Optional()
    @Inject(TASK_SUGGESTION_PRESENTER)
    private readonly presenter?: TaskSuggestionPresenter,
  ) {}

  /** True when a chip surface is bound (the chat-words fallback otherwise). */
  get hasPresenter(): boolean {
    return !!this.presenter;
  }

  /**
   * Capture a suggested unit of work on the backlog and post the chip. The board row is the durable
   * suggestion; the chip's disposition acts on it later. Returns a discriminated outcome the caller
   * renders; never throws on a presenter failure.
   */
  async suggest(opts: {
    team: string;
    project: string;
    title: string;
    why: string;
    description?: string;
    suggestedDisposition?: 'run' | 'backlog';
    proposedBy: string;
    surfaceId: string;
  }): Promise<SuggestOutcome> {
    // CAPTURE: a freshly-parked, un-approved 'open' item (the enqueue_finding semantics). The board
    // description carries the rationale so the parked candidate is self-explanatory on the backlog.
    const body = opts.description
      ? `${opts.why}\n\n${opts.description}`
      : opts.why;
    const created = await this.board.create({
      team: opts.team,
      project: opts.project,
      title: opts.title,
      description: body,
      createdBy: opts.proposedBy,
    });
    if ('unknownDeps' in created) return { ok: false, kind: 'create-failed' };

    if (!this.presenter)
      return { ok: true, taskId: created.id, presented: 'no-surface' };
    try {
      await this.presenter.present({
        team: opts.team,
        taskId: created.id,
        title: opts.title,
        why: opts.why,
        description: opts.description,
        suggestedDisposition: opts.suggestedDisposition,
        proposedBy: opts.proposedBy,
        surfaceId: opts.surfaceId,
      });
      return { ok: true, taskId: created.id, presented: 'posted' };
    } catch (err) {
      return {
        ok: true,
        taskId: created.id,
        presented: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
