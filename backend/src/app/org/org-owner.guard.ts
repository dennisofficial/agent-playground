import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * The "Administer" gate. Splits org capabilities into two tiers: any member may OPERATE (threads:
 * create/approve/say/build/delete — the work), but only the `owner` may ADMINISTER (credentials,
 * connecting repos, member invites, org settings). Roles are just `owner` (the creator) and `member`.
 *
 * Reads `request.org.role`, which `OrgMembershipGuard` attaches — so it MUST run AFTER membership
 * (`@UseGuards(OrgMembershipGuard, OrgOwnerGuard)`, or with membership at the controller level and this at
 * the method level). If `request.org` is absent (membership never ran), the role is undefined and the
 * request is denied — fail closed.
 */
@Injectable()
export class OrgOwnerGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx
      .switchToHttp()
      .getRequest<{ org?: { id: string; role: string } }>();
    if (req.org?.role !== 'owner') {
      throw new ForbiddenException(
        'Only the organization owner can perform this action',
      );
    }
    return true;
  }
}
