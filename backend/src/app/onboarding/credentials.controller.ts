import { Body, Controller, Get, Put, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { ClaudeCredentialStore } from './claude-credential.store';
import { OnboardingService, type ValidationResult } from './onboarding.service';
import { TenantCredentialStore, type TenantCredentialPatch } from './tenant-credential.store';

class SetCredentialsDto {
  @IsOptional() @IsString() anthropicApiKey?: string;
  @IsOptional() @IsString() openaiApiKey?: string;
  @IsOptional() @IsString() githubPat?: string;
  /** Claude subscription OAuth token for the SDK harness (engine runs subscription-only). */
  @IsOptional() @IsString() claudeOauthToken?: string;
  /** Codex subscription secret (auth.json / token) for the SDK harness. */
  @IsOptional() @IsString() codexAuthSecret?: string;
}

/**
 * `/web/orgs/:orgId/credentials` — set + inspect the org's encrypted credentials. PUT writes through the
 * single encrypt-on-write path, validates the Anthropic key (1-token probe), and tries to activate the
 * org. GET returns presence flags only (never secret values). Membership-gated; writing (PUT) is an
 * Administer action — owner only (`OrgOwnerGuard`).
 */
@Controller('web/orgs/:orgId/credentials')
@UseGuards(OrgMembershipGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class OrgCredentialsController {
  constructor(
    private readonly store: TenantCredentialStore,
    private readonly claudeStore: ClaudeCredentialStore,
    private readonly onboarding: OnboardingService,
  ) {}

  @Put()
  @UseGuards(OrgOwnerGuard)
  async set(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: SetCredentialsDto,
  ): Promise<{ ok: boolean; validation: { llmKey?: ValidationResult } }> {
    // `claudeOauthToken` no longer writes the legacy `claude_oauth_token_enc` column — it upserts+selects
    // a `setup_token` row in `claude_credentials` instead, keeping that table the single source of truth.
    const { claudeOauthToken, ...rest } = body;
    const patch: TenantCredentialPatch = { ...rest };
    await this.store.write(org.id, patch);
    if (claudeOauthToken !== undefined) {
      await this.claudeStore.upsertLegacySetupToken(org.id, claudeOauthToken);
    }

    // Validate the Anthropic key (LangChain chains) when it was (re)set — surfaces a bad key now.
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
    llmValidated: boolean;
  }> {
    const presence = await this.store.presence(org.id);
    const status = await this.onboarding.status(org.id);
    return { ...presence, llmValidated: status.steps.llmKey };
  }
}
