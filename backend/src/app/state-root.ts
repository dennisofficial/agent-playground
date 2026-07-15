import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Root for all of Atlas's durable HOST-side runtime state — engine homes, repo clones/worktrees, the
 * hydration sidecar, and the central skills store. Deliberately kept INSIDE the repo at gitignored
 * `.atlas-state/` so the whole generated working set is self-contained: delete the checkout and every
 * byte of state goes with it, nothing left orphaned under the developer's `$HOME`. (Previously these
 * defaulted under `~/.agent-playground/…`, which survived a `rm -rf` of the repo.)
 *
 * Anchored on the monorepo root (the dir holding `pnpm-workspace.yaml`), found by walking up from this
 * compiled module — stable whether running from `src` (ts-node/vitest, where `__dirname` is the source
 * tree) or `dist`. Override any individual root via its env var (`AGENT_HOME_ROOT` / `REPOS_ROOT` /
 * `ATLAS_HYDRATION_STATE` / `SKILLS_ROOT`) to point at a persistent volume in deployment, where the repo
 * checkout is ephemeral and state must outlive it.
 */
/**
 * The monorepo root — the dir holding `pnpm-workspace.yaml` — found by walking up from this compiled
 * module. Stable whether running from `src` (ts-node/vitest, where `__dirname` is the source tree) or
 * `dist`. Falls back to `cwd` (never `$HOME`) if the marker isn't found, so a caller anchored on this
 * still lands inside the project tree. The shared primitive behind {@link repoStateRoot} and
 * `skills/system-skill-store-paths.ts`'s `managedSkillsRootHost` (a DIFFERENT fixed subdir, same walk).
 */
export function monorepoRoot(): string {
  let dir = __dirname;
  for (let depth = 0; depth < 16; depth++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root without finding the marker
    dir = parent;
  }
  return process.cwd(); // marker not found (unexpected) — refuse to escape to $HOME anyway
}

export function repoStateRoot(): string {
  return join(monorepoRoot(), '.atlas-state');
}

/** A named subdir of {@link repoStateRoot}. Callers create it lazily, exactly as before. */
export function repoStateDir(
  name: 'agent-home' | 'repos' | 'hydration-state' | 'skills',
): string {
  return join(repoStateRoot(), name);
}
