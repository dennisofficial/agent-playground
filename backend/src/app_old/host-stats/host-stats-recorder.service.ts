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
import { LeaderElectionService } from '../cluster/leader-election.service';
import { HostStatsSampleRepository } from './host-stats-sample.repository';
import { HostStatsService } from './host-stats.service';

const SAMPLE_INTERVAL_MS = 15_000;
const PRUNE_INTERVAL_MS = 300_000;
const RETENTION_HOURS = 48;
const SAMPLE_INTERVAL = 'host-stats:sample';
const PRUNE_INTERVAL = 'host-stats:prune';

@Injectable()
export class HostStatsRecorderService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(HostStatsRecorderService.name);
  private promoteSub?: Subscription;
  private demoteSub?: Subscription;

  constructor(
    private readonly stats: HostStatsService,
    private readonly samples: HostStatsSampleRepository,
    private readonly election: LeaderElectionService,
    private readonly env: EnvService,
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
      const sampleIv = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
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
