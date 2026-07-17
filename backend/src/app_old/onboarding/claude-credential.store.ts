import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, LessThan, QueryFailedError, Repository } from 'typeorm';
import { isNewerClaudeCredential } from '../../_shared/onboarding/claude-credential-freshness';
import { DB_CONNECTION } from '../persistence/database.module';
import { OrganizationEntity, OrgClaudeCredentialEntity } from '../persistence/entities';
import { decryptSecret, encryptSecret, loadSecretsKey } from './secret-cipher';

export interface ClaudeCredentialSummary {
  id: string;
  label: string;
  kind: 'setup_token' | 'personal';
  status: string;
  expiresAt: number | null;
  accountEmail: string | null;
  isSelected: boolean;
}

type DecryptedClaudeCredential = {
  id: string;
  kind: 'setup_token' | 'personal';
  status: 'active' | 'needs_reauth' | 'error';
  secret: string;
};

type SelectedClaudeCredential = Omit<DecryptedClaudeCredential, 'status'>;

const LEGACY_SETUP_TOKEN_LABEL = 'Imported setup-token';
const PG_UNIQUE_VIOLATION = '23505';

type UpsertPersonalInput = {
  label: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string;
  subscriptionType?: string;
  accountEmail?: string;
};

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

  async list(orgId: string): Promise<ClaudeCredentialSummary[]> {
    const [rows, org] = await Promise.all([
      this.repo.find({
        where: { org_id: orgId },
        order: { created_at: 'ASC' },
      }),
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

  async getSelectedDecrypted(orgId: string): Promise<SelectedClaudeCredential | null> {
    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    const selectedId = org?.selected_claude_credential_id;
    if (!selectedId) return null;
    const row = await this.repo.findOne({
      where: { id: selectedId, org_id: orgId },
    });
    if (!row) return null;
    return { id: row.id, kind: row.kind, secret: this.decryptToSecret(row) };
  }

  async getSelectedDisplay(orgId: string): Promise<{
    accountEmail: string | null;
    subscriptionType: string | null;
    label: string;
  } | null> {
    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    const selectedId = org?.selected_claude_credential_id;
    if (!selectedId) return null;
    const row = await this.repo.findOne({
      where: { id: selectedId, org_id: orgId },
    });
    if (!row) return null;
    return {
      accountEmail: row.account_email,
      subscriptionType: row.subscription_type,
      label: row.label,
    };
  }

  async getSelectedCredentialId(orgId: string): Promise<string | null> {
    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    return org?.selected_claude_credential_id ?? null;
  }

  async getSelectedRefreshMeta(
    orgId: string,
  ): Promise<{ id: string; lastRefreshedAt: Date | null } | null> {
    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    const selectedId = org?.selected_claude_credential_id;
    if (!selectedId) return null;
    const row = await this.repo.findOne({
      where: { id: selectedId, org_id: orgId },
      select: { id: true, last_refreshed_at: true },
    });
    if (!row) return null;
    return { id: row.id, lastRefreshedAt: row.last_refreshed_at };
  }

  async getDecryptedById(orgId: string, id: string): Promise<DecryptedClaudeCredential | null> {
    const row = await this.repo.findOne({ where: { id, org_id: orgId } });
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      secret: this.decryptToSecret(row),
    };
  }

  private decryptToSecret(row: OrgClaudeCredentialEntity): string {
    const key = this.key();
    const accessToken = decryptSecret(row.access_token_enc, key);
    if (row.kind === 'setup_token') return accessToken;
    const refreshToken = row.refresh_token_enc
      ? decryptSecret(row.refresh_token_enc, key)
      : undefined;
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

  async upsertPersonal(orgId: string, p: UpsertPersonalInput): Promise<string> {
    const key = this.key(); // throws loudly when SECRETS_ENCRYPTION_KEY is unset
    const accountEmail = p.accountEmail?.trim() || undefined;
    const existing = accountEmail
      ? await this.repo.findOne({
          where: {
            org_id: orgId,
            kind: 'personal',
            account_email: accountEmail,
          },
        })
      : null;
    if (existing) {
      this.assignPersonalFields(existing, p, key, accountEmail);
      const saved = await this.repo.save(existing);
      this.logger.log(
        `updated personal claude credential in place for org=${orgId} id=${saved.id}`,
      );
      return saved.id; // selection + created_at preserved
    }
    const row = this.repo.create({
      org_id: orgId,
      label: p.label,
      kind: 'personal',
      access_token_enc: encryptSecret(p.accessToken, key),
      refresh_token_enc: encryptSecret(p.refreshToken, key),
      expires_at: new Date(p.expiresAt),
      scopes: p.scopes ?? null,
      subscription_type: p.subscriptionType ?? null,
      account_email: accountEmail ?? null,
      status: 'active',
    });
    try {
      const saved = await this.repo.save(row);
      this.logger.log(`created personal claude credential for org=${orgId} id=${saved.id}`);
      return saved.id;
    } catch (err) {
      if (!accountEmail || !isUniqueViolation(err)) throw err;
      const raced = await this.repo.findOne({
        where: { org_id: orgId, kind: 'personal', account_email: accountEmail },
      });
      if (!raced) throw err;
      this.assignPersonalFields(raced, p, key, accountEmail);
      const saved = await this.repo.save(raced);
      this.logger.log(
        `updated personal claude credential after unique race for org=${orgId} id=${saved.id}`,
      );
      return saved.id;
    }
  }

  private assignPersonalFields(
    row: OrgClaudeCredentialEntity,
    p: UpsertPersonalInput,
    key: Buffer,
    accountEmail: string | undefined,
  ): void {
    row.access_token_enc = encryptSecret(p.accessToken, key);
    row.refresh_token_enc = encryptSecret(p.refreshToken, key);
    row.expires_at = new Date(p.expiresAt);
    row.scopes = p.scopes ?? null;
    row.subscription_type = p.subscriptionType ?? null;
    row.account_email = accountEmail ?? null;
    row.label = p.label; // keep the display name in sync with the email
    row.status = 'active';
    row.last_refreshed_at = new Date();
  }

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

  async setSelected(orgId: string, credentialId: string): Promise<boolean> {
    const [row, org] = await Promise.all([
      this.repo.findOne({ where: { id: credentialId, org_id: orgId } }),
      this.orgRepo.findOne({ where: { id: orgId } }),
    ]);
    if (!row) {
      throw new Error(`setSelected: no claude credential ${credentialId} for org=${orgId}`);
    }
    const changed = org?.selected_claude_credential_id !== credentialId;
    await this.orgRepo.update({ id: orgId }, { selected_claude_credential_id: credentialId });
    return changed;
  }

  async remove(orgId: string, id: string): Promise<boolean> {
    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    const wasSelected = org?.selected_claude_credential_id === id;
    const result = await this.repo.delete({ id, org_id: orgId });
    return wasSelected && (result.affected ?? 0) > 0;
  }

  async upsertLegacySetupToken(orgId: string, token: string): Promise<boolean> {
    const key = this.key(); // throws loudly when SECRETS_ENCRYPTION_KEY is unset
    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    const { rowId, secretChanged } = await this.dataSource.transaction(async (m) => {
      const existing = await m.findOne(OrgClaudeCredentialEntity, {
        where: {
          org_id: orgId,
          kind: 'setup_token',
          label: LEGACY_SETUP_TOKEN_LABEL,
        },
      });
      let secretChanged = true;
      if (existing) {
        try {
          secretChanged = decryptSecret(existing.access_token_enc, key) !== token;
        } catch {
          secretChanged = true;
        }
      }
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
      return { rowId: saved.id, secretChanged };
    });
    await this.orgRepo.update({ id: orgId }, { selected_claude_credential_id: rowId });
    this.logger.log(`upserted legacy setup-token claude credential for org=${orgId} id=${rowId}`);
    return secretChanged || org?.selected_claude_credential_id !== rowId;
  }

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

  async markNeedsReauth(orgId: string, credentialId: string, reason?: string): Promise<void> {
    await this.repo.update(
      { id: credentialId, org_id: orgId, kind: 'personal' },
      { status: 'needs_reauth' },
    );
    this.logger.warn(
      `marked claude credential needs_reauth org=${orgId} id=${credentialId}` +
        (reason ? ` reason=${reason}` : ''),
    );
  }

  async findPersonalUnderLock(
    m: EntityManager,
    orgId: string,
    credentialId: string,
  ): Promise<{ row: OrgClaudeCredentialEntity; secret: string } | null> {
    const row = await m.findOne(OrgClaudeCredentialEntity, {
      where: { id: credentialId, org_id: orgId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!row || row.kind !== 'personal') return null;
    return { row, secret: this.decryptToSecret(row) };
  }

  async writeRefreshedWithinTxn(
    m: EntityManager,
    row: OrgClaudeCredentialEntity,
    refreshedSecret: string,
  ): Promise<void> {
    const oauth = parseClaudeOauth(refreshedSecret);
    if (!oauth) {
      throw new Error('writeRefreshedWithinTxn: malformed refreshed blob');
    }
    const key = this.key();
    row.access_token_enc = encryptSecret(oauth.accessToken, key);
    row.refresh_token_enc = encryptSecret(oauth.refreshToken, key);
    row.expires_at = new Date(oauth.expiresAt);
    row.status = 'active';
    row.last_refreshed_at = new Date();
    if (oauth.scopes !== undefined) row.scopes = oauth.scopes.join(' ');
    if (oauth.subscriptionType !== undefined) row.subscription_type = oauth.subscriptionType;
    await m.save(row);
  }

  async listExpiringPersonal(
    withinMs: number,
  ): Promise<Array<{ orgId: string; credentialId: string }>> {
    const rows = await this.repo
      .createQueryBuilder('c')
      .select(['c.id AS id', 'c.org_id AS org_id'])
      .where('c.kind = :kind', { kind: 'personal' })
      .andWhere('c.status = :status', { status: 'active' })
      .andWhere('c.refresh_token_enc IS NOT NULL')
      .andWhere('c.expires_at < :cutoff', {
        cutoff: new Date(Date.now() + withinMs),
      })
      .getRawMany<{ id: string; org_id: string }>();
    return rows.map((r) => ({ orgId: r.org_id, credentialId: r.id }));
  }

  async credentialHealthSnapshot(): Promise<{
    expiredActivePersonal: number;
    needsReauth: number;
  }> {
    const now = new Date();
    const [expiredActivePersonal, needsReauth] = await Promise.all([
      this.repo.count({
        where: {
          kind: 'personal',
          status: 'active',
          expires_at: LessThan(now),
        },
      }),
      this.repo.count({ where: { status: 'needs_reauth' } }),
    ]);
    return { expiredActivePersonal, needsReauth };
  }
}

type ClaudeOauth = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
};

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

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const pgCode =
    (err as QueryFailedError & { code?: unknown }).code ??
    (err as QueryFailedError & { driverError?: { code?: unknown } }).driverError?.code;
  return pgCode === PG_UNIQUE_VIOLATION;
}
