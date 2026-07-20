import type { ResolveClaims } from '@workspace/nestjs-rls';
import { rlsGuard } from '@workspace/nestjs-rls/pg-realtime';
import type { ModelConfig, Row } from '@workspace/pg-realtime';
import { OrganizationMember } from '../../_lib/database/entities/organization-member.entity';
import { Organization } from '../../_lib/database/entities/organization.entity';

/**
 * The org read-feeds: `organizations` (streamDocument — live settings/status, scoped by `id` via
 * Organization's `@Rls`) and `organization_members` (the change-trigger for the joined org-list +
 * members snapshots, scoped by `orgId`). Row-scope now comes from each entity's `@Rls` policy.
 */
export function buildOrgRealtimeModels(resolveClaims: ResolveClaims): ModelConfig[] {
  return [
    {
      table: 'organizations',
      name: 'organizations',
      primaryKey: 'id',
      guard: rlsGuard(Organization, resolveClaims),
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
      guard: rlsGuard(OrganizationMember, resolveClaims),
      mapRow: (raw: Row): Row => ({
        orgId: raw.org_id,
        userId: raw.user_id,
        role: raw.role,
      }),
    },
  ];
}
