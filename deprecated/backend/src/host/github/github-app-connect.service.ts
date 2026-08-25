import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import type { GithubAppInstallUrl, GithubAppStatus } from '@workspace/shared';
import { OrgCredentialsService } from '../org-credentials/credentials.service';
import { OrgService } from '../org/org.service';
import { GithubAppStateStore } from './github-app-state.store';
import { GithubAppTokenService } from './github-app-token.service';

@Injectable()
export class GithubAppConnectService {
  private readonly logger = new Logger(this.constructor.name);

  constructor(
    private readonly appTokens: GithubAppTokenService,
    private readonly stateStore: GithubAppStateStore,
    private readonly credentials: OrgCredentialsService,
    private readonly orgs: OrgService,
    private readonly env: EnvService,
  ) {}

  /** Build the GitHub install URL (owner-only), carrying a single-use state nonce. */
  async installUrl(userId: string, orgId: string): Promise<GithubAppInstallUrl> {
    await this.orgs.assertOwner(userId, orgId);
    const nonce = await this.stateStore.stash(orgId, userId);
    return {
      url: `https://github.com/apps/${this.appTokens.appSlug()}/installations/new?state=${nonce}`,
    };
  }

  /** The org's App connection status (any member). */
  async status(userId: string, orgId: string): Promise<GithubAppStatus> {
    await this.orgs.assertMember(userId, orgId);
    const installation = await this.credentials.getGithubAppInstallation(orgId);
    return {
      connected: !!installation,
      installationId: installation?.id ?? null,
      account: installation?.account ?? null,
    };
  }

  /** Disconnect the org's App installation (owner-only). */
  async disconnect(userId: string, orgId: string): Promise<void> {
    await this.orgs.assertOwner(userId, orgId);
    await this.credentials.clearGithubAppInstallation(orgId);
  }

  async completeCallback(args: {
    installationId?: string;
    state?: string;
  }): Promise<{ redirectUrl: string }> {
    const frontend = this.env.get('FRONTEND_HOST');
    const { installationId, state } = args;

    if (!state || !installationId) {
      this.logger.warn('github app callback missing state or installation_id');
      return { redirectUrl: `${frontend}/?githubApp=error&reason=invalid_state` };
    }

    const consumed = await this.stateStore.consume(state);
    if (!consumed) {
      this.logger.warn('github app callback: unknown, expired, or already-used state');
      return { redirectUrl: `${frontend}/?githubApp=error&reason=invalid_state` };
    }
    const { orgId, userId } = consumed;
    const settingsUrl = `${frontend}/orgs/${orgId}/settings`;

    // Verify the installation is real AND we can mint a token for it before trusting it.
    const installation = await this.appTokens.getInstallation(installationId).catch(() => null);
    const mintedOk = await this.appTokens
      .getInstallationToken(installationId)
      .then(() => true)
      .catch(() => false);
    if (!installation || !mintedOk) {
      this.logger.warn(
        `github app callback: installation ${installationId} failed verification for org ${orgId}`,
      );
      return { redirectUrl: `${settingsUrl}?githubApp=error&reason=verification_failed` };
    }

    // Reuse guard: an installation already held by another org is only allowed if the connecting user
    // also owns that org (e.g. re-pointing their own installation), never a silent cross-org claim.
    const otherHolders = await this.credentials.orgsHoldingInstallation(installationId, orgId);
    if (otherHolders.length > 0) {
      const mayReuse = userId ? await this.orgs.ownsAnyOf(userId, otherHolders) : false;
      if (!mayReuse) {
        this.logger.warn(
          `github app callback: installation ${installationId} held by another owner's org — denying reuse for org ${orgId}`,
        );
        return { redirectUrl: `${settingsUrl}?githubApp=error&reason=already_connected` };
      }
    }

    await this.credentials.setGithubAppInstallation(orgId, {
      id: installationId,
      account: installation.accountLogin,
    });

    return { redirectUrl: `${settingsUrl}?githubApp=connected` };
  }
}
