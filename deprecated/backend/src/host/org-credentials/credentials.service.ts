import { SecretCipherService } from '@lib/crypto/secret-cipher.service';
import { PrismaService } from '@lib/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import type { CredentialPresence } from '@workspace/shared';

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
 *
 * `OrgCredential` is `NO_CLIENT_ACCESS` in the pgbase registry (never on `ScopedDb`), and internal
 * callers may have no request at all — this injects `PrismaService` and writes the `orgId` filter
 * explicitly on every query.
 */
@Injectable()
export class OrgCredentialsService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly cipher: SecretCipherService,
  ) {}

  /** Which keys the org has set — presence only, no decryption. */
  async presence(orgId: string): Promise<CredentialPresence> {
    const row = await this.prismaService.orgCredential.findUnique({
      where: { orgId },
      select: {
        anthropicApiKeyEnc: true,
        openaiApiKeyEnc: true,
        githubPatEnc: true,
        githubAppInstallationId: true,
      },
    });
    return {
      anthropic: !!row?.anthropicApiKeyEnc,
      openai: !!row?.openaiApiKeyEnc,
      github: !!row?.githubPatEnc,
      githubApp: !!row?.githubAppInstallationId,
    };
  }

  /** Write the provided keys (encrypted). Only non-empty fields are set; the rest stay as they are. */
  async save(orgId: string, input: SaveCredentialsInput): Promise<void> {
    const data = {
      ...(input.anthropicApiKey && {
        anthropicApiKeyEnc: this.cipher.encrypt(input.anthropicApiKey),
      }),
      ...(input.openaiApiKey && { openaiApiKeyEnc: this.cipher.encrypt(input.openaiApiKey) }),
      ...(input.githubPat && { githubPatEnc: this.cipher.encrypt(input.githubPat) }),
    };
    await this.prismaService.orgCredential.upsert({
      where: { orgId },
      create: { orgId, ...data },
      update: data,
    });
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

  /** The org's GitHub App installation (id + account login), or null when the App isn't connected. */
  async getGithubAppInstallation(
    orgId: string,
  ): Promise<{ id: string; account: string | null } | null> {
    const row = await this.prismaService.orgCredential.findUnique({
      where: { orgId },
      select: { githubAppInstallationId: true, githubAppInstallationAccount: true },
    });
    if (!row?.githubAppInstallationId) return null;
    return { id: row.githubAppInstallationId, account: row.githubAppInstallationAccount };
  }

  /** Persist (connect) the org's GitHub App installation. */
  async setGithubAppInstallation(
    orgId: string,
    installation: { id: string; account: string | null },
  ): Promise<void> {
    const data = {
      githubAppInstallationId: installation.id,
      githubAppInstallationAccount: installation.account,
    };
    await this.prismaService.orgCredential.upsert({
      where: { orgId },
      create: { orgId, ...data },
      update: data,
    });
  }

  /** Disconnect the org's GitHub App installation (no-op when unset). */
  async clearGithubAppInstallation(orgId: string): Promise<void> {
    await this.prismaService.orgCredential.updateMany({
      where: { orgId },
      data: { githubAppInstallationId: null, githubAppInstallationAccount: null },
    });
  }

  /**
   * Other orgs already holding this installation id (excluding `exceptOrgId`). Powers the callback's
   * reuse guard: a single GitHub installation must not be silently claimed by a second, unrelated org.
   * Deliberately cross-org — this is a global uniqueness check, not a tenancy read.
   */
  async orgsHoldingInstallation(installationId: string, exceptOrgId: string): Promise<string[]> {
    const rows = await this.prismaService.orgCredential.findMany({
      where: { githubAppInstallationId: installationId, orgId: { not: exceptOrgId } },
      select: { orgId: true },
    });
    return rows.map((r) => r.orgId);
  }

  private async decryptField(
    orgId: string,
    field: 'anthropicApiKeyEnc' | 'openaiApiKeyEnc' | 'githubPatEnc',
  ): Promise<string | null> {
    const row = await this.prismaService.orgCredential.findUnique({ where: { orgId } });
    const ciphertext = row?.[field];
    return ciphertext ? this.cipher.decrypt(ciphertext) : null;
  }
}
