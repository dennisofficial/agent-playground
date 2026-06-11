import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * A per-employee Slack "puppet app" bot token for THIS workspace (tenant DB ⇒ workspace-scoped).
 * The puppet apps post/react as real bot users (proper reactions, mentions, profiles, app icons);
 * the main app stays the single event listener. The VALUE is AES-256-GCM encrypted at rest
 * (`v1:<iv>:<tag>:<ct>`, SECRETS_ENCRYPTION_KEY) and WRITE-ONLY through the admin API — read
 * paths return bot_id + metadata, never ciphertext or plaintext. An employee with no row simply
 * falls back to the main app's `username` override (the pre-puppet behavior).
 */
@Entity({ name: 'slack_identities' })
export class SlackIdentity extends TimestampedEntity {
  /** The roster employee id ('alex') — NOT a Slack id. */
  @PrimaryColumn({ type: 'text' })
  bot_id!: string;

  @Column({ type: 'text' })
  token_ciphertext!: string;
}
