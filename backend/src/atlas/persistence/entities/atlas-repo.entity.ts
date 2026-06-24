import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * A connected GitHub repo — what Atlas works against. Org ⊃ repos; threads/jobs/memory scope to a repo
 * via the composite `(org_id, repo_id)`. Replaces the Slack-era `atlas_projects` + `atlas_channels` pair
 * — a repo IS the conversation container now. `repo_id` is a URL-safe slug (the identifier the web app
 * addresses, e.g. `/orgs/:orgId/repos/:repoId`), stable for the life of the connection. `access_ok`
 * records whether the org's GitHub token reached the repo at connect time; onboarding activates the org
 * only on validated access.
 */
@Entity({ name: 'atlas_repos' })
@Index(['org_id'])
export class AtlasRepo extends TimestampedEntity {
  /** The owning org (FK → atlas_organizations.id). */
  @PrimaryColumn({ type: 'text' })
  org_id!: string;

  /** URL-safe slug, unique within the org (derived from the repo name). The web-facing repo id. */
  @PrimaryColumn({ type: 'text' })
  repo_id!: string;

  /** Display name. */
  @Column({ type: 'text' })
  name!: string;

  /** HTTPS GitHub URL — cloned locally for the per-thread worktree sandboxes. */
  @Column({ type: 'text' })
  git_url!: string;

  /** The PR base branch. */
  @Column({ type: 'text', default: 'main' })
  default_branch!: string;

  /** Named GitHub-token override; null → the org default token. */
  @Column({ type: 'text', nullable: true })
  token_name!: string | null;

  /** Whether the org's GitHub token reached the repo at the last connect/validate. */
  @Column({ type: 'boolean', default: false })
  access_ok!: boolean;

  /** When access was last validated; null until first checked. */
  @Column({ type: 'timestamptz', nullable: true })
  access_checked_at!: Date | null;
}
