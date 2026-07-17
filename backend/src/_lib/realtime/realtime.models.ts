import type { ModelConfig, Row } from '@workspace/pg-realtime';
import type { Repository } from 'typeorm';
import type { OrganizationMember } from '../../app/org/entities/organization-member.entity';
import { OrgMembershipGuard } from '../../app/org/org-realtime.guard';
import { RepoRealtimeGuard } from '../../app/repo/repo.guard';

// ── Defensive coercion: snapshot rows arrive SQL-typed, live WAL rows may be text. ──
const bool = (v: unknown): boolean =>
  v === true || v === 't' || v === 'true' || v === 1 || v === '1';
const int = (v: unknown): number => (v == null ? 0 : Number(v));
const nstr = (v: unknown): string | null => (v == null ? null : String(v));
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * The realtime models registered with pg-realtime. Every org-owned model keeps its `orgId` (or `id`,
 * for the org itself) on the mapped row so its guard can scope it. Guards are feature-local
 * ({@link RepoRealtimeGuard}, {@link OrgMembershipGuard}) and are the single authority for both the SSE
 * feed and REST (`scopedFindWhere`). `mapRow` produces the exact wire shape the web renders (RepoView /
 * org settings), except for the members model, consumed only as a change-trigger.
 */
export function buildRealtimeModels(members: Repository<OrganizationMember>): ModelConfig[] {
  return [
    // Flagship feed: repos list (streamList). Self-contained single table.
    {
      table: 'repos',
      name: 'repos',
      primaryKey: 'id',
      guard: new RepoRealtimeGuard(members),
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
      guard: new OrgMembershipGuard(members, 'id'),
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
      guard: new OrgMembershipGuard(members, 'orgId'),
      mapRow: (raw: Row): Row => ({
        orgId: String(raw.org_id),
        userId: String(raw.user_id),
        role: String(raw.role),
      }),
    },
  ];
}
