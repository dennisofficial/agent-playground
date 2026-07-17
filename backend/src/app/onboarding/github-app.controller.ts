import { EnvService } from '@core/config/env/env.service';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, Public } from '@workspace/auth/server';
import { IsIn } from 'class-validator';
import type { Response } from 'express';
import { GitHubAppTokenService } from '../git/github-app-token.service';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { OrganizationService } from '../org/organization.service';
import type { UserEntity } from '../persistence/entities';
import { GithubAppStateStore } from './github-app-state.store';
import { OnboardingService } from './onboarding.service';
import { TenantCredentialStore } from './tenant-credential.store';

class SetGithubAuthModeDto {
  @IsIn(['pat', 'app']) mode!: 'pat' | 'app';
}

@Controller('web/orgs/:orgId/github-app')
@UseGuards(OrgMembershipGuard)
export class GithubAppController {
  constructor(
    private readonly store: TenantCredentialStore,
    private readonly appTokens: GitHubAppTokenService,
    private readonly onboarding: OnboardingService,
    private readonly stateStore: GithubAppStateStore,
  ) {}

  @Post('install-url')
  @UseGuards(OrgOwnerGuard)
  async installUrl(
    @CurrentOrg() org: CurrentOrgCtx,
    @CurrentUser() user: UserEntity,
  ): Promise<{ url: string }> {
    if (!this.appTokens.isConfigured()) {
      throw new BadRequestException('GitHub App is not configured on this server');
    }
    const nonce = await this.stateStore.stash(org.id, user.id);
    const slug = await this.appTokens.appSlug();
    return {
      url: `https://github.com/apps/${slug}/installations/new?state=${nonce}`,
    };
  }

  @Put('mode')
  @UseGuards(OrgOwnerGuard)
  async setMode(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: SetGithubAuthModeDto,
  ): Promise<{ ok: true; mode: 'pat' | 'app' }> {
    const creds = await this.store.read(org.id);
    if (body.mode === 'app') {
      if (!creds?.githubAppInstallationId) {
        throw new BadRequestException('Connect the GitHub App before switching to app mode');
      }
    } else if (!creds?.githubPat) {
      throw new BadRequestException('Save a GitHub PAT before switching to PAT mode');
    }
    await this.store.write(org.id, { githubAuthMode: body.mode });
    await this.onboarding.tryActivate(org.id);
    return { ok: true, mode: body.mode };
  }

  @Delete()
  @UseGuards(OrgOwnerGuard)
  async disconnect(@CurrentOrg() org: CurrentOrgCtx): Promise<{ ok: true }> {
    await this.store.write(org.id, {
      githubAppInstallationId: null,
      githubAppInstallationAccount: null,
      githubAuthMode: 'pat',
    });
    await this.onboarding.tryActivate(org.id);
    return { ok: true };
  }

  @Get('status')
  async status(@CurrentOrg() org: CurrentOrgCtx): Promise<{
    configured: boolean;
    connected: boolean;
    mode: 'pat' | 'app';
    installationId: string | null;
    account: string | null;
  }> {
    const [presence, creds] = await Promise.all([
      this.store.presence(org.id),
      this.store.read(org.id),
    ]);
    return {
      configured: this.appTokens.isConfigured(),
      connected: presence.hasGithubApp,
      mode: presence.githubAuthMode,
      installationId: creds?.githubAppInstallationId ?? null,
      account: creds?.githubAppInstallationAccount ?? null,
    };
  }
}

@Public()
@Controller('web/github-app')
export class GithubAppCallbackController {
  private readonly logger = new Logger(GithubAppCallbackController.name);

  constructor(
    private readonly stateStore: GithubAppStateStore,
    private readonly appTokens: GitHubAppTokenService,
    private readonly store: TenantCredentialStore,
    private readonly onboarding: OnboardingService,
    private readonly orgs: OrganizationService,
    private readonly env: EnvService,
  ) {}

  @Get('callback')
  async callback(
    @Query('installation_id') installationId: string | undefined,
    @Query('setup_action') setupAction: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const frontend = this.env.get('FRONTEND_HOST');

    if (!state || !installationId) {
      this.logger.warn(
        `github app callback missing state or installation_id (setup_action=${setupAction ?? 'none'})`,
      );
      res.redirect(302, `${frontend}/?githubApp=error&reason=invalid_state`);
      return;
    }

    const consumed = await this.stateStore.consume(state);
    if (!consumed) {
      this.logger.warn('github app callback: unknown, expired, or already-used state');
      res.redirect(302, `${frontend}/?githubApp=error&reason=invalid_state`);
      return;
    }
    const { orgId, userId } = consumed;
    const settingsUrl = `${frontend}/orgs/${orgId}/settings`;

    const installation = await this.appTokens.getInstallation(installationId).catch(() => null);
    const mintedOk = await this.appTokens
      .getInstallationToken(installationId)
      .then(() => true)
      .catch(() => false);
    if (!installation || !mintedOk) {
      this.logger.warn(
        `github app callback: installation ${installationId} failed verification for org ${orgId}`,
      );
      res.redirect(302, `${settingsUrl}?githubApp=error&reason=verification_failed`);
      return;
    }

    const otherHolders = await this.store.orgsHoldingInstallation(installationId, orgId);
    if (otherHolders.length > 0) {
      const mayReuse = userId ? await this.orgs.ownsAnyOf(userId, otherHolders) : false;
      if (!mayReuse) {
        this.logger.warn(
          `github app callback: installation ${installationId} held by another owner's org — denying reuse for org ${orgId}`,
        );
        res.redirect(302, `${settingsUrl}?githubApp=error&reason=already_connected`);
        return;
      }
    }

    await this.store.write(orgId, {
      githubAppInstallationId: installationId,
      githubAppInstallationAccount: installation.account.login,
    });

    await this.onboarding.tryActivate(orgId).catch((err) => {
      this.logger.warn(`github app callback: tryActivate failed for org ${orgId}: ${err}`);
    });

    res.redirect(302, `${settingsUrl}?githubApp=connected`);
  }
}
