import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * A named GitHub token. The VALUE is AES-256-GCM encrypted at rest (`v1:<iv>:<tag>:<ct>`, key from
 * SECRETS_ENCRYPTION_KEY env) and is WRITE-ONLY through the admin API — list/read paths return
 * names + metadata, never ciphertext or plaintext. Exactly one token may be the default (partial
 * unique index); projects override by naming a token.
 */
@Entity({ name: 'github_tokens' })
@Index(['is_default'], { unique: true, where: 'is_default' })
export class GithubToken extends TimestampedEntity {
  @PrimaryColumn({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  token_ciphertext!: string;

  @Column({ type: 'boolean', default: false })
  is_default!: boolean;
}
