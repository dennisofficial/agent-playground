import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger, type BeforeApplicationShutdown } from '@nestjs/common';
import { LeaderElectionService } from '../cluster';
import { AgentSessionManager } from './agent-session-manager.service';

/**
 * GRACEFUL DRAIN on SIGTERM — the "drain-then-release" half of the rolling-update handoff. Lives in
 * `BrainModule` (co-located with `AgentSessionManager`) to avoid a cluster→brain import cycle; it depends
 * only on the @Global `LeaderElectionService` + `EnvService`.
 *
 * Order matters:
 *   1. `election.beginDrain()` — flip to `draining` so `/health/ready` returns 503 (Caddy stops sending
 *      NEW connections here) and the reaper + realtime engine stop. The advisory lock is KEPT, so no
 *      standby promotes yet; established SSE streams + in-flight turns keep running.
 *   2. `drainInFlight(DRAIN_GRACE_MS)` — let in-flight turns finish (new ones are already rejected).
 *   3. If they drained cleanly → `releaseLeadership()` so the standby promotes within a poll interval.
 *      If the grace cap was hit → DON'T release explicitly; the process exit closes the pg connection,
 *      which releases the lock, and the over-cap turns cold-resume on the next leader. This avoids a
 *      two-leaders-at-once window in the long-tail case.
 */
@Injectable()
export class DrainService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(DrainService.name);

  constructor(
    private readonly election: LeaderElectionService,
    private readonly sessions: AgentSessionManager,
    private readonly env: EnvService,
  ) {}

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (signal !== 'SIGTERM' && signal !== 'SIGINT') return;
    this.logger.log(`drain start (signal ${signal})`);
    this.election.beginDrain();
    // `?? `, not `|| ` — DRAIN_GRACE_MS=0 (valid per Joi min(0)) means "cut over immediately"; `||`
    // would treat the intentional 0 as falsy and wait the full default instead.
    const graceMs = this.env.get('DRAIN_GRACE_MS') ?? 120_000;
    const drained = await this.sessions.drainInFlight(graceMs);
    if (drained) {
      this.logger.log('drained cleanly — releasing leadership');
      await this.election.releaseLeadership();
    } else {
      this.logger.warn('drain grace exceeded — exiting; lock releases on disconnect, turns cold-resume');
    }
  }
}
