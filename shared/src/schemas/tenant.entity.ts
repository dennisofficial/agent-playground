import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * A tenant = a Slack workspace. Single-process / single-DB model: this row is the workspace
 * registry — every tenant-scoped table carries the same `team_id`, and one Node process serves
 * all of them. A workspace is created ONLY by the OAuth install hook (no CLI, no per-tenant
 * stack). `status` enables/disables the workspace; engine readiness (pending keys) is derived
 * separately from its own `provider_keys` rows.
 */
@Entity({ name: 'tenants' })
export class Tenant extends TimestampedEntity {
  /** The Slack team id — THE tenant id everywhere (memory team tier, tenant-qualified surface ids). */
  @PrimaryColumn({ type: 'text' })
  team_id!: string;

  @Column({ type: 'text' })
  team_name!: string;

  @Column({ type: 'text', default: 'active' })
  status!: string; // 'active' | 'suspended'

  /** The workspace's xoxb bot token (the single "ears" event listener) — SecretCipher v1 format,
   * SECRETS_ENCRYPTION_KEY. Write-only through the store; decrypted only where a client is built. */
  @Column({ type: 'text' })
  bot_token_ciphertext!: string;

  /** `authed_user.id` from the OAuth exchange — who installed the app (future: key-submit gate). */
  @Column({ type: 'text', nullable: true })
  installed_by!: string | null;
}
