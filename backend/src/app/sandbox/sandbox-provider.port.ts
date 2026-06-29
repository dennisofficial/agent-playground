import type { FeatureSandbox } from '../git';

/** DI token for the {@link SandboxProvider}. */
export const SANDBOX_PROVIDER = Symbol('SANDBOX_PROVIDER');

/**
 * A cache/state directory to bind-mount into the container under the worktree (e.g. `.cocoindex`,
 * `node_modules/.cache`). Declared here (not imported from the driver's manifest types) so the sandbox
 * layer takes no dependency on the driver — the `WorktreeProvisioner` passes already-validated specs.
 * `per-thread` = its own host dir (no cross-thread write contention); `shared-ro` = one immutable host
 * dir mounted read-only into every thread. There is deliberately no shared read-write mode.
 */
export interface SandboxMount {
  /** Worktree-relative path (already path-guarded by the provisioner). */
  path: string;
  mode: 'per-thread' | 'shared-ro';
}

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
  threadId?: string;
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
   * container at `/context`). Outside the worktree, keyed by `threadId`, durable across container
   * recreate. The brain authors plan/track specs here and reads them back via this path.
   */
  contextDirHost(orgId: string, threadId: string): string;
  /**
   * The HOST path of a thread BRAIN session's Claude transcript root (`<brainHome>/claude/projects`),
   * located by `threadId`. Survives container reaping (host side of the agent-home bind), so crash
   * recovery can read a turn that completed in the container but was never persisted to `messages`.
   * Null when nothing is on disk for the thread yet.
   */
  brainTranscriptProjectsDir(threadId: string): string | null;
  /**
   * Reclaim a container by its DETERMINISTIC identity (the same `orgId · repo · thread/branch` key
   * `attach` uses to name it) even when its concrete id isn't known. This is the terminal-cleanup
   * counterpart to `attach`: terminal cleanup can't rely on a persisted `container_id` because a process
   * restart nulls it while the real container keeps running — a close/delete before the thread's next
   * turn would otherwise skip teardown and orphan the container forever. Idempotent; reclaims the
   * container plus its per-sandbox network/volume, and is a no-op when nothing matches the identity.
   */
  teardownByIdentity(input: SandboxAttachInput): Promise<void>;
}
