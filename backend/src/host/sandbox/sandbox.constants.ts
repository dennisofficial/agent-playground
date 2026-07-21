export const LABEL_ORG = 'atlas.io/org';
export const LABEL_JOB = 'atlas.io/job';
export const POD_NAME_PREFIX = 'sbx-';

/** The engine container (the exec target). Kept idle between turns; each turn execs into it. */
export const MAIN_CONTAINER = 'main';

/**
 * The one-shot cold-boot container: runs the repo's workspace-profile setup script ONLY (the clone happens
 * host-side, before the pod). Omitted entirely when no setup script is configured. NOT gated — the setup
 * script runs on every sandbox (re)start, since repos rely on per-boot setup work.
 */
export const SETUP_CONTAINER = 'setup';

/**
 * The repo worktree, and ONLY the repo — this path must stay Atlas-agnostic (it's the user's project; the
 * agent `cd`s here and it maps 1:1 to the cloned repo). NO Atlas artifacts ever land here. Durable across
 * reaps (its host backing is a per-job subdir of $ATLAS_DATA).
 */
export const WORK_MOUNT = '/workspace';

/** The `work` volume; its host backing is a per-job subdir of $ATLAS_DATA (durable across reaps). */
export const WORK_VOLUME = 'work';

/**
 * Atlas-owned per-job scratch, mounted OUTSIDE {@link WORK_MOUNT} so no Atlas bookkeeping ever pollutes the
 * repo. Durable across reaps (host backing `$ATLAS_DATA/state/<jobId>`) — the same host dir that holds the
 * host-side `cloned` sentinel, kept as the reserved out-of-worktree scratch mount for in-pod Atlas metadata.
 */
export const ATLAS_STATE_VOLUME = 'atlas-state';
export const ATLAS_STATE_MOUNT = '/atlas';

/**
 * A dedicated volume for the inner dockerd's `/var/lib/docker`. Kept OFF the container root layer so
 * `overlay2` is viable (the entrypoint auto-detects overlay2 vs vfs by the fs under this mount). Ephemeral
 * emptyDir — image layers re-pull on a cold boot; the worktree durability that matters lives on `work`.
 */
export const DOCKER_STORAGE_VOLUME = 'docker-storage';
export const DOCKER_STORAGE_MOUNT = '/var/lib/docker';

/**
 * The engine turn launcher baked into the sandbox image; the host execs it per turn (see launchEngineTurn).
 * Deliberately an ABSOLUTE path OFF $PATH (libexec/ → /usr/local/lib/atlas in the Dockerfile) so the
 * in-sandbox agent's Bash tool can't discover it and recursively spawn an engine turn inside its own sandbox.
 */
export const ENGINE_ENTRYPOINT = '/usr/local/lib/atlas/atlas-engine-turn';

/**
 * Wrapper baked into the sandbox image that renices agent-spawned work below the engine. Claude Code runs
 * every Bash tool command through it via the `CLAUDE_CODE_SHELL_PREFIX` env var (an official harness seam:
 * `bashProvider.buildExecCommand` prepends it to every command), so a `pnpm build` / vitest run can't starve
 * the engine's token stream. The engine process itself keeps default priority — it never routes through here.
 */
export const SHELL_PREFIX_WRAPPER = '/usr/local/bin/atlas-classify';

/**
 * Resource envelope proven sufficient by the S2a spike (ran every DinD proof, incl. nested k3s, on one
 * k3d node). Constant infra tuning — lives in code, not env.
 *
 * The CPU **request** is the pod's guaranteed floor under node contention (kubelet maps it to cgroup
 * weight): when many sandboxes pack a node and their builds saturate it, this is the slice the engine's
 * stream is guaranteed regardless. Sized above bare idle (250m) so streaming stays smooth even when the
 * burst headroom up to the limit is contended away. The limit stays high for build bursts.
 */
export const POD_RESOURCES = {
  requests: { cpu: '750m', memory: '1Gi' },
  limits: { cpu: '2', memory: '4Gi' },
};

export const LEASE_TTL_S = 30 * 60;
