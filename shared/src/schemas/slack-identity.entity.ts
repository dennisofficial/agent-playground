import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * A per-employee Slack "puppet app" bot token, scoped to a workspace by `team_id`.
 * The puppet apps post/react as real bot users (proper reactions, mentions, profiles, app icons);
 * the main app stays the single event listener. The VALUE is AES-256-GCM encrypted at rest
 * (`v1:<iv>:<tag>:<ct>`, SECRETS_ENCRYPTION_KEY) and WRITE-ONLY through the admin API — read
 * paths return bot_id + metadata, never ciphertext or plaintext. An employee with no row simply
 * falls back to the main app's `username` override (the pre-puppet behavior).
 */
@Entity({ name: 'slack_identities' })
export class SlackIdentity extends TimestampedEntity {
  /** The tenant (Slack team id) this puppet token is for — part of the PK; an 'alex' token in
   * workspace A is a different app/token from 'alex' in workspace B. */
  @PrimaryColumn({ type: 'text' })
  team_id!: string;

  /** The roster employee id ('alex') — NOT a Slack id. */
  @PrimaryColumn({ type: 'text' })
  bot_id!: string;

  @Column({ type: 'text' })
  token_ciphertext!: string;

  /** The bot's Slack user ID (Uxxxxxx) from `auth.test()` — populated on puppet OAuth install.
   * Used by JarvisService to recognise puppet-join events in `member_joined_channel`. */
  @Column({ type: 'text', nullable: true })
  slack_bot_user_id!: string | null;
}
