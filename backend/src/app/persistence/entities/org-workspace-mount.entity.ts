import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';

/**
 * A cache/state directory a repo's sandbox binds at `path`, DB-backed so it propagates to every job's
 * NEXT hydration instantly — no PR, no merge, no rebase (see docs/adr/0003). Composite PK
 * (org_id, repo_id, path) makes `write_workspace_config` an idempotent upsert-by-path: recording the same
 * path again just replaces `mode`, it can never duplicate or clobber an unrelated mount.
 *
 * Mirrors {@link OrgWorkspaceSecretFileEntity} exactly — same ownership model (org+repo scoped,
 * cascade-deleted with either), same reasoning for why a repo-controlled file plays no part in
 * authority: the DB row IS the mount, not a request for one.
 */
@Entity({ name: 'org_workspace_mounts' })
@Index(['org_id'])
@Index(['org_id', 'repo_id'])
export class OrgWorkspaceMountEntity extends TimestampedEntity {
  /** The owning org (FK → organizations). */
  @PrimaryColumn({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The repo this mount applies to (FK → repos.id — the uuid, not the slug). */
  @PrimaryColumn({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  /**
   * The bind target: worktree-relative (lands at `/workspace/<path>`) OR an absolute container path (an
   * EXTERNAL mount at that exact location, guarded against system binds/OS roots — see
   * `isReservedContainerPath` in `sandbox/container-paths.ts`).
   */
  @PrimaryColumn({ type: 'text' })
  path!: string;

  /** `MountMode` — `per-thread` | `shared-ro` | `shared-rw` (see `sandbox/container-paths.ts`). */
  @Column({ type: 'text' })
  mode!: string;
}
