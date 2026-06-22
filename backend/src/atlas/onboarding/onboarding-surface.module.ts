import { Module } from '@nestjs/common';
import { OnboardingSlackService } from './onboarding-slack.service';
import { SlackInteractivityBridge } from './slack-interactivity.bridge';
import { SlackOAuthController } from './slack-oauth.controller';

/**
 * The ONBOARDING SURFACE wiring (Phase 2/3) — the Slack-facing edge of the onboarding layer, kept
 * SEPARATE from the @Global `OnboardingModule` (credential store + service) because it depends on the
 * surface + brain (and must instantiate after them). Provides:
 *  - `SlackInteractivityBridge` — subscribes the surface's interactive/view/lifecycle Subjects and
 *    routes (approval verdicts → `DecisionApprovalService`, onboarding card/modal → `OnboardingSlackService`);
 *  - `OnboardingSlackService` — the in-Slack card + modal + the secret-write path;
 *  - `SlackOAuthController` — the `/slack/install` + `/slack/oauth_redirect` self-service install flow.
 *
 * Every dependency (`AtlasSlackSurface`, `SlackInstallationStore`, `DecisionApprovalService`,
 * `OnboardingService`, `TenantCredentialStore`) is provided by an @Global module, so this one only
 * declares its own providers + controller. Imported LAST in `AppModule` so those globals exist first.
 */
@Module({
  controllers: [SlackOAuthController],
  providers: [OnboardingSlackService, SlackInteractivityBridge],
  exports: [OnboardingSlackService],
})
export class OnboardingSurfaceModule {}
