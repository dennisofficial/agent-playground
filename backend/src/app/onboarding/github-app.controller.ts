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
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Public } from '@workspace/auth/server';
import { IsIn } from 'class-validator';
import type { Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { GitHubAppTokenService } from '../git/github-app-token.service';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { GithubAppStateStore } from './github-app-state.store';
import { OnboardingService } from './onboarding.service';
import { TenantCredentialStore } from './tenant-credential.store';

/** Postgres unique-violation SQLSTATE — the `github_app_installation_id` partial unique index. */
const PG_UNIQUE_VIOLATION = '23505';

class SetGithubAuthModeDto {
  @IsIn(['pat', 'app']) mode!: 'pat' | 'app';
}

class SetGithubIdentityModeDto {
  @IsIn(['pat', 'app']) identity!: 'pat' | 'app';
}

/**
 * `/web/orgs/:orgId/github-app` — connect/disconnect the Atlas GitHub App and switch the org's
 * `githubAuthMode` between `pat` and `app`. Membership-gated; every write is owner-only
 * (`OrgOwnerGuard`) — connecting/disconnecting the App is an Administer action, same tier as
 * `OrgCredentialsController`.
 */
@Controller('web/orgs/:orgId/github-app')
@UseGuards(OrgMembershipGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
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
  async installUrl(@CurrentOrg() org: CurrentOrgCtx): Promise<{ url: string }> {
    if (!this.appTokens.isConfigured()) {
      throw new BadRequestException('GitHub App is not configured on this server');
    }
    const nonce = await this.stateStore.stash(org.id);
    const slug = await this.appTokens.appSlug();
    return { url: `https://github.com/apps/${slug}/installations/new?state=${nonce}` };
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

  /** Set the org's identity-write preference (which credential AUTHORS commits/PRs/comments/reviews). Permissive — the value is inert unless the fallback chain lands on it; the UI only exposes it when both a PAT and an App installation exist. */
  @Put('identity')
  @UseGuards(OrgOwnerGuard)
  async setIdentity(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: SetGithubIdentityModeDto,
  ): Promise<{ ok: true; identity: 'pat' | 'app' }> {
    await this.store.write(org.id, { githubIdentityMode: body.identity });
    await this.onboarding.tryActivate(org.id);
    return { ok: true, identity: body.identity };
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
    identityMode: 'pat' | 'app' | null;
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
      identityMode: presence.githubIdentityMode,
    };
  }
}

/**
 * `GET /web/github-app/callback` — the Atlas App's configured Setup URL. GitHub redirects the owner's
 * browser here after install/update with only `installation_id`/`setup_action`/`state` — no session, no
 * org. `@Public()` bypasses the global `AuthGuard` (mirrors `McpOAuthCallbackController`); the security
 * boundary is entirely the single-use `state` nonce (`GithubAppStateStore`) plus verifying the
 * installation actually mints a usable token before it's persisted. A unique-index collision (the
 * installation already claimed by a different org) is surfaced as a redirect error rather than a 409 —
 * there is no caller to receive one, only a browser to send back to the console.
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

    const orgId = await this.stateStore.consume(state);
    if (!orgId) {
      this.logger.warn('github app callback: unknown, expired, or already-used state');
      res.redirect(302, `${frontend}/?githubApp=error&reason=invalid_state`);
      return;
    }
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

    try {
      await this.store.write(orgId, {
        githubAppInstallationId: installationId,
        githubAuthMode: 'app',
        githubAppInstallationAccount: installation.account.login,
      });
    } catch (err) {
      if (
        err instanceof QueryFailedError &&
        (err as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
      ) {
        this.logger.warn(
          `github app callback: installation ${installationId} already connected to another org`,
        );
        res.redirect(302, `${settingsUrl}?githubApp=error&reason=already_connected`);
        return;
      }
      throw err;
    }

    // Best-effort — never fail the redirect over an activation hiccup.
    await this.onboarding.tryActivate(orgId).catch((err) => {
      this.logger.warn(`github app callback: tryActivate failed for org ${orgId}: ${err}`);
    });

    res.redirect(302, `${settingsUrl}?githubApp=connected`);
  }
}
