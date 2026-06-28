import { EnvService } from '@core/config/env/env.service';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { RealtimeEngine, type Logger as RealtimeLogger, type SubscriptionImpl } from '@workspace/pg-realtime';
import pg from 'pg';
import type { Subscription } from 'rxjs';
import { LeaderElectionService } from '../cluster';
import { resolveSsl } from '../persistence/database.module';
import { THREADS_MODEL, type RealtimePrincipal } from './thread-realtime.model';

const PUBLICATION_NAME = 'pg_realtime_pub';

/**
 * The in-process realtime engine (WAL → SSE). A logical replication slot is SINGLE-CONSUMER, so the
 * engine is a LEADER-ONLY duty: it starts on promotion and stops on demotion/drain, gated by
 * `LeaderElectionService`. The slot name is made UNIQUE PER INSTANCE (`<prefix>_<instanceId>`) so a
 * freshly-promoted leader never contends with a predecessor's slot during the brief deploy overlap; on
 * start it also sweeps inactive `<prefix>_*` slots left by a SIGKILLed predecessor to reclaim WAL.
 *
 * Realtime is core, not opt-in. The only exception is automated test runs (the `*_test` DB), where every
 * int-test would boot an engine and fight over a slot. FAIL-SOFT: if the engine can't start (e.g.
 * `wal_level` isn't `logical`), boot continues and the REST list endpoints still serve `needsYou`.
 */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeService.name);
  private engine: RealtimeEngine | null = null;
  private promoteSub?: Subscription;
  private demoteSub?: Subscription;

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

  /** Whether live updates are available (engine started). */
  get available(): boolean {
    return this.engine !== null;
  }

  /** Open a per-operator subscription over ALL their orgs' threads (the cross-org sidebar stream). */
  async openThreadSubscription(principal: RealtimePrincipal): Promise<SubscriptionImpl> {
    if (!this.engine) throw new ServiceUnavailableException('realtime unavailable');
    return this.engine.openSubscription({ model: 'threads', user: principal });
  }

  // ── leader-gated lifecycle ──────────────────────────────────────────────────────────────────────

  private async startEngine(): Promise<void> {
    if (this.engine) return;
    const slotName = this.slotName();
    try {
      await this.dropInactiveSlots(); // reclaim WAL from any SIGKILLed predecessor's leftover slot
      const engine = new RealtimeEngine({
        connectionString: this.connectionString(),
        slotName,
        publicationName: PUBLICATION_NAME,
        models: [THREADS_MODEL],
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

  private async stopEngine(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    if (engine) await engine.stop().catch(() => undefined);
    // Best-effort: drop our own (now-inactive) slot so it doesn't pin WAL after demotion.
    await this.dropSlot(this.slotName()).catch(() => undefined);
  }

  /** Per-instance replication slot, so leaders never share one during a deploy overlap. */
  private slotName(): string {
    const prefix = this.env.get('REALTIME_SLOT_PREFIX') ?? 'pg_realtime_slot';
    const suffix = this.election.instanceId.replace(/-/g, '').slice(0, 16);
    return `${prefix}_${suffix}`;
  }

  /** Drop any INACTIVE `<prefix>_*` slots (orphans from a crashed predecessor) to reclaim WAL. */
  private async dropInactiveSlots(): Promise<void> {
    const prefix = this.env.get('REALTIME_SLOT_PREFIX') ?? 'pg_realtime_slot';
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
      connectionString: this.connectionString(),
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

  /** Build a direct (non-pooled) libpq connection string from the same POSTGRES_* env the datasource uses. */
  private connectionString(): string {
    const user = encodeURIComponent(this.env.get('POSTGRES_USER'));
    const pass = encodeURIComponent(this.env.get('POSTGRES_PASSWORD'));
    const host = this.env.get('POSTGRES_HOST');
    const port = this.env.get('POSTGRES_PORT') ?? 5432;
    const db = encodeURIComponent(this.env.get('POSTGRES_DB'));
    return `postgresql://${user}:${pass}@${host}:${port}/${db}`;
  }

  /** Bridge the engine's tiny logger interface to the Nest logger (kept quiet at debug). */
  private engineLogger(): RealtimeLogger {
    return {
      debug: (m) => this.logger.debug(m),
      info: (m) => this.logger.log(m),
      warn: (m) => this.logger.warn(m),
      error: (m) => this.logger.error(m),
    };
  }
}
