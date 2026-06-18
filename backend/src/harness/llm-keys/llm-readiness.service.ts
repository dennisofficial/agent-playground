import { Injectable, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { TenantCredentialService } from './tenant-credential.service';

/**
 * Per-tenant pending-keys readiness. In the single-process model each workspace boots independently
 * key-less and goes "ready" when BOTH its provider keys are resolvable (store, or env as a dev
 * fallback). The conductor gates a room's scheduling on `isReady(teamId)`; keys are NEVER written to
 * `process.env` (one process serves many workspaces) — they flow per-turn via CredentialContext.
 *
 * `isReady` is a synchronous cached-set check (the scheduler calls it per room); `ensureChecked`
 * kicks an async re-check for an unknown workspace and `ready$` emits the teamId on the pending→ready
 * edge so the conductor can release that workspace's backlog. the onboarding guard calls `refresh` right after a
 * key-modal submission for an instant flip.
 */
@Injectable()
export class LlmReadinessService {
  private readonly logger = new Logger(LlmReadinessService.name);
  private readonly readyTeams = new Set<string>();
  private readonly checking = new Set<string>();

  /** Emits a teamId on its pending→ready edge. Subscribers (conductor, onboarding guard) react. */
  readonly ready$ = new Subject<string>();

  constructor(private readonly creds: TenantCredentialService) {}

  /** Synchronous: has this workspace been observed ready? (The scheduler's per-room gate.) */
  isReady(teamId: string): boolean {
    return this.readyTeams.has(teamId);
  }

  /**
   * Re-evaluate a workspace's key availability; flips the cached set and emits `ready$` on the edge.
   * Safe to call from anywhere (the onboarding guard after a modal submit, tests). Returns the readiness.
   */
  async refresh(teamId: string): Promise<boolean> {
    if (this.readyTeams.has(teamId)) return true;
    const ready = await this.creds.isReady(teamId);
    if (ready) {
      this.readyTeams.add(teamId);
      this.logger.log(
        `Workspace ${teamId}: provider keys in place — engines live.`,
      );
      this.ready$.next(teamId);
    }
    return ready;
  }

  /** Fire-and-forget readiness probe for a workspace of unknown state (debounced) — for the scheduler. */
  ensureChecked(teamId: string): void {
    if (this.readyTeams.has(teamId) || this.checking.has(teamId)) return;
    this.checking.add(teamId);
    void this.refresh(teamId)
      .catch((err) =>
        this.logger.warn(`readiness refresh(${teamId}) failed: ${err}`),
      )
      .finally(() => this.checking.delete(teamId));
  }
}
