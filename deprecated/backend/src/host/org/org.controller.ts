import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '@dltech/jwt-auth/server';
import { CreateOrgDto, UpdateOrgDto, type MemberView, type OrgSummary } from '@workspace/shared';
import type { User } from '../../generated/prisma/client';
import { OrgService } from './org.service';

@Controller('orgs')
export class OrgController {
  constructor(private readonly orgs: OrgService) {}

  @Post()
  create(@CurrentUser() user: User, @Body() body: CreateOrgDto): Promise<OrgSummary> {
    return this.orgs.create(user.id, body.name);
  }

  /**
   * The one read endpoint this controller serves, and a deliberate exception to the CQS rule that
   * reads go over the socket. A member list needs `email` and `name`, which live on `User` — a model
   * with no client access, so there is no live-query or one-shot read path to it from the browser at
   * all. pgbase's own answer for that case is a server endpoint: `membersOf` resolves the membership
   * rows under the caller's scope first and looks up only those user ids.
   */
  @Get(':orgId/members')
  members(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<MemberView[]> {
    return this.orgs.membersOf(user.id, orgId);
  }

  @Patch(':orgId')
  update(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: UpdateOrgDto,
  ): Promise<OrgSummary> {
    return this.orgs.update(user.id, orgId, body);
  }

  @Delete(':orgId')
  async remove(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<{ ok: true }> {
    await this.orgs.remove(user.id, orgId);
    return { ok: true };
  }
}
