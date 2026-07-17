import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import { CreateOrgDto, UpdateOrgDto, type MemberView, type OrgSummary } from '@workspace/shared';
import type { User } from '../auth/entities/user.entity';
import { OrgService } from './org.service';

@Controller('orgs')
export class OrgController {
  constructor(private readonly orgs: OrgService) {}

  @Post()
  create(@CurrentUser() user: User, @Body() body: CreateOrgDto): Promise<OrgSummary> {
    return this.orgs.create(user.id, body.name);
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

  @Get(':orgId/members')
  members(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<MemberView[]> {
    return this.orgs.membersOf(user.id, orgId);
  }
}
