import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OnboardingService } from './onboarding.service';

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
