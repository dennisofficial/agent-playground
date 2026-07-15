import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { OrgWorkspaceSecretFileEntity } from '../persistence/entities';
import { decryptSecret, encryptSecret, loadSecretsKey } from './secret-cipher';

/** A secret file's identity + display label (never its value). */
export interface WorkspaceSecretFileRef {
  repoId: string;
  path: string;
  label?: string | null;
}

/** A repo-scoped secret file ref plus its `updated_at` epoch ms — for cheap re-hydration sig. */
export interface WorkspaceSecretFileVersion {
  path: string;
  label?: string | null;
  updatedAt: number;
}

/**
 * The encrypt-on-write / decrypt-on-read path for per-repo workspace secret FILES. Mirrors {@link
 * TenantCredentialStore}: AES-256-GCM via `secret-cipher`, values never logged,
 * `SECRETS_ENCRYPTION_KEY` required to write/read a value.
 *
 * A single row IS the value, the authority, AND the render instruction — it replaces the old two-table
 * split (a named value + a separate grant). The security invariant (ADR-0003: a repo's committed
 * `.atlas/worktree.json` is a request, never authority) now lives in row EXISTENCE: a file renders only
 * when an owner-created `(org, repo, path)` row exists. `list`/`listForRepo` expose paths + labels only
 * — never values.
 */
@Injectable()
export class WorkspaceSecretFileStore {
  private readonly logger = new Logger(WorkspaceSecretFileStore.name);

  constructor(
    @InjectRepository(OrgWorkspaceSecretFileEntity, DB_CONNECTION)
    private readonly files: Repository<OrgWorkspaceSecretFileEntity>,
    private readonly env: EnvService,
  ) {}

  private key(): Buffer {
    return loadSecretsKey(this.env.get('SECRETS_ENCRYPTION_KEY'));
  }

  /** All secret files for an org (paths + labels, never values), optionally scoped to one repo. */
  async list(
    orgId: string,
    repoId?: string,
  ): Promise<WorkspaceSecretFileRef[]> {
    const rows = await this.files.find({
      where: repoId ? { org_id: orgId, repo_id: repoId } : { org_id: orgId },
      select: ['repo_id', 'path', 'label'],
    });
    return rows.map((r) => ({
      repoId: r.repo_id,
      path: r.path,
      label: r.label ?? null,
    }));
  }

  /**
   * Repo-scoped file refs + their `updated_at` epoch ms (NO decryption, no values), for cheap
   * re-hydration sig computation. A rotated value bumps `updated_at`, so the sig changes and the next
   * attach re-renders it; an added/removed row changes the path set.
   */
  async listForRepo(
    orgId: string,
    repoId: string,
  ): Promise<WorkspaceSecretFileVersion[]> {
    const rows = await this.files.find({
      where: { org_id: orgId, repo_id: repoId },
      select: ['path', 'label', 'updated_at'],
    });
    return rows.map((r) => ({
      path: r.path,
      label: r.label ?? null,
      updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0,
    }));
  }

  /** Decrypted value for (orgId, repoId, path), or null when no row exists. Not cached (cold provision path). */
  async read(
    orgId: string,
    repoId: string,
    path: string,
  ): Promise<string | null> {
    const row = await this.files.findOne({
      where: { org_id: orgId, repo_id: repoId, path },
    });
    return row ? decryptSecret(row.value_enc, this.key()) : null;
  }

  /**
   * Encrypt + upsert a secret file at (orgId, repoId, path). `label` is an optional human name for
   * display only (identity is the path). Refuses without `SECRETS_ENCRYPTION_KEY`.
   */
  async write(
    orgId: string,
    repoId: string,
    path: string,
    value: string,
    label?: string | null,
  ): Promise<void> {
    const key = this.key();
    const row =
      (await this.files.findOne({
        where: { org_id: orgId, repo_id: repoId, path },
      })) ?? this.files.create({ org_id: orgId, repo_id: repoId, path });
    row.value_enc = encryptSecret(value, key);
    if (label !== undefined) row.label = label;
    await this.files.save(row);
    this.logger.log(
      `wrote workspace secret file org=${orgId} repo=${repoId} path=${path}`,
    );
  }

  /** Delete a secret file at (orgId, repoId, path). */
  async delete(orgId: string, repoId: string, path: string): Promise<void> {
    await this.files.delete({ org_id: orgId, repo_id: repoId, path });
    this.logger.log(
      `deleted workspace secret file org=${orgId} repo=${repoId} path=${path}`,
    );
  }
}
