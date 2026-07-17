import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { ClaudeCredentialStore } from './claude-credential.store';
import { OauthUsageService } from './oauth-usage.service';
import { OnboardingService, type ValidationResult } from './onboarding.service';
import { TenantCredentialStore, type TenantCredentialPatch } from './tenant-credential.store';

class SetCredentialsDto {
  @IsOptional() @IsString() anthropicApiKey?: string;
  @IsOptional() @IsString() openaiApiKey?: string;
  @IsOptional() @IsString() githubPat?: string;
  @IsOptional() @IsString() claudeOauthToken?: string;
  @IsOptional() @IsString() codexAuthSecret?: string;
}

@Controller('web/orgs/:orgId/credentials')
@UseGuards(OrgMembershipGuard)
export class OrgCredentialsController {
  constructor(
    private readonly store: TenantCredentialStore,
    private readonly claudeStore: ClaudeCredentialStore,
    private readonly onboarding: OnboardingService,
    private readonly usage: OauthUsageService,
  ) {}

  @Put()
  @UseGuards(OrgOwnerGuard)
  async set(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: SetCredentialsDto,
  ): Promise<{ ok: boolean; validation: { llmKey?: ValidationResult } }> {
    const { claudeOauthToken, ...rest } = body;
    const patch: TenantCredentialPatch = { ...rest };
    await this.store.write(org.id, patch);
    if (claudeOauthToken !== undefined) {
      const changed = await this.claudeStore.upsertLegacySetupToken(org.id, claudeOauthToken);
      if (changed) await this.usage.invalidate(org.id);
    }

    let llmKey: ValidationResult | undefined;
    if (body.anthropicApiKey !== undefined) {
      llmKey = await this.onboarding.validateLlmKey(org.id);
    }
    await this.onboarding.tryActivate(org.id);
    return { ok: true, validation: { ...(llmKey ? { llmKey } : {}) } };
  }

  @Get()
  async presence(@CurrentOrg() org: CurrentOrgCtx): Promise<{
    hasAnthropic: boolean;
    hasOpenai: boolean;
    hasGithub: boolean;
    engineAuthSet: boolean;
    hasCodex: boolean;
    hasGithubApp: boolean;
    githubAuthMode: 'pat' | 'app';
    llmValidated: boolean;
  }> {
    const presence = await this.store.presence(org.id);
    const status = await this.onboarding.status(org.id);
    return { ...presence, llmValidated: status.steps.llmKey };
  }

  @Get('codex')
  @UseGuards(OrgOwnerGuard)
  async codex(
    @CurrentOrg() org: CurrentOrgCtx,
  ): Promise<{ present: boolean; accountEmail?: string }> {
    const email = await this.store.codexAccountEmail(org.id);
    const presence = await this.store.presence(org.id);
    return { present: presence.hasCodex, accountEmail: email };
  }
}
