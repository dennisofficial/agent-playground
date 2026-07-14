import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  detectInstallCommand,
  renderInstallAwareness,
  type InstallMatch,
} from '../prompt-kit/jit/install-awareness';
import { WorkspaceConfigStore } from '../onboarding/workspace-config.store';
import { WorkspaceProfileService } from './workspace-profile.service';
import { INSTALL_AWARENESS_FILTER, type InstallAwarenessFilter } from './install-awareness-filter';

/**
 * The host round-trip handler for the install-awareness nudge (decisions d1/d2). Detects a
 * profile-relevant install/remove in a Bash command, dedups it against the per-repo `profile_seen_tooling`
 * ledger, and — on a real state TRANSITION only (null otherwise: either not an install, or a steady-state
 * repeat already deduped) — renders the deterministic Stage-1 checklist and hands it to the optional
 * Stage-2 Haiku filter/enricher, which may suppress it (pure noise) or attach one specific suggestion.
 *
 * Fail-silent end-to-end (decision d1): `handle` never throws — any error degrades to "no nudge", never to a
 * failed/blocked tool call. Stage 2 is itself fail-open (see `applyFilter`): unavailable, kill-switched, or
 * erroring all fall through to the plain Stage-1 text, so the mechanism fully works with Stage 2 disabled.
 */
@Injectable()
export class ProfileAwarenessService {
  private readonly logger = new Logger(ProfileAwarenessService.name);

  constructor(
    private readonly configStore: WorkspaceConfigStore,
    // Both optional: `WorkspaceProfileModule` always provides them, but narrower test modules (the Stage-1
    // int tests) construct `ProfileAwarenessService` without them — Stage 2 simply stays off in that case,
    // identical to the kill-switch/no-key fallback.
    @Optional() private readonly profile?: WorkspaceProfileService,
    @Optional() @Inject(INSTALL_AWARENESS_FILTER) private readonly filter?: InstallAwarenessFilter,
  ) {}

  /** Returns the nudge text to inject via `additionalContext`, or null to suppress. Never throws. */
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

      // The ledger transition is already committed above — Stage 2 only ever affects whether/how the
      // text is SHOWN, never whether the tool is recorded as seen (decision d2's "record-then-filter").
      const text = renderInstallAwareness(match);
      return await this.applyFilter(input.orgId, input.repoId, match, text);
    } catch (err) {
      this.logger.warn(
        `handle: swallowed error for org=${input.orgId} repo=${input.repoId} job=${input.jobId} — ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Stage 2 (decision d2): a read-only Haiku pass over the already-decided Stage-1 text. Self-contained
   * try/catch so a Stage-2 hiccup degrades to the Stage-1 text rather than bubbling into `handle`'s
   * catch-all (which would otherwise turn a Stage-2 blip into a fully suppressed nudge instead of a
   * Stage-1 one).
   */
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
      const verdict = await this.filter.filter({ orgId, match, profileBlock });
      if (!verdict) return text; // no key / error / timeout → fail-open to Stage 1
      if (verdict.suppress) return null; // filtered out as noise
      return verdict.suggestion.trim() ? `${text}\n\nSuggestion: ${verdict.suggestion.trim()}` : text;
    } catch (err) {
      this.logger.warn(
        `applyFilter: swallowed Stage-2 error for org=${orgId} repo=${repoId} — ${err instanceof Error ? err.message : String(err)}`,
      );
      return text;
    }
  }
}
