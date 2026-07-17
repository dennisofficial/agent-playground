import { ECredentialKey } from '@workspace/shared';
import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, Repository } from 'typeorm';
import { TimestampedEntity } from '../../../_lib/database/base.entity';
import { Organization } from '../../org/entities/organization.entity';

/**
 * One encrypted secret held for an org, keyed by a typed {@link ECredentialKey}. The value is
 * AES-256-GCM encrypted at rest (`iv.tag.ct`, key from `SECRETS_ENCRYPTION_KEY`) and is WRITE-ONLY
 * through the API — presence/read paths never return ciphertext or plaintext. Composite PK
 * `(orgId, key)`: at most one row per (org, credential).
 */
@Entity({ name: 'org_secrets' })
export class OrgSecret extends TimestampedEntity {
  @PrimaryColumn({ type: 'uuid' })
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  @PrimaryColumn({ type: 'enum', enum: ECredentialKey })
  key!: ECredentialKey;

  /** AES-256-GCM ciphertext (`iv.tag.ct`, base64 parts). Never leaves the backend. */
  @Column({ type: 'text' })
  ciphertext!: string;
}

/** Injectable DI token / typed alias for the OrgSecret repository. */
export class OrgSecretRepo extends Repository<OrgSecret> {}
