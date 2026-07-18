import { Injectable, NotFoundException } from '@nestjs/common';
import {
  type AgentCredentialView,
  EAgentCredentialKind,
  EAgentCredentialStatus,
  EAgentProvider,
} from '@workspace/shared';
import { SecretCipherService } from '../../_lib/crypto/secret-cipher.service';
import { projectAgentCredentialView } from './agent-credential.view';
import { AgentCredential, AgentCredentialRepo } from './entities/agent-credential.entity';
import { type ClaudeTokenSet, tokenSetToBlob } from './oauth/claude-oauth.client';
import { assertValidCodexAuthJson, CodexAuthInvalidError } from './oauth/codex-auth-validate';
import {
  decodeCodexAccountEmail,
  decodeCodexIdentity,
  decodeJwtExpMs,
} from './oauth/codex-id-token';
import { isNewerMaterial } from './oauth/material-freshness';

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
 * Store + CRUD for {@link AgentCredential} rows. Owns material encryption, per-account dedupe, the
 * one-selected-per-provider invariant, and the refresh write-back (newer-only under a pessimistic lock).
 * Tenancy is enforced by the controller; this is pure mechanism so internal callers (resolver, refresh,
 * usage) can operate without a request context.
 */
@Injectable()
export class AgentCredentialService {
  constructor(
    private readonly repo: AgentCredentialRepo,
    private readonly cipher: SecretCipherService,
  ) {}

  // ── Reads ──

  async list(orgId: string): Promise<AgentCredentialView[]> {
    const rows = await this.repo.find({
      where: { orgId },
      order: { provider: 'ASC', createdAt: 'ASC' },
    });
    return rows.map(projectAgentCredentialView);
  }

  async getById(orgId: string, credentialId: string): Promise<AgentCredential | null> {
    return this.repo.findOne({ where: { id: credentialId, orgId } });
  }

  async getSelected(orgId: string, provider: EAgentProvider): Promise<AgentCredential | null> {
    return this.repo.findOne({ where: { orgId, provider, selected: true } });
  }

  decrypt(row: AgentCredential): string {
    return this.cipher.decrypt(row.materialEnc);
  }

  toView(row: AgentCredential): AgentCredentialView {
    return projectAgentCredentialView(row);
  }

  // ── Claude ──

  /** Upsert a Claude personal (OAuth) account from a fresh token set; dedupes by account email. */
  async upsertClaudePersonal(orgId: string, tokenSet: ClaudeTokenSet): Promise<AgentCredential> {
    const material = JSON.stringify(tokenSetToBlob(tokenSet));
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
    const row = this.repo.create({
      orgId,
      provider: EAgentProvider.CLAUDE,
      kind: EAgentCredentialKind.SETUP_TOKEN,
      label: label?.trim() || 'Claude setup token',
      accountEmail: null,
      subscriptionType: null,
      scopes: null,
      materialEnc: this.cipher.encrypt(setupToken.trim()),
      expiresAt: null,
      status: EAgentCredentialStatus.ACTIVE,
      selected: false,
    });
    const saved = await this.repo.save(row);
    await this.ensureOneSelected(orgId, EAgentProvider.CLAUDE, saved.id);
    return saved;
  }

  // ── Codex ──

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
    assertValidCodexAuthJson(parsed);
    const tokens = (parsed as { tokens?: { id_token?: string; access_token?: string } }).tokens;
    const email = decodeCodexAccountEmail(authJson) ?? null;
    const planType = tokens?.id_token ? decodeCodexIdentity(tokens.id_token).planType : undefined;
    const accessExpMs = decodeJwtExpMs(tokens?.access_token);
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

  // ── Selection / removal ──

  /** Make one account the selected one for its (org, provider). Throws if the credential isn't found. */
  async setSelected(orgId: string, credentialId: string): Promise<void> {
    const row = await this.repo.findOne({ where: { id: credentialId, orgId } });
    if (!row) throw new NotFoundException('Agent credential not found');
    await this.repo.manager.transaction(async (m) => {
      // Clear the current selection FIRST so the partial-unique (org, provider) WHERE selected holds.
      await m.update(
        AgentCredential,
        { orgId, provider: row.provider, selected: true },
        { selected: false },
      );
      await m.update(AgentCredential, { id: credentialId }, { selected: true });
    });
  }

