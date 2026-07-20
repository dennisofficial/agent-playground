import { type MingoFilter, RealtimeRuleGuard, type Row } from '@workspace/pg-realtime';
import type { Repository } from 'typeorm';
import type { User } from '../auth/entities/user.entity';
import { OrganizationMember } from './entities/organization-member.entity';

/**
 * Row-level guard for the org read-feeds — the `organizations` document/list feed (scope by `id`) and the
 * `organization_members` change-trigger (scope by `orgId`). Read-only: a user sees only rows in orgs they
 * belong to. `scopeField` selects which field on the mapped row carries the org id.
 */
export class OrgMembershipGuard extends RealtimeRuleGuard<User, Row> {
  constructor(
    private readonly members: Repository<OrganizationMember>,
    private readonly scopeField: string,
  ) {
    super();
  }

  async canRead(user: User | null): Promise<MingoFilter | boolean> {
    if (!user) return false;
    const rows = await this.members.find({ where: { userId: user.id }, select: { orgId: true } });
    const orgIds = rows.map((r) => r.orgId);
    return orgIds.length ? { [this.scopeField]: { $in: orgIds } } : false;
  }
}
