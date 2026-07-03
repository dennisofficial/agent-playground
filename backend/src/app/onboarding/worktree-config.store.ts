import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { OrgWorktreeMountEntity } from '../persistence/entities';
import type { MountMode, MountSpec } from '../sandbox/container-paths';
import { loadLegacyManifestFile } from './legacy-worktree-manifest';

/**
 * The org+repo-scoped store for a repo's worktree config — cache/auth `mounts` — DB-backed so a
 * `write_worktree_config` call from any thread reaches every OTHER in-flight job's very next hydration
 * instantly, no PR/merge/rebase lag (see docs/adr/0003). Mirrors {@link WorktreeSecretStore}'s
 * find-then-save idiom exactly — this codebase has no `.upsert()`/`.exist()` precedent, so this store
 * doesn't introduce either.
 */
@Injectable()
export class WorktreeConfigStore {
  private readonly logger = new Logger(WorktreeConfigStore.name);

  constructor(
    @InjectRepository(OrgWorktreeMountEntity, DB_CONNECTION)
    private readonly mounts: Repository<OrgWorktreeMountEntity>,
  ) {}

  /** All mounts for a repo. */
  async listMounts(orgId: string, repoId: string): Promise<MountSpec[]> {
    const rows = await this.mounts.find({ where: { org_id: orgId, repo_id: repoId } });
    return rows.map((r) => ({ path: r.path, mode: r.mode as MountMode }));
  }

  /** Upsert a mount by `path` — idempotent; re-recording the same path replaces `mode`, never duplicates. */
  async upsertMount(orgId: string, repoId: string, path: string, mode: MountMode): Promise<void> {
    const row =
      (await this.mounts.findOne({ where: { org_id: orgId, repo_id: repoId, path } })) ??
      this.mounts.create({ org_id: orgId, repo_id: repoId, path });
    row.mode = mode;
    await this.mounts.save(row);
    this.logger.log(`upserted worktree mount org=${orgId} repo=${repoId} path=${path} mode=${mode}`);
  }

  /** Remove a mount. */
  async removeMount(orgId: string, repoId: string, path: string): Promise<void> {
    await this.mounts.delete({ org_id: orgId, repo_id: repoId, path });
    this.logger.log(`removed worktree mount org=${orgId} repo=${repoId} path=${path}`);
  }

  /**
   * One-time migration off a committed `atlas.json`: if this repo has ZERO mount rows in the DB and its
   * worktree still has a legacy manifest file, import every mount from it, after which the DB is
   * authoritative. Table emptiness IS the "already imported" flag — a genuinely unconfigured repo just
   * stays empty, which is correct. Best-effort by design: callers should `.catch()` this and never let a
   * bad legacy file block provisioning.
   */
  async importLegacyIfEmpty(orgId: string, repoId: string, worktreePath: string): Promise<void> {
    const existingMounts = await this.mounts.find({ where: { org_id: orgId, repo_id: repoId } });
    if (existingMounts.length > 0) return;

    const { manifest } = loadLegacyManifestFile(worktreePath);
    if (manifest.mounts.length === 0) return;

    for (const m of manifest.mounts) await this.upsertMount(orgId, repoId, m.path, m.mode);
    this.logger.log(
      `imported legacy worktree manifest org=${orgId} repo=${repoId} mounts=${manifest.mounts.length}`,
    );
  }
}
