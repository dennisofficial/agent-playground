import { Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import type { UserEntity } from '../persistence/entities';
import { OrganizationService, type InvitePreview } from './organization.service';

/**
 * `/web/invites/:token` — the invitee side of the copy-paste invite flow. Login-only (the global
 * `AuthGuard`), NOT membership-gated — the whole point is to join an org you're not yet in.
 * `GET` previews the invite (org name) for the accept screen; `POST …/accept` redeems it (idempotent).
 */
@Controller('web/invites')
export class InviteController {
  constructor(private readonly orgs: OrganizationService) {}

  /** `GET /web/invites/:token` — preview the org this invite joins. */
  @Get(':token')
  async preview(@Param('token') token: string): Promise<InvitePreview> {
    const invite = await this.orgs.getInvite(token);
    if (!invite) throw new NotFoundException('Invite not found');
    return invite;
  }

  /** `POST /web/invites/:token/accept` — redeem the invite as the logged-in user. */
  @Post(':token/accept')
  async accept(
    @CurrentUser() user: UserEntity,
    @Param('token') token: string,
  ): Promise<{ orgId: string }> {
    return this.orgs.acceptInvite(token, user.id);
  }
}
