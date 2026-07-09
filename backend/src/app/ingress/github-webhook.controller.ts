import { Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { Public } from '@workspace/auth/server';
import { GithubNotificationSource } from './github-notification.source';
import { runIngress, runPrWebhook, type RawBodyRequest } from './ingress-http';
import { StimulusIntake } from '../stimulus';
import { GithubPrStateSync } from '../driver';

/**
 * `POST /webhooks/github/events` — the GitHub WORK-EVENTS webhook (CI results, reviews, PR/issue
 * comments). Verification + parsing + routing live in the `GithubNotificationSource` adapter; this
 * controller is thin plumbing: hand the raw request to the adapter, feed an accepted event into the
 * intake, return the mapped status. The event is ROUTED to the brain of the job that already OWNS its
 * PR/branch (a CI failure / review comment reaching the session that can act on it); an event nothing
 * owns is dropped — repo activity never seeds a new job (route-only, decision d6). A `pull_request`
 * arriving here is deliberately ignored (that drives the silent PR-state sync at
 * `/webhooks/github/state`, never this door). Reads `@Req()` for the raw body (the HMAC must cover the
 * EXACT bytes — the Atlas HTTP app is created with `rawBody: true`).
 *
 * Always answers fast (GitHub expects a timely 2xx). INBOUND-ONLY — no reply path. Zero v1 imports.
 */
@Public() // verifies itself via GitHub HMAC; no operator session involved
@Controller('webhooks/github/events')
export class GithubEventsWebhookController {
  private readonly logger = new Logger(GithubEventsWebhookController.name);

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
 * `POST /webhooks/github/state` — the GitHub PR-STATE webhook. Silent PR-state sync ONLY: it does its
 * own verify+route (shared with `GithubEventsWebhookController` via the adapter), parses `pull_request`
 * events into a `PrStateDelta`, and dispatches them straight to `GithubPrStateSync` — it never touches
 * `StimulusIntake`, so a PR event can't leak into triage / wake a brain / seed a job.
 */
@Public()
@Controller('webhooks/github/state')
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
