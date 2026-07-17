import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';
import {
  decisionApprovalBlocks,
  DecisionApprovalCard,
} from '../surface/approval-blocks';

/** The verdict a human (Dennis) rules on the proposed plan. */
export type ApprovalVerdict = 'approve' | 'request_changes' | 'deny';

/** Where to post the approval card — the job's channel + thread. */
export interface ApprovalTarget {
  /** Surface-native channel coordinate (e.g. a Slack channel id 'C042'). */
  channel: string;
  /** The thread the card is posted into (the job's thread root ts). */
  threadTs?: string;
  /** The tenant to post as (selects the workspace credentials). */
  orgId?: string;
}

/** The resolved approval — the verdict + who ruled + any free-text the human added. */
export interface ApprovalResolution {
  jobId: string;
  verdict: ApprovalVerdict;
  /** Who ruled (the operator's id). */
  ruledBy: string;
  /** Optional free-text accompanying the verdict (e.g. the change request). */
  note?: string;
  /** The decision record the operator actually clicked (the version pin). */
  clickedDecisionRecordId?: string;
}

/** A live approval — the card is posted, the gate awaits a human verdict. */
export interface ApprovalHandle {
  /** The job this approval gates. */
  readonly jobId: string;
  /** The ts of the posted approval card (undefined if the surface couldn't post). */
  readonly cardTs: string | undefined;
  /**
   * Resolves when the human rules (or rejects on `cancel`). The brain `await`s this: `approve` →
   * dispatch; `request_changes` / `deny` → back to grilling.
   */
  readonly verdict: Promise<ApprovalResolution>;
  /** Non-blocking peek. */
  readonly resolved: boolean;
  readonly resolution?: ApprovalResolution;
}

interface ApprovalState {
  jobId: string;
  cardTs?: string;
  resolved: boolean;
  resolution?: ApprovalResolution;
  resolve: (r: ApprovalResolution) => void;
  reject: (e: Error) => void;
}

/**
 * W3 — the DECISION-RECORD APPROVAL service (the human gate). NOT v1's board-stateful `ProposalService`:
 * this is decision-record-keyed and stateless beyond an in-memory pending map. When the conversational
 * brain has a locked decision record + thread list it calls `request(...)`:
 *   1. POSTS the approval card (the copied `approval-blocks` renderer) into the job's thread;
 *   2. returns an `ApprovalHandle` whose `verdict` promise resolves when the human rules.
 *
 * The verdict ARRIVES via `resolve(jobId, verdict, ruledBy, note?)` — the seam a verdict source plugs
 * into. W6 wires the Slack interactivity handler (the approve / request-changes / deny buttons carry the
 * jobId in their `value`, per `approval-blocks.ts`) to call `resolve`; tests call it directly. Keeping
 * the verdict source decoupled means the brain's gate doesn't depend on HOW the button click is routed.
 *
 * DURABILITY SEAM: pending state is IN-MEMORY (a `Map`), so a restart drops in-flight approvals (the
 * card persists in Slack; the brain re-derives an awaiting-approval job from its `awaiting_approval`
 * status on boot — a later workstream rehydrates the handle). Zero v1 imports.
 */
@Injectable()
export class DecisionApprovalService implements OnModuleDestroy {
  private readonly logger = new Logger(DecisionApprovalService.name);
  private readonly pending = new Map<string, ApprovalState>();

  constructor(@Inject(CHAT_SURFACE) private readonly surface: ChatSurface) {}

  onModuleDestroy(): void {
    for (const state of this.pending.values()) {
      if (!state.resolved)
        state.reject(new Error('Atlas shutting down — approval abandoned.'));
    }
    this.pending.clear();
  }

  /**
   * Post the proposal card into the job's thread and register the pending approval. Returns the handle
   * the brain awaits. The card carries the jobId (+ decisionRecordId) in its button values, so a verdict
   * survives a restart of the verdict source.
   */
  async request(
    target: ApprovalTarget,
    card: DecisionApprovalCard,
  ): Promise<ApprovalHandle> {
    const blocks = decisionApprovalBlocks(card);
    const cardTs = await this.surface.post(
      target.channel,
      `Plan proposal — ${card.title}`,
      {
        ...(target.threadTs ? { threadTs: target.threadTs } : {}),
        ...(target.orgId ? { orgId: target.orgId } : {}),
        blocks,
      },
    );

    let resolve!: (r: ApprovalResolution) => void;
    let reject!: (e: Error) => void;
    const verdict = new Promise<ApprovalResolution>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Attach a no-op rejection sink so an ABANDONED approval (cancel/shutdown rejects it) never becomes
    // an unhandled rejection when the caller chose to poll `resolved` instead of awaiting `verdict`.
    // Independent of any real `.then`/`.catch` the caller adds — those still fire.
    verdict.catch(() => undefined);

    const state: ApprovalState = {
      jobId: card.jobId,
      ...(cardTs ? { cardTs } : {}),
      resolved: false,
      resolve: (r) => {
        state.resolved = true;
        state.resolution = r;
        resolve(r);
      },
      reject,
    };
    this.pending.set(card.jobId, state);
    this.logger.log(
      `approval requested for job ${card.jobId} (card ${cardTs ?? '(unposted)'})`,
    );

    return {
      jobId: card.jobId,
      cardTs,
      verdict,
      get resolved() {
        return state.resolved;
      },
      get resolution() {
        return state.resolution;
      },
    };
  }

  /**
   * Resolve a pending approval with a human verdict — the seam W6's Slack interactivity handler (or a
   * test) calls. No-op if the job has no pending approval (a stale / double click). Returns whether a
   * pending approval was actually resolved.
   */
  resolve(
    jobId: string,
    verdict: ApprovalVerdict,
    ruledBy: string,
    note?: string,
    clickedDecisionRecordId?: string,
  ): boolean {
    const state = this.pending.get(jobId);
    if (!state || state.resolved) return false;
    const resolution: ApprovalResolution = {
      jobId,
      verdict,
      ruledBy,
      ...(note ? { note } : {}),
      ...(clickedDecisionRecordId ? { clickedDecisionRecordId } : {}),
    };
    this.logger.log(
      `approval for job ${jobId} ruled "${verdict}" by ${ruledBy}`,
    );
    state.resolve(resolution);
    this.pending.delete(jobId);
    return true;
  }

  /** Abandon a pending approval (e.g. the job was cancelled). Rejects its `verdict` and drops it. */
  cancel(jobId: string, reason = 'approval cancelled'): void {
    const state = this.pending.get(jobId);
    if (!state) return;
    if (!state.resolved) state.reject(new Error(reason));
    this.pending.delete(jobId);
  }

  /** Count of approvals still awaiting a verdict (diagnostics). */
  get pendingCount(): number {
    let n = 0;
    for (const s of this.pending.values()) if (!s.resolved) n++;
    return n;
  }
}
