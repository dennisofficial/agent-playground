import { Body, Controller, Get, Put, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { OnboardingService, type ValidationResult } from './onboarding.service';
import { TenantCredentialStore, type TenantCredentialPatch } from './tenant-credential.store';

class SetCredentialsDto {
  @IsOptional() @IsString() anthropicApiKey?: string;
  @IsOptional() @IsString() openaiApiKey?: string;
  @IsOptional() @IsString() githubPat?: string;
  @IsOptional() @IsIn(['api_key', 'subscription']) engineAuthMode?: 'api_key' | 'subscription';
  @IsOptional() @IsString() engineAuthSecret?: string;
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
    private readonly onboarding: OnboardingService,
  ) {}

  @Put()
  @UseGuards(OrgOwnerGuard)
  async set(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: SetCredentialsDto,
  ): Promise<{ ok: boolean; validation: { llmKey?: ValidationResult } }> {
    const patch: TenantCredentialPatch = { ...body };
    await this.store.write(org.id, patch);

    // Validate the Anthropic key when it was (re)set or engine auth is api_key — surfaces a bad key now.
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
    llmValidated: boolean;
  }> {
    const presence = await this.store.presence(org.id);
    const status = await this.onboarding.status(org.id);
    return { ...presence, llmValidated: status.steps.llmKey };
  }
}
