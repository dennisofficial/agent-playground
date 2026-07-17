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

/**
 * `/web/orgs/:orgId/github-app` — connect/disconnect the Atlas GitHub App and switch the org's
 * `githubAuthMode` between `pat` and `app`. Membership-gated; every write is owner-only
 * (`OrgOwnerGuard`) — connecting/disconnecting the App is an Administer action, same tier as
 * `OrgCredentialsController`. Connecting the App (the callback below) does NOT change `githubAuthMode` —
 * the owner switches modes explicitly via `PUT mode`.
 */
@Controller('web/orgs/:orgId/github-app')
@UseGuards(OrgMembershipGuard)
export class GithubAppController {
  constructor(
    private readonly store: TenantCredentialStore,
    private readonly appTokens: GitHubAppTokenService,
    private readonly onboarding: OnboardingService,
    private readonly stateStore: GithubAppStateStore,
  ) {}

  /** Mint the org's install URL: a single-use nonce (see {@link GithubAppStateStore}) + the App's slug. */
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

  /** Switch the resolved GitHub credential. `app` requires a connected installation first. */
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

  /** Disconnect the App: clear the installation + fall back to `pat` mode. */
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

  /** Connect state for the settings UI — member-visible (no secret values). */
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

/**
 * `GET /web/github-app/callback` — the Atlas App's configured Setup URL. GitHub redirects the owner's
 * browser here after install/update with only `installation_id`/`setup_action`/`state` — no session, no
 * org. `@Public()` bypasses the global `AuthGuard` (mirrors `McpOAuthCallbackController`); the security
 * boundary is the single-use `state` nonce (`GithubAppStateStore`, which also carries the initiating
 * user) plus verifying the installation actually mints a usable token before it's persisted. One GitHub
 * App installs once per GitHub account, so an installation may legitimately back several Atlas orgs owned
 * by the same person: reuse is allowed only when the initiating user OWNS another org that already holds
 * the installation (common-ownership gate) — otherwise it's refused as `already_connected`, blocking
 * cross-tenant installation takeover. That reject is a redirect, not a 409 — there is no caller to
 * receive one, only a browser to send back to the console.
 */
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

    // Common-ownership reuse gate: an installation already held by ANOTHER org may be linked here only
    // when the initiating user also owns one of those holder orgs (spreading their own installation
    // across their own orgs). Otherwise it's a cross-tenant takeover attempt — refuse.
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

    // Best-effort — never fail the redirect over an activation hiccup.
    await this.onboarding.tryActivate(orgId).catch((err) => {
      this.logger.warn(`github app callback: tryActivate failed for org ${orgId}: ${err}`);
    });

    res.redirect(302, `${settingsUrl}?githubApp=connected`);
  }
}
