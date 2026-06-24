import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import { IsString, MinLength } from 'class-validator';
import { OnboardingService } from '../onboarding/onboarding.service';
import type { AtlasUser } from '../persistence/entities';
import { CurrentOrg, type CurrentOrgCtx } from './current-org.decorator';
import { OrgMembershipGuard } from './org-membership.guard';
import { OrganizationService, type OrgSummary } from './organization.service';

class CreateOrgDto {
  @IsString()
  @MinLength(2, { message: 'Organization name must be at least 2 characters' })
  name!: string;
}

/**
 * `/web/orgs` — organization CRUD for the web console. Gated by the global `AtlasAuthGuard` (logged in);
 * `:orgId` routes additionally require `OrgMembershipGuard`. Creating an org makes the caller its owner.
 */
@Controller('web/orgs')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class OrgController {
  constructor(
    private readonly orgs: OrganizationService,
    private readonly onboarding: OnboardingService,
  ) {}

  /** `POST /web/orgs` — create an org; the caller becomes owner. */
  @Post()
  async create(@CurrentUser() user: AtlasUser, @Body() body: CreateOrgDto): Promise<OrgSummary> {
    return this.orgs.create(user.id, body.name);
  }

  /** `GET /web/orgs` — every org the caller belongs to. */
  @Get()
  async list(@CurrentUser() user: AtlasUser): Promise<OrgSummary[]> {
    return this.orgs.listForUser(user.id);
  }

  /** `GET /web/orgs/:orgId` — org detail + the derived onboarding checklist. */
  @Get(':orgId')
  @UseGuards(OrgMembershipGuard)
  async detail(@CurrentOrg() org: CurrentOrgCtx): Promise<unknown> {
    const row = await this.orgs.get(org.id);
    if (!row) throw new NotFoundException('Organization not found');
    const onboarding = await this.onboarding.status(org.id);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      status: row.status,
      role: org.role,
      onboarding: {
        lifecycle: onboarding.lifecycle,
        steps: onboarding.steps,
        missing: onboarding.missing,
      },
    };
  }
}
