import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type {
  ClaudeUsageSnapshot,
  ClaudeUsageWindowKey,
  StoredUsageWindow,
} from '@workspace/shared';
import { DataSource, Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { OrganizationEntity, OrgCredentialsEntity } from '../persistence/entities';
import { isNewerCodexAuth } from './codex-auth-freshness';
import { decodeCodexAccountEmail } from './codex-id-token';
import { decryptSecret, encryptSecret, loadSecretsKey } from './secret-cipher';

export interface TenantCredentials {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  githubPat?: string;
  claudeOauthToken?: string;
  codexAuthSecret?: string;
  githubAppInstallationId?: string | null;
  githubAppInstallationAccount?: string | null;
  githubAuthMode?: 'pat' | 'app';
}

export interface TenantCredentialPatch {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  githubPat?: string;
  claudeOauthToken?: string;
  codexAuthSecret?: string;
  githubAppInstallationId?: string | null;
  githubAppInstallationAccount?: string | null;
  githubAuthMode?: 'pat' | 'app';
}

export interface CredentialPresence {
  hasAnthropic: boolean;
  hasOpenai: boolean;
  hasGithub: boolean;
  engineAuthSet: boolean;
  hasCodex: boolean;
  hasGithubApp: boolean;
  githubAuthMode: 'pat' | 'app';
}

@Injectable()
export class TenantCredentialStore {
  private readonly logger = new Logger(TenantCredentialStore.name);
  private readonly cache = new Map<string, TenantCredentials | null>();

  constructor(
    @InjectRepository(OrgCredentialsEntity, DB_CONNECTION)
    private readonly repo: Repository<OrgCredentialsEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
    private readonly env: EnvService,
  ) {}

  private cacheKey(orgId: string, scope: string): string {
    return `${orgId}:${scope}`;
  }

  private key(): Buffer {
    return loadSecretsKey(this.env.get('SECRETS_ENCRYPTION_KEY'));
  }

  async read(orgId: string, scope = '*'): Promise<TenantCredentials | null> {
    const ck = this.cacheKey(orgId, scope);
    const cached = this.cache.get(ck);
    if (cached !== undefined) return cached;
    const row = await this.repo.findOne({ where: { org_id: orgId, scope } });
    const creds = row ? this.decryptRow(row) : null;
    this.cache.set(ck, creds);
    return creds;
  }

  async presence(orgId: string, scope = '*'): Promise<CredentialPresence> {
    const [row, org] = await Promise.all([
      this.repo.findOne({ where: { org_id: orgId, scope } }),
      this.dataSource.getRepository(OrganizationEntity).findOne({ where: { id: orgId } }),
    ]);
    return {
      hasAnthropic: !!row?.anthropic_api_key_enc,
      hasOpenai: !!row?.openai_api_key_enc,
      hasGithub: !!row?.github_pat_enc,
      engineAuthSet: !!org?.selected_claude_credential_id,
      hasCodex: !!row?.codex_auth_secret_enc,
      hasGithubApp: !!row?.github_app_installation_id,
      githubAuthMode: row?.github_auth_mode ?? 'pat',
    };
  }

  async orgsHoldingInstallation(installationId: string, exceptOrgId: string): Promise<string[]> {
    const rows = await this.repo.find({
      where: { github_app_installation_id: installationId },
      select: { org_id: true },
    });
    return [...new Set(rows.map((r) => r.org_id))].filter((id) => id !== exceptOrgId);
  }

  async codexAccountEmail(orgId: string, scope = '*'): Promise<string | undefined> {
    const row = await this.repo.findOne({ where: { org_id: orgId, scope } });
    if (!row?.codex_auth_secret_enc) return undefined;
    return decodeCodexAccountEmail(decryptSecret(row.codex_auth_secret_enc, this.key()));
  }

  async write(orgId: string, patch: TenantCredentialPatch, scope = '*'): Promise<void> {
    const key = this.key(); // throws loudly when SECRETS_ENCRYPTION_KEY is unset
    const row =
      (await this.repo.findOne({ where: { org_id: orgId, scope } })) ??
      this.repo.create({ org_id: orgId, scope });
    if (patch.anthropicApiKey !== undefined)
      row.anthropic_api_key_enc = encryptSecret(patch.anthropicApiKey, key);
    if (patch.openaiApiKey !== undefined)
      row.openai_api_key_enc = encryptSecret(patch.openaiApiKey, key);
    if (patch.githubPat !== undefined) row.github_pat_enc = encryptSecret(patch.githubPat, key);
    if (patch.claudeOauthToken !== undefined)
      row.claude_oauth_token_enc = encryptSecret(patch.claudeOauthToken, key);
    if (patch.codexAuthSecret !== undefined)
      row.codex_auth_secret_enc = encryptSecret(patch.codexAuthSecret, key);
    if (patch.githubAppInstallationId !== undefined)
      row.github_app_installation_id = patch.githubAppInstallationId;
    if (patch.githubAppInstallationAccount !== undefined)
      row.github_app_installation_account = patch.githubAppInstallationAccount;
    if (patch.githubAuthMode !== undefined) row.github_auth_mode = patch.githubAuthMode;
    await this.repo.save(row);
    this.cache.delete(this.cacheKey(orgId, scope));
    this.logger.log(`wrote credentials for team=${orgId} scope=${scope} (${describePatch(patch)})`);
  }

  async advanceCodexAuthSecret(orgId: string, newSecret: string, scope = '*'): Promise<void> {
    const key = this.key(); // throws loudly when SECRETS_ENCRYPTION_KEY is unset
    const wrote = await this.dataSource.transaction(async (m) => {
      const row = await m.findOne(OrgCredentialsEntity, {
        where: { org_id: orgId, scope },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) {
        this.logger.warn(
          `advanceCodexAuthSecret: no credentials row for team=${orgId} scope=${scope} — skipping`,
        );
        return false;
      }
      const current = row.codex_auth_secret_enc
        ? decryptSecret(row.codex_auth_secret_enc, key)
        : undefined;
      if (current !== undefined && !isNewerCodexAuth(newSecret, current)) return false; // stale / no-change
      row.codex_auth_secret_enc = encryptSecret(newSecret, key);
      await m.save(row);
      return true;
    });
    if (wrote) {
      this.cache.delete(this.cacheKey(orgId, scope));
      this.logger.log(`advanced codex auth secret for team=${orgId} scope=${scope}`);
    }
  }

  async readClaudeUsageSnapshot(orgId: string, scope = '*'): Promise<ClaudeUsageSnapshot | null> {
    const row = await this.repo.findOne({ where: { org_id: orgId, scope } });
    return row?.claude_usage_snapshot ?? null;
  }

  async mergeClaudeUsageWindow(
    orgId: string,
    key: ClaudeUsageWindowKey,
    window: StoredUsageWindow,
    fetchedAt: number,
    credentialId?: string,
    scope = '*',
  ): Promise<boolean> {
    return await this.dataSource.transaction(async (m) => {
      const row = await m.findOne(OrgCredentialsEntity, {
        where: { org_id: orgId, scope },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) return false;
      let snapshot: ClaudeUsageSnapshot = row.claude_usage_snapshot ?? {
        windows: {},
        fetchedAt: 0,
      };
      if (snapshot.credentialId !== credentialId) {
        snapshot = { windows: {}, fetchedAt: 0, credentialId };
      }
      const existing = snapshot.windows[key];
      if (
        existing &&
        existing.utilization === window.utilization &&
        existing.resetsAt === window.resetsAt
      ) {
        return false; // unchanged — skip the write
      }
      snapshot.windows = { ...snapshot.windows, [key]: window };
      snapshot.fetchedAt = fetchedAt;
      snapshot.credentialId = credentialId;
      row.claude_usage_snapshot = snapshot;
      await m.save(row);
      return true;
    });
  }

  async clearClaudeUsageSnapshot(orgId: string, scope = '*'): Promise<void> {
    await this.repo.update({ org_id: orgId, scope }, { claude_usage_snapshot: null });
  }

  private decryptRow(row: OrgCredentialsEntity): TenantCredentials {
    const key = this.key();
    const dec = (v: string | null): string | undefined => (v ? decryptSecret(v, key) : undefined);
    return {
      anthropicApiKey: dec(row.anthropic_api_key_enc),
      openaiApiKey: dec(row.openai_api_key_enc),
      githubPat: dec(row.github_pat_enc),
      claudeOauthToken: dec(row.claude_oauth_token_enc),
      codexAuthSecret: dec(row.codex_auth_secret_enc),
      githubAppInstallationId: row.github_app_installation_id ?? null,
      githubAppInstallationAccount: row.github_app_installation_account ?? null,
      githubAuthMode: row.github_auth_mode ?? 'pat',
    };
  }
}

function describePatch(patch: TenantCredentialPatch): string {
  const set = Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
  return set.length ? set.join(', ') : '(empty)';
}
