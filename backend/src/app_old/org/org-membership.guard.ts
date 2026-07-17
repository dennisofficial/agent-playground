import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { UserEntity } from '../persistence/entities';
import { OrganizationService } from './organization.service';

@Injectable()
export class OrgMembershipGuard implements CanActivate {
  constructor(private readonly orgs: OrganizationService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      user?: UserEntity;
      params?: Record<string, string>;
      org?: { id: string; role: string };
    }>();
    const user = req.user;
    const orgId = req.params?.orgId;
    if (!user?.id || !orgId) {
      throw new ForbiddenException('OrganizationEntity membership required');
    }
    const membership = await this.orgs.membership(user.id, orgId);
    if (!membership) {
      throw new ForbiddenException('Not a member of this organization');
    }
    req.org = { id: orgId, role: membership.role };
    return true;
  }
}
