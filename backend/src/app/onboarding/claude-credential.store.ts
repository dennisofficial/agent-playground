import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { OrganizationEntity, OrgClaudeCredentialEntity } from '../persistence/entities';
import { isNewerClaudeCredential } from './claude-credential-freshness';
import { decryptSecret, encryptSecret, loadSecretsKey } from './secret-cipher';

/** Cheap, NON-secret listing row for the settings UI — no decryption, no secret values. */
export interface ClaudeCredentialSummary {
  id: string;
  label: string;
  kind: 'setup_token' | 'personal';
  status: string;
  expiresAt: number | null;
  accountEmail: string | null;
  isSelected: boolean;
}

const LEGACY_SETUP_TOKEN_LABEL = 'Imported setup-token';

/**
 * The ONLY encrypt-on-write / decrypt-on-read path for `claude_credentials` — a LIST of Claude credentials
 * per org (unlike the singleton `org_credentials` row). Secret VALUES are never logged. Each org has at most
 * one SELECTED credential (`organizations.selected_claude_credential_id`), which drives all of that org's
 * turns; `getSelectedDecrypted` is the single resolution path `CredentialResolver` reads through.
 */
@Injectable()
export class ClaudeCredentialStore {
  private readonly logger = new Logger(ClaudeCredentialStore.name);

  constructor(
    @InjectRepository(OrgClaudeCredentialEntity, DB_CONNECTION)
    private readonly repo: Repository<OrgClaudeCredentialEntity>,
    @InjectRepository(OrganizationEntity, DB_CONNECTION)
    private readonly orgRepo: Repository<OrganizationEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
    private readonly env: EnvService,
  ) {}

  private key(): Buffer {
    return loadSecretsKey(this.env.get('SECRETS_ENCRYPTION_KEY'));
  }

