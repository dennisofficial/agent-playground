/**
 * The NEUTRAL in-sandbox mount paths every engine turn runs against. Kept separate from the engine
 * runner so they're a stable, dependency-light import for the manager / runner / provisioner.
 */

/** The engine's isolated agent home INSIDE the sandbox (long-lived → session resume across turns). */
export const CONTAINER_AGENT_HOME = '/atlas-home';

/**
 * The worktree's mount path INSIDE the sandbox — a NEUTRAL container path, NOT the host path. The host
 * worktree is bind-mounted here so the engine never sees host-shaped paths (and can tell it is boxed);
 * `cwd` is translated host→container at the runner boundary.
 */
export const CONTAINER_WORKTREE = '/workspace';

/** The repo's SHARED git common dir mount path INSIDE the sandbox (linked-worktree case only). */
export const CONTAINER_GIT_COMMON = '/repo.git';

/**
 * The in-sandbox path of the SHARED pnpm content-addressable store. pnpm forces its store onto the
 * PROJECT's device — it ignores `store-dir`/`.npmrc` pointing at another mount and always uses
 * `<project-mount>/.pnpm-store` (verified live). So the only way to share the store across every
 * thread is to bind ONE host dir at exactly this path; a dependency is then fetched ONCE globally and
 * copied from the store on every later install (cross-device → copy, not hardlink). The store is
 * git-excluded by the `WorktreeProvisioner`, so `commitAll`'s `git add -A` never stages it — which is
 * what previously failed the build when a ~1.7 GB `.pnpm-store/` landed in the worktree.
 */
export const CONTAINER_PNPM_STORE = `${CONTAINER_WORKTREE}/.pnpm-store`;

/**
 * The thread's durable SHARED CONTEXT folder INSIDE the sandbox — a per-thread scratch/working space
 * that lives OUTSIDE the git worktree (so plan/spec artifacts never pollute the repo diff). Every
 * in-sandbox session for the thread (the brain AND the plan/step/review/auto-fix turns) reads & writes
 * here; the host reads it back via `SandboxManager.contextDirHost()`. Durable across container restarts.
 */
export const CONTAINER_CONTEXT = '/context';
