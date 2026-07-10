import { EnvService } from '@core/config/env/env.service';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Subscription } from 'rxjs';
import { REDIS_STREAM_PORT, type RedisStreamPort } from '../../_lib/redis/redis.port';
import { LeaderElectionService } from '../cluster';
import { turnKeys } from './redis-turn-keys';
import { TurnRegistry } from './turn-registry.service';

/** Default stale window: ~18× the engine's 5s heartbeat — long enough that a slow-but-live turn is safe. */
const DEFAULT_STALE_MS = 90_000;
/** How often the leader sweeps for dead turns. */
const SWEEP_INTERVAL_MS = 30_000;
/** SchedulerRegistry interval name (process-unique) for the leader-gated dead-turn sweep. */
const WATCHDOG_INTERVAL = 'sandbox:turn-watchdog';

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

  constructor(
    private readonly registry: TurnRegistry,
    private readonly election: LeaderElectionService,
    private readonly env: EnvService,
    @Inject(REDIS_STREAM_PORT) private readonly redis: RedisStreamPort,
    // Prod always injects the scheduler (global ScheduleModule); unit tests omit it and never promote, so
    // the watchdog never starts there.
    @Optional() private readonly scheduler?: SchedulerRegistry,
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
    if (!this.scheduler) return;
    if (this.scheduler.doesExist('interval', WATCHDOG_INTERVAL)) return;
    // Boot grace: stamp a fresh heartbeat on every running turn BEFORE the first sweep, then reconcile.
    // Heartbeats are relayed by an attached host, so a restart freezes them; without this, a turn whose
    // engine is alive but whose DB heartbeat aged past the stale window would be finalized the instant we
    // promote — racing (and beating) boot re-attach. The touch gives each a full stale window to re-attach.
    void this.registry
      .touchAllRunningHeartbeats()
      .catch((err) => this.logger.debug(`watchdog boot heartbeat touch failed (ignored): ${err}`))
      .finally(() => void this.sweep());
    const iv = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    iv.unref?.(); // never keep the process alive (SchedulerRegistry does not unref for us)
    this.scheduler.addInterval(WATCHDOG_INTERVAL, iv);
    this.logger.log('turn watchdog started (leader)');
  }

  private stop(): void {
    // deleteInterval clears the interval AND removes it from the registry.
    if (this.scheduler?.doesExist('interval', WATCHDOG_INTERVAL)) {
      this.scheduler.deleteInterval(WATCHDOG_INTERVAL);
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
      // The DB heartbeat measures "a host is attached and relaying", NOT "the engine is alive" — after a
      // restart (or between watch respawns) no host is attached, the relay freezes, and a perfectly live
      // detached engine looks stale here. The engine itself writes a heartbeat frame to its events stream
      // every 5s regardless of any host, so consult THAT before pronouncing death: a recently-active
      // stream means the turn is alive-but-unattached — freshen the row (so it leaves the stale set until
      // re-attach resumes the relay) and leave it for the boot re-attach instead of finalizing it.
      try {
        const idleSec = await this.redis.objectIdleTime(turnKeys(turn.turn_id).events);
        if (idleSec !== null && idleSec * 1000 < this.staleMs) {
          this.logger.log(
            `turn ${turn.turn_id} DB-stale but its events stream is live (idle ${idleSec}s) — unattached, not dead; skipping`,
          );
          await this.registry.heartbeat(turn.turn_id).catch(() => undefined);
          continue;
        }
      } catch (err) {
        this.logger.debug(`liveness probe for ${turn.turn_id} failed (treating as stale): ${err}`);
      }
      await this.registry
        .finalize(turn.turn_id, 'failed')
        .then(() =>
          this.logger.warn(
            `finalized stale turn ${turn.turn_id} (thread ${turn.job_id}) — engine heartbeat lost`,
          ),
        )
        .catch((err) => this.logger.debug(`finalize ${turn.turn_id} failed (ignored): ${err}`));
    }
  }
}
