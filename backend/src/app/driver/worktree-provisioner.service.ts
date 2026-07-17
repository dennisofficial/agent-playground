import { Inject, Injectable, Logger } from '@nestjs/common';
import { FeatureSandbox } from '../git/local-git.service';
import { McpResolver } from '../mcp/mcp-resolver.service';
import { WorkspaceConfigStore } from '../onboarding/workspace-config.store';
import {
  SANDBOX_PROVIDER,
  SandboxMilestoneStage,
  type SandboxProvider,
} from '../sandbox/sandbox-provider.port';
import { PipelineAwarenessStore } from './pipeline-awareness.store';
import { WorktreeHydrator } from './worktree-hydrator.service';

export interface ProvisionAndAttachInput {
  sandbox: FeatureSandbox;
  orgId: string;
  jobId: string;
  repoDbId?: string;
  knownSig?: string;
  forceHydrate?: boolean;
  onMilestone?: (stage: SandboxMilestoneStage) => void;
}

export interface ProvisionAndAttachResult {
  sandbox: FeatureSandbox;
  hydrationSig: string;
}

@Injectable()
export class WorktreeProvisioner {
  private readonly logger = new Logger(WorktreeProvisioner.name);

  constructor(
    private readonly hydrator: WorktreeHydrator,
    private readonly awareness: PipelineAwarenessStore,
    private readonly config: WorkspaceConfigStore,
    private readonly mcp: McpResolver,
    @Inject(SANDBOX_PROVIDER) private readonly sandboxProvider: SandboxProvider,
  ) {}

  async provisionAndAttach(input: ProvisionAndAttachInput): Promise<ProvisionAndAttachResult> {
    const { sandbox, orgId, jobId, repoDbId } = input;
    const worktreePath = sandbox.worktreePath;


    if (repoDbId) {
      await this.config
        .importLegacyIfEmpty(orgId, repoDbId, worktreePath)
        .catch((err) =>
          this.logger.debug(`legacy workspace config import skipped (continuing): ${err}`),
        );
    }

    const mounts = repoDbId ? await this.hydrator.resolveMounts(orgId, repoDbId, worktreePath) : [];

    const setupScript = repoDbId ? await this.config.getSetupScript(orgId, repoDbId) : null;

    const hydrationSig = await this.hydrator.computeSig(worktreePath, orgId, repoDbId);
    if (input.forceHydrate || hydrationSig !== input.knownSig) {
      const { notices } = await this.hydrator.hydrateFiles({
        worktreePath,
        orgId,
        repoDbId,
      });
      if (notices.length) {
        await this.awareness
          .appendMarker(jobId, {
            id: 'worktree-hydration-issues',
            text: `⚠ workspace config — ${notices.length} issue(s): ${notices.join('; ')}`,
            at: new Date().toISOString(),
          })
          .catch((err) => this.logger.debug(`worktree notice append failed (continuing): ${err}`));
      }
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

    if (repoDbId && this.sandboxProvider.kickMcpHubRefresh) {
      const servers = await this.mcp.resolveForSandbox(orgId, repoDbId).catch(() => []);
      void this.sandboxProvider
        .kickMcpHubRefresh({ jobId, servers })
        .catch((err) => this.logger.debug(`mcp-hub refresh kick skipped (continuing): ${err}`));
    }

    return { sandbox: attached, hydrationSig };
  }
}
