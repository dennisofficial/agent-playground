import { EnvService } from '@core/config/env/env.service';
import {
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Subscription } from 'rxjs';
import { LeaderElectionService } from '../cluster';
import { HostStatsSampleRepository } from './host-stats-sample.repository';
import { HostStatsService } from './host-stats.service';

const SAMPLE_INTERVAL_MS = 15_000;
const PRUNE_INTERVAL_MS = 300_000;
const RETENTION_HOURS = 48;
/** SchedulerRegistry interval names (process-unique). */
const SAMPLE_INTERVAL = 'host-stats:sample';
const PRUNE_INTERVAL = 'host-stats:prune';

/**
 * LEADER-ONLY recorder that persists `HostStatsService.collect()` snapshots to `host_stats_sample`
 * every ~15s and prunes rows past 48h. Deliberately decoupled from the realtime SSE stream
 * (`HostStatsController#realtime`) — the two only share `collect()`, not a subscription, so neither
 * depends on the other's cadence or lifecycle. Mirrors `TurnWatchdogService`'s leader-gated lifecycle.
 */
@Injectable()
export class HostStatsRecorderService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(HostStatsRecorderService.name);
  private promoteSub?: Subscription;
  private demoteSub?: Subscription;

  constructor(
    private readonly stats: HostStatsService,
    private readonly samples: HostStatsSampleRepository,
    private readonly election: LeaderElectionService,
    private readonly env: EnvService,
    // Prod always injects the scheduler (global ScheduleModule); unit tests omit it and never promote, so
    // the recorder never starts there.
    @Optional() private readonly scheduler?: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.get('POSTGRES_DB')?.endsWith('_test')) {
      this.logger.log('host-stats recorder off (test database)');
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
    if (!this.scheduler.doesExist('interval', SAMPLE_INTERVAL)) {
      const sampleIv = setInterval(
        () => void this.sample(),
        SAMPLE_INTERVAL_MS,
      );
      sampleIv.unref?.();
      this.scheduler.addInterval(SAMPLE_INTERVAL, sampleIv);
    }
    if (!this.scheduler.doesExist('interval', PRUNE_INTERVAL)) {
      const pruneIv = setInterval(() => void this.prune(), PRUNE_INTERVAL_MS);
      pruneIv.unref?.();
      this.scheduler.addInterval(PRUNE_INTERVAL, pruneIv);
    }
    this.logger.log('host-stats recorder started (leader)');
  }

  private stop(): void {
    if (this.scheduler?.doesExist('interval', SAMPLE_INTERVAL)) {
      this.scheduler.deleteInterval(SAMPLE_INTERVAL);
    }
    if (this.scheduler?.doesExist('interval', PRUNE_INTERVAL)) {
      this.scheduler.deleteInterval(PRUNE_INTERVAL);
    }
  }

  async sample(): Promise<void> {
    try {
      const snap = await this.stats.collect();
      await this.samples.insertSnapshot(snap);
    } catch (err) {
      this.logger.debug(`host-stats sample failed (ignored): ${String(err)}`);
    }
  }

  async prune(): Promise<void> {
    try {
      await this.samples.pruneOlderThan(RETENTION_HOURS);
    } catch (err) {
      this.logger.debug(`host-stats prune failed (ignored): ${String(err)}`);
    }
  }
}
