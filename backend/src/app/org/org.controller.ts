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
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { AUTO_APPROVE_MODES, type AutoApproveMode } from '@workspace/shared';
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
  // Both fields optional — `@IsOptional()` makes class-validator skip the other validators when the field is
  // absent (otherwise an omitted `name` would still fail `@IsString`/`@MinLength`).
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

/**
 * `/web/orgs` — organization CRUD + membership/invites for the web console. Gated by the global
 * `AuthGuard` (logged in); `:orgId` routes additionally require `OrgMembershipGuard`. Creating an
 * org makes the caller its owner. Invites are copy-paste links redeemed via `/web/invites/:token`.
 *
 * Capability tiers (see `OrgOwnerGuard`): roles are just `owner` and `member`. Any member may read
 * org/members and OPERATE on threads; only the `owner` may ADMINISTER — manage members (invites) and, in
 * sibling controllers, set credentials and connect repos. Invite listing is owner-only because the rows
 * carry the live invite-link tokens.
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
  async create(
    @CurrentUser() user: UserEntity,
    @Body() body: CreateOrgDto,
  ): Promise<OrgSummary> {
    return this.orgs.create(user.id, body.name);
  }

  /** `GET /web/orgs` — every org the caller belongs to. */
  @Get()
  async list(@CurrentUser() user: UserEntity): Promise<OrgSummary[]> {
    return this.orgs.listForUser(user.id);
  }

  /** `GET /web/orgs/:orgId` — org detail + the derived onboarding checklist. */
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

  /** `PATCH /web/orgs/:orgId` — rename / re-slug the org (owner only). */
  @Patch(':orgId')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async update(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: UpdateOrgDto,
  ): Promise<OrgSummary> {
    return this.orgs.rename(org.id, body, org.role);
  }

  /** `DELETE /web/orgs/:orgId` — delete the org + all repos/threads/sessions (owner only). */
  @Delete(':orgId')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async remove(@CurrentOrg() org: CurrentOrgCtx): Promise<{ ok: boolean }> {
    await this.orgs.deleteOrg(org.id);
    return { ok: true };
  }

  /** `GET /web/orgs/:orgId/members` — the org's members. */
  @Get(':orgId/members')
  @UseGuards(OrgMembershipGuard)
  async members(@CurrentOrg() org: CurrentOrgCtx): Promise<MemberView[]> {
    return this.orgs.membersOf(org.id);
  }

  /** `POST /web/orgs/:orgId/invites` — create a copy-paste invite (owner only). Returns the link. */
  @Post(':orgId/invites')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async invite(
    @CurrentUser() user: UserEntity,
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: InviteDto,
  ): Promise<InviteView> {
    return this.orgs.createInvite(org.id, body.email, user.id);
  }

  /** `GET /web/orgs/:orgId/invites` — pending invites (owner only; rows carry live invite tokens). */
  @Get(':orgId/invites')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async invites(@CurrentOrg() org: CurrentOrgCtx): Promise<InviteView[]> {
    return this.orgs.listInvites(org.id);
  }

  /** `DELETE /web/orgs/:orgId/invites/:token` — revoke a pending invite (owner only). */
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
