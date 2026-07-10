import type { FeatureSandbox } from '../git';
import type { ResolvedMcpServer } from '../engine/engine.types';

/** DI token for the {@link SandboxProvider}. */
export const SANDBOX_PROVIDER = Symbol('SANDBOX_PROVIDER');

/**
 * A genuinely slow `attach()` sub-step worth narrating to whoever's waiting on the sandbox: a real image
 * rebuild (`'image_build'`, not the fast label-match skip), or a cold container create (`'container_create'`,
 * not a warm reuse / restart-a-stopped-container). Deliberately NOT exhaustive — mount resolution, network
 * create, the ready-wait poll etc. are sub-second-to-a-few-seconds and stay silent, as today.
 */
export type SandboxMilestoneStage = 'image_build' | 'container_create';

/**
 * A cache/state directory to bind-mount into the container under the worktree (e.g. `.venv`,
 * `node_modules/.cache`). Declared here (not imported from the driver's manifest types) so the sandbox
 * layer takes no dependency on the driver — the `WorktreeProvisioner` passes already-validated specs.
 * `per-thread` = its own host dir (no cross-thread write contention); `shared-ro` = one immutable host
 * dir mounted read-only into every thread; `shared-rw` = one PER-REPO host dir mounted read-write across
 * all of a repo's sandboxes (persistent auth STATE like `.gcloud` — the rare concurrent-refresh race is
 * accepted; see sandbox/container-paths.ts and onboarding/workspace-config.store.ts).
 */
export interface SandboxMount {
  /**
   * The bind target, already path-guarded by the provisioner. EITHER worktree-relative (lands at
   * `/workspace/<path>`) OR an absolute container path (an EXTERNAL mount at that exact location, guarded
   * against system binds / OS roots — see `isReservedContainerPath` in `sandbox/container-paths.ts`). The
   * HOST side is always a managed org/repo cache dir; only the container target varies.
   */
  path: string;
  mode: 'per-thread' | 'shared-ro' | 'shared-rw';
}

/**
 * The result of probing a job's container for which supervised processes are alive RIGHT NOW. A
 * discriminated union so "we couldn't tell" (`unknown`) is distinct from "the container is gone, so
 * everything is stopped" (`down`) — the caller must never conflate them (a transient probe failure
 * must not flip a running service to stopped). On `up`, `containerStartedAt` is the current
 * PID-namespace generation marker (Docker `State.StartedAt`): a process whose own marker predates it
 * is from a previous container and is dead regardless of PID reuse, so the caller gates on it before
 * trusting `alive`.
 */
export type ServiceLivenessProbe =
  | { status: 'unknown' }
  | { status: 'down' }
  | { status: 'up'; containerStartedAt: string; alive: number[] };

/** Input to `attach` — the cut worktree plus the tenant scope (for container naming/labels/isolation). */
export interface SandboxAttachInput {
  /** The per-feature worktree the driver already cut (LocalGitService.createFeatureSandbox). */
  sandbox: FeatureSandbox;
  /** The tenant org_id — scopes the gate sandbox's container name, network, and labels. */
  orgId: string;
  /**
   * The owning thread. When set (every product sandbox), the container is keyed by thread alone
   * (`atlas-sbx-thread-<id>`) so it is STABLE across the thread's branch and across re-attach. Omitted
   * only by the acceptance gate, whose sandbox stays keyed by org+repo+branch (one container per branch).
   */
  jobId?: string;
  /**
   * The repo's uuid (`repos.id`) — carried separately from the slug-valued `sandbox.repoId`. Used by the
   * provisioner for grant resolution; not needed by `attach` itself but threaded through for parity.
   */
  repoDbId?: string;
  /**
   * Validated cache mounts to bind under the worktree. The provisioner resolves these from the repo's
   * `.atlas/worktree.json`; `attach` only applies them (picks host dirs, pre-creates + chowns the
   * in-worktree mountpoints, and folds them into the recreate fingerprint).
   */
  mounts?: SandboxMount[];
  /**
   * The repo's cold-boot setup script, resolved by the `WorktreeProvisioner` from the repo's DB config
   * (`repos.setup_script`). `attach` runs it ONLY on a COLD bring-up (fresh create / restart-from-stopped),
   * never on a warm reuse, and folds its hash into the recreate fingerprint so an edited script recreates a
   * warm container. Opaque text — the sandbox layer takes no dependency on the store. Absent/empty → no step.
   */
  setupScript?: string | null;
  /**
   * Optional callback fired ONLY on genuinely slow attach sub-steps (see {@link SandboxMilestoneStage}) —
   * never on the common warm/fast path. A plain function param (not DI), so this low-level infra module
   * takes no dependency on the message store; the caller (ultimately `AgentSessionManager`) decides what
   * to do with it. Omitted by the acceptance gate (no thread/chat surface exists there).
   */
  onMilestone?: (stage: SandboxMilestoneStage) => void;
}

