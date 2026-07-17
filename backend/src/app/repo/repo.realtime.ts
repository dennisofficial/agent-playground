import type { ModelConfig, Row } from '@workspace/pg-realtime';
import type { Repository } from 'typeorm';
import type { OrganizationMember } from '../org/entities/organization-member.entity';
import { RepoRealtimeGuard } from './repo.guard';

/**
 * The `repos` realtime model — the flagship `streamList` feed. A self-contained single table: `mapRow`
 * is a plain snake→camel rename to the `RepoView` wire shape (the WAL + snapshot paths both deliver
 * already-typed JS values — pg-logical-replication runs the same pg-types parsers as node-postgres — so
 * no coercion is needed; `Date`s serialize to ISO on the SSE JSON encode). It keeps `orgId` so the guard
 * can scope the mapped row. Contributed to the engine via REALTIME_MODEL in `RepoModule`.
 */
export function buildRepoRealtimeModel(members: Repository<OrganizationMember>): ModelConfig {
  return {
    table: 'repos',
    name: 'repos',
    primaryKey: 'id',
    guard: new RepoRealtimeGuard(members),
    mapRow: (raw: Row): Row => ({
      id: raw.id,
      orgId: raw.org_id, // kept for the guard scope
      slug: raw.slug,
      name: raw.name,
      gitUrl: raw.git_url,
      defaultBranch: raw.default_branch,
      accessOk: raw.access_ok,
      accessCheckedAt: raw.access_checked_at,
      threadCount: raw.thread_count,
      onboardingThreadId: raw.onboarding_thread_id,
      onboardedAt: raw.onboarded_at,
      webhookWarning: raw.webhook_warning,
      branchPrefix: raw.branch_prefix,
      defaultAutoMergeMethod: raw.default_auto_merge_method,
      defaultAutoMergeDeleteBranch: raw.default_auto_merge_delete_branch,
    }),
  };
}
