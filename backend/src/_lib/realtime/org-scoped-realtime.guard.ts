import { type MingoFilter, RealtimeRuleGuard, type Row } from '@workspace/pg-realtime';
import type { Repository } from 'typeorm';
import type { User } from '../../app/auth/entities/user.entity';
import type { OrganizationMember } from '../../app/org/entities/organization-member.entity';

/**
 * Row-level scope for realtime models keyed to org membership. `canRead` runs **once per
 * subscription open** (not per row/delta), so the single membership query here is one round-trip per
 * SSE connection. It returns a mingo scope ANDed into the subscription — the real security boundary,
 * which a client-supplied filter can only narrow, never escape. Anonymous or org-less users are
 * denied outright.
 *
 * The scope is matched against the **mapped** row, so every model using this guard must keep its
 * org-id field on `mapRow`'s output under `scopeField`.
 */
export class OrgScopedRealtimeGuard extends RealtimeRuleGuard<User, Row> {
  constructor(
    private readonly members: Repository<OrganizationMember>,
    /** Field on the mapped row holding the org id — 'orgId' for org-owned rows, 'id' for the org itself. */
    private readonly scopeField: string = 'orgId',
  ) {
    super();
  }

  async canRead(user: User | null): Promise<MingoFilter | boolean> {
    if (!user) return false;
    const rows = await this.members.find({ where: { userId: user.id }, select: { orgId: true } });
    const orgIds = rows.map((r) => r.orgId);
    if (orgIds.length === 0) return false;
    return { [this.scopeField]: { $in: orgIds } } as MingoFilter;
  }
}
