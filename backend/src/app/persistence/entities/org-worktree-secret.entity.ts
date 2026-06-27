import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';

/**
 * A per-org NAMED secret VALUE that the worktree hydrator can render into a sandbox as a file
 * (`.env.keys`, a GCP service-account JSON, …). The value column stores AES-256-GCM ciphertext
 * (`secret-cipher.ts`) — plaintext NEVER lands in a column or a log, exactly like {@link
 * OrgCredentialsEntity}. Resolved through `WorktreeSecretStore`.
 *
 * The VALUE here is inert on its own: it is only ever materialised into a worktree when an owner-created
 * {@link OrgWorktreeSecretGrantEntity} authorises it for a specific repo + path. The repo's committed
 * `.atlas/worktree.json` is a request, never authority.
 *
 * Composite PK (org_id, name): `name` is the manifest's `secrets[].from` key (e.g. `dotenvxPrivateKeys`).
 */
@Entity({ name: 'org_worktree_secrets' })
@Index(['org_id'])
export class OrgWorktreeSecretEntity extends TimestampedEntity {
  /** The owning org (FK → organizations). */
  @PrimaryColumn({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** Logical secret name referenced by a manifest's `secrets[].from`. */
  @PrimaryColumn({ type: 'text' })
  name!: string;

  /** The secret value — AES-256-GCM ciphertext (`iv.tag.ct`). */
  @Column({ type: 'text' })
  value_enc!: string;
}
