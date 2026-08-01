import { SecretCipherService } from '@lib/crypto/secret-cipher.service';
import { PrismaService } from '@lib/prisma/prisma.service';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { RawAgentCredential } from '@workspace/shared';
import {
  type AgentCredentialView,
  EAgentCredentialKind,
  EAgentCredentialStatus,
  EAgentProvider,
} from '@workspace/shared';
import type { AgentCredential } from '../../generated/prisma/client';
import { Prisma } from '../../generated/prisma/client';
import { AgentCredentialViewService } from './agent-credential-view.service';
import { ClaudeOAuthClient, type ClaudeTokenSet } from './oauth/claude-oauth.client';
import { CodexAuthInvalidError } from './oauth/codex-auth-invalid.error';
import { CodexAuthService } from './oauth/codex-auth.service';
import { MaterialFreshnessService } from './oauth/material-freshness.service';

type UpsertPersonalInput = {
  orgId: string;
  provider: EAgentProvider;
  accountEmail: string | null;
  subscriptionType: string | null;
  scopes: string | null;
  expiresAt: Date | null;
  material: string;
  label: string;
};

/**
 * Runs from both a request (the controller) and the turn-dispatch queue worker (via
 * `AgentCredentialResolver`), so this injects `PrismaService`, not `ScopedDb` — a scoped delegate
 * would throw outside a request. Every CREATE/UPDATE/DELETE entry point below is only ever reached
 * through `AgentCredentialsController`, which asserts org ownership (`OrgService.assertOwner`)
 * before calling in — that's the imperative `orgId ∈ ownerOrgIds` check pgbase's registry can't
 * express for this model.
 */
