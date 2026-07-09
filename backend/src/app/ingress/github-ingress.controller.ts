import { Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { Public } from '@workspace/auth/server';
import { GithubNotificationSource } from './github-notification.source';
import { runIngress, runPrWebhook, type RawBodyRequest } from './ingress-http';
import { StimulusIntake } from '../stimulus';
import { GithubPrStateSync } from '../driver';

/**
 * `POST /ingress/github` — the GitHub webhook front door. Verification + parsing + routing live in the
 * `GithubNotificationSource` adapter; this controller is thin plumbing: hand the raw request to the
 * adapter, feed an accepted event into the intake, return the mapped status. Work-events→job intake
 * ONLY — a `pull_request` arriving here is deliberately ignored (that event drives the silent PR-state
 * sync over at `/webhooks/github`, never this door). Reads `@Req()` for the raw body (the HMAC must
 * cover the EXACT bytes — the Atlas HTTP app is created with `rawBody: true`).
 *
 * Always answers fast (GitHub expects a timely 2xx). Unlike v1's Slack ingress this is INBOUND-ONLY —
 * no reply path; the notification SEEDS a thread and the conversation continues over the chat surface.
 * Zero v1 imports.
 */
@Public() // verifies itself via GitHub HMAC; no operator session involved
@Controller('ingress/github')
export class GithubIngressController {
  private readonly logger = new Logger(GithubIngressController.name);

  constructor(
    private readonly adapter: GithubNotificationSource,
    private readonly intake: StimulusIntake,
  ) {}

  @Post()
  @HttpCode(202)
  async receive(@Req() req: RawBodyRequest): Promise<Record<string, unknown>> {
    return runIngress(this.logger, this.adapter, this.intake, req);
  }
}

/**
 * `POST /webhooks/github` — the GitHub PR-state webhook front door. Silent PR-state sync ONLY: it does
 * its own verify+route (shared with `GithubIngressController` via the adapter), parses `pull_request`
 * events into a `PrStateDelta`, and dispatches them straight to `GithubPrStateSync` — it never touches
 * `StimulusIntake`, so a PR event can't leak into triage.
 */
@Public()
@Controller('webhooks/github')
export class GithubStateWebhookController {
  private readonly logger = new Logger(GithubStateWebhookController.name);

  constructor(
    private readonly adapter: GithubNotificationSource,
    private readonly prSync: GithubPrStateSync,
  ) {}

  @Post()
  @HttpCode(202)
  async receive(@Req() req: RawBodyRequest): Promise<Record<string, unknown>> {
    return runPrWebhook(this.logger, this.adapter, req, this.prSync);
  }
}