  /** Every credential row for the org, NO secret values, flagged with which one is selected. */
  async list(orgId: string): Promise<ClaudeCredentialSummary[]> {
    const [rows, org] = await Promise.all([
      this.repo.find({ where: { org_id: orgId }, order: { created_at: 'ASC' } }),
      this.orgRepo.findOne({ where: { id: orgId } }),
    ]);
    const selectedId = org?.selected_claude_credential_id ?? null;
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      kind: row.kind,
      status: row.status,
      expiresAt: row.expires_at ? row.expires_at.getTime() : null,
      accountEmail: row.account_email,
      isSelected: row.id === selectedId,
    }));
  }

  /**
   * Resolve the org's SELECTED credential and decrypt it into the injectable secret shape: the raw token
   * for `setup_token`, or a `claudeAiOauth` JSON blob for `personal`. Null when no credential is selected,
   * or the pointer is dangling (row deleted since selection).
   */
  async getSelectedDecrypted(
    orgId: string,
  ): Promise<{ id: string; kind: 'setup_token' | 'personal'; secret: string } | null> {
    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    const selectedId = org?.selected_claude_credential_id;
    if (!selectedId) return null;
    const row = await this.repo.findOne({ where: { id: selectedId, org_id: orgId } });
    if (!row) return null;
    return { id: row.id, kind: row.kind, secret: this.decryptToSecret(row) };
  }

  /** Decrypt one row into the injectable secret shape (raw token, or a `claudeAiOauth` JSON blob). */
  private decryptToSecret(row: OrgClaudeCredentialEntity): string {
    const key = this.key();
    const accessToken = decryptSecret(row.access_token_enc, key);
    if (row.kind === 'setup_token') return accessToken;
    const refreshToken = row.refresh_token_enc ? decryptSecret(row.refresh_token_enc, key) : undefined;
    return JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken,
        expiresAt: row.expires_at ? row.expires_at.getTime() : undefined,
        scopes: row.scopes ? row.scopes.split(' ') : undefined,
        subscriptionType: row.subscription_type ?? undefined,
      },
    });
  }

  /** Create a new `personal` (OAuth login) credential row. Does NOT select it — callers call `setSelected`. */
  async createPersonal(
    orgId: string,
    p: {
      label: string;
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      scopes?: string;
      subscriptionType?: string;
      accountEmail?: string;
    },
  ): Promise<string> {
    const key = this.key(); // throws loudly when SECRETS_ENCRYPTION_KEY is unset
    const row = this.repo.create({
      org_id: orgId,
      label: p.label,
      kind: 'personal',
      access_token_enc: encryptSecret(p.accessToken, key),
      refresh_token_enc: encryptSecret(p.refreshToken, key),
      expires_at: new Date(p.expiresAt),
      scopes: p.scopes ?? null,
      subscription_type: p.subscriptionType ?? null,
      account_email: p.accountEmail ?? null,
      status: 'active',
    });
    const saved = await this.repo.save(row);
    this.logger.log(`created personal claude credential for org=${orgId} id=${saved.id}`);
    return saved.id;
  }

  /** Create a new `setup_token` credential row. Does NOT select it — callers call `setSelected`. */
  async createSetupToken(orgId: string, p: { label: string; token: string }): Promise<string> {
    const key = this.key(); // throws loudly when SECRETS_ENCRYPTION_KEY is unset
    const row = this.repo.create({
      org_id: orgId,
      label: p.label,
      kind: 'setup_token',
      access_token_enc: encryptSecret(p.token, key),
      refresh_token_enc: null,
      expires_at: null,
      scopes: null,
      subscription_type: null,
      account_email: null,
      status: 'active',
    });
    const saved = await this.repo.save(row);
    this.logger.log(`created setup-token claude credential for org=${orgId} id=${saved.id}`);
    return saved.id;
  }

  /** Point the org's active credential at `credentialId`. Throws if it doesn't belong to the org. */
  async setSelected(orgId: string, credentialId: string): Promise<void> {
    const row = await this.repo.findOne({ where: { id: credentialId, org_id: orgId } });
    if (!row) {
      throw new Error(`setSelected: no claude credential ${credentialId} for org=${orgId}`);
    }
    await this.orgRepo.update({ id: orgId }, { selected_claude_credential_id: credentialId });
  }

  /** Delete a credential row. The FK `ON DELETE SET NULL` clears the org's selection automatically. */
  async remove(orgId: string, id: string): Promise<void> {
    await this.repo.delete({ id, org_id: orgId });
  }

  /**
   * Back-compat write-through for the legacy `PUT /credentials {claudeOauthToken}` route: upserts ONE
   * canonical "Imported setup-token" row per org (never accumulating duplicates on repeated legacy PUTs)
   * and selects it, matching the migration's imported label.
   */
  async upsertLegacySetupToken(orgId: string, token: string): Promise<void> {
    const key = this.key(); // throws loudly when SECRETS_ENCRYPTION_KEY is unset
    const rowId = await this.dataSource.transaction(async (m) => {
      const existing = await m.findOne(OrgClaudeCredentialEntity, {
        where: { org_id: orgId, kind: 'setup_token', label: LEGACY_SETUP_TOKEN_LABEL },
      });
      const row =
        existing ??
        m.create(OrgClaudeCredentialEntity, {
          org_id: orgId,
          label: LEGACY_SETUP_TOKEN_LABEL,
          kind: 'setup_token',
          refresh_token_enc: null,
          expires_at: null,
          status: 'active',
        });
      row.access_token_enc = encryptSecret(token, key);
      const saved = await m.save(row);
      return saved.id;
    });
    await this.orgRepo.update({ id: orgId }, { selected_claude_credential_id: rowId });
    this.logger.log(`upserted legacy setup-token claude credential for org=${orgId} id=${rowId}`);
  }

  /** True when the org has a selected credential AND the referenced row still exists. */
  async hasSelected(orgId: string): Promise<boolean> {
    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    const selectedId = org?.selected_claude_credential_id;
    if (!selectedId) return false;
    const row = await this.repo.findOne({ where: { id: selectedId, org_id: orgId } });
    return !!row;
  }

  /**
   * ATOMICALLY advance a `personal` credential to a REFRESHED `claudeAiOauth` blob — the auth-refresh
   * write-back, mirroring `TenantCredentialStore.advanceCodexAuthSecret`'s transaction + `pessimistic_write`
   * row-lock pattern. No-ops when `credentialId` is absent, the row is gone, the row isn't `personal`, or the
   * refreshed blob isn't newer (`isNewerClaudeCredential`). Must NOT throw into the caller (best-effort).
   */
  async advanceClaudeCredential(
    orgId: string,
    credentialId: string | undefined,
    refreshedSecret: string,
  ): Promise<void> {
    if (!credentialId) return;
    const key = this.key(); // throws loudly when SECRETS_ENCRYPTION_KEY is unset
    const wrote = await this.dataSource.transaction(async (m) => {
      const row = await m.findOne(OrgClaudeCredentialEntity, {
        where: { id: credentialId, org_id: orgId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row || row.kind !== 'personal') return false;
      const current = this.decryptToSecret(row);
      if (!isNewerClaudeCredential(refreshedSecret, current)) return false; // stale / no-change
      // Best-effort contract: a malformed refreshed blob must not throw out of the transaction. The
      // freshness guard above falls through to "changed at all" on unparseable input, so validate the
      // shape HERE and no-op rather than propagate a parse/field-access throw into the caller.
      const oauth = parseClaudeOauth(refreshedSecret);
      if (!oauth) return false;
      row.access_token_enc = encryptSecret(oauth.accessToken, key);
      row.refresh_token_enc = encryptSecret(oauth.refreshToken, key);
      row.expires_at = new Date(oauth.expiresAt);
      row.status = 'active';
      row.last_refreshed_at = new Date();
      if (oauth.scopes !== undefined) row.scopes = oauth.scopes.join(' ');
      if (oauth.subscriptionType !== undefined) row.subscription_type = oauth.subscriptionType;
      await m.save(row);
      return true;
    });
    if (wrote) {
      this.logger.log(`advanced claude credential for org=${orgId} id=${credentialId}`);
    }
  }
}

type ClaudeOauth = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
};

/** Parse + shape-validate a `{claudeAiOauth:{…}}` refreshed blob; null on malformed input (never throws). */
function parseClaudeOauth(secret: string): ClaudeOauth | null {
  try {
    const oauth = (JSON.parse(secret) as { claudeAiOauth?: Partial<ClaudeOauth> }).claudeAiOauth;
    if (
      !oauth ||
      typeof oauth.accessToken !== 'string' ||
      typeof oauth.refreshToken !== 'string' ||
      typeof oauth.expiresAt !== 'number'
    ) {
      return null;
    }
    return oauth as ClaudeOauth;
  } catch {
    return null;
  }
}
