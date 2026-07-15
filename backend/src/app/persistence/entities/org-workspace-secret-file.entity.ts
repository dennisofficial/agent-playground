import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';

/**
 * A per-repo secret FILE the worktree hydrator renders into a sandbox (`.env.keys`, a GCP
 * service-account JSON, …). This single row IS the value, the authority, AND the render instruction —
 * it replaces the old two-table split (a named `OrgWorkspaceSecret` value + a separate
 * `OrgWorkspaceSecretGrant` authorising it for a repo+path). In practice every secret was a strict
 * 1-value-↔-1-grant pair bound to one destination, so the value/authority separation bought nothing
 * and forced two confusing invalid states ("granted but no value", "value but no grant").
 *
 * The value column stores AES-256-GCM ciphertext (`secret-cipher.ts`) — plaintext NEVER lands in a
 * column or a log, exactly like {@link OrgCredentialsEntity}. Resolved through
 * {@link WorkspaceSecretFileStore}.
 *
 * The ADR-0003 "committed file is a request, never authority" property is preserved: a row existing
 * IS the owner's authorisation to render that file; a repo-controlled `.atlas/worktree.json` (which
 * any member can commit) plays no part in secret rendering — it carries mounts/seed only.
 *
 * Composite PK (org_id, repo_id, path): the destination path is the file's identity. `repo_id` is the
 * `repos.id` uuid (the FK identity), NOT the slug.
 */
@Entity({ name: 'org_workspace_secret_files' })
@Index(['org_id'])
@Index(['org_id', 'repo_id'])
export class OrgWorkspaceSecretFileEntity extends TimestampedEntity {
  /** The owning org (FK → organizations). */
  @PrimaryColumn({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The repo this secret file renders into (FK → repos.id — the uuid, not the slug). */
  @PrimaryColumn({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  /** The worktree-relative destination path the value renders to (e.g. `.env.keys`). */
  @PrimaryColumn({ type: 'text' })
  path!: string;

  /** The secret value — AES-256-GCM ciphertext (`iv.tag.ct`). */
  @Column({ type: 'text' })
  value_enc!: string;

  /**
   * Optional human name for display (carries the old secret `name`, e.g. `STRIPE_KEY`). NOT part of
   * identity and NEVER rendered — the destination `path` is the file's identity.
   */
  @Column({ type: 'text', nullable: true })
  label?: string | null;
}
