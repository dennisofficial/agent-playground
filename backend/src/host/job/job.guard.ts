import { type MingoFilter, RealtimeRuleGuard, type Row } from '@workspace/pg-realtime';
import type { Repository } from 'typeorm';
import { OrganizationMember } from '../../_lib/database/entities/organization-member.entity';
import type { User } from '../../_lib/database/entities/user.entity';

export class JobRealtimeGuard extends RealtimeRuleGuard<User, Row> {
  constructor(private readonly members: Repository<OrganizationMember>) {
    super();
  }

  async canRead(user: User | null): Promise<MingoFilter | boolean> {
    if (!user) return false;
    const rows = await this.members.find({
      where: { userId: user.id },
      select: { orgId: true },
    });
    const orgIds = rows.map((r) => r.orgId);
    return orgIds.length ? { orgId: { $in: orgIds } } : false;
  }
}
