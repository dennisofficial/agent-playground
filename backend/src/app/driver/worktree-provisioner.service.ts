import { Inject, Injectable, Logger } from '@nestjs/common';
import { LocalGitService, type FeatureSandbox } from '../git';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox';
import { PipelineAwarenessStore } from './pipeline-awareness.store';
import { WorktreeHydrator } from './worktree-hydrator.service';

export interface ProvisionAndAttachInput {
  /** The cut worktree (base+feature already in place). */
  sandbox: FeatureSandbox;
  /** Tenant org id. */
  orgId: string;
  /** Owning thread — every provisioned sandbox is per-thread (the gate attaches directly, not here). */
  threadId: string;
  /** The repo's uuid (`repos.id`) — required to resolve secret grants. Absent → no secrets. */
  repoDbId?: string;
  /** Last hydration signature (thread sandboxes persist it). Re-hydrate only when it changes. */
  knownSig?: string;
  /** Force a (re-)hydration regardless of `knownSig` — e.g. a freshly cut / restored worktree. */
  forceHydrate?: boolean;
  /**
   * The owning thread is an ONBOARDING thread (`kind='onboarding'`) → skip secret rendering so its
   * worktree never holds a real secret value (mounts/seed still apply). See {@link WorktreeHydrator}.
   */
  isOnboarding?: boolean;
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
    private readonly awareness: PipelineAwarenessStore,
    private readonly git: LocalGitService,
    @Inject(SANDBOX_PROVIDER) private readonly sandboxProvider: SandboxProvider,
  ) {}

  async provisionAndAttach(input: ProvisionAndAttachInput): Promise<ProvisionAndAttachResult> {
    const { sandbox, orgId, threadId, repoDbId } = input;
    const worktreePath = sandbox.worktreePath;

    // Ignore package-manager / build caches at the clone level so `commitAll`'s `git add -A` can never
    // sweep a multi-GB package store into a PR (a safety net beneath the relocated shared store).
    // Idempotent + fail-soft.
    await this.git.ensureBuildJunkExcluded(worktreePath);

    // Mounts are cheap to (re)compute and must be passed on EVERY attach (a cold recreate needs them).
    const mounts = this.hydrator.resolveMounts(worktreePath);

    // File hydration is gated: re-run only when the manifest/secret/grant signature changed, or when
    // forced (a freshly cut or restored worktree has no files yet).
    const hydrationSig = await this.hydrator.computeSig(worktreePath, orgId, repoDbId);
    if (input.forceHydrate || hydrationSig !== input.knownSig) {
      const { notices } = await this.hydrator.hydrateFiles({
        worktreePath,
        slug: sandbox.repoId,
        orgId,
        repoDbId,
        ...(input.isOnboarding ? { skipSecrets: true } : {}),
      });
      // Surface a bad/incomplete `.atlas/worktree.json` to the OPERATOR (it never errors the build). The
      // passive-awareness marker is drained into the next operator turn so the brain can relay it — no
      // wake, no spam (this only fires on a (re)hydration, i.e. at thread creation or a config change).
      if (notices.length) {
        await this.awareness
          .appendMarker(threadId, {
            id: 'worktree-hydration-issues',
            text: `⚠ .atlas/worktree.json — ${notices.length} issue(s): ${notices.join('; ')}`,
            at: new Date().toISOString(),
          })
          .catch((err) => this.logger.debug(`worktree notice append failed (continuing): ${err}`));
      }
    }

    const attached = await this.sandboxProvider.attach({
      sandbox,
      orgId,
      mounts,
      threadId,
      ...(repoDbId ? { repoDbId } : {}),
    });
    return { sandbox: attached, hydrationSig };
  }
}
