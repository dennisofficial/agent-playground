import type { ModelConfig, Row } from '@workspace/pg-realtime';
import type { Repository } from 'typeorm';
import type { OrganizationMember } from './entities/organization-member.entity';
import { OrgMembershipGuard } from './org-realtime.guard';

/**
 * The org read-feeds: `organizations` (streamDocument — live settings/status, scoped by `id`) and
 * `organization_members` (the change-trigger for the joined org-list + members snapshots, scoped by
 * `orgId`). `mapRow` is a plain snake→camel rename — both WAL + snapshot rows are already-typed JS.
 * Contributed via `PgRealtimeModule.forFeature(...)` in `OrgModule`.
 */
export function buildOrgRealtimeModels(members: Repository<OrganizationMember>): ModelConfig[] {
  return [
    {
      table: 'organizations',
      name: 'organizations',
      primaryKey: 'id',
      guard: new OrgMembershipGuard(members, 'id'),
      mapRow: (raw: Row): Row => ({
        id: raw.id,
        name: raw.name,
        status: raw.status,
        defaultAutoApprove: raw.default_auto_approve,
        defaultAutoShip: raw.default_auto_ship,
        defaultAutoMerge: raw.default_auto_merge,
      }),
    },
    {
      table: 'organization_members',
      name: 'organization_members',
      primaryKey: ['org_id', 'user_id'],
      guard: new OrgMembershipGuard(members, 'orgId'),
      mapRow: (raw: Row): Row => ({
        orgId: raw.org_id,
        userId: raw.user_id,
        role: raw.role,
      }),
    },
  ];
}
