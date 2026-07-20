import { Controller, Get, UseGuards } from '@nestjs/common';
import type { OrgUsage } from '@workspace/shared';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OauthUsageService } from './oauth-usage.service';

@Controller('web/orgs/:orgId/usage')
@UseGuards(OrgMembershipGuard)
export class OrgUsageController {
  constructor(private readonly usage: OauthUsageService) {}

  @Get()
  async get(@CurrentOrg() org: CurrentOrgCtx): Promise<OrgUsage> {
    return this.usage.get(org.id);
  }
}
