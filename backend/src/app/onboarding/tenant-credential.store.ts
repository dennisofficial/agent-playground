import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type { ClaudeUsageSnapshot, ClaudeUsageWindowKey, StoredUsageWindow } from '@workspace/shared';
import { DataSource, Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { OrganizationEntity, OrgCredentialsEntity } from '../persistence/entities';
import { isNewerCodexAuth } from './codex-auth-freshness';
import { decryptSecret, encryptSecret, loadSecretsKey } from './secret-cipher';

/** Decrypted credentials for a (team, scope) — the in-memory shape consumers read. */
export interface TenantCredentials {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  githubPat?: string;
  /** Claude subscription OAuth token for the SDK harness. */
  claudeOauthToken?: string;
  /** Codex subscription secret (auth.json / token) for the SDK harness. */
  codexAuthSecret?: string;
}

/** A partial update — only provided fields are (re-)encrypted and written. */
export interface TenantCredentialPatch {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  githubPat?: string;
  claudeOauthToken?: string;
  codexAuthSecret?: string;
}

/** Cheap existence flags for the onboarding checklist — NO decryption, NO secret values. */
export interface CredentialPresence {
  hasAnthropic: boolean;
  hasOpenai: boolean;
  hasGithub: boolean;
  /** Engine (SDK harness) auth is satisfiable: the org has a SELECTED Claude credential (Codex is optional). */
  engineAuthSet: boolean;
  /** Optional Codex subscription secret is set (a second, optional coding engine). */
  hasCodex: boolean;
}

/**
 * The ONLY encrypt-on-write / decrypt-on-read path for tenant credentials. Decrypted reads are cached
 * per (team, scope) and invalidated on write (so the hot brain/driver path doesn't hit Postgres every
 * turn). Secret VALUES are never logged. `presence()` answers the checklist without decrypting (and so
 * works even without `SECRETS_ENCRYPTION_KEY`).
 */
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

  /** Decrypted credentials for (orgId, scope), or null when no row exists. Cached. */
  async read(orgId: string, scope = '*'): Promise<TenantCredentials | null> {
    const ck = this.cacheKey(orgId, scope);
    const cached = this.cache.get(ck);
    if (cached !== undefined) return cached;
    const row = await this.repo.findOne({ where: { org_id: orgId, scope } });
    const creds = row ? this.decryptRow(row) : null;
    this.cache.set(ck, creds);
    return creds;
  }

  /** Existence flags for the checklist — one cheap query, no decryption. */
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
    };
  }

  /** Encrypt + persist the provided fields (find-or-create the (team, scope) row). Refuses without a key. */
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
    await this.repo.save(row);
    this.cache.delete(this.cacheKey(orgId, scope));
    this.logger.log(`wrote credentials for team=${orgId} scope=${scope} (${describePatch(patch)})`);
  }

  /**
   * ATOMICALLY advance the stored Codex subscription secret to a REFRESHED `auth.json` — the auth-refresh
   * write-back. The whole read-compare-write runs in ONE transaction under a `pessimistic_write` row lock
   * (`SELECT … FOR UPDATE`), so it is safe against concurrent turns AND reads fresh from the DB (bypassing
   * the decrypt cache). A monotonic `last_refresh` guard means an older/slower turn can never clobber a
   * newer blob; when timestamps are missing it degrades to write-only-on-real-change. No-ops when no
   * credentials row exists. Refuses (throws) without an encryption key — callers must swallow.
   */
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

  /** Durable Claude usage snapshot for (orgId, scope), or null when no row exists / none harvested yet. Plaintext — no cipher involved. */
  async readClaudeUsageSnapshot(orgId: string, scope = '*'): Promise<ClaudeUsageSnapshot | null> {
    const row = await this.repo.findOne({ where: { org_id: orgId, scope } });
    return row?.claude_usage_snapshot ?? null;
  }

  /**
   * ATOMICALLY merge one harvested window into the durable snapshot, mirroring
   * {@link advanceCodexAuthSecret}'s transaction + `pessimistic_write` row-lock pattern. No-ops when no
   * credentials row exists, or when the stored window already matches (avoids redundant writes on every
   * turn). Does NOT touch the decrypt `cache` — this column is plaintext and unrelated to it.
   */
  async mergeClaudeUsageWindow(
    orgId: string,
    key: ClaudeUsageWindowKey,
    window: StoredUsageWindow,
    fetchedAt: number,
    scope = '*',
  ): Promise<boolean> {
    return await this.dataSource.transaction(async (m) => {
      const row = await m.findOne(OrgCredentialsEntity, {
        where: { org_id: orgId, scope },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) return false;
      const snapshot: ClaudeUsageSnapshot = row.claude_usage_snapshot ?? { windows: {}, fetchedAt: 0 };
      const existing = snapshot.windows[key];
      if (existing && existing.utilization === window.utilization && existing.resetsAt === window.resetsAt) {
        return false; // unchanged — skip the write
      }
      snapshot.windows = { ...snapshot.windows, [key]: window };
      snapshot.fetchedAt = fetchedAt;
      row.claude_usage_snapshot = snapshot;
      await m.save(row);
      return true;
    });
  }

  /** Drop the org's harvested usage snapshot (set the nullable column null) — used on a Claude account switch so the ring re-reads the new account from scratch. */
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
    };
  }
}

/** Field NAMES only (never values) — safe to log. */
function describePatch(patch: TenantCredentialPatch): string {
  const set = Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
  return set.length ? set.join(', ') : '(empty)';
}
