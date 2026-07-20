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
} from '@nestjs/common';
import type { OrgUsage } from '@workspace/shared';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { ClaudeCredentialStore, type ClaudeCredentialSummary } from './claude-credential.store';
import { ClaudeOAuthPkceStore } from './claude-oauth-pkce.store';
import {
  buildAuthorizeUrl,
  buildClaudeOAuthConfig,
  exchangeCode,
  generatePkce,
  type ClaudeOAuthConfig,
} from './claude-oauth.client';
import { OauthUsageService } from './oauth-usage.service';
import { OnboardingService } from './onboarding.service';

const SETUP_TOKEN_PREFIX = 'sk-ant-oat';

class CreateCredentialDto {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() setupToken?: string;
  @IsOptional() @IsString() label?: string;
}

class SelectCredentialDto {
  @IsString() @IsNotEmpty() credentialId!: string;
}

@Controller('web/orgs/:orgId/claude-credentials')
@UseGuards(OrgMembershipGuard)
export class ClaudeCredentialsController {
  constructor(
    private readonly store: ClaudeCredentialStore,
    private readonly pkce: ClaudeOAuthPkceStore,
    private readonly onboarding: OnboardingService,
    private readonly env: EnvService,
    private readonly usageService: OauthUsageService,
  ) {}

  private config(): ClaudeOAuthConfig {
    return buildClaudeOAuthConfig(this.env);
  }

  @Post('authorize-url')
  @UseGuards(OrgOwnerGuard)
  async authorizeUrl(@CurrentOrg() org: CurrentOrgCtx): Promise<{ url: string; state: string }> {
    const config = this.config();
    const { verifier, challenge, state } = generatePkce();
    await this.pkce.stash(org.id, state, verifier);
    return { url: buildAuthorizeUrl(config, { challenge, state }), state };
  }

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
    let usageInvalidated = false;
    if (rows.length === 1) {
      const changed = await this.store.setSelected(org.id, id);
      if (changed) {
        await this.usageService.invalidate(org.id);
        usageInvalidated = true;
      }
      rows = await this.store.list(org.id); // re-read so the returned summary's isSelected is accurate
    }

    const created = rows.find((row) => row.id === id);
    if (!created) throw new Error(`claude credential ${id} vanished immediately after create`);
    if (created.isSelected && !usageInvalidated) {
      await this.usageService.invalidate(org.id);
    }
    await this.onboarding.tryActivate(org.id);
    return created;
  }

  private async createPersonal(org: CurrentOrgCtx, body: CreateCredentialDto): Promise<string> {
    if (!body.state) throw new BadRequestException('state is required for the OAuth login flow');
    const code = body.code;
    if (!code) throw new BadRequestException('code is required for the OAuth login flow');
    const verifier = await this.pkce.consume(org.id, body.state);
    if (!verifier) throw new BadRequestException('expired or invalid state');
    const tokens = await exchangeCode(this.config(), {
      code,
      verifier,
      state: body.state,
    });
    const label = tokens.accountEmail?.trim() || 'Claude subscription';
    return this.store.upsertPersonal(org.id, {
      label,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      subscriptionType: tokens.subscriptionType,
      accountEmail: tokens.accountEmail,
    });
  }

  private async createSetupToken(org: CurrentOrgCtx, body: CreateCredentialDto): Promise<string> {
    const label = body.label?.trim();
    if (!label) throw new BadRequestException('label is required for a setup-token');
    const setupToken = body.setupToken;
    if (!setupToken) throw new BadRequestException('code or setupToken is required');
    if (!setupToken.startsWith(SETUP_TOKEN_PREFIX)) {
      throw new BadRequestException(`setup token must start with "${SETUP_TOKEN_PREFIX}"`);
    }
    return this.store.createSetupToken(org.id, {
      label,
      token: setupToken,
    });
  }

  @Get()
  @UseGuards(OrgOwnerGuard)
  async list(@CurrentOrg() org: CurrentOrgCtx): Promise<ClaudeCredentialSummary[]> {
    return this.store.list(org.id);
  }

  @Put('selected')
  @UseGuards(OrgOwnerGuard)
  async select(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: SelectCredentialDto,
  ): Promise<{ ok: true }> {
    const changed = await this.store.setSelected(org.id, body.credentialId);
    if (changed) await this.usageService.invalidate(org.id);
    await this.onboarding.tryActivate(org.id);
    return { ok: true };
  }

  @Delete(':id')
  @UseGuards(OrgOwnerGuard)
  async remove(@CurrentOrg() org: CurrentOrgCtx, @Param('id') id: string): Promise<{ ok: true }> {
    const changed = await this.store.remove(org.id, id);
    if (changed) await this.usageService.invalidate(org.id);
    return { ok: true };
  }

  @Get(':id/usage')
  @UseGuards(OrgOwnerGuard)
  async usage(@CurrentOrg() org: CurrentOrgCtx, @Param('id') id: string): Promise<OrgUsage> {
    return this.usageService.getForCredential(org.id, id);
  }
}
