import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { OnboardingService } from '../onboarding/onboarding.service';
import type { AtlasUser } from '../persistence/entities';
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
  @MinLength(2, { message: 'Organization name must be at least 2 characters' })
  name!: string;
}

class InviteDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email!: string;
}

/**
 * `/web/orgs` — organization CRUD + membership/invites for the web console. Gated by the global
 * `AtlasAuthGuard` (logged in); `:orgId` routes additionally require `OrgMembershipGuard`. Creating an
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
    @CurrentUser() user: AtlasUser,
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
