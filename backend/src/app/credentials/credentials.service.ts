import { Injectable } from '@nestjs/common';
import { ECredentialKey } from '@workspace/shared';
import { In } from 'typeorm';
import { SecretCipherService } from '../../_lib/crypto/secret-cipher.service';
import { OrgSecretRepo } from './entities/org-secret.entity';

/**
 * Generic, domain-agnostic org secret vault. Stores one encrypted value per `(orgId, key)`; it
 * attaches no meaning to any {@link ECredentialKey} — consuming modules (GitHub, engine, …) interpret
 * the keys. Pure mechanism: no user/tenancy checks here, so internal callers can resolve a secret
 * without a request context. The user-facing tenancy gate lives in the controller.
 */
@Injectable()
export class CredentialsService {
  constructor(
    private readonly secrets: OrgSecretRepo,
    private readonly cipher: SecretCipherService,
  ) {}

  /** Store (or replace) a secret for an org. */
  async set(orgId: string, key: ECredentialKey, plaintext: string): Promise<void> {
    const ciphertext = this.cipher.encrypt(plaintext);
    await this.secrets.upsert({ orgId, key, ciphertext }, ['orgId', 'key']);
  }

  /** Store (or replace) several secrets for an org in a single upsert. No-op when empty. */
  async setMany(
    orgId: string,
    entries: { key: ECredentialKey; plaintext: string }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const rows = entries.map((e) => ({
      orgId,
      key: e.key,
      ciphertext: this.cipher.encrypt(e.plaintext),
    }));
    await this.secrets.upsert(rows, ['orgId', 'key']);
  }

  /** Decrypt and return a secret, or `null` when the org has no value for this key. */
  async get(orgId: string, key: ECredentialKey): Promise<string | null> {
    const row = await this.secrets.findOne({ where: { orgId, key } });
    return row ? this.cipher.decrypt(row.ciphertext) : null;
  }

  /** Whether the org has a value for this key (no decryption). */
  async has(orgId: string, key: ECredentialKey): Promise<boolean> {
    return (await this.secrets.count({ where: { orgId, key } })) > 0;
  }

  /** Presence of several keys in one query — `{ [key]: boolean }` for every requested key. */
  async hasMany(orgId: string, keys: ECredentialKey[]): Promise<Record<ECredentialKey, boolean>> {
    const rows = keys.length
      ? await this.secrets.find({ where: { orgId, key: In(keys) }, select: { key: true } })
      : [];
    const present = new Set(rows.map((r) => r.key));
    return Object.fromEntries(keys.map((k) => [k, present.has(k)])) as Record<
      ECredentialKey,
      boolean
    >;
  }

  /** Remove a secret. No-op when absent. */
  async delete(orgId: string, key: ECredentialKey): Promise<void> {
    await this.secrets.delete({ orgId, key });
  }
}
