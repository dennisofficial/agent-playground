import { EnvService } from '@core/config/env/env.service';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { LeaderElectionService } from '../cluster';
import { TurnRegistry } from './turn-registry.service';

/** Default stale window: ~18× the engine's 5s heartbeat — long enough that a slow-but-live turn is safe. */
const DEFAULT_STALE_MS = 90_000;
/** How often the leader sweeps for dead turns. */
const SWEEP_INTERVAL_MS = 30_000;

/**
 * LEADER-ONLY watchdog for Redis-transport turns (`active_turns`). The ephemeral in-container engine
 * heartbeats onto its events stream; the host advances `last_heartbeat_at`. If a turn's heartbeat goes
 * stale the engine CONTAINER itself died (the only truly-unrecoverable case — a backend restart doesn't
 * stop the engine) — the watchdog finalizes the row `failed` so it stops lingering in the live set.
 *
 * Mirrors `RealtimeService`'s lifecycle: started on leader promotion, stopped on demotion/shutdown, and
 * disabled entirely against a `*_test` DB. Full live RE-ATTACH (resume streaming a surviving turn to a
 * reconnecting operator + rebuild the brain tool closure from `ctx`) rides on this registry and is the
 * next increment; this service is the safety-net half (no orphaned `running` rows).
 */
@Injectable()
export class TurnWatchdogService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TurnWatchdogService.name);
  private promoteSub?: Subscription;
  private demoteSub?: Subscription;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly registry: TurnRegistry,
    private readonly election: LeaderElectionService,
    private readonly env: EnvService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.get('POSTGRES_DB')?.endsWith('_test')) {
      this.logger.log('turn watchdog off (test database)');
      return;
    }
    this.promoteSub = this.election.onPromote(() => this.start());
    this.demoteSub = this.election.onDemote(() => this.stop());
  }

  onApplicationShutdown(): void {
    this.promoteSub?.unsubscribe();
    this.demoteSub?.unsubscribe();
    this.stop();
  }

  private start(): void {
    if (this.timer) return;
    void this.sweep(); // an immediate boot reconcile, then on an interval
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.log('turn watchdog started (leader)');
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private get staleMs(): number {
    const raw = Number(this.env.get('TURN_STALE_MS'));
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_MS;
  }

  /** Finalize every turn whose engine heartbeat has gone stale (the container died). */
  async sweep(): Promise<void> {
    let stale;
    try {
      stale = await this.registry.findStale(this.staleMs);
    } catch (err) {
      this.logger.debug(`watchdog sweep query failed (will retry): ${err}`);
      return;
    }
    for (const turn of stale) {
      await this.registry
        .finalize(turn.turn_id, 'failed')
        .then(() =>
          this.logger.warn(
            `finalized stale turn ${turn.turn_id} (thread ${turn.thread_id}) — engine heartbeat lost`,
          ),
        )
        .catch((err) => this.logger.debug(`finalize ${turn.turn_id} failed (ignored): ${err}`));
    }
  }
}
