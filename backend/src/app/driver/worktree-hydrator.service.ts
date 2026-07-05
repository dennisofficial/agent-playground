import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LocalGitService, writeForbiddenPaths } from '../git';
import { WorktreeConfigStore, WorktreeSecretStore } from '../onboarding';
import { isExternalMountPath, type MountSpec } from '../sandbox/container-paths';
import { resolveExternalMountTarget, resolveSafeTarget } from './worktree-path-guard';

export interface HydrateInput {
  worktreePath: string;
  /** The tenant org id (or the gate's synthetic `'gate'`, which resolves to no secrets). */
  orgId: string;
  /** The repo's uuid (`repos.id`) — grants + config are keyed by this. Absent → no secrets/mounts. */
  repoDbId?: string;
}

/**
 * Hydrates a worktree from two DB-backed sources — owner GRANTS (per-org secrets, see
 * {@link WorktreeSecretStore}) and the org+repo-scoped worktree config (cache/auth mounts, see
 * {@link WorktreeConfigStore}) — never a committed file (see docs/adr/0003: a `write_worktree_config` call
 * from ANY thread propagates to every other in-flight job's next hydration instantly, no PR/merge/rebase
 * lag). It renders each granted secret to its destination and returns the validated cache mounts for the
 * sandbox to bind. Every materialized path is gitignore-guarded (so a writer's `git add -A` can't sweep it
 * into a PR) and traversal/symlink-guarded; the set is persisted to a host-only sidecar so the pre-ship
 * branch leak-scan can reject a committed secret even if config changes mid-turn.
 *
 * Stateless and idempotent: callers decide WHEN to (re-)hydrate (thread paths gate on {@link computeSig};
 * gate/legacy paths re-hydrate every attach). This service never touches the container — the
 * `WorktreeProvisioner` wires hydrate → attach.
 */
@Injectable()
export class WorktreeHydrator {
  private readonly logger = new Logger(WorktreeHydrator.name);
  private tmpCounter = 0;

  constructor(
    private readonly git: LocalGitService,
    private readonly secrets: WorktreeSecretStore,
    private readonly config: WorktreeConfigStore,
  ) {}

  /**
   * Read the repo's DB-backed mount config, tolerating a transient store failure (a Postgres hiccup
   * must never fail a sandbox attach) — logs a warning and returns empty so the caller proceeds as if the
   * repo simply has no config THIS pass; the next attach re-reads and self-heals once the store recovers.
   */
  private async safeListMounts(orgId: string, repoId: string): Promise<MountSpec[]> {
    try {
      return await this.config.listMounts(orgId, repoId);
    } catch (err) {
      this.logger.warn(`worktree mount config read failed for repo=${repoId} (treating as none this pass): ${(err as Error).message}`);
      return [];
    }
  }

