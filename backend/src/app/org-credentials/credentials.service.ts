import { Injectable } from '@nestjs/common';
import type { CredentialPresence } from '@workspace/shared';
import { SecretCipherService } from '../../_lib/crypto/secret-cipher.service';
import { OrgCredentialRepo } from './entities/org-credential.entity';

/** The provided-and-non-empty subset of API keys to write; omitted fields are left untouched. */
export type SaveCredentialsInput = {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  githubPat?: string;
};

/**
 * The org's API-key store — typed columns on `org_credentials`, one row per org, AES-256-GCM at rest.
 * Values are write-only; reads expose presence only, except the internal typed getters used by consuming
 * modules (GitHub today; the engine later). Pure mechanism — no tenancy checks here (the controller gates
 * them), so internal callers can resolve a key without a request context.
 */
@Injectable()
export class OrgCredentialsService {
  constructor(
    private readonly repo: OrgCredentialRepo,
    private readonly cipher: SecretCipherService,
  ) {}

  /** Which keys the org has set — presence only, no decryption. */
  async presence(orgId: string): Promise<CredentialPresence> {
    const row = await this.repo.findOne({
      where: { orgId },
      select: { anthropicApiKeyEnc: true, openaiApiKeyEnc: true, githubPatEnc: true },
    });
    return {
      anthropic: !!row?.anthropicApiKeyEnc,
      openai: !!row?.openaiApiKeyEnc,
      github: !!row?.githubPatEnc,
    };
  }

  /** Write the provided keys (encrypted). Only non-empty fields are set; the rest stay as they are. */
  async save(orgId: string, input: SaveCredentialsInput): Promise<void> {
    const row = (await this.repo.findOne({ where: { orgId } })) ?? this.repo.create({ orgId });
    if (input.anthropicApiKey) row.anthropicApiKeyEnc = this.cipher.encrypt(input.anthropicApiKey);
    if (input.openaiApiKey) row.openaiApiKeyEnc = this.cipher.encrypt(input.openaiApiKey);
    if (input.githubPat) row.githubPatEnc = this.cipher.encrypt(input.githubPat);
    await this.repo.save(row);
  }

  /** Decrypt and return the org's Anthropic API key, or null when unset. */
  getAnthropicApiKey(orgId: string): Promise<string | null> {
    return this.decryptField(orgId, 'anthropicApiKeyEnc');
  }

  /** Decrypt and return the org's OpenAI API key, or null when unset. */
  getOpenaiApiKey(orgId: string): Promise<string | null> {
    return this.decryptField(orgId, 'openaiApiKeyEnc');
  }

  /** Decrypt and return the org's GitHub PAT, or null when unset. */
  getGithubPat(orgId: string): Promise<string | null> {
    return this.decryptField(orgId, 'githubPatEnc');
  }

  /** Whether the org has a GitHub PAT set (no decryption). */
  async hasGithubPat(orgId: string): Promise<boolean> {
    const p = await this.presence(orgId);
    return p.github;
  }

  private async decryptField(
    orgId: string,
    field: 'anthropicApiKeyEnc' | 'openaiApiKeyEnc' | 'githubPatEnc',
  ): Promise<string | null> {
    const row = await this.repo.findOne({ where: { orgId } });
    const ciphertext = row?.[field];
    return ciphertext ? this.cipher.decrypt(ciphertext) : null;
  }
}
