/**
 * The NEUTRAL in-sandbox mount paths every engine turn runs against. Kept separate from the engine
 * runner so they're a stable, dependency-light import for the manager / runner / provisioner.
 */

import { posix } from 'node:path';

/**
 * The ENGINE's own isolated home INSIDE the sandbox — session transcripts (long-lived → resume across
 * turns) and `atlas-svc` supervisor markers/logs. Host-owned, durable, keyed PER-JOB (survives a
 * `reset_sandbox` of the same job, but NOT shared across other jobs on the repo — see {@link CONTAINER_HOME}
 * for cross-job/per-repo durability). Hidden dotdir naming (`.atlas`, mirroring `.git`/`.ssh`/`.docker`)
 * signals this is engine-internal machinery, NOT a general scratch space — Atlas's own throwaway
 * scripts/spikes belong in {@link CONTAINER_PLAYGROUND} instead.
 */
export const CONTAINER_AGENT_HOME = '/.atlas';

/**
 * The agent shell's `HOME` INSIDE the sandbox — a durable, host-owned, PER-REPO bind. Turns exec as the
 * host uid:gid (not root) and the image would otherwise leave `HOME` undefined, so a tool's "default"
 * config/cred/install paths (`~/.config/gcloud`, `~/.local/bin`) were neither well-defined nor persistent.
 * Binding this per-repo makes those defaults real + durable across resets and jobs, with no config override.
 * NOTE: distinct from {@link CONTAINER_AGENT_HOME} — that is the ENGINE's OWN config dir (transcripts, keyed
 * per-job; the engine sets it explicitly, not via `HOME`), so changing `HOME` never touches session resume.
 */
export const CONTAINER_HOME = '/home/atlas';

/**
 * The worktree's mount path INSIDE the sandbox — a NEUTRAL container path, NOT the host path. The host
 * worktree is bind-mounted here so the engine never sees host-shaped paths (and can tell it is boxed);
 * `cwd` is translated host→container at the runner boundary.
 */
export const CONTAINER_WORKTREE = '/workspace';

/** The repo's SHARED git common dir mount path INSIDE the sandbox (linked-worktree case only). */
export const CONTAINER_GIT_COMMON = `${CONTAINER_AGENT_HOME}/git-common`;

/**
 * The central skills store's mount path INSIDE the sandbox — the host bind-mounts ONE org's whole skills
 * subtree here (`orgSkillsRootHost`, see `skills/skill-store-paths.ts`), read-write, mirroring `/refs`
 * (read-only cross-repo reference library) but for this org's own skill dirs. `SkillResolver.resolveForTurn`
 * puts an org-agnostic `dirPath` (relative to this root) on each `ResolvedSkill`; the per-turn skills-compose
 * step in `engine-core.ts` joins it here to build write-through symlinks under `<CLAUDE_CONFIG_DIR>/skills/`.
 * Read-write (not `:ro`) because a future session-scoped edit grant (Skill P3) writes THROUGH the mount to
 * the canonical host file — enforcement is `canUseTool`-side, not a mount flag.
 */
export const CONTAINER_SKILLS_STORE = '/skills';

/**
 * The in-sandbox path of the SHARED pnpm content-addressable store — explicitly pointed here regardless
 * of which pnpm version a repo's `packageManager` field (or corepack's own resolution) ends up running,
 * via TWO mechanisms baked in the sandbox Dockerfile (verified live against both): `npm_config_store_dir`
 * for pnpm 10.x and earlier, and a global `~/.config/pnpm/config.yaml` (reached by redirecting
 * `XDG_CONFIG_HOME` to a path no bind ever shadows) for pnpm 11.x, which dropped `storeDir` from
 * `.npmrc`/env vars in favor of that file or a per-project `pnpm-workspace.yaml`. Left unset, pnpm falls
 * back to its own per-disk default — which, even with a durable `HOME` (a separate bind from `/workspace`
 * either way), still lands a LIVE store inside the worktree, which is what once made a ~1.7 GB
 * `.pnpm-store/` get swept into a commit by `git add -A`. One host dir is bound here, shared by every
 * org/repo/thread, so a dependency is fetched ONCE globally and copied from the store on every later
 * install (copy, not hardlink — the store bind is a separate device from the worktree either way).
 */
export const CONTAINER_PNPM_STORE = `${CONTAINER_AGENT_HOME}/pnpm-store`;

