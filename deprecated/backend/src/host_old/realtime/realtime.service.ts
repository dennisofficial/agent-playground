import { EnvService } from '@core/config/env/env.service';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  RealtimeEngine,
  type Logger as RealtimeLogger,
  type SubscriptionImpl,
} from '@workspace/pg-realtime';
import pg from 'pg';
import type { Subscription } from 'rxjs';
import { LeaderElectionService } from '../cluster/leader-election.service';
import { pgConnectionString, resolveSsl } from '../persistence/database.module';
import { DRAFTS_MODEL } from './draft-realtime.model';
import { THREADS_MODEL, type RealtimePrincipal } from './job-realtime.model';

const PUBLICATION_NAME = 'pg_realtime_pub';

@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeService.name);
  private engine: RealtimeEngine | null = null;
  private promoteSub?: Subscription;
  private demoteSub?: Subscription;
  private engineOp: Promise<void> = Promise.resolve();

  constructor(
    private readonly env: EnvService,
    private readonly election: LeaderElectionService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.get('POSTGRES_DB')?.endsWith('_test')) {
      this.logger.log('realtime off (test database)');
      return;
    }
    this.promoteSub = this.election.onPromote(() => this.startEngine());
    this.demoteSub = this.election.onDemote(() => this.stopEngine());
  }

  async onApplicationShutdown(): Promise<void> {
    this.promoteSub?.unsubscribe();
    this.demoteSub?.unsubscribe();
    await this.stopEngine();
  }

  get available(): boolean {
    return this.engine !== null;
  }

  async openThreadSubscription(principal: RealtimePrincipal): Promise<SubscriptionImpl> {
    if (!this.engine) throw new ServiceUnavailableException('realtime unavailable');
    return this.engine.openSubscription({ model: 'jobs', user: principal });
  }

  async openDraftSubscription(principal: RealtimePrincipal): Promise<SubscriptionImpl> {
    if (!this.engine) throw new ServiceUnavailableException('realtime unavailable');
    return this.engine.openSubscription({
      model: 'composer_drafts',
      user: principal,
    });
  }

  private startEngine(): Promise<void> {
    return (this.engineOp = this.engineOp.catch(() => undefined).then(() => this.doStartEngine()));
  }

  private stopEngine(): Promise<void> {
    return (this.engineOp = this.engineOp.catch(() => undefined).then(() => this.doStopEngine()));
  }

  private async doStartEngine(): Promise<void> {
    if (this.engine) return;
    const slotName = this.slotName();
    try {
      await this.dropInactiveSlots(); // reclaim WAL from any SIGKILLed predecessor's leftover slot
      const engine = new RealtimeEngine({
        connectionString: pgConnectionString(this.env),
        slotName,
        publicationName: PUBLICATION_NAME,
        models: [THREADS_MODEL, DRAFTS_MODEL],
        logger: this.engineLogger(),
      });
      await engine.start();
      this.engine = engine;
      this.logger.log(`realtime engine started (threads → SSE), slot ${slotName}`);
    } catch (err) {
      this.engine = null;
      this.logger.warn(
        `realtime engine failed to start — falling back to non-live status (REST needsYou still works). ` +
          `Ensure Postgres wal_level=logical. Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async doStopEngine(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    if (engine) await engine.stop().catch(() => undefined);
    await this.dropSlot(this.slotName()).catch(() => undefined);
  }

  private slotName(): string {
    const prefix = 'pg_realtime_slot';
    const suffix = this.election.instanceId.replace(/-/g, '').slice(0, 16);
    return `${prefix}_${suffix}`;
  }

  private async dropInactiveSlots(): Promise<void> {
    const prefix = 'pg_realtime_slot';
    await this.withClient(async (client) => {
      const res = await client.query<{ slot_name: string }>(
        `SELECT slot_name FROM pg_replication_slots WHERE slot_name LIKE $1 AND active = false`,
        [`${prefix}_%`],
      );
      for (const { slot_name } of res.rows) {
        await client
          .query('SELECT pg_drop_replication_slot($1)', [slot_name])
          .then(() => this.logger.log(`dropped orphaned replication slot ${slot_name}`))
          .catch((err) => this.logger.debug(`could not drop slot ${slot_name}: ${err}`));
      }
    });
  }

  private async dropSlot(slot: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots
         WHERE slot_name = $1 AND active = false`,
        [slot],
      );
    });
  }

  private async withClient(fn: (client: pg.Client) => Promise<void>): Promise<void> {
    const client = new pg.Client({
      connectionString: pgConnectionString(this.env),
      ssl: resolveSsl(this.env),
      application_name: 'atlas-realtime-admin',
    });
    try {
      await client.connect();
      await fn(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private engineLogger(): RealtimeLogger {
    return {
      debug: (m) => this.logger.debug(m),
      info: (m) => this.logger.log(m),
      warn: (m) => this.logger.warn(m),
      error: (m) => this.logger.error(m),
    };
  }
}