@Injectable()
export class AgentCredentialService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly secretCipherService: SecretCipherService,
    private readonly claudeOAuthClient: ClaudeOAuthClient,
    private readonly agentCredentialViewService: AgentCredentialViewService,
    private readonly codexAuthService: CodexAuthService,
    private readonly materialFreshnessService: MaterialFreshnessService,
  ) {}

  async getById(orgId: string, credentialId: string): Promise<AgentCredential | null> {
    return this.prismaService.agentCredential.findFirst({ where: { id: credentialId, orgId } });
  }

  async getSelected(orgId: string, provider: EAgentProvider): Promise<AgentCredential | null> {
    return this.prismaService.agentCredential.findFirst({
      where: { orgId, provider, selected: true },
    });
  }

  decrypt(row: AgentCredential): string {
    return this.secretCipherService.decrypt(row.materialEnc);
  }

  toView(row: AgentCredential): AgentCredentialView {
    // Enum branding + Json only: the Prisma row and RawAgentCredential are the same shape on the wire.
    return this.agentCredentialViewService.project(row as unknown as RawAgentCredential);
  }

  /** Upsert a Claude personal (OAuth) account from a fresh token set; dedupes by account email. */
  async upsertClaudePersonal(orgId: string, tokenSet: ClaudeTokenSet): Promise<AgentCredential> {
    const material = JSON.stringify(this.claudeOAuthClient.tokenSetToBlob(tokenSet));
    return this.upsertPersonal({
      orgId,
      provider: EAgentProvider.CLAUDE,
      accountEmail: tokenSet.accountEmail ?? null,
      subscriptionType: tokenSet.subscriptionType ?? null,
      scopes: tokenSet.scopes ?? null,
      expiresAt: new Date(tokenSet.expiresAt),
      material,
      label: tokenSet.accountEmail ?? 'Claude account',
    });
  }

  /** Add a Claude setup-token (`sk-ant-oat…`) account — non-personal, non-expiring, no refresh. */
  async createClaudeSetupToken(
    orgId: string,
    setupToken: string,
    label?: string,
  ): Promise<AgentCredential> {
    const saved = await this.prismaService.agentCredential.create({
      data: {
        orgId,
        provider: EAgentProvider.CLAUDE,
        kind: EAgentCredentialKind.SETUP_TOKEN,
        label: label?.trim() || 'Claude setup token',
        accountEmail: null,
        subscriptionType: null,
        scopes: null,
        materialEnc: this.secretCipherService.encrypt(setupToken.trim()),
        expiresAt: null,
        status: EAgentCredentialStatus.ACTIVE,
        selected: false,
      },
    });
    await this.ensureOneSelected(orgId, EAgentProvider.CLAUDE, saved.id);
    return saved;
  }

  /**
   * Upsert a Codex personal account from a full `~/.codex/auth.json` blob (device-login result or a
   * user paste). Dedupes by the account email decoded from the id_token; validates the blob shape.
   */
  async upsertCodexFromAuthJson(
    orgId: string,
    authJson: string,
    label?: string,
  ): Promise<AgentCredential> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(authJson);
    } catch {
      throw new CodexAuthInvalidError('not valid JSON');
    }
    this.codexAuthService.assertValidAuthJson(parsed);
    const tokens = (parsed as { tokens?: { id_token?: string; access_token?: string } }).tokens;
    const email = this.codexAuthService.decodeAccountEmail(authJson) ?? null;
    const planType = tokens?.id_token
      ? this.codexAuthService.decodeIdentity(tokens.id_token).planType
      : undefined;
    const accessExpMs = this.codexAuthService.decodeJwtExpMs(tokens?.access_token);
    return this.upsertPersonal({
      orgId,
      provider: EAgentProvider.CODEX,
      accountEmail: email,
      subscriptionType: planType ?? null,
      scopes: null,
      expiresAt: accessExpMs ? new Date(accessExpMs) : null,
      material: authJson,
      label: label?.trim() || email || 'Codex account',
    });
  }

  /** Make one account the selected one for its (org, provider). Throws if the credential isn't found. */
  async setSelected(orgId: string, credentialId: string): Promise<void> {
    const row = await this.prismaService.agentCredential.findFirst({
      where: { id: credentialId, orgId },
    });
    if (!row) throw new NotFoundException('Agent credential not found');
    await this.prismaService.$transaction(async (tx) => {
      // Clear the current selection FIRST so the partial-unique (org, provider) WHERE selected holds.
      await tx.agentCredential.updateMany({
        where: { orgId, provider: row.provider, selected: true },
        data: { selected: false },
      });
      await tx.agentCredential.update({ where: { id: credentialId }, data: { selected: true } });
    });
  }

  async remove(orgId: string, credentialId: string): Promise<void> {
    const row = await this.prismaService.agentCredential.findFirst({
      where: { id: credentialId, orgId },
    });
    if (!row) return;
    await this.prismaService.agentCredential.delete({ where: { id: credentialId, orgId } });
    // If we removed the selected account, promote the next one so the provider still has an active pick.
    if (row.selected) await this.ensureOneSelected(orgId, row.provider as EAgentProvider);
  }

  /** Persist a rotated secret only if it's newer than what's stored, under a pessimistic row lock. */
  async advanceMaterial(
    credentialId: string,
    material: string,
    expiresAt: Date | null,
  ): Promise<void> {
    await this.prismaService.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM agent_credentials WHERE id = ${credentialId}::uuid FOR UPDATE`;
      const row = await tx.agentCredential.findUnique({ where: { id: credentialId } });
      if (!row) return;
      const current = this.secretCipherService.decrypt(row.materialEnc);
      if (
        !this.materialFreshnessService.isNewerMaterial(
          row.provider as EAgentProvider,
          material,
          current,
        )
      )
        return;
      await tx.agentCredential.update({
        where: { id: credentialId },
        data: {
          materialEnc: this.secretCipherService.encrypt(material),
          expiresAt,
          lastRefreshedAt: new Date(),
          status: EAgentCredentialStatus.ACTIVE,
        },
      });
    });
  }

  async markStatus(credentialId: string, status: EAgentCredentialStatus): Promise<void> {
    await this.prismaService.agentCredential.update({
      where: { id: credentialId },
      data: { status },
    });
  }

  private async upsertPersonal(input: UpsertPersonalInput): Promise<AgentCredential> {
    if (input.accountEmail) {
      const existing = await this.findPersonalByEmail(input);
      if (existing) return this.applyPersonalUpdate(existing, input);
    }
    let saved: AgentCredential;
    try {
      saved = await this.prismaService.agentCredential.create({
        data: {
          orgId: input.orgId,
          provider: input.provider,
          kind: EAgentCredentialKind.PERSONAL,
          label: input.label,
          accountEmail: input.accountEmail,
          subscriptionType: input.subscriptionType,
          scopes: input.scopes,
          expiresAt: input.expiresAt,
          materialEnc: this.secretCipherService.encrypt(input.material),
          status: EAgentCredentialStatus.ACTIVE,
          selected: false,
        },
      });
    } catch (err) {
      // Concurrent first-login for the same email: the unique index rejected us — update in place.
      if (AgentCredentialService.isUniqueViolation(err) && input.accountEmail) {
        const existing = await this.findPersonalByEmail(input);
        if (existing) return this.applyPersonalUpdate(existing, input);
      }
      throw err;
    }
    await this.ensureOneSelected(input.orgId, input.provider, saved.id);
    return saved;
  }

  private findPersonalByEmail(input: UpsertPersonalInput): Promise<AgentCredential | null> {
    return this.prismaService.agentCredential.findFirst({
      where: {
        orgId: input.orgId,
        provider: input.provider,
        accountEmail: input.accountEmail as string,
        kind: EAgentCredentialKind.PERSONAL,
      },
    });
  }

  private applyPersonalUpdate(
    row: AgentCredential,
    input: UpsertPersonalInput,
  ): Promise<AgentCredential> {
    return this.prismaService.agentCredential.update({
      where: { id: row.id },
      data: {
        materialEnc: this.secretCipherService.encrypt(input.material),
        subscriptionType: input.subscriptionType,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
        label: input.label,
        status: EAgentCredentialStatus.ACTIVE,
        lastRefreshedAt: new Date(),
      },
    });
  }

  /** Select `fallbackId` (or the oldest remaining account) when the provider has no selected account. */
  private async ensureOneSelected(
    orgId: string,
    provider: EAgentProvider,
    fallbackId?: string,
  ): Promise<void> {
    if (
      await this.prismaService.agentCredential.findFirst({
        where: { orgId, provider, selected: true },
      })
    )
      return;
    const target =
      fallbackId ??
      (
        await this.prismaService.agentCredential.findFirst({
          where: { orgId, provider },
          orderBy: { createdAt: 'asc' },
        })
      )?.id;
    if (target) {
      await this.prismaService.agentCredential.update({
        where: { id: target },
        data: { selected: true },
      });
    }
  }

  private static isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
  }
}
