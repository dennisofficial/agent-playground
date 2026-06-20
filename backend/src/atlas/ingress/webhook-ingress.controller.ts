import { Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { GenericWebhookNotificationSource } from './generic-webhook-notification.source';
import { runIngress, type RawBodyRequest } from './ingress-http';
import { StimulusIntake } from '../stimulus';

/**
 * `POST /ingress/webhook` — the generic first-party webhook front door (PostHog/Sentry/cron drop in
 * here until each warrants its own adapter+endpoint). Verification (shared-secret header) + parsing +
 * routing live in the `GenericWebhookNotificationSource` adapter; this controller is the same thin
 * plumbing as the GitHub one. Inbound-only — seeds a thread, no reply path. Zero v1 imports.
 */
@Controller('ingress/webhook')
export class WebhookIngressController {
  private readonly logger = new Logger(WebhookIngressController.name);

  constructor(
    private readonly adapter: GenericWebhookNotificationSource,
    private readonly intake: StimulusIntake,
  ) {}

  @Post()
  @HttpCode(202)
  async receive(@Req() req: RawBodyRequest): Promise<Record<string, unknown>> {
    return runIngress(this.logger, this.adapter, this.intake, req);
  }
}
