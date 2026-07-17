import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import { AUTO_APPROVE_MODES, type AutoApproveMode } from '@workspace/shared';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { OnboardingService } from '../onboarding/onboarding.service';
import type { UserEntity } from '../persistence/entities';
import { CurrentOrg, type CurrentOrgCtx } from './current-org.decorator';
import { OrgMembershipGuard } from './org-membership.guard';
import { OrgOwnerGuard } from './org-owner.guard';
import {
  OrganizationService,
  type InviteView,
  type MemberView,
  type OrgSummary,
} from './organization.service';

class CreateOrgDto {
  @IsString()
  @MinLength(2, {
    message: 'OrganizationEntity name must be at least 2 characters',
  })
  name!: string;
}

class UpdateOrgDto {
  @IsOptional()
  @IsString()
  @MinLength(2, {
    message: 'OrganizationEntity name must be at least 2 characters',
  })
  name?: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsIn(AUTO_APPROVE_MODES)
  defaultAutoApproveMode?: AutoApproveMode;

  @IsOptional()
  @IsBoolean()
  defaultAutoMerge?: boolean;
}

class InviteDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email!: string;
}

@Controller('web/orgs')
export class OrgController {
  constructor(
    private readonly orgs: OrganizationService,
    private readonly onboarding: OnboardingService,
  ) {}

  @Post()
  async create(@CurrentUser() user: UserEntity, @Body() body: CreateOrgDto): Promise<OrgSummary> {
    return this.orgs.create(user.id, body.name);
  }

  @Get()
  async list(@CurrentUser() user: UserEntity): Promise<OrgSummary[]> {
    return this.orgs.listForUser(user.id);
  }

  @Get(':orgId')
  @UseGuards(OrgMembershipGuard)
  async detail(@CurrentOrg() org: CurrentOrgCtx): Promise<unknown> {
    const row = await this.orgs.get(org.id);
    if (!row) throw new NotFoundException('OrganizationEntity not found');
    const onboarding = await this.onboarding.status(org.id);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      status: row.status,
      role: org.role,
      defaultAutoApproveMode: row.default_auto_approve_mode,
      defaultAutoMerge: row.default_auto_merge,
      onboarding: {
        lifecycle: onboarding.lifecycle,
        steps: onboarding.steps,
        missing: onboarding.missing,
      },
    };
  }

  @Patch(':orgId')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async update(@CurrentOrg() org: CurrentOrgCtx, @Body() body: UpdateOrgDto): Promise<OrgSummary> {
    return this.orgs.rename(org.id, body, org.role);
  }

  @Delete(':orgId')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async remove(@CurrentOrg() org: CurrentOrgCtx): Promise<{ ok: boolean }> {
    await this.orgs.deleteOrg(org.id);
    return { ok: true };
  }

  @Get(':orgId/members')
  @UseGuards(OrgMembershipGuard)
  async members(@CurrentOrg() org: CurrentOrgCtx): Promise<MemberView[]> {
    return this.orgs.membersOf(org.id);
  }

  @Post(':orgId/invites')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async invite(
    @CurrentUser() user: UserEntity,
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: InviteDto,
  ): Promise<InviteView> {
    return this.orgs.createInvite(org.id, body.email, user.id);
  }

  @Get(':orgId/invites')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async invites(@CurrentOrg() org: CurrentOrgCtx): Promise<InviteView[]> {
    return this.orgs.listInvites(org.id);
  }

  @Delete(':orgId/invites/:token')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async revoke(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('token') token: string,
  ): Promise<{ ok: boolean }> {
    await this.orgs.revokeInvite(org.id, token);
    return { ok: true };
  }
}
