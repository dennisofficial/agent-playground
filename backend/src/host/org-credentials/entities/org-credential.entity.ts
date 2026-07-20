import { TimestampedEntity } from '@lib/database/base.entity';
import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn, Repository } from 'typeorm';
import { Organization } from '../../org/entities/organization.entity';

/**
 * The org's raw API keys, one row per org (PK = orgId). Each value is AES-256-GCM encrypted at rest
 * (`iv.tag.ct`, key from `SECRETS_ENCRYPTION_KEY`) and is WRITE-ONLY through the API — presence/read
 * paths never return ciphertext or plaintext. Typed columns rather than a key-agnostic vault: the set of
 * keys is small and fixed. Kept off the `organizations` table so this write-only, owner-gated secret
 * material doesn't ride along on every org read.
 */
@Entity({ name: 'org_credentials' })
export class OrgCredential extends TimestampedEntity {
  @PrimaryColumn({ type: 'uuid' })
  orgId!: string;

  @OneToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  /** Anthropic API key (`sk-ant-api03-…`) — LangChain prompts/embeddings. */
  @Column({ type: 'text', nullable: true })
  anthropicApiKeyEnc!: string | null;

  /** OpenAI API key (`sk-…`) — memory embeddings. */
  @Column({ type: 'text', nullable: true })
  openaiApiKeyEnc!: string | null;

  /** GitHub Personal Access Token (`ghp_…` / `github_pat_…`) — consumed by the GitHub module. */
  @Column({ type: 'text', nullable: true })
  githubPatEnc!: string | null;
}

export class OrgCredentialRepo extends Repository<OrgCredential> {}
