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
 * Worktree-relative paths the SYSTEM already binds under {@link CONTAINER_WORKTREE} on its own. A
 * repo's worktree config must NOT also request a cache mount at one of these, or two binds land
 * on the same container target and Docker hard-fails container creation ("Duplicate mount point"),
 * wedging every turn on the thread. `.pnpm-store` is the shared store bound at {@link
 * CONTAINER_PNPM_STORE}; the fnm store (`/atlas-fnm`) and `/context` live OUTSIDE `/workspace` so a
 * worktree-relative mount can't reach them. Reserved mounts are dropped (with a warning) both when the
 * brain authors config and when it is resolved at provision time.
 */
export const RESERVED_WORKTREE_MOUNTS: ReadonlySet<string> = new Set(['.pnpm-store']);

/**
 * Cache/state mount mode.
 * - `per-thread` = its own host dir (no cross-thread write contention).
 * - `shared-ro` = one immutable host dir mounted read-only into every thread.
 * - `shared-rw` = one PER-REPO host dir mounted read-write across all of a repo's sandboxes. Used for
 *   persistent auth STATE (e.g. `.gcloud`) that must survive sandbox reap and be reused by every job.
 *   The concurrent-writer race (two jobs refreshing a token at once) is accepted: login is rare and
 *   refresh is near-atomic; worst case is one job re-auths, not corruption.
 */
export type MountMode = 'per-thread' | 'shared-ro' | 'shared-rw';

/** A cache/state directory bind-mounted into the container at `path` (worktree-relative). */
export interface MountSpec {
  path: string;
  mode: MountMode;
}

/**
 * Max length for a worktree-relative mount/seed path recorded in the DB-backed worktree config. This is
 * now the ONLY size guard on that data (there is no committed file to re-parse under a byte/entry cap),
 * so it is enforced at write-time by the brain's tool-input normalizers.
 */
export const MAX_MOUNT_PATH_LEN = 512;

/**
 * Normalize a worktree-relative mount path for reserved-path comparison + bind construction: strip a
 * leading `./`, collapse repeated slashes, and drop a trailing slash. So `./.pnpm-store`,
 * `.pnpm-store/`, and `.pnpm-store` all compare equal to the reserved entry.
 */
export function normalizeMountPath(p: string): string {
  return p
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

/** True if a worktree-relative mount path targets a system-managed location (see {@link RESERVED_WORKTREE_MOUNTS}). */
export function isReservedMountPath(p: string): boolean {
  return RESERVED_WORKTREE_MOUNTS.has(normalizeMountPath(p));
}

/**
 * The in-sandbox path of the SHARED fnm version store (= `FNM_DIR`, set in the sandbox Dockerfile). ONE
 * host dir is bound here for every org/repo/thread (not keyed), so a Node version a repo pins via
 * `.nvmrc`/`.node-version` is downloaded ONCE globally (`fnm use --install-if-missing`) and reused by
 * every later thread — mirroring the shared pnpm store. (Sandboxes have outbound egress; only inbound
 * port exposure is unavailable.) A repo with no version file just runs the image's base Node 22.
 */
export const CONTAINER_FNM_STORE = '/atlas-fnm';

/**
 * The thread's durable SHARED CONTEXT folder INSIDE the sandbox — a per-thread scratch/working space
 * that lives OUTSIDE the git worktree (so plan/spec artifacts never pollute the repo diff). Every
 * in-sandbox session for the thread (the brain AND the plan/step/review/auto-fix turns) reads & writes
 * here; the host reads it back via `SandboxManager.contextDirHost()`. Durable across container restarts.
 */
export const CONTAINER_CONTEXT = '/context';

/**
 * The job's durable PLAYGROUND / scratch space INSIDE the sandbox — a freeform, read-write area OUTSIDE
 * the git worktree (so throwaway scripts/spikes/one-off harnesses never pollute the repo diff or a PR).
 * Keyed by jobId → shared by every build lane of the job, durable across container recreate/reap (the
 * host reads it via `SandboxManager.playgroundDirHost()`); removed on deep job delete. Distinct from
 * `/context` (plan/spec artifacts read by the build engines) — `/playground` is purely Atlas's own
 * scratch pad, given no imposed structure.
 */
export const CONTAINER_PLAYGROUND = '/playground';
