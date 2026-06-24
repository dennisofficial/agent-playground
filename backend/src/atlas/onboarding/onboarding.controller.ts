import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentOrg, type CurrentOrgCtx, OrgMembershipGuard } from '../org';
import { OnboardingService } from './onboarding.service';

/**
 * `GET /web/orgs/:orgId/onboarding` — the derived onboarding checklist (repo + credentials) the web
 * wizard renders. Membership-gated.
 */
@Controller('web/orgs/:orgId/onboarding')
@UseGuards(OrgMembershipGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  async status(@CurrentOrg() org: CurrentOrgCtx): Promise<{
    status: string;
    steps: Record<string, boolean>;
    missing: string[];
  }> {
    const s = await this.onboarding.status(org.id);
    return { status: s.lifecycle, steps: s.steps, missing: s.missing };
  }
}