/**
 * Worktree-relative paths the SYSTEM already binds under {@link CONTAINER_WORKTREE} on its own, OR that
 * must never be mounted into a worktree at all. A repo's worktree config must NOT request a cache mount
 * at one of these, or (for a genuine system bind) two binds would land on the same container target and
 * Docker hard-fails container creation ("Duplicate mount point"), wedging every turn on the thread.
 * `.pnpm-store` no longer lives under `/workspace` (see {@link CONTAINER_PNPM_STORE}, now under
 * `/.atlas`) but stays reserved regardless — a repo has no legitimate reason to mount a package cache
 * into its own worktree. Reserved mounts are dropped (with a warning) both when the brain authors config
 * and when it is resolved at provision time.
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

/**
 * A cache/state directory bind-mounted into the container at `path`. `path` is EITHER worktree-relative
 * (lands at `/workspace/<path>`, the original behaviour) OR an absolute container path (an EXTERNAL mount
 * at that exact location, e.g. `/root/.config/gcloud`) — see {@link isExternalMountPath}. External targets
 * are guarded by {@link isReservedContainerPath} (can't shadow a system bind / OS root); the HOST side is
 * always a managed org/repo cache dir regardless, so no arbitrary host path is ever bound.
 */
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
export const CONTAINER_FNM_STORE = `${CONTAINER_AGENT_HOME}/fnm`;

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

/**
 * The fixed LOOPBACK port the per-sandbox MCP hub (`start_mcp_hub` in `sandbox-init.sh`) listens on. The
 * per-turn engine `docker exec` shares the container's netns, so `127.0.0.1:<port>` reaches the hub with no
 * inbound external port exposure (which sandboxes lack anyway). A constant, not a mount — see
 * `image/mcp-hub-server.ts` (the hub) + `image/user-mcp-bridge-options.ts` (the engine-side endpoints).
 */
export const MCP_HUB_PORT = 8785;

/**
 * The MCP hub's per-JOB working dir INSIDE the sandbox (pidfile `hub.pid` + `hub.log`), under the durable
 * {@link CONTAINER_AGENT_HOME} (host-writable, survives `reset_sandbox`). Already covered by the `/.atlas`
 * reserved mount — no separate bind.
 */
export const CONTAINER_MCP_HUB_DIR = `${CONTAINER_AGENT_HOME}/mcp-hub`;

/**
 * The host-written hub CONFIG the in-sandbox hub reads — the resolved union of THIS sandbox's user MCP
 * servers (secrets inlined) plus the stdio `spawn` identity block. Lands under {@link CONTAINER_AGENT_HOME}
 * (same trust boundary as the durable agent home, which already holds creds/transcripts). See
 * `image/mcp-hub-config.ts` for the shape.
 */
export const CONTAINER_MCP_HUB_CONFIG = `${CONTAINER_AGENT_HOME}/mcp-hub.json`;

/** True if a mount `path` is an ABSOLUTE container path (an external mount) vs a worktree-relative one. */
export function isExternalMountPath(path: string): boolean {
  return posix.isAbsolute(path);
}

/**
 * Container paths an EXTERNAL mount may not target — every system bind the sandbox already owns, plus the
 * OS roots that would break the box if shadowed. Declared AFTER all the `CONTAINER_*` consts so the array
 * literal doesn't hit a temporal-dead-zone at module load.
 */
export const RESERVED_CONTAINER_MOUNTS: readonly string[] = [
  CONTAINER_WORKTREE, // /workspace
  CONTAINER_AGENT_HOME, // /.atlas (covers the nested pnpm-store/fnm/git-common binds under it too)
  CONTAINER_HOME,
  CONTAINER_FNM_STORE,
  CONTAINER_CONTEXT,
  CONTAINER_GIT_COMMON,
  CONTAINER_PLAYGROUND,
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/proc', '/sys', '/dev', '/run',
];

/**
 * True if an absolute container `path` collides with a reserved location — checked as "IS, is UNDER, or is
 * an ANCESTOR of" any reserved path (so mounting `/` or `/home` — a parent of `/home/atlas` — is refused
 * too, since binding a parent would shadow the child system bind). Trailing slashes are ignored.
 */
export function isReservedContainerPath(path: string): boolean {
  const norm = (posix.normalize(path).replace(/\/+$/, '') || '/');
  if (norm === '/') return true;
  return RESERVED_CONTAINER_MOUNTS.some((r) => {
    const rr = r.replace(/\/+$/, '');
    return norm === rr || norm.startsWith(`${rr}/`) || rr.startsWith(`${norm}/`);
  });
}
