import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { OrgWorkspaceMountEntity, RepoEntity } from '../persistence/entities';
import type { MountMode, MountSpec } from '../sandbox/container-paths';
import type { InstallMatch } from '../prompt-kit/jit/install-awareness';
import type { SeenTooling } from '../workspace-profile/seen-tooling';
import { loadLegacyManifestFile } from './legacy-worktree-manifest';

/**
 * The org+repo-scoped store for a repo's workspace config — cache/auth `mounts` — DB-backed so a
 * `write_workspace_config` call from any thread reaches every OTHER in-flight job's very next hydration
 * instantly, no PR/merge/rebase lag (see docs/adr/0003). Mirrors {@link WorkspaceSecretFileStore}'s
 * find-then-save idiom exactly — this codebase has no `.upsert()`/`.exist()` precedent, so this store
 * doesn't introduce either.
 */
@Injectable()
export class WorkspaceConfigStore {
  private readonly logger = new Logger(WorkspaceConfigStore.name);

  constructor(
    @InjectRepository(OrgWorkspaceMountEntity, DB_CONNECTION)
    private readonly mounts: Repository<OrgWorkspaceMountEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
  ) {}

  /**
   * The repo's cold-boot setup script (`repos.setup_script`), or null when unset. Resolved by the
   * `WorktreeProvisioner` on every attach and handed to `SandboxManager`, which runs it on COLD bring-up
   * only (see {@link RepoEntity.setup_script}).
   */
  async getSetupScript(orgId: string, repoId: string): Promise<string | null> {
    const row = await this.repos.findOne({ where: { id: repoId, org_id: orgId } });
    return row?.setup_script ?? null;
  }

  /** Set (or clear, when empty/blank) the repo's cold-boot setup script. Live for every future job's next
   *  cold attach — no PR. */
  async setSetupScript(orgId: string, repoId: string, script: string | null): Promise<void> {
    const trimmed = script?.trim() ? script : null;
    await this.repos.update({ id: repoId, org_id: orgId }, { setup_script: trimmed });
    this.logger.log(
      `${trimmed ? 'set' : 'cleared'} setup script org=${orgId} repo=${repoId}` +
        (trimmed ? ` (${trimmed.length} chars)` : ''),
    );
  }

  /** The repo's preview recipe (`repos.preview_instructions`), or null when unset. Spliced into the
   *  Spin-up-preview seed (see `previewPrepRule`). */
  async getPreviewInstructions(orgId: string, repoId: string): Promise<string | null> {
    const row = await this.repos.findOne({ where: { id: repoId, org_id: orgId } });
    return row?.preview_instructions ?? null;
  }

  /** Set (or clear, when empty/blank) the repo's preview recipe. Live for every future job's next
   *  Spin-up-preview — no PR. */
  async setPreviewInstructions(orgId: string, repoId: string, instructions: string | null): Promise<void> {
    const trimmed = instructions?.trim() ? instructions : null;
    await this.repos.update({ id: repoId, org_id: orgId }, { preview_instructions: trimmed });
    this.logger.log(
      `${trimmed ? 'set' : 'cleared'} preview instructions org=${orgId} repo=${repoId}` +
        (trimmed ? ` (${trimmed.length} chars)` : ''),
    );
  }

  /** The dependency manifests the Workspace Profile has acknowledged (`repos.profile_seen_manifests`),
   *  or null when never seeded — see {@link RepoEntity.profile_seen_manifests}. */
  async getSeenManifests(orgId: string, repoId: string): Promise<string[] | null> {
    const row = await this.repos.findOne({ where: { id: repoId, org_id: orgId } });
    return row?.profile_seen_manifests ?? null;
  }

  /** Record the manifest set the profile has now acknowledged (seeded at onboarding, refreshed when the
   *  brain records a setup script). Sorted + de-duped so the new-stack diff is stable. */
  async setSeenManifests(orgId: string, repoId: string, manifests: string[]): Promise<void> {
    const unique = Array.from(new Set(manifests)).sort();
    await this.repos.update({ id: repoId, org_id: orgId }, { profile_seen_manifests: unique });
  }

  /**
   * Apply an install/remove transition to the seen-tooling ledger (`repos.profile_seen_tooling`) atomically —
   * `SELECT … FOR UPDATE` under `this.repos.manager.transaction`, mirroring
   * {@link TenantCredentialStore.advanceCodexAuthSecret}. Safe against a build lane racing the brain on the
   * same repo row. Returns the action that actually fired, or null on a no-op (add of an already-present key,
   * remove of an absent one) — the caller (`ProfileAwarenessService`) suppresses the nudge on null. A missing
   * repo row is also a no-op.
   */
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
        this.logger.warn(`applyToolingTransition: no repo row for org=${orgId} repo=${repoId} — skipping`);
        return null;
      }
      const ledger = row.profile_seen_tooling ?? [];
      const present = ledger.some((t) => t.key === match.key);

      if (match.action === 'add') {
        if (present) return null; // already tracked — steady-state repeat, deduped
        const entry: SeenTooling = { key: match.key, kind: match.kind, seenAt: new Date().toISOString() };
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
