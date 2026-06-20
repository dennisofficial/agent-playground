import type { FeatureSandbox } from '../git';

/** DI token for the {@link SandboxProvider}. */
export const SANDBOX_PROVIDER = Symbol('SANDBOX_PROVIDER');

/** Input to `attach` — the cut worktree plus the tenant scope (for container naming/labels/isolation). */
export interface SandboxAttachInput {
  /** The per-feature worktree the driver already cut (LocalGitService.createFeatureSandbox). */
  sandbox: FeatureSandbox;
  /** The tenant (Slack workspace / team_id) — scopes the container name, network, and labels. */
  teamId: string;
}

/**
 * The SANDBOX_PROVIDER port — where a feature's turns execute. Two bindings, chosen by
 * `ATLAS_SANDBOX_MODE`:
 *  - `LocalSandboxProvider` ('local', default): a no-op — turns run in-process against the host
 *    worktree (today's behavior, byte-identical).
 *  - `SandboxManager` ('docker'): ensures a long-lived, network-isolated, privileged per-feature
 *    container with the worktree bind-mounted at /work, and returns the sandbox augmented with the
 *    `containerId`/`execUser` the `DockerEngineRunner` execs turns into.
 *
 * `attach` is idempotent (a resume reuses the existing container). The driver calls it once per job
 * right after cutting the worktree; the returned `FeatureSandbox` flows unchanged through the rest of
 * the pipeline (turns, auto-fix), so only this one call differs between modes.
 */
export interface SandboxProvider {
  attach(input: SandboxAttachInput): Promise<FeatureSandbox>;
  teardown(sandbox: FeatureSandbox): Promise<void>;
}
