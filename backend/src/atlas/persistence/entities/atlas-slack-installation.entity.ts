import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * One Slack workspace's OAuth installation — the per-workspace bot token Atlas posts AS (so each
 * workspace bills its own usage). The token is AES-256-GCM ciphertext at rest (`secret-cipher.ts`,
 * the same key as tenant credentials); the only decrypt path is `SlackInstallationStore`. Inbound
 * events for ALL workspaces still arrive over the ONE app-level Socket Mode connection — this row is
 * only the OUTBOUND identity (token + bot_user_id) keyed by `team_id`.
 */
@Entity({ name: 'atlas_slack_installations' })
export class AtlasSlackInstallation extends TimestampedEntity {
  /** The Slack workspace id (the tenant). */
  @PrimaryColumn({ type: 'text' })
  team_id!: string;

  /** The workspace bot token (`xoxb-…`) — ciphertext. */
  @Column({ type: 'text' })
  bot_token_enc!: string;

  /** This workspace's bot user id — the echo-guard + "bot added to channel" key. */
  @Column({ type: 'text', nullable: true })
  bot_user_id!: string | null;

  /** Granted scopes (comma-joined), for diagnostics. */
  @Column({ type: 'text', nullable: true })
  scopes!: string | null;

  /** Workspace display name (from the OAuth response). */
  @Column({ type: 'text', nullable: true })
  team_name!: string | null;

  /** Set when the app is uninstalled / the token is revoked — a soft-delete (row kept for history). */
  @Column({ type: 'timestamptz', nullable: true })
  uninstalled_at!: Date | null;
}
