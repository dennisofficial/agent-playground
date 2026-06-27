import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  OrgWorktreeSecretEntity,
  OrgWorktreeSecretGrantEntity,
} from '../persistence/entities';
import { decryptSecret, encryptSecret, loadSecretsKey } from './secret-cipher';

/** A grant the owner created: secret `name` may be rendered to `path` in repo `repoId`. */
export interface WorktreeSecretGrant {
  repoId: string;
  name: string;
  path: string;
}

/**
 * The encrypt-on-write / decrypt-on-read path for per-org NAMED worktree secrets, plus the owner
 * GRANTS that authorise rendering them. Mirrors {@link TenantCredentialStore}: AES-256-GCM via
 * `secret-cipher`, values never logged, `SECRETS_ENCRYPTION_KEY` required to write/read a value.
 *
 * The security invariant lives in {@link isGranted}: a repo's committed `.atlas/worktree.json` is a
 * request, and a secret is only ever materialised when an owner-created grant matches the exact
 * (name → repoId → path) triple. `list`/`listGrants` expose NAMES only — never values.
 */
@Injectable()
export class WorktreeSecretStore {
  private readonly logger = new Logger(WorktreeSecretStore.name);

  constructor(
    @InjectRepository(OrgWorktreeSecretEntity, DB_CONNECTION)
    private readonly secrets: Repository<OrgWorktreeSecretEntity>,
    @InjectRepository(OrgWorktreeSecretGrantEntity, DB_CONNECTION)
    private readonly grants: Repository<OrgWorktreeSecretGrantEntity>,
    private readonly env: EnvService,
  ) {}

  private key(): Buffer {
    return loadSecretsKey(this.env.get('SECRETS_ENCRYPTION_KEY'));
  }

  // ── secret values ───────────────────────────────────────────────────────────────────────────

  /** Decrypted value for (orgId, name), or null when no row exists. Not cached (cold provision path). */
  async read(orgId: string, name: string): Promise<string | null> {
    const row = await this.secrets.findOne({ where: { org_id: orgId, name } });
    return row ? decryptSecret(row.value_enc, this.key()) : null;
  }

  /** Secret NAMES for an org (never values). */
  async list(orgId: string): Promise<string[]> {
    const rows = await this.secrets.find({ where: { org_id: orgId }, select: ['name'] });
    return rows.map((r) => r.name);
  }

  /**
   * name → last-updated epoch ms, for cheap re-hydration sig computation (NO decryption, no values).
   * A rotated value bumps `updated_at`, so the hydration sig changes and the next attach re-applies it.
   */
  async secretVersions(orgId: string): Promise<Record<string, number>> {
    const rows = await this.secrets.find({
      where: { org_id: orgId },
      select: ['name', 'updated_at'],
    });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.name] = r.updated_at ? new Date(r.updated_at).getTime() : 0;
    return out;
  }

  /** Encrypt + upsert a named secret value. Refuses without `SECRETS_ENCRYPTION_KEY`. */
  async write(orgId: string, name: string, value: string): Promise<void> {
    const key = this.key();
    const row =
      (await this.secrets.findOne({ where: { org_id: orgId, name } })) ??
      this.secrets.create({ org_id: orgId, name });
    row.value_enc = encryptSecret(value, key);
    await this.secrets.save(row);
    this.logger.log(`wrote worktree secret org=${orgId} name=${name}`);
  }

  /** Delete a named secret (and any grants that reference it). */
  async delete(orgId: string, name: string): Promise<void> {
    await this.secrets.delete({ org_id: orgId, name });
    await this.grants.delete({ org_id: orgId, name });
    this.logger.log(`deleted worktree secret org=${orgId} name=${name}`);
  }

  // ── grants (the authority) ──────────────────────────────────────────────────────────────────

  /** All grants for an org, optionally scoped to one repo. NAMES + paths only — never values. */
  async listGrants(orgId: string, repoId?: string): Promise<WorktreeSecretGrant[]> {
    const rows = await this.grants.find({
      where: repoId ? { org_id: orgId, repo_id: repoId } : { org_id: orgId },
    });
    return rows.map((r) => ({ repoId: r.repo_id, name: r.name, path: r.path }));
  }

  /** Owner authorises `name` → `path` in `repoId`. Idempotent. */
  async grant(orgId: string, repoId: string, name: string, path: string): Promise<void> {
    const existing = await this.grants.findOne({
      where: { org_id: orgId, repo_id: repoId, name, path },
    });
    if (!existing) {
      await this.grants.save(this.grants.create({ org_id: orgId, repo_id: repoId, name, path }));
    }
    this.logger.log(`granted worktree secret org=${orgId} repo=${repoId} name=${name} path=${path}`);
  }

  /** Owner revokes a grant. */
  async revoke(orgId: string, repoId: string, name: string, path: string): Promise<void> {
    await this.grants.delete({ org_id: orgId, repo_id: repoId, name, path });
    this.logger.log(`revoked worktree secret org=${orgId} repo=${repoId} name=${name} path=${path}`);
  }

  /** THE authorisation check: is rendering `name` to `path` in `repoId` allowed? */
  async isGranted(orgId: string, repoId: string, name: string, path: string): Promise<boolean> {
    const row = await this.grants.findOne({
      where: { org_id: orgId, repo_id: repoId, name, path },
    });
    return !!row;
  }
}
