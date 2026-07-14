import { Injectable, Logger } from '@nestjs/common';
import { detectInstallCommand, renderInstallAwareness } from '../prompt-kit/jit/install-awareness';
import { WorkspaceConfigStore } from '../onboarding/workspace-config.store';

/**
 * The host round-trip handler for the install-awareness nudge (Stage 1, decision d1). Detects a
 * profile-relevant install/remove in a Bash command, dedups it against the per-repo `profile_seen_tooling`
 * ledger, and returns the deterministic Stage-1 checklist on a real state TRANSITION only (null otherwise —
 * either not an install, or a steady-state repeat already deduped).
 *
 * Fail-silent end-to-end (decision d1): `handle` never throws — any error degrades to "no nudge", never to a
 * failed/blocked tool call. Thread 3 adds a read-only Haiku filter/enrich stage in front of this method's
 * return value; this thread ships Stage 1 only.
 */
@Injectable()
export class ProfileAwarenessService {
  private readonly logger = new Logger(ProfileAwarenessService.name);

  constructor(private readonly configStore: WorkspaceConfigStore) {}

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
      if (!fired) return null; // repeat / no transition — deduped

      return renderInstallAwareness(match);
    } catch (err) {
      this.logger.warn(
        `handle: swallowed error for org=${input.orgId} repo=${input.repoId} job=${input.jobId} — ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
