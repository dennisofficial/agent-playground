import { Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';

/**
 * A worktree-relative golden-seed path a repo's sandbox copies in when missing, DB-backed so it
 * propagates to every job's NEXT hydration instantly — no PR, no merge, no rebase (see
 * docs/adr/0003). Composite PK (org_id, repo_id, path) makes `write_worktree_config`'s seed union
 * idempotent — recording the same path again is a no-op.
 *
 * Mirrors {@link OrgWorktreeMountEntity}, minus `mode` (seed paths never had one).
 */
@Entity({ name: 'org_worktree_seed' })
@Index(['org_id'])
@Index(['org_id', 'repo_id'])
export class OrgWorktreeSeedEntity extends TimestampedEntity {
  /** The owning org (FK → organizations). */
  @PrimaryColumn({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The repo this seed path applies to (FK → repos.id — the uuid, not the slug). */
  @PrimaryColumn({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  /** The worktree-relative golden-seed path. */
  @PrimaryColumn({ type: 'text' })
  path!: string;
}