  async remove(orgId: string, credentialId: string): Promise<void> {
    const row = await this.repo.findOne({ where: { id: credentialId, orgId } });
    if (!row) return;
    await this.repo.delete({ id: credentialId, orgId });
    // If we removed the selected account, promote the next one so the provider still has an active pick.
    if (row.selected) await this.ensureOneSelected(orgId, row.provider);
  }

  // ── Refresh write-back (used by the refresh service + the engine sink) ──

  /** Persist a rotated secret only if it's newer than what's stored, under a pessimistic row lock. */
  async advanceMaterial(
    credentialId: string,
    material: string,
    expiresAt: Date | null,
  ): Promise<void> {
    await this.repo.manager.transaction(async (m) => {
      const row = await m.findOne(AgentCredential, {
        where: { id: credentialId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) return;
      const current = this.cipher.decrypt(row.materialEnc);
      if (!isNewerMaterial(row.provider, material, current)) return;
      row.materialEnc = this.cipher.encrypt(material);
      row.expiresAt = expiresAt;
      row.lastRefreshedAt = new Date();
      row.status = EAgentCredentialStatus.ACTIVE;
      await m.save(row);
    });
  }

  async markStatus(credentialId: string, status: EAgentCredentialStatus): Promise<void> {
    await this.repo.update({ id: credentialId }, { status });
  }

  // ── Internals ──

  private async upsertPersonal(input: UpsertPersonalInput): Promise<AgentCredential> {
    if (input.accountEmail) {
      const existing = await this.findPersonalByEmail(input);
      if (existing) return this.applyPersonalUpdate(existing, input);
    }
    const row = this.repo.create({
      orgId: input.orgId,
      provider: input.provider,
      kind: EAgentCredentialKind.PERSONAL,
      label: input.label,
      accountEmail: input.accountEmail,
      subscriptionType: input.subscriptionType,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      materialEnc: this.cipher.encrypt(input.material),
      status: EAgentCredentialStatus.ACTIVE,
      selected: false,
    });
    let saved: AgentCredential;
    try {
      saved = await this.repo.save(row);
    } catch (err) {
      // Concurrent first-login for the same email: the unique index rejected us — update in place.
      if (isUniqueViolation(err) && input.accountEmail) {
        const existing = await this.findPersonalByEmail(input);
        if (existing) return this.applyPersonalUpdate(existing, input);
      }
      throw err;
    }
    await this.ensureOneSelected(input.orgId, input.provider, saved.id);
    return saved;
  }

  private findPersonalByEmail(input: UpsertPersonalInput): Promise<AgentCredential | null> {
    return this.repo.findOne({
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
    row.materialEnc = this.cipher.encrypt(input.material);
    row.subscriptionType = input.subscriptionType;
    row.scopes = input.scopes;
    row.expiresAt = input.expiresAt;
    row.label = input.label;
    row.status = EAgentCredentialStatus.ACTIVE;
    row.lastRefreshedAt = new Date();
    return this.repo.save(row);
  }

  /** Select `fallbackId` (or the oldest remaining account) when the provider has no selected account. */
  private async ensureOneSelected(
    orgId: string,
    provider: EAgentProvider,
    fallbackId?: string,
  ): Promise<void> {
    if (await this.repo.findOne({ where: { orgId, provider, selected: true } })) return;
    const target =
      fallbackId ??
      (await this.repo.findOne({ where: { orgId, provider }, order: { createdAt: 'ASC' } }))?.id;
    if (target) await this.repo.update({ id: target }, { selected: true });
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; driverError?: { code?: string } })?.code;
  const driverCode = (err as { driverError?: { code?: string } })?.driverError?.code;
  return code === '23505' || driverCode === '23505';
}
