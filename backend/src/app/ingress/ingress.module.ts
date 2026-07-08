import { Module } from '@nestjs/common';
import { StimulusModule } from '../stimulus';
import { GenericWebhookNotificationSource } from './generic-webhook-notification.source';
import {
  GithubIngressController,
  GithubStateWebhookController,
} from './github-ingress.controller';
import { GithubNotificationSource } from './github-notification.source';
import { WebhookIngressController } from './webhook-ingress.controller';

/**
 * The Atlas v2 INGRESS module — the HTTP edge for the `NotificationSource` adapters. One controller +
 * one adapter per gateway (MVP: GitHub + generic webhook); each adapter owns its verification, parsing,
 * dedupe-key derivation, severity mapping, and project routing, and emits ONLY a `ParsedEvent` into
 * the shared `StimulusIntake`. New gateways (PostHog/Sentry/email) are drop-ins: add an adapter
 * implementing `NotificationSource` + a thin controller, wire them here.
 *
 * Depends on `StimulusModule` for the intake seam + project routing (the only shared contract
 * downstream of an adapter). Zero v1 imports.
 */
@Module({
  imports: [StimulusModule],
  controllers: [
    GithubIngressController,
    GithubStateWebhookController,
    WebhookIngressController,
  ],
  providers: [GithubNotificationSource, GenericWebhookNotificationSource],
  exports: [GithubNotificationSource, GenericWebhookNotificationSource],
})
export class IngressModule {}
