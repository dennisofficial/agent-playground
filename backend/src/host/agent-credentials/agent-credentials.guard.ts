import { type MingoFilter, RealtimeRuleGuard, type Row } from '@workspace/pg-realtime';
import { EOrgRole } from '@workspace/shared';
import type { Repository } from 'typeorm';
import { OrganizationMember } from '../../_lib/database/entities/organization-member.entity';
import type { User } from '../../_lib/database/entities/user.entity';

/**
 * Row-level guard for the `agentCredentials` model. Reads are scoped to orgs the user is a member of;
 * writes to orgs they OWN — so a member (or anyone who merely knows an id) can't mutate another org's
 * accounts. Matched against the mapped row, which keeps `orgId`. Mirrors {@link RepoRealtimeGuard}.
 */
export class AgentCredentialsRealtimeGuard extends RealtimeRuleGuard<User, Row> {
  constructor(private readonly members: Repository<OrganizationMember>) {
    super();
  }

  canRead(user: User | null): Promise<MingoFilter | boolean> {
    return this.scopeFor(user);
  }

  canCreate(user: User | null): Promise<MingoFilter | boolean> {
    return this.scopeFor(user, EOrgRole.OWNER);
  }
  canUpdate(user: User | null): Promise<MingoFilter | boolean> {
    return this.scopeFor(user, EOrgRole.OWNER);
  }
  canDelete(user: User | null): Promise<MingoFilter | boolean> {
    return this.scopeFor(user, EOrgRole.OWNER);
  }

  private async scopeFor(user: User | null, role?: EOrgRole): Promise<MingoFilter | boolean> {
    if (!user) return false;
    const rows = await this.members.find({
      where: { userId: user.id, ...(role ? { role } : {}) },
      select: { orgId: true },
    });
    const orgIds = rows.map((r) => r.orgId);
    return orgIds.length ? { orgId: { $in: orgIds } } : false;
  }
}