  /** Validated cache-mount specs from the repo's DB config (cheap; no secrets). Bad paths are dropped + warned. */
  async resolveMounts(orgId: string, repoId: string, worktreePath: string): Promise<MountSpec[]> {
    const mounts = await this.safeListMounts(orgId, repoId);
    const out: MountSpec[] = [];
    for (const m of mounts) {
      try {
        // External mounts (absolute container path) validate against the reserved-container guard; worktree
        // mounts (relative) against the traversal/escape guard. Either way a bad entry is dropped + warned.
        if (isExternalMountPath(m.path)) resolveExternalMountTarget(m.path);
        else resolveSafeTarget(worktreePath, m.path);
        out.push(m);
      } catch (err) {
        this.logger.warn(`worktree mount "${m.path}" rejected: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /**
   * A cheap signature of what hydration WOULD produce — hash of the repo's live mount rows + the
   * referenced secrets' versions (updated_at, no decryption) + the repo's grant set. Stable unless a
   * mount row, a referenced secret, OR a grant changes — so a thread sandbox re-hydrates when stale,
   * INCLUDING when an owner adds or revokes a grant (otherwise a freshly-granted secret wouldn't render
   * until something else changed). Hashes live content directly (not `updated_at` timestamps) so an
   * idempotent no-op upsert can never spuriously bump the signature.
   */
  async computeSig(worktreePath: string, orgId: string, repoDbId?: string): Promise<string> {
    const mounts = repoDbId ? await this.safeListMounts(orgId, repoDbId) : [];
    const versions = await this.secrets.secretVersions(orgId);
    const grantList = repoDbId ? await this.secrets.listGrants(orgId, repoDbId) : [];
    // Rendering is grant-driven, so the sig must thread the GRANTED secrets' versions (a rotated value
    // bumps `updated_at` → the sig changes → the next attach re-renders it) plus the grant set itself
    // (name → path).
    const referenced = grantList.map((g) => `${g.name}:${versions[g.name] ?? 0}`).sort();
    const grants = grantList.map((g) => `${g.name}:${g.path}`).sort();
    const mountSig = mounts.map((m) => `${m.path}:${m.mode}`).sort();
    return createHash('sha256')
      .update(JSON.stringify({ mounts: mountSig, referenced, grants }))
      .digest('hex');
  }

  /**
   * Render granted secrets into the worktree and persist the forbidden-paths sidecar.
   * Returns the materialized paths AND operator-facing `notices` for anything that was skipped/rejected (a
   * bad config entry never throws — it just doesn't hydrate; the notices are surfaced to the operator by
   * the provisioner so a misconfiguration isn't silent). Idempotent.
   */
  async hydrateFiles(input: HydrateInput): Promise<{ forbiddenPaths: string[]; notices: string[] }> {
    const { worktreePath, orgId, repoDbId } = input;
    const forbidden: string[] = [];
    const notices: string[] = [];
    // Operator/Atlas-facing notice + matching server-log warning in one place — this is the channel the
    // provisioner drains into the thread's passive-awareness buffer, so a notice here reaches Atlas on its
    // next turn even though this method itself never throws.
    const note = (msg: string): void => {
      notices.push(msg);
      this.logger.warn(`${msg} (${worktreePath})`);
    };

    let mounts: MountSpec[] = [];
    if (repoDbId) {
      try {
        mounts = await this.config.listMounts(orgId, repoDbId);
      } catch (err) {
        note(`worktree config unavailable — mounts skipped this hydration (will retry next attach): ${(err as Error).message}`);
      }
    }

    // ── secrets (category 1) — rendered from owner GRANTS, not worktree config ──────────────────
    // The grant IS the render instruction AND the authority (owner-authored). Worktree config (mounts)
    // never carries secrets — so a `write_worktree_config` call can't read an org secret.
    // NOTE: EVERY thread (incl. onboarding) renders real secret values now. The brain has Bash and can
    // read them in-sandbox — that is INTENTIONAL and accepted: this is a private, trusted deployment where
    // Atlas is at least as capable as local Claude Code (which runs with the user's full unisolated creds).
    // The only guard is "don't COMMIT it": each target must be gitignored (below) + the pre-ship leak-scan.
    if (repoDbId) {
      for (const g of await this.secrets.listGrants(orgId, repoDbId)) {
        let target: string;
        try {
          target = resolveSafeTarget(worktreePath, g.path);
        } catch (err) {
          note(`worktree secret "${g.path}" rejected (unsafe path): ${(err as Error).message}`);
          continue;
        }
        const value = await this.secrets.read(orgId, g.name);
        if (value == null) {
          note(`worktree secret "${g.name}" is granted but has no stored value — set it in Settings → Worktree secrets`);
          continue;
        }
        if (!(await this.git.isIgnored(worktreePath, g.path))) {
          note(`worktree secret target "${g.path}" is NOT gitignored — refusing to render (it would leak into the PR); add it to .gitignore`);
          continue;
        }
        await this.writeAtomic(target, value, 0o600);
        forbidden.push(g.path);
      }
    }

    // ── mounts (category 2) — notice on rejected paths (the attach applies the valid ones) ───────
    // External mounts (absolute container path) render NO files and need NO gitignore check — they live
    // outside /workspace, so a writer's `git add -A` can never see them. We only surface a notice for a
    // path the guard rejects (external → reserved-container guard; worktree → traversal/escape guard).
    for (const m of mounts) {
      try {
        if (isExternalMountPath(m.path)) resolveExternalMountTarget(m.path);
        else resolveSafeTarget(worktreePath, m.path);
      } catch (err) {
        note(`worktree mount "${m.path}" rejected (unsafe path): ${(err as Error).message}`);
      }
    }

    // Persist the forbidden set OUTSIDE the worktree for the pre-ship branch leak-scan.
    await writeForbiddenPaths(worktreePath, forbidden);
    if (forbidden.length) {
      this.logger.log(`hydrated ${forbidden.length} file(s) into ${worktreePath}`);
    }
    return { forbiddenPaths: forbidden, notices };
  }

  private async writeAtomic(target: string, content: string, mode: number): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.atlas-tmp-${process.pid}-${this.tmpCounter++}`;
    await writeFile(tmp, content, { mode });
    await rename(tmp, target);
  }
}
