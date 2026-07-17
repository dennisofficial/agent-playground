import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { InstallMatch } from '@shared/prompt-kit/jit/install-awareness';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { OrgWorkspaceMountEntity, RepoEntity } from '../persistence/entities';
import type { MountMode, MountSpec } from '../sandbox/container-paths';
import type { SeenTooling } from '../workspace-profile/seen-tooling';
import { loadLegacyManifestFile } from './legacy-worktree-manifest';

@Injectable()
export class WorkspaceConfigStore {
  private readonly logger = new Logger(WorkspaceConfigStore.name);

  constructor(
    @InjectRepository(OrgWorkspaceMountEntity, DB_CONNECTION)
    private readonly mounts: Repository<OrgWorkspaceMountEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
  ) {}

  async getSetupScript(orgId: string, repoId: string): Promise<string | null> {
    const row = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    return row?.setup_script ?? null;
  }

  async setSetupScript(orgId: string, repoId: string, script: string | null): Promise<void> {
    const trimmed = script?.trim() ? script : null;
    await this.repos.update({ id: repoId, org_id: orgId }, { setup_script: trimmed });
    this.logger.log(
      `${trimmed ? 'set' : 'cleared'} setup script org=${orgId} repo=${repoId}` +
        (trimmed ? ` (${trimmed.length} chars)` : ''),
    );
  }

  async getPreviewInstructions(orgId: string, repoId: string): Promise<string | null> {
    const row = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    return row?.preview_instructions ?? null;
  }

  async setPreviewInstructions(
    orgId: string,
    repoId: string,
    instructions: string | null,
  ): Promise<void> {
    const trimmed = instructions?.trim() ? instructions : null;
    await this.repos.update({ id: repoId, org_id: orgId }, { preview_instructions: trimmed });
    this.logger.log(
      `${trimmed ? 'set' : 'cleared'} preview instructions org=${orgId} repo=${repoId}` +
        (trimmed ? ` (${trimmed.length} chars)` : ''),
    );
  }

  async getSeenManifests(orgId: string, repoId: string): Promise<string[] | null> {
    const row = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    return row?.profile_seen_manifests ?? null;
  }

  async setSeenManifests(orgId: string, repoId: string, manifests: string[]): Promise<void> {
    const unique = Array.from(new Set(manifests)).sort();
    await this.repos.update({ id: repoId, org_id: orgId }, { profile_seen_manifests: unique });
  }

  async applyToolingTransition(
    orgId: string,
    repoId: string,
    match: InstallMatch,
  ): Promise<'add' | 'remove' | null> {
    return this.repos.manager.transaction(async (m) => {
      const row = await m.findOne(RepoEntity, {
        where: { id: repoId, org_id: orgId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) {
        this.logger.warn(
          `applyToolingTransition: no repo row for org=${orgId} repo=${repoId} — skipping`,
        );
        return null;
      }
      const ledger = row.profile_seen_tooling ?? [];
      const present = ledger.some((t) => t.key === match.key);

      if (match.action === 'add') {
        if (present) return null; // already tracked — steady-state repeat, deduped
        const entry: SeenTooling = {
          key: match.key,
          kind: match.kind,
          firstSeenAt: new Date().toISOString(),
        };
        row.profile_seen_tooling = [...ledger, entry];
        await m.save(row);
        return 'add';
      }

      if (!present) return null; // never tracked — steady-state repeat, deduped
      row.profile_seen_tooling = ledger.filter((t) => t.key !== match.key);
      await m.save(row);
      return 'remove';
    });
  }

  async listMounts(orgId: string, repoId: string): Promise<MountSpec[]> {
    const rows = await this.mounts.find({
      where: { org_id: orgId, repo_id: repoId },
    });
    return rows.map((r) => ({ path: r.path, mode: r.mode as MountMode }));
  }

  async upsertMount(orgId: string, repoId: string, path: string, mode: MountMode): Promise<void> {
    const row =
      (await this.mounts.findOne({
        where: { org_id: orgId, repo_id: repoId, path },
      })) ?? this.mounts.create({ org_id: orgId, repo_id: repoId, path });
    row.mode = mode;
    await this.mounts.save(row);
    this.logger.log(
      `upserted worktree mount org=${orgId} repo=${repoId} path=${path} mode=${mode}`,
    );
  }

  async removeMount(orgId: string, repoId: string, path: string): Promise<void> {
    await this.mounts.delete({ org_id: orgId, repo_id: repoId, path });
    this.logger.log(`removed worktree mount org=${orgId} repo=${repoId} path=${path}`);
  }

  async importLegacyIfEmpty(orgId: string, repoId: string, worktreePath: string): Promise<void> {
    const existingMounts = await this.mounts.find({
      where: { org_id: orgId, repo_id: repoId },
    });
    if (existingMounts.length > 0) return;

    const { manifest } = loadLegacyManifestFile(worktreePath);
    if (manifest.mounts.length === 0) return;

    for (const m of manifest.mounts) await this.upsertMount(orgId, repoId, m.path, m.mode);
    this.logger.log(
      `imported legacy worktree manifest org=${orgId} repo=${repoId} mounts=${manifest.mounts.length}`,
    );
  }
}
