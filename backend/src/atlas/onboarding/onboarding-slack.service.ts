import { Injectable, Logger } from '@nestjs/common';
import { parseGithubRepoUrl } from '../git';
import {
  AtlasSlackSurface,
  type SlackBlockAction,
  type SlackViewSubmission,
} from '../surface';
import {
  type OnboardSetupMeta,
  onboardingCardBlocks,
  parseSetupValues,
  setupModalView,
} from './onboarding-blocks';
import { OnboardingService } from './onboarding.service';
import { TenantCredentialStore } from './tenant-credential.store';

/**
 * The in-Slack onboarding UX — the SECRET-WRITE path. Posts the setup card when Atlas joins a channel,
 * opens the setup modal on the card button, and on `view_submission` writes the workspace's credentials
 * (the ONLY secret-write path) + binds the channel to its repo + activates the tenant. Slack-specific,
 * so it talks to `AtlasSlackSurface` directly (post/openModal); the generic state lives in
 * `OnboardingService`. Raw secrets never touch chat text — only the modal's encrypted-at-rest write.
 */
@Injectable()
export class OnboardingSlackService {
  private readonly logger = new Logger(OnboardingSlackService.name);

  constructor(
    private readonly surface: AtlasSlackSurface,
    private readonly onboarding: OnboardingService,
    private readonly store: TenantCredentialStore,
  ) {}

  /** Post the setup card in a channel Atlas was just added to (idempotent enough — one card per join). */
  async postSetupCard(teamId: string, channel: string): Promise<void> {
    const status = await this.onboarding.status(teamId);
    if (status.lifecycle === 'active' && status.missing.length === 0) return; // already set up
    await this.surface.post(
      channel,
      'Set up Atlas in this channel',
      { teamId, blocks: onboardingCardBlocks(status) },
    );
  }

  /** Card button → open the setup modal, stashing where to bind in `private_metadata`. */
  async openSetupModal(payload: SlackBlockAction): Promise<void> {
    const teamId = payload.team?.id;
    const channelRef = payload.channel?.id;
    const triggerId = payload.trigger_id;
    if (!teamId || !channelRef || !triggerId) {
      this.logger.warn('onboarding modal open missing team/channel/trigger — ignoring');
      return;
    }
    const meta: OnboardSetupMeta = { teamId, channelRef };
    await this.surface.openModal(triggerId, setupModalView(meta), teamId);
  }

  /** Modal submit → write secrets, bind the channel to its repo, activate. The only secret-write path. */
  async handleSetupSubmission(payload: SlackViewSubmission): Promise<void> {
    const meta = parseMeta(payload.view?.private_metadata);
    const teamId = meta?.teamId ?? payload.team?.id;
    if (!teamId) {
      this.logger.warn('onboarding submission missing teamId — ignoring');
      return;
    }
    const values = parseSetupValues(payload.view?.state?.values);

    // Secrets → encrypted store (only provided fields). NEVER logged.
    if (values.anthropicKey || values.githubPat) {
      await this.store.write(teamId, {
        ...(values.anthropicKey ? { anthropicApiKey: values.anthropicKey } : {}),
        ...(values.githubPat ? { githubPat: values.githubPat } : {}),
      });
    }

    // Repo → bind the channel (projectId derived from the repo name).
    let channelRef = meta?.channelRef;
    if (values.repoUrl && channelRef) {
      const parsed = parseGithubRepoUrl(values.repoUrl);
      const projectId = parsed?.repo ?? channelRef;
      await this.onboarding.bindChannel({
        teamId,
        projectId,
        channelRef,
        repoUrl: values.repoUrl,
      });
    }

    const status = await this.onboarding.tryActivate(teamId);
    if (channelRef) {
      const text =
        status.missing.length === 0
          ? '✅ Atlas is set up here — send me what you’d like built.'
          : `Saved. Still needed: ${status.missing.join(', ')}. Re-open setup to finish.`;
      await this.surface.post(channelRef, text, { teamId });
    }
  }
}

function parseMeta(raw: string | undefined): OnboardSetupMeta | undefined {
  if (!raw) return undefined;
  try {
    const m = JSON.parse(raw) as Partial<OnboardSetupMeta>;
    return m.teamId && m.channelRef ? { teamId: m.teamId, channelRef: m.channelRef } : undefined;
  } catch {
    return undefined;
  }
}
