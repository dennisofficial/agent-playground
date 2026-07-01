import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LocalGitService, writeForbiddenPaths } from '../git';
import { WorktreeSecretStore } from '../onboarding';
import { loadWorktreeManifest, type MountSpec } from './worktree-manifest';
import { resolveSafeSource, resolveSafeTarget } from './worktree-path-guard';

export interface HydrateInput {
  worktreePath: string;
  /** The repo's slug (on-disk identity) — used for the golden seed source path. */
  slug: string;
  /** The tenant org id (or the gate's synthetic `'gate'`, which resolves to no secrets). */
  orgId: string;
  /** The repo's uuid (`repos.id`) — grants are keyed by this. Absent → no secrets (gate/legacy). */
  repoDbId?: string;
  /**
   * Skip secret rendering entirely (mounts/seed still apply). Set for ONBOARDING threads: their worktree
   * must never hold a real secret value (the brain has Bash and could `cat` it). Onboarding works against
   * `.env.example`/placeholders; real secrets render only into BUILD threads.
   */
  skipSecrets?: boolean;
}

/**
 * Hydrates a worktree from two sources: owner GRANTS (the authority for per-org secrets — see
 * {@link WorktreeSecretStore}) and the repo's committed `.atlas/worktree.json` (mounts + golden seed
 * ONLY; the manifest is NOT consulted for secrets). It renders each granted secret to its destination,
 * copies operator golden-seed files, and returns the validated cache mounts for the sandbox to bind.
 * Every materialized path is gitignore-guarded (so `commitAll`'s `git add -A` can't sweep it into a PR)
 * and traversal/symlink-guarded; the set is persisted to a host-only sidecar so `commitAll`'s leak-scan
 * can reject them even if the in-worktree manifest is later edited.
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
    private readonly env: EnvService,
  ) {}

  /** Validated cache-mount specs from the manifest (cheap; no secrets). Bad paths are dropped + warned. */
  resolveMounts(worktreePath: string): MountSpec[] {
    const { manifest, warnings } = loadWorktreeManifest(worktreePath);
    this.warn(worktreePath, warnings);
    const out: MountSpec[] = [];
    for (const m of manifest.mounts) {
      try {
        resolveSafeTarget(worktreePath, m.path);
        out.push(m);
      } catch (err) {
        this.logger.warn(`worktree mount "${m.path}" rejected: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /**
   * A cheap signature of what hydration WOULD produce — hash of the manifest + the referenced secrets'
   * versions (updated_at, no decryption) + the repo's grant set. Stable unless the manifest, a referenced
   * secret, OR a grant changes — so a thread sandbox re-hydrates when stale, INCLUDING when an owner adds
   * or revokes a grant (otherwise a freshly-granted secret wouldn't render until something else changed).
   */
  async computeSig(worktreePath: string, orgId: string, repoDbId?: string): Promise<string> {
    const { manifest } = loadWorktreeManifest(worktreePath);
    const versions = await this.secrets.secretVersions(orgId);
    const grantList = repoDbId ? await this.secrets.listGrants(orgId, repoDbId) : [];
    // Rendering is grant-driven, so the sig must thread the GRANTED secrets' versions (a rotated value
    // bumps `updated_at` → the sig changes → the next attach re-renders it) plus the grant set itself
    // (name → path), NOT the manifest's legacy `secrets[]`.
    const referenced = grantList.map((g) => `${g.name}:${versions[g.name] ?? 0}`).sort();
    const grants = grantList.map((g) => `${g.name}:${g.path}`).sort();
    return createHash('sha256')
      .update(JSON.stringify({ manifest, referenced, grants }))
      .digest('hex');
  }

  /**
   * Render granted secrets + golden seed into the worktree and persist the forbidden-paths sidecar.
   * Returns the materialized paths AND operator-facing `notices` for anything in the manifest that was
   * skipped/rejected (a bad manifest never throws — it just doesn't hydrate; the notices are surfaced to
   * the operator by the provisioner so a misconfiguration isn't silent). Idempotent.
   */
  async hydrateFiles(input: HydrateInput): Promise<{ forbiddenPaths: string[]; notices: string[] }> {
    const { worktreePath, slug, orgId, repoDbId } = input;
    const { manifest, warnings } = loadWorktreeManifest(worktreePath);
    this.warn(worktreePath, warnings);
    const forbidden: string[] = [];
    const notices: string[] = [...warnings];
    // Operator-facing notice + matching server-log warning in one place.
    const note = (msg: string): void => {
      notices.push(msg);
      this.logger.warn(`${msg} (${worktreePath})`);
    };

    // ── secrets (category 1) — rendered from owner GRANTS, not the manifest ─────────────────────
    // The grant IS the render instruction AND the authority (owner-authored). The committed manifest is
    // never consulted for secrets — so a repo-controlled `.atlas/worktree.json` can't read an org secret.
    // Skipped wholesale for onboarding threads (their worktree must never hold a real secret value).
    if (input.skipSecrets) {
      this.logger.debug(`skipping secret hydration for ${worktreePath} (onboarding thread)`);
    } else if (repoDbId) {
      if (manifest.secrets.length) {
        note(
          `.atlas/worktree.json lists secrets[] — these are ignored. Secrets render from owner grants ` +
            `(Settings → Worktree secrets); the manifest is mounts/seed only.`,
        );
      }
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

    // ── seed (category 3) ─────────────────────────────────────────────────────────────────────
    const goldenRoot = this.env.get('ATLAS_GOLDEN_ROOT');
    if (manifest.seed.length && !goldenRoot) {
      note(`.atlas/worktree.json has seed[] but ATLAS_GOLDEN_ROOT is not configured — seed files skipped`);
    }
    if (manifest.seed.length && goldenRoot) {
      const sourceRoot = join(goldenRoot, orgId, slug);
      for (const rel of manifest.seed) {
        let target: string;
        try {
          target = resolveSafeTarget(worktreePath, rel);
        } catch (err) {
          note(`worktree seed "${rel}" rejected (unsafe path): ${(err as Error).message}`);
          continue;
        }
        if (existsSync(target)) continue; // materialize-if-missing (never clobber agent edits)
        let src: string;
        try {
          src = resolveSafeSource(sourceRoot, rel);
        } catch {
          note(`worktree seed "${rel}" has no source under the golden dir — skipped`);
          continue;
        }
        if (!(await this.git.isIgnored(worktreePath, rel))) {
          note(`worktree seed target "${rel}" is NOT gitignored — refusing to copy (it would leak into the PR); add it to .gitignore`);
          continue;
        }
        await mkdir(dirname(target), { recursive: true });
        await cp(src, target, { recursive: true });
        forbidden.push(rel);
      }
    }

    // ── mounts (category 2) — notice on rejected paths (the attach applies the valid ones) ───────
    for (const m of manifest.mounts) {
      try {
        resolveSafeTarget(worktreePath, m.path);
      } catch (err) {
        note(`worktree mount "${m.path}" rejected (unsafe path): ${(err as Error).message}`);
      }
    }

    // Persist the forbidden set OUTSIDE the worktree for commitAll's leak-scan.
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

  private warn(worktreePath: string, warnings: string[]): void {
    for (const w of warnings) this.logger.warn(`${w} (${worktreePath})`);
  }
}
