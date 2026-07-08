import { Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { Public } from '@workspace/auth/server';
import { GithubNotificationSource } from './github-notification.source';
import { runIngress, type RawBodyRequest } from './ingress-http';
import { StimulusIntake } from '../stimulus';
import { GithubPrStateSync } from '../driver';

/**
 * `POST /ingress/github` — the GitHub webhook front door. Verification + parsing + routing live in the
 * `GithubNotificationSource` adapter; this controller is thin plumbing: hand the raw request to the
 * adapter, feed an accepted event into the intake, return the mapped status. Reads `@Req()` for the
 * raw body (the HMAC must cover the EXACT bytes — the Atlas HTTP app is created with `rawBody: true`).
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
    private readonly prSync: GithubPrStateSync,
  ) {}

  @Post()
  @HttpCode(202)
  async receive(@Req() req: RawBodyRequest): Promise<Record<string, unknown>> {
    return runIngress(this.logger, this.adapter, this.intake, req, this.prSync);
  }
}
