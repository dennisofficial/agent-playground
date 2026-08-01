import { Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { CurrentUser } from '@dltech/jwt-auth/server';
import type { UserEntity } from '../persistence/entities';
import { OrganizationService, type InvitePreview } from './organization.service';

@Controller('web/invites')
export class InviteController {
  constructor(private readonly orgs: OrganizationService) {}

  @Get(':token')
  async preview(@Param('token') token: string): Promise<InvitePreview> {
    const invite = await this.orgs.getInvite(token);
    if (!invite) throw new NotFoundException('Invite not found');
    return invite;
  }

  @Post(':token/accept')
  async accept(
    @CurrentUser() user: UserEntity,
    @Param('token') token: string,
  ): Promise<{ orgId: string }> {
    return this.orgs.acceptInvite(token, user.id);
  }
}
