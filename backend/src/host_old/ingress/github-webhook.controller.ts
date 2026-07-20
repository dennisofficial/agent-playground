import { Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { Public } from '@workspace/auth/server';
import { BaseMoveMergeabilitySync } from '../driver/base-move-mergeability-sync.service';
import { GitStateReconciler } from '../driver/git-state-reconciler.service';
import { GithubCiStateSync } from '../driver/github-ci-state-sync.service';
import { GithubPrStateSync } from '../driver/github-pr-state-sync.service';
import { StimulusIntake } from '../stimulus/stimulus-intake.service';
import { GithubNotificationSource } from './github-notification.source';
import { runPrWebhook, runWorkEvent, type RawBodyRequest } from './ingress-http';

@Public() // verifies itself via GitHub HMAC; no operator session involved
@Controller('webhooks/github/events')
export class GithubEventsWebhookController {
  private readonly logger = new Logger(GithubEventsWebhookController.name);

  constructor(
    private readonly adapter: GithubNotificationSource,
    private readonly intake: StimulusIntake,
    private readonly ciSync: GithubCiStateSync,
    private readonly reconciler: GitStateReconciler,
  ) {}

  @Post()
  @HttpCode(202)
  async receive(@Req() req: RawBodyRequest): Promise<Record<string, unknown>> {
    return runWorkEvent(this.logger, this.adapter, this.intake, this.ciSync, this.reconciler, req);
  }
}

@Public()
@Controller('webhooks/github/state')
export class GithubStateWebhookController {
  private readonly logger = new Logger(GithubStateWebhookController.name);

  constructor(
    private readonly adapter: GithubNotificationSource,
    private readonly prSync: GithubPrStateSync,
    private readonly reconciler: GitStateReconciler,
    private readonly baseMove: BaseMoveMergeabilitySync,
  ) {}

  @Post()
  @HttpCode(202)
  async receive(@Req() req: RawBodyRequest): Promise<Record<string, unknown>> {
    return runPrWebhook(
      this.logger,
      this.adapter,
      req,
      this.prSync,
      this.reconciler,
      this.baseMove,
    );
  }
}