/**
 * The outcome of running a repo's cold-boot {@link SandboxAttachInput.setupScript}. Set on the returned
 * `FeatureSandbox` (transient, never persisted) only when a script actually ran (a cold attach). `tail` is
 * the last chunk of combined stdout+stderr for surfacing the failure to the brain; a timeout / exec error is
 * reported as `ok:false` with `exitCode:-1` rather than throwing.
 */
export interface SetupScriptResult {
  ok: boolean;
  exitCode: number;
  tail: string;
}

/**
 * The SANDBOX_PROVIDER port — where a feature's turns execute. Always bound to `SandboxManager`:
 * ensures a long-lived, network-isolated, privileged per-feature container with the worktree
 * bind-mounted at /workspace, and returns the sandbox augmented with the `containerId`/`execUser` the
 * `DockerEngineRunner` execs turns into. Docker is the only execution mode.
 *
 * `attach` is idempotent (a resume reuses the existing container). The driver calls it once per job
 * right after cutting the worktree; the returned `FeatureSandbox` flows unchanged through the rest of
 * the pipeline (turns, auto-fix).
 */
export interface SandboxProvider {
  attach(input: SandboxAttachInput): Promise<FeatureSandbox>;
  teardown(sandbox: FeatureSandbox): Promise<void>;
  /**
   * The HOST path of a thread's durable `/context` shared folder (the same dir bind-mounted into the
   * container at `/context`). Outside the worktree, keyed by `jobId`, durable across container
   * recreate. The brain authors plan/thread specs here and reads them back via this path.
   */
  contextDirHost(orgId: string, jobId: string): string;
  /**
   * The HOST path of a job's durable `/playground` scratch folder (the same dir bind-mounted into the
   * container at `/playground`). Outside the worktree, keyed by `jobId`, durable across container
   * recreate. Atlas's freeform scratch pad; reclaimed by `JobLifecycleService.deleteJobDeep`.
   */
  playgroundDirHost(orgId: string, jobId: string): string;
  /**
   * The HOST path of a thread BRAIN session's Claude transcript root (`<brainHome>/claude/projects`),
   * located by `jobId`. Survives container reaping (host side of the agent-home bind), so crash
   * recovery can read a turn that completed in the container but was never persisted to `messages`.
   * Null when nothing is on disk for the thread yet.
   */
  brainTranscriptProjectsDir(jobId: string): string | null;
  /**
   * The HOST path of a thread's `atlas-svc` supervisor dir (markers + captured logs for processes the
   * agent started via `atlas-svc run`). Same durability as {@link brainTranscriptProjectsDir}. Null when
   * the thread has no sandbox home on disk yet.
   */
  supervisorDirHost(jobId: string): string | null;
  /**
   * Probe a job's container for which of the given supervised process-groups (`pgids`, read from the
   * durable markers) are actually alive right now. Runs the same `kill -0` liveness test `atlas-svc`
   * uses, execed INTO the container (the host can't see its PID namespace). Never throws — any failure
   * (no container, exec error) resolves to a `status` the caller maps to `unknown`/`stopped`, never a
   * false `running`. See {@link ServiceLivenessProbe} for the generation-gate contract.
   */
  probeLiveness(jobId: string, pgids: number[]): Promise<ServiceLivenessProbe>;
  /**
   * Reclaim a container by its DETERMINISTIC identity (the same `orgId · repo · thread/branch` key
   * `attach` uses to name it) even when its concrete id isn't known. This is the terminal-cleanup
   * counterpart to `attach`: terminal cleanup can't rely on a persisted `container_id` because a process
   * restart nulls it while the real container keeps running — a close/delete before the thread's next
   * turn would otherwise skip teardown and orphan the container forever. Idempotent; reclaims the
   * container plus its per-sandbox network/volume, and is a no-op when nothing matches the identity.
   */
  teardownByIdentity(input: SandboxAttachInput): Promise<void>;
  /**
   * Reclaim FULLY ORPHANED per-sandbox artifacts — `-net` networks and `-dind` volumes whose owning container
   * no longer exists (leaks from crashes / `kill -9` / a swallowed `removeNetwork` "active endpoints" race, or
   * the restart path that nulls `container_id` while the real container keeps its network). Never touches an
   * artifact attached to a live container OR one whose create is still in flight. Best-effort; returns counts
   * reclaimed. Optional on the port so test fakes needn't implement it; `SandboxManager` (the only real
   * binding) always does. Scheduled by the driver's leader-gated reap timer + once on leadership acquisition.
   */
  reapOrphanedArtifacts?(): Promise<{ networks: number; volumes: number }>;
  /**
   * Pipe a value into a path inside a thread's LIVE container over exec stdin (never argv/env, so it can't
   * leak into `docker inspect`/process lists), bounded by `timeoutMs`. The delivery lane for EPHEMERAL
   * secrets (an OAuth code, a 2FA code): the target is typically a FIFO the brain wired a waiting process to
   * read. Returns `{ ok:false, reason }` when the container isn't running or the write times out (a dead
   * reader blocks the FIFO open) — the caller restarts the flow rather than wedging. Optional on the port so
   * test fakes needn't implement it; `SandboxManager` (the only real binding) always does.
   */
  writeToJobContainerPath?(input: {
    jobId: string;
    path: string;
    value: string;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; reason?: string }>;

  /**
   * Push the sandbox's user MCP servers to the persistent per-sandbox MCP HUB: write the resolved UNION
   * (secrets inlined) to the durable `/.atlas` config + `SIGHUP` the hub so it (re)connects once per sandbox
   * instead of once per turn. Called at provision (create / reset / warm re-attach) by `WorktreeProvisioner`.
   * Best-effort: writes even before the container is running (the hub reads it on boot), never throws.
   * Optional on the port so test fakes needn't implement it.
   */
  kickMcpHubRefresh?(input: { jobId: string; servers: ResolvedMcpServer[] }): Promise<void>;

  /**
   * The DETERMINISTIC container name of a thread's sandbox (`atlas-sbx-thread-<jobId>`) — the host the
   * preview reverse-proxy dials as its upstream. Derived from the same naming scheme `attach` uses, so it
   * resolves without a live container lookup.
   */
  sandboxContainerName(jobId: string): string;

  /**
   * Connect the Caddy container into this sandbox's isolated `-net` so the reverse proxy can reach the
   * dev-server upstream by container name. Idempotent (an already-connected Caddy resolves quietly) and a
   * feature-gated no-op when preview exposure is disabled.
   */
  bridgeCaddyToSandbox(jobId: string): Promise<void>;

  /**
   * Disconnect the Caddy container from this sandbox's `-net` — the inverse of {@link bridgeCaddyToSandbox}.
   * Idempotent (a Caddy not on the net resolves quietly); feature-gated no-op when exposure is disabled.
   */
  unbridgeCaddyFromSandbox(jobId: string): Promise<void>;

  /** The jobIds of every currently-RUNNING managed thread sandbox — the set the reconciler sweeps. */
  listLiveThreadJobIds(): Promise<string[]>;
}
