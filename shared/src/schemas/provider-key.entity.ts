import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * A tenant-supplied LLM provider API key ('anthropic' | 'openai'). The VALUE is AES-256-GCM
 * encrypted at rest (`v1:<iv>:<tag>:<ct>`, key from SECRETS_ENCRYPTION_KEY env) and is WRITE-ONLY
 * through the admin API — list/read paths return provider + metadata, never ciphertext or
 * plaintext. Keys arrive at RUNTIME (the tenant exists before its keys): the harness boots
 * key-less in pending-keys mode and LlmReadinessService lights the engines up when both land.
 */
@Entity({ name: 'provider_keys' })
export class ProviderKey extends TimestampedEntity {
  @PrimaryColumn({ type: 'text' })
  provider!: string;

  @Column({ type: 'text' })
  key_ciphertext!: string;
}
