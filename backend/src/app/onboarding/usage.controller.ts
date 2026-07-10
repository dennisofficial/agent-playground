import { Controller, Get, UseGuards } from '@nestjs/common';
import type { OrgUsage } from '@workspace/shared';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OauthUsageService } from './oauth-usage.service';

/**
 * `/web/orgs/:orgId/usage` — the org's merged Claude subscription usage snapshot (harvested from live
 * turns, filled by the unofficial `/api/oauth/usage` HTTP fallback when cold). Membership-gated, read-only.
 */
@Controller('web/orgs/:orgId/usage')
@UseGuards(OrgMembershipGuard)
export class OrgUsageController {
  constructor(private readonly usage: OauthUsageService) {}

  @Get()
  async get(@CurrentOrg() org: CurrentOrgCtx): Promise<OrgUsage> {
    return this.usage.get(org.id);
  }
}
