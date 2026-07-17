import { EnvService } from '@core/config/env/env.service';
import {
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { LeaderElectionService } from '../cluster/leader-election.service';
import { ClaudeCredentialStore } from './claude-credential.store';
import { CredentialRefreshService } from './credential-refresh.service';

const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const KEEPALIVE_EXPIRY_WINDOW_MS = 35 * 60 * 1000; // 35 min
const KEEPALIVE_INTERVAL_NAME = 'onboarding:credential-keepalive';

@Injectable()
export class CredentialKeepAliveService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CredentialKeepAliveService.name);
  private promoteSub?: { unsubscribe(): void };
  private demoteSub?: { unsubscribe(): void };
  private running = false;

  constructor(
    private readonly store: ClaudeCredentialStore,
    private readonly refresh: CredentialRefreshService,
    private readonly election: LeaderElectionService,
    private readonly env: EnvService,
    @Optional() private readonly scheduler?: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.get('POSTGRES_DB')?.endsWith('_test')) {
      this.logger.log('credential keep-alive off (test database)');
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
    if (this.scheduler.doesExist('interval', KEEPALIVE_INTERVAL_NAME)) return;
    void this.tick(); // boot/promotion sweep
    const iv = setInterval(() => void this.tick(), KEEPALIVE_INTERVAL_MS);
    iv.unref?.(); // never keep the process alive (SchedulerRegistry does not unref for us)
    this.scheduler.addInterval(KEEPALIVE_INTERVAL_NAME, iv);
    this.logger.log('credential keep-alive started (leader)');
  }

  private stop(): void {
    if (this.scheduler?.doesExist('interval', KEEPALIVE_INTERVAL_NAME)) {
      this.scheduler.deleteInterval(KEEPALIVE_INTERVAL_NAME);
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.store.listExpiringPersonal(KEEPALIVE_EXPIRY_WINDOW_MS);
      let refreshed = 0;
      let failed = 0;
      for (const { orgId, credentialId } of due) {
        await this.refresh
          .ensureFresh(orgId, credentialId)
          .then(() => {
            refreshed += 1;
          })
          .catch((err) => {
            failed += 1;
            this.logger.warn(`keep-alive refresh failed org=${orgId} id=${credentialId}: ${err}`);
          });
      }
      const health = await this.store.credentialHealthSnapshot();
      this.logger.log(
        `keep-alive tick: due=${due.length} refreshed=${refreshed} failed=${failed} ` +
          `expiredActivePersonal=${health.expiredActivePersonal} needsReauth=${health.needsReauth}`,
      );
      if (health.expiredActivePersonal > 0) {
        this.logger.warn(
          `keep-alive: ${health.expiredActivePersonal} active personal credential(s) already PAST expiry — ` +
            `the sweep is not keeping up (leader down/behind, or refresh failing)`,
        );
      }
    } catch (err) {
      this.logger.warn(`keep-alive tick failed: ${err}`);
    } finally {
      this.running = false;
    }
  }
}
