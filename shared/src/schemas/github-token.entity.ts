import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * A named GitHub token. The VALUE is AES-256-GCM encrypted at rest (`v1:<iv>:<tag>:<ct>`, key from
 * SECRETS_ENCRYPTION_KEY env) and is WRITE-ONLY through the admin API — list/read paths return
 * names + metadata, never ciphertext or plaintext. Exactly one token PER TENANT may be the default
 * (partial unique index on team_id); projects override by naming a token.
 */
@Entity({ name: 'github_tokens' })
@Index(['team_id'], { unique: true, where: 'is_default' })
export class GithubToken extends TimestampedEntity {
  /** The tenant (Slack team id) this token belongs to — part of the PK; each workspace has its
   * own token namespace and at most one default. */
  @PrimaryColumn({ type: 'text' })
  team_id!: string;

  @PrimaryColumn({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  token_ciphertext!: string;

  @Column({ type: 'boolean', default: false })
  is_default!: boolean;
}
