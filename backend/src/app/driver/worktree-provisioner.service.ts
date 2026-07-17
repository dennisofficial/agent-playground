import { Inject, Injectable, Logger } from '@nestjs/common';
import { type FeatureSandbox } from '../git';
import { McpResolver } from '../mcp';
import { WorkspaceConfigStore } from '../onboarding';
import { SANDBOX_PROVIDER, type SandboxMilestoneStage, type SandboxProvider } from '../sandbox';
import { WorktreeHydrator } from './worktree-hydrator.service';

export interface ProvisionAndAttachInput {
  /** The cut worktree (base+feature already in place). */
  sandbox: FeatureSandbox;
  /** Tenant org id. */
  orgId: string;
  /** Owning thread — every provisioned sandbox is per-thread (the gate attaches directly, not here). */
  jobId: string;
  /** The repo's uuid (`repos.id`) — required to resolve secret grants. Absent → no secrets. */
  repoDbId?: string;
  /** Last hydration signature (thread sandboxes persist it). Re-hydrate only when it changes. */
  knownSig?: string;
  /** Force a (re-)hydration regardless of `knownSig` — e.g. a freshly cut / restored worktree. */
  forceHydrate?: boolean;
  /** Threaded straight through to `SandboxProvider.attach()` — see `SandboxAttachInput.onMilestone`. */
  onMilestone?: (stage: SandboxMilestoneStage) => void;
}

export interface ProvisionAndAttachResult {
  sandbox: FeatureSandbox;
  /** The current hydration signature — callers with a sandbox row persist this on it. */
  hydrationSig: string;
}

/**
 * THE single seam that turns a cut worktree into an attached, hydrated sandbox. `JobLifecycleService`
 * routes thread sandboxes through here instead of calling `SANDBOX_PROVIDER.attach` directly, so worktree
 * hydration + cache mounts are applied uniformly and can never be forgotten. (The acceptance gate attaches
 * directly — it has no org/grants and can't hydrate a tenant secret, so it deliberately skips this seam.)
 *
 * It lives on the driver side (which already consumes `SANDBOX_PROVIDER` and can inject the git +
 * onboarding stores) so `SandboxManager` stays a low-level mount-applier that never resolves
 * secrets/grants — avoiding the SandboxModule → git/onboarding circular dependency.
 */
@Injectable()
export class WorktreeProvisioner {
  private readonly logger = new Logger(WorktreeProvisioner.name);

  constructor(
    private readonly hydrator: WorktreeHydrator,
    private readonly config: WorkspaceConfigStore,
    private readonly mcp: McpResolver,
    @Inject(SANDBOX_PROVIDER) private readonly sandboxProvider: SandboxProvider,
  ) {}

  async provisionAndAttach(input: ProvisionAndAttachInput): Promise<ProvisionAndAttachResult> {
    const { sandbox, orgId, jobId, repoDbId } = input;
    const worktreePath = sandbox.worktreePath;

    // NOTE: build-junk exclusion (a host-managed `info/exclude`) was removed with the writer-owns-commits
    // change — writers now own `.gitignore` and stage their own work, so the host no longer pre-empts junk
    // for an automatic `git add -A` it no longer runs. The pnpm store is pinned outside the worktree
    // (`CONTAINER_PNPM_STORE`), so the original multi-GB footgun is already fixed at its root.

    // One-time, best-effort: import an already-onboarded repo's committed legacy manifest into the DB the
    // first time it's seen with zero config rows (see docs/adr/0003) — never blocks provisioning.
    if (repoDbId) {
      await this.config
        .importLegacyIfEmpty(orgId, repoDbId, worktreePath)
        .catch((err) =>
          this.logger.debug(`legacy workspace config import skipped (continuing): ${err}`),
        );
    }

    // Mounts are cheap to (re)compute and must be passed on EVERY attach (a cold recreate needs them).
    const mounts = repoDbId ? await this.hydrator.resolveMounts(orgId, repoDbId, worktreePath) : [];

    // The repo's cold-boot setup script — resolved like the mounts and passed on EVERY attach; `attach` runs it
    // only on a COLD bring-up and folds its hash into the recreate fingerprint. Failures ride back on the
    // returned sandbox (`setupScriptResult`); `JobLifecycleService` stamps them + wakes the brain (this
    // provisioner has no brain access, so it never surfaces them itself).
    const setupScript = repoDbId ? await this.config.getSetupScript(orgId, repoDbId) : null;

    // File hydration is gated: re-run only when the manifest/secret/grant signature changed, or when
    // forced (a freshly cut or restored worktree has no files yet).
    const hydrationSig = await this.hydrator.computeSig(worktreePath, orgId, repoDbId);
    if (input.forceHydrate || hydrationSig !== input.knownSig) {
      await this.hydrator.hydrateFiles({
        worktreePath,
        orgId,
        repoDbId,
      });
    }

    const attached = await this.sandboxProvider.attach({
      sandbox,
      orgId,
      mounts,
      setupScript,
      jobId,
      onMilestone: input.onMilestone,
      ...(repoDbId ? { repoDbId } : {}),
    });

    // Push the sandbox's user MCP servers to the persistent per-sandbox hub (connect once per sandbox, not
    // once per turn). Best-effort: writes the config even if the container's still coming up (the hub reads
    // it on boot), never blocks or fails provisioning. NOTE: MCP servers are scoped by the repo UUID
    // (`mcp_servers.scope`), so resolve by `repoDbId` — NOT `sandbox.repoId`, which is the slug-valued
    // container/worktree name (see SandboxProvider.repoId doc). Passing the slug silently resolves to `[]`.
    if (repoDbId && this.sandboxProvider.kickMcpHubRefresh) {
      const servers = await this.mcp.resolveForSandbox(orgId, repoDbId).catch(() => []);
      void this.sandboxProvider
        .kickMcpHubRefresh({ jobId, servers })
        .catch((err) => this.logger.debug(`mcp-hub refresh kick skipped (continuing): ${err}`));
    }

    return { sandbox: attached, hydrationSig };
  }
}
