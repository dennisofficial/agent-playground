import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * A connected GitHub repo — what Atlas works against. Org ⊃ repos; threads/memory scope to a repo via
 * `repo_id` (this row's `id`, a `uuid`). `slug` is the URL-safe, human-readable identity (unique within
 * the org) used for the on-disk clone dir, worktree key, container label, and UX — DB relations use
 * `id`. `access_ok` records whether the org's GitHub token reached the repo at connect time; onboarding
 * activates the org only on validated access.
 */
@Entity({ name: 'repos' })
@Index(['org_id'])
@Unique(['org_id', 'slug'])
export class RepoEntity extends TimestampedEntity {
  /** DB-generated UUID — the FK target child rows store. */
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning org (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  /** URL-safe slug, unique within the org (derived from the repo name). The clone/worktree/UX identity. */
  @Column({ type: 'text' })
  slug!: string;

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
