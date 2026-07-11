import { EnvService } from '@core/config/env/env.service';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import {
  buildAuthorizeUrl,
  DEFAULT_CLAUDE_OAUTH_CONFIG,
  exchangeCode,
  generatePkce,
  type ClaudeOAuthConfig,
} from './claude-oauth.client';
import { ClaudeOAuthPkceStore } from './claude-oauth-pkce.store';
import {
  ClaudeCredentialStore,
  type ClaudeCredentialSummary,
} from './claude-credential.store';
import { OnboardingService } from './onboarding.service';

/** A `claude setup-token`'s literal prefix — the only shape accepted for the setup-token creation path. */
const SETUP_TOKEN_PREFIX = 'sk-ant-oat';

class AuthorizeUrlDto {
  @IsString() @IsNotEmpty() label!: string;
}

class CreateCredentialDto {
  /** Present for the `personal` (OAuth login) path, alongside `state`. */
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() state?: string;
  /** Present for the `setup_token` path. */
  @IsOptional() @IsString() setupToken?: string;
  @IsString() @IsNotEmpty() label!: string;
}

class SelectCredentialDto {
  @IsString() @IsNotEmpty() credentialId!: string;
}

/**
 * `/web/orgs/:orgId/claude-credentials` — manage the org's LIST of Claude credentials (multi-credential
 * successor to the legacy singleton `claudeOauthToken`). Every route is owner-only (`OrgOwnerGuard`),
 * including `list`: rows carry account emails, which is Administer-tier info, not member-visible. Secret
 * VALUES never appear in a request/response body or a log line — only `ClaudeCredentialSummary` rows leave
 * this controller.
 */
@Controller('web/orgs/:orgId/claude-credentials')
@UseGuards(OrgMembershipGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class ClaudeCredentialsController {
  constructor(
    private readonly store: ClaudeCredentialStore,
    private readonly pkce: ClaudeOAuthPkceStore,
    private readonly onboarding: OnboardingService,
    private readonly env: EnvService,
  ) {}

  private config(): ClaudeOAuthConfig {
    return {
      ...DEFAULT_CLAUDE_OAUTH_CONFIG,
      authorizeUrl:
        this.env.get('CLAUDE_OAUTH_AUTHORIZE_URL') ??
        DEFAULT_CLAUDE_OAUTH_CONFIG.authorizeUrl,
      clientId:
        this.env.get('CLAUDE_OAUTH_CLIENT_ID') ??
        DEFAULT_CLAUDE_OAUTH_CONFIG.clientId,
    };
  }

  /** Kick off consent: mint + stash a fresh PKCE verifier, return the URL the owner opens. */
  @Post('authorize-url')
  @UseGuards(OrgOwnerGuard)
  async authorizeUrl(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: AuthorizeUrlDto,
  ): Promise<{ url: string; state: string; label: string }> {
    const config = this.config();
    const { verifier, challenge, state } = generatePkce();
    await this.pkce.stash(org.id, state, verifier);
    return {
      url: buildAuthorizeUrl(config, { challenge, state }),
      state,
      label: body.label,
    };
  }

  /** Create a credential — either a `personal` OAuth login (`code`+`state`) or a `setup_token` (`setupToken`). */
  @Post()
  @UseGuards(OrgOwnerGuard)
  async create(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: CreateCredentialDto,
  ): Promise<ClaudeCredentialSummary> {
    const id =
      body.code !== undefined
        ? await this.createPersonal(org, body)
        : await this.createSetupToken(org, body);

    let rows = await this.store.list(org.id);
    if (rows.length === 1) {
      await this.store.setSelected(org.id, id);
      rows = await this.store.list(org.id); // re-read so the returned summary's isSelected is accurate
    }
    await this.onboarding.tryActivate(org.id);

    const created = rows.find((row) => row.id === id);
    if (!created)
      throw new Error(
        `claude credential ${id} vanished immediately after create`,
      );
    return created;
  }

  private async createPersonal(
    org: CurrentOrgCtx,
    body: CreateCredentialDto,
  ): Promise<string> {
    if (!body.state)
      throw new BadRequestException(
        'state is required for the OAuth login flow',
      );
    const code = body.code;
    if (!code)
      throw new BadRequestException(
        'code is required for the OAuth login flow',
      );
    const verifier = await this.pkce.consume(org.id, body.state);
    if (!verifier) throw new BadRequestException('expired or invalid state');
    const tokens = await exchangeCode(this.config(), {
      code,
      verifier,
      state: body.state,
    });
    return this.store.createPersonal(org.id, {
      label: body.label,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      subscriptionType: tokens.subscriptionType,
      accountEmail: tokens.accountEmail,
    });
  }

  private async createSetupToken(
    org: CurrentOrgCtx,
    body: CreateCredentialDto,
  ): Promise<string> {
    const setupToken = body.setupToken;
    if (!setupToken)
      throw new BadRequestException('code or setupToken is required');
    if (!setupToken.startsWith(SETUP_TOKEN_PREFIX)) {
      throw new BadRequestException(
        `setup token must start with "${SETUP_TOKEN_PREFIX}"`,
      );
    }
    return this.store.createSetupToken(org.id, {
      label: body.label,
      token: setupToken,
    });
  }

  @Get()
  @UseGuards(OrgOwnerGuard)
  async list(
    @CurrentOrg() org: CurrentOrgCtx,
  ): Promise<ClaudeCredentialSummary[]> {
    return this.store.list(org.id);
  }

  @Put('selected')
  @UseGuards(OrgOwnerGuard)
  async select(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: SelectCredentialDto,
  ): Promise<{ ok: true }> {
    await this.store.setSelected(org.id, body.credentialId);
    await this.onboarding.tryActivate(org.id);
    return { ok: true };
  }

  @Delete(':id')
  @UseGuards(OrgOwnerGuard)
  async remove(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.store.remove(org.id, id);
    return { ok: true };
  }
}
