import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  detectInstallCommand,
  renderInstallAwareness,
  type InstallMatch,
} from '@shared/prompt-kit/jit/install-awareness';
import { WorkspaceConfigStore } from '../onboarding/workspace-config.store';
import { INSTALL_AWARENESS_FILTER, type InstallAwarenessFilter } from './install-awareness-filter';
import {
  WorkspaceProfileService,
  type WorkspaceProfileSnapshot,
} from './workspace-profile.service';

@Injectable()
export class ProfileAwarenessService {
  private readonly logger = new Logger(ProfileAwarenessService.name);

  constructor(
    private readonly configStore: WorkspaceConfigStore,
    @Optional() private readonly profile?: WorkspaceProfileService,
    @Optional()
    @Inject(INSTALL_AWARENESS_FILTER)
    private readonly filter?: InstallAwarenessFilter,
  ) {}

  async handle(input: {
    orgId: string;
    repoId: string;
    jobId: string;
    sessionType: string;
    command: string;
  }): Promise<string | null> {
    try {
      const match = detectInstallCommand(input.command);
      if (!match) return null;

      const fired = await this.configStore.applyToolingTransition(input.orgId, input.repoId, match);
      if (!fired) return null; // repeat / no transition — deduped (ledger untouched)

      const text = renderInstallAwareness(match);
      return await this.applyFilter(input.orgId, input.repoId, match, text);
    } catch (err) {
      this.logger.warn(
        `handle: swallowed error for org=${input.orgId} repo=${input.repoId} job=${input.jobId} — ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async applyFilter(
    orgId: string,
    repoId: string,
    match: InstallMatch,
    text: string,
  ): Promise<string | null> {
    if (!this.filter || !this.profile) return text; // Stage 2 disabled/unavailable → Stage 1 only

    try {
      const snapshot = await this.profile.describe(orgId, repoId);
      const profileBlock = this.profile.render(snapshot);
      const renderSkill = (s: WorkspaceProfileSnapshot['skills'][number]): string =>
        `${s.name} (${s.tier}${s.enabled ? '' : ', disabled'}) — ${s.description}`;
      const catalog = snapshot.skills.length
        ? snapshot.skills.map(renderSkill).join('\n')
        : undefined;
      const verdict = await this.filter.filter({
        orgId,
        match,
        profileBlock,
        catalog,
      });
      if (!verdict) return text; // no key / error / timeout → fail-open to Stage 1
      if (verdict.suppress) return null; // filtered out as noise
      return verdict.suggestion.trim()
        ? `${text}\n\nSuggestion: ${verdict.suggestion.trim()}`
        : text;
    } catch (err) {
      this.logger.warn(
        `applyFilter: swallowed Stage-2 error for org=${orgId} repo=${repoId} — ${err instanceof Error ? err.message : String(err)}`,
      );
      return text;
    }
  }
}
