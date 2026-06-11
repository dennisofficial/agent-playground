import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '../classes/base.entity';

/**
 * A tenant = a Slack workspace = its own stack (process + DB). CONTROL-PLANE ONLY: this table
 * lives in the gateway's `agent_control` database, never in a tenant stack's schema — tenant
 * stacks must not know other tenants exist. `status` is about ingress routing (does the gateway
 * forward this workspace's events, and where); engine readiness (pending keys etc.) is tenant-
 * stack state, derived from its own `provider_keys`.
 */
@Entity({ name: 'tenants' })
export class Tenant extends TimestampedEntity {
  /** The Slack team id — THE tenant id everywhere (memory team tier, env overlay, DB name). */
  @PrimaryColumn({ type: 'text' })
  team_id!: string;

  @Column({ type: 'text' })
  team_name!: string;

  @Column({ type: 'text', default: 'provisioning' })
  status!: string; // 'provisioning' | 'active' | 'suspended'

  /** The workspace's xoxb bot token — SecretCipher v1 format, the gateway's own
   * SECRETS_ENCRYPTION_KEY. Write-only through the store; decrypted only at the provision seam. */
  @Column({ type: 'text' })
  bot_token_ciphertext!: string;

  /** Base URL of the tenant stack's inbound listener (`http://host:port`) — null until
   * provisioned. */
  @Column({ type: 'text', nullable: true })
  stack_base_url!: string | null;

  /** `authed_user.id` from the OAuth exchange — who installed the app (future: key-submit gate). */
  @Column({ type: 'text', nullable: true })
  installed_by!: string | null;
}
