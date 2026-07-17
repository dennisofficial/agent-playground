import type { ModelConfig, Row } from '@workspace/pg-realtime';
import type { Repository } from 'typeorm';
import { OrgScopedRealtimeGuard } from '../../_lib/realtime/org-scoped-realtime.guard';
import type { OrganizationMember } from '../org/entities/organization-member.entity';

// ── Defensive coercion: snapshot rows arrive SQL-typed, live WAL rows may be text. ──
const bool = (v: unknown): boolean => v === true || v === 't' || v === 'true' || v === 1 || v === '1';
const int = (v: unknown): number => (v == null ? 0 : Number(v));
const nstr = (v: unknown): string | null => (v == null ? null : String(v));
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * The realtime models registered with pg-realtime. Every org-owned model keeps its `orgId` (or `id`,
 * for the org itself) on the mapped row so {@link OrgScopedRealtimeGuard} can scope it. `mapRow`
 * produces the exact wire shape the web renders (RepoView / org settings), except for the members
 * model, which is consumed only as a change-trigger (the members list is served as a joined snapshot).
 */
export function buildRealtimeModels(members: Repository<OrganizationMember>): ModelConfig[] {
  return [
    // Flagship feed: repos list (streamList). Self-contained single table.
    {
      table: 'repos',
      name: 'repos',
      primaryKey: 'id',
      guard: new OrgScopedRealtimeGuard(members, 'orgId'),
      mapRow: (raw: Row): Row => ({
        id: String(raw.id),
        orgId: String(raw.org_id), // kept for the guard scope
        slug: String(raw.slug),
        name: String(raw.name),
        gitUrl: String(raw.git_url),
        defaultBranch: String(raw.default_branch),
        accessOk: bool(raw.access_ok),
        accessCheckedAt: iso(raw.access_checked_at),
        threadCount: int(raw.thread_count),
        onboardingThreadId: nstr(raw.onboarding_thread_id),
        onboardedAt: iso(raw.onboarded_at),
        webhookWarning: nstr(raw.webhook_warning),
        branchPrefix: nstr(raw.branch_prefix),
        defaultAutoMergeMethod: String(raw.default_auto_merge_method),
        defaultAutoMergeDeleteBranch: bool(raw.default_auto_merge_delete_branch),
      }),
    },
    // Org document (streamDocument): live settings/status for one org.
    {
      table: 'organizations',
      name: 'organizations',
      primaryKey: 'id',
      guard: new OrgScopedRealtimeGuard(members, 'id'),
      mapRow: (raw: Row): Row => ({
        id: String(raw.id),
        name: String(raw.name),
        status: String(raw.status),
        defaultAutoApprove: bool(raw.default_auto_approve),
        defaultAutoShip: bool(raw.default_auto_ship),
        defaultAutoMerge: bool(raw.default_auto_merge),
      }),
    },
    // Change-trigger for the joined org-list + members snapshot feeds.
    {
      table: 'organization_members',
      name: 'organization_members',
      primaryKey: ['org_id', 'user_id'],
      guard: new OrgScopedRealtimeGuard(members, 'orgId'),
      mapRow: (raw: Row): Row => ({
        orgId: String(raw.org_id),
        userId: String(raw.user_id),
        role: String(raw.role),
      }),
    },
  ];
}
