import { EnvService } from '@core/config/env/env.service';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { RealtimeEngine, type Logger as RealtimeLogger, type SubscriptionImpl } from '@workspace/pg-realtime';
import { THREADS_MODEL, type RealtimePrincipal } from './thread-realtime.model';

const SLOT_NAME = 'pg_realtime_slot';
const PUBLICATION_NAME = 'pg_realtime_pub';

/**
 * The in-process realtime engine (WAL → SSE), single-instance. Atlas runs as ONE process, so we use the
 * engine's defaults — `consume: true`, `InProcessBus`, `NoopLeaderElector` — and skip the multi-replica
 * machinery (pg_notify fan-out, leader election). Any write to the `threads` table propagates to
 * connected sidebars automatically; nothing has to remember to emit.
 *
 * Realtime is ALWAYS ON — it's core, not an opt-in. The only exception is automated test runs (where every
 * int-test would boot an engine and fight over the single replication slot); those are detected by the
 * `*_test` database invariant and skipped. FAIL-SOFT: if the engine can't start (e.g. Postgres `wal_level`
 * isn't `logical`), boot continues and the engine stays unavailable — the REST list endpoints still serve
 * the server-derived `needsYou`, so the dots are correct on refetch, just not live.
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeService.name);
  private engine: RealtimeEngine | null = null;

  constructor(private readonly env: EnvService) {}

  async onModuleInit(): Promise<void> {
    // Off only in automated tests: many int-tests each boot the full app, and a logical replication slot
    // is single-consumer — they'd contend over it. The `*_test` DB is the authoritative test signal.
    if (this.env.get('POSTGRES_DB')?.endsWith('_test')) {
      this.logger.log('realtime off (test database)');
      return;
    }
    try {
      const engine = new RealtimeEngine({
        connectionString: this.connectionString(),
        slotName: SLOT_NAME,
        publicationName: PUBLICATION_NAME,
        models: [THREADS_MODEL],
        logger: this.engineLogger(),
      });
      await engine.start();
      this.engine = engine;
      this.logger.log('realtime engine started (threads → SSE)');
    } catch (err) {
      this.engine = null;
      this.logger.warn(
        `realtime engine failed to start — falling back to non-live status (REST needsYou still works). ` +
          `Ensure Postgres wal_level=logical. Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    if (engine) await engine.stop().catch(() => undefined);
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
