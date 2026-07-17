import { Module } from '@nestjs/common';
import { StimulusModule } from '../stimulus/stimulus.module';
import { GithubNotificationSource } from './github-notification.source';
import {
  GithubEventsWebhookController,
  GithubStateWebhookController,
} from './github-webhook.controller';

/**
 * The Atlas v2 GITHUB WEBHOOK edge — the HTTP ingress for GitHub's two webhooks on each connected repo:
 *
 *  - `POST /webhooks/github/events` (WORK_EVENTS) → `GithubNotificationSource.handle` → `StimulusIntake`,
 *    which ROUTES the event to the job that owns its PR/branch (route-only — an unowned event never
 *    seeds a job; decision d6).
 *  - `POST /webhooks/github/state` (pull_request) → `GithubNotificationSource.handlePrWebhook` →
 *    `GithubPrStateSync`, a silent PR-state sync that never touches the intake.
 *
 * Both are literally GitHub webhooks on the same repo, split by event set + downstream behavior (wakes a
 * brain vs silent state). The single adapter owns verification (HMAC), parsing, dedupe-key derivation,
 * severity mapping, and repo routing. New gateways (PostHog/Sentry/email) are drop-ins: add an adapter
 * implementing `NotificationSource` + a thin controller, wire them here.
 *
 * Depends on `StimulusModule` for the intake seam + repo routing. Zero v1 imports.
 */
@Module({
  imports: [StimulusModule],
  controllers: [GithubEventsWebhookController, GithubStateWebhookController],
  providers: [GithubNotificationSource],
  exports: [GithubNotificationSource],
})
export class IngressModule {}
