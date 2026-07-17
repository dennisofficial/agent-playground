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
import { LeaderElectionService } from '../cluster/leader-election.service';
import type { ActiveTurnEntity } from '../persistence/entities';
import { turnKeys } from './redis-turn-keys';
import { TurnReattachRegistry } from './turn-reattach.registry';
import { TurnRegistry } from './turn-registry.service';

const DEFAULT_STALE_MS = 90_000;
const SWEEP_INTERVAL_MS = 30_000;
const WATCHDOG_INTERVAL = 'sandbox:turn-watchdog';

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
    @Optional() private readonly scheduler?: SchedulerRegistry,
    @Optional() private readonly reattach?: TurnReattachRegistry,
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
    if (this.scheduler?.doesExist('interval', WATCHDOG_INTERVAL)) {
      this.scheduler.deleteInterval(WATCHDOG_INTERVAL);
    }
  }

  private get staleMs(): number {
    const raw = Number(this.env.get('TURN_STALE_MS'));
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_MS;
  }

  async sweep(): Promise<void> {
    let stale;
    try {
      stale = await this.registry.findStale(this.staleMs);
    } catch (err) {
      this.logger.debug(`watchdog sweep query failed (will retry): ${err}`);
      return;
    }
    for (const turn of stale) {
      try {
        const idleSec = await this.redis.objectIdleTime(turnKeys(turn.turn_id).events);
        if (idleSec !== null && idleSec * 1000 < this.staleMs) {
          await this.triggerReattach(turn);
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

  private async triggerReattach(turn: ActiveTurnEntity): Promise<void> {
    const handler = this.reattach?.handlerFor(turn.kind);
    if (!handler) {
      this.logger.log(
        `turn ${turn.turn_id} live but unattached (kind=${turn.kind}) — no reattach handler; keeping alive`,
      );
      return;
    }
    try {
      const outcome = await handler(turn);
      this.logger.log(
        outcome === 'attached'
          ? `turn ${turn.turn_id} live but unattached (${turn.kind}) — triggered reattach`
          : `turn ${turn.turn_id} live but unattached (${turn.kind}) — reattach deferred to existing recovery (job not drivable)`,
      );
    } catch (err) {
      this.logger.warn(`reattach trigger for turn ${turn.turn_id} (${turn.kind}) threw: ${err}`);
    }
  }
}
