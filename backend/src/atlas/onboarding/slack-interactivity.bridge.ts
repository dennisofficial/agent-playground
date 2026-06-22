import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { DecisionApprovalService, type ApprovalVerdict } from '../brain';
import {
  APPROVE_ACTION_ID,
  AtlasSlackSurface,
  DENY_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
  type ApprovalActionMeta,
  type SlackBlockAction,
  type SlackViewSubmission,
  type SlackLifecycleEvent,
  verdictBlocks,
} from '../surface';
import { OnboardingSlackService } from './onboarding-slack.service';

/** action_id → approval verdict. */
const VERDICT_BY_ACTION: Record<string, ApprovalVerdict> = {
  [APPROVE_ACTION_ID]: 'approve',
  [REQUEST_CHANGES_ACTION_ID]: 'request_changes',
  [DENY_ACTION_ID]: 'deny',
};

const VERDICT_LINE: Record<ApprovalVerdict, string> = {
  approve: '✅ Approved',
  request_changes: '✏️ Changes requested',
  deny: '❌ Denied',
};

/**
 * The seam that turns Slack interactivity into Atlas actions — finally wiring the approval-card buttons
 * (which were posted but DROPPED before multi-workspace transport) and the onboarding card/modal. It
 * subscribes to the surface's `interactive$` / `viewSubmission$` / `lifecycle$` Subjects and routes by
 * action_id / callback_id prefix. Keeps the existing HTTP `/test/approve` path working — two verdict
 * sources, one `DecisionApprovalService.resolve`.
 */
@Injectable()
export class SlackInteractivityBridge implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SlackInteractivityBridge.name);
  private readonly subs: Subscription[] = [];

  constructor(
    private readonly surface: AtlasSlackSurface,
    private readonly approvals: DecisionApprovalService,
    private readonly onboarding: OnboardingSlackService,
  ) {}

  onApplicationBootstrap(): void {
    this.subs.push(
      this.surface.interactive$.subscribe((p) => void this.onInteractive(p).catch(this.warn('interactive'))),
      this.surface.viewSubmission$.subscribe((p) => void this.onSubmission(p).catch(this.warn('view_submission'))),
      this.surface.lifecycle$.subscribe((e) => void this.onLifecycle(e).catch(this.warn('lifecycle'))),
    );
  }

  onApplicationShutdown(): void {
    for (const s of this.subs) s.unsubscribe();
  }

  private warn(kind: string) {
    return (err: unknown): void => this.logger.warn(`${kind} handler failed: ${err}`);
  }

  /** block_actions → approval verdict OR onboarding modal open. */
  private async onInteractive(payload: SlackBlockAction): Promise<void> {
    const action = payload.actions?.[0];
    const actionId = action?.action_id ?? '';
    if (actionId in VERDICT_BY_ACTION) {
      await this.resolveApproval(payload, actionId, action?.value);
      return;
    }
    if (actionId.startsWith('atlas_onboarding:')) {
      await this.onboarding.openSetupModal(payload);
    }
    // atlas_approval:view_plan is a link button — nothing to do server-side.
  }

  /** view_submission → onboarding secret write (the only secret-write path). */
  private async onSubmission(payload: SlackViewSubmission): Promise<void> {
    const callbackId = payload.view?.callback_id ?? '';
    if (callbackId.startsWith('atlas_secret:')) {
      await this.onboarding.handleSetupSubmission(payload);
    }
  }

  /**
   * Bot added to a channel → post the setup card. An @mention is the bootstrap for an UNregistered
   * channel (chat there is otherwise dropped before the brain): `postSetupCard` no-ops if already set up,
   * so mentioning a configured Atlas won't spam the card.
   */
  private async onLifecycle(event: SlackLifecycleEvent): Promise<void> {
    if (event.kind === 'bot_joined' || event.kind === 'mention') {
      await this.onboarding.postSetupCard(event.teamId, event.channel);
    }
  }

  private async resolveApproval(
    payload: SlackBlockAction,
    actionId: string,
    rawValue: string | undefined,
  ): Promise<void> {
    const verdict = VERDICT_BY_ACTION[actionId];
    const meta = parseValue(rawValue);
    if (!meta?.jobId) {
      this.logger.warn('approval action missing jobId — ignoring');
      return;
    }
    const ruledBy = payload.user?.id ?? 'slack-user';
    const ok = this.approvals.resolve(meta.jobId, verdict, ruledBy);
    this.logger.log(`approval ${meta.jobId} → ${verdict} by ${ruledBy} (ok=${ok})`);

    // Repaint the card so the buttons are replaced with the verdict (best-effort).
    const channel = payload.channel?.id;
    const ts = payload.message?.ts;
    if (ok && channel && ts) {
      const line = `${VERDICT_LINE[verdict]} by <@${ruledBy}>`;
      await this.surface
        .update(channel, ts, { blocks: verdictBlocks(payload.message?.blocks ?? [], line) }, payload.team?.id)
        .catch((err) => this.logger.warn(`card update failed: ${err}`));
    }
  }
}

function parseValue(raw: string | undefined): ApprovalActionMeta | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ApprovalActionMeta;
  } catch {
    return undefined;
  }
}
