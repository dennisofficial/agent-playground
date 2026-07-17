import { type MingoFilter, RealtimeRuleGuard, type Row } from '@workspace/pg-realtime';
import { EOrgRole } from '@workspace/shared';
import type { Repository } from 'typeorm';
import type { User } from '../auth/entities/user.entity';
import { OrganizationMember } from '../org/entities/organization-member.entity';

/**
 * Row-level guard for the `repos` model — the single authority for BOTH the SSE feed (mingo scope) and
 * REST queries (via pg-realtime's `scopedFindWhere`). Reads are scoped to orgs the user is a member of;
 * writes to orgs they OWN, so a member — or anyone who merely knows an org/repo id — can't mutate a repo
 * they don't own. It runs once per subscription open / once per scoped query, so the membership lookup is
 * a single round-trip. The scope is matched against the mapped row, which keeps `orgId`.
 */
export class RepoRealtimeGuard extends RealtimeRuleGuard<User, Row> {
  constructor(private readonly members: Repository<OrganizationMember>) {
    super();
  }

  /** Reads: any org the user is a member of. */
  canRead(user: User | null): Promise<MingoFilter | boolean> {
    return this.scopeFor(user);
  }

  // Writes: only orgs the user OWNS. Routed through `scopedFindWhere({ action })`, this is the
  // authoritative write gate — it can't be bypassed by knowing the org/repo id.
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
