import { Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';

/**
 * The AUTHORITY that turns a {@link OrgWorktreeSecretEntity} value into a file in a sandbox. An org
 * OWNER grants "secret `name` may be rendered to `path` in repo `repo_id`". The worktree hydrator only
 * materialises a manifest `secrets[]` entry when a matching grant exists — so a repo-controlled
 * `.atlas/worktree.json` (which any org member can commit) cannot self-authorise reading an org secret.
 *
 * Keyed by `repo_id` (the `repos.id` uuid — the FK identity), NOT the slug. Composite PK
 * (org_id, repo_id, name, path) makes a grant the exact (secret → repo → destination) triple.
 */
@Entity({ name: 'org_worktree_secret_grants' })
@Index(['org_id'])
@Index(['org_id', 'repo_id'])
export class OrgWorktreeSecretGrantEntity extends TimestampedEntity {
  /** The owning org (FK → organizations). */
  @PrimaryColumn({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The repo this grant applies to (FK → repos.id — the uuid, not the slug). */
  @PrimaryColumn({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  /** The secret name authorised (→ {@link OrgWorktreeSecretEntity.name}). */
  @PrimaryColumn({ type: 'text' })
  name!: string;

  /** The exact worktree-relative path the secret may be rendered to (e.g. `.env.keys`). */
  @PrimaryColumn({ type: 'text' })
  path!: string;
}
