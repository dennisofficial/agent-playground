import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { decisionApprovalBlocks, DecisionApprovalCard } from '../surface/approval-blocks';
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';

export type ApprovalVerdict = 'approve' | 'request_changes' | 'deny';

export interface ApprovalTarget {
  channel: string;
  threadTs?: string;
  orgId?: string;
}

export interface ApprovalResolution {
  jobId: string;
  verdict: ApprovalVerdict;
  ruledBy: string;
  note?: string;
  clickedDecisionRecordId?: string;
}

export interface ApprovalHandle {
  readonly jobId: string;
  readonly cardTs: string | undefined;
  readonly verdict: Promise<ApprovalResolution>;
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

@Injectable()
export class DecisionApprovalService implements OnModuleDestroy {
  private readonly logger = new Logger(DecisionApprovalService.name);
  private readonly pending = new Map<string, ApprovalState>();

  constructor(@Inject(CHAT_SURFACE) private readonly surface: ChatSurface) {}

  onModuleDestroy(): void {
    for (const state of this.pending.values()) {
      if (!state.resolved) state.reject(new Error('Atlas shutting down — approval abandoned.'));
    }
    this.pending.clear();
  }

  async request(target: ApprovalTarget, card: DecisionApprovalCard): Promise<ApprovalHandle> {
    const blocks = decisionApprovalBlocks(card);
    const cardTs = await this.surface.post(target.channel, `Plan proposal — ${card.title}`, {
      ...(target.threadTs ? { threadTs: target.threadTs } : {}),
      ...(target.orgId ? { orgId: target.orgId } : {}),
      blocks,
    });

    let resolve!: (r: ApprovalResolution) => void;
    let reject!: (e: Error) => void;
    const verdict = new Promise<ApprovalResolution>((res, rej) => {
      resolve = res;
      reject = rej;
    });
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
    this.logger.log(`approval requested for job ${card.jobId} (card ${cardTs ?? '(unposted)'})`);

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
    this.logger.log(`approval for job ${jobId} ruled "${verdict}" by ${ruledBy}`);
    state.resolve(resolution);
    this.pending.delete(jobId);
    return true;
  }

  cancel(jobId: string, reason = 'approval cancelled'): void {
    const state = this.pending.get(jobId);
    if (!state) return;
    if (!state.resolved) state.reject(new Error(reason));
    this.pending.delete(jobId);
  }

  get pendingCount(): number {
    let n = 0;
    for (const s of this.pending.values()) if (!s.resolved) n++;
    return n;
  }
}
