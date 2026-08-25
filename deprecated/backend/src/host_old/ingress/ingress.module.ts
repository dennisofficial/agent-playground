import { Module } from '@nestjs/common';
import { StimulusModule } from '../stimulus/stimulus.module';
import { GithubNotificationSource } from './github-notification.source';
import {
  GithubEventsWebhookController,
  GithubStateWebhookController,
} from './github-webhook.controller';

@Module({
  imports: [StimulusModule],
  controllers: [GithubEventsWebhookController, GithubStateWebhookController],
  providers: [GithubNotificationSource],
  exports: [GithubNotificationSource],
})
export class IngressModule {}
