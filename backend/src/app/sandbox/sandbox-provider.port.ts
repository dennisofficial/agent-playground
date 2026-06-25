import type { FeatureSandbox } from '../git';

/** DI token for the {@link SandboxProvider}. */
export const SANDBOX_PROVIDER = Symbol('SANDBOX_PROVIDER');

/** Input to `attach` — the cut worktree plus the tenant scope (for container naming/labels/isolation). */
export interface SandboxAttachInput {
  /** The per-feature worktree the driver already cut (LocalGitService.createFeatureSandbox). */
  sandbox: FeatureSandbox;
  /** The tenant (Slack workspace / org_id) — scopes the container name, network, and labels. */
  orgId: string;
  /**
   * The owning thread (R2 per-thread sandboxes). When set, the container is keyed by thread so it is
   * STABLE across the thread's branch and across re-attach. Omit for the legacy per-feature path and
   * gate sandboxes, which stay keyed by branch (one container per branch — unchanged behavior).
   */
  threadId?: string;
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
   * Reclaim a container by its DETERMINISTIC identity (the same `orgId · repo · thread/branch` key
   * `attach` uses to name it) even when its concrete id isn't known. This is the terminal-cleanup
   * counterpart to `attach`: terminal cleanup can't rely on a persisted `container_id` because a process
   * restart nulls it while the real container keeps running — a close/delete before the thread's next
   * turn would otherwise skip teardown and orphan the container forever. Idempotent; reclaims the
   * container plus its per-sandbox network/volume, and is a no-op when nothing matches the identity.
   */
  teardownByIdentity(input: SandboxAttachInput): Promise<void>;
}
