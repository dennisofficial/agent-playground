import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AtlasUser } from '../persistence/entities';
import { OrganizationService } from './organization.service';

/**
 * Gate `/web/orgs/:orgId/*` on membership: the authenticated user (attached by the global
 * `AtlasAuthGuard` as `request.user`) must belong to `:orgId`. On success the org context (`{ id, role }`)
 * is attached to `request.org` for `@CurrentOrg()`; otherwise 403. This is the cross-tenant isolation seam.
 */
@Injectable()
export class OrgMembershipGuard implements CanActivate {
  constructor(private readonly orgs: OrganizationService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      user?: AtlasUser;
      params?: Record<string, string>;
      org?: { id: string; role: string };
    }>();
    const user = req.user;
    const orgId = req.params?.orgId;
    if (!user?.id || !orgId) {
      throw new ForbiddenException('Organization membership required');
    }
    const membership = await this.orgs.membership(user.id, orgId);
    if (!membership) {
      throw new ForbiddenException('Not a member of this organization');
    }
    req.org = { id: orgId, role: membership.role };
    return true;
  }
}
