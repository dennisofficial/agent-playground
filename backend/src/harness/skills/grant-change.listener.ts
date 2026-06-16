import { EnvService } from '@core/config/env/env.service';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { PgNotifyBus } from '@workspace/pg-realtime/bus';
import { EngineHomeProvisioner } from './engine-home-provisioner.service';

/** The channel the DB trigger fires on; payload = `{ employeeId }` JSON (PgNotifyBus JSON-parses it). */
export const GRANT_CHANGE_CHANNEL = 'employee_tools_changed';

const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8_000;

/**
 * Reactive grant reconcile — replaces the old 30s poll. A DB trigger on
 * `employee_skills`/`employee_mcp_servers` fires `NOTIFY employee_tools_changed, '{"employeeId":…}'`
 * on every insert/update/delete (so the admin REST, a seeder, or a direct SQL edit all trigger it
 * with no app-side publish), and this subscribes via the VENDORED `@workspace/pg-realtime` bus
 * (`PgNotifyBus` — dedicated LISTEN connection, auto-reconnect + re-LISTEN) and calls
 * `provisioner.reconcile(employeeId)`. The change reflects on the employee's next engine turn with
 * no restart.
 *
 * NOTE: PgNotifyBus re-LISTENs after a dropped connection but doesn't surface a reconnect hook, so a
 * grant changed DURING a disconnect window isn't replayed (Postgres doesn't queue NOTIFYs for an
 * absent listener) — it resyncs on the next event for that employee or on the next boot
 * (`provisioner.reconcileAll()` runs at startup). Acceptable for config that changes rarely.
 */
@Injectable()
export class GrantChangeListener
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(GrantChangeListener.name);
  private bus?: PgNotifyBus;
  private closed = false;
  private attempts = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private resolveReady!: () => void;
  /** Resolves once the LISTEN is established (first successful subscribe) — for tests/health checks. */
  readonly ready = new Promise<void>((r) => {
    this.resolveReady = r;
  });

  constructor(
    private readonly env: EnvService,
    private readonly provisioner: EngineHomeProvisioner,
  ) {}

  onApplicationBootstrap(): void {
    // Don't block boot — subscribe in the background (the provisioner already did the initial full
    // provision in its own bootstrap hook).
    void this.subscribe();
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    try {
      await this.bus?.close();
    } catch {
      /* best effort */
    }
    this.bus = undefined;
  }

  private async subscribe(): Promise<void> {
    if (this.closed) return;
    try {
      this.bus = new PgNotifyBus({
        connectionString: this.connectionString(),
        logger: {
          debug: () => {},
          info: (m) => this.logger.debug(m),
          warn: (m) => this.logger.warn(m),
          error: (m) => this.logger.error(m),
        },
      });
      // PgNotifyBus auto-reconnects after a successful connect; this retry only covers a FIRST
      // connect that fails (e.g. DB not up yet at boot).
      await this.bus.subscribe(GRANT_CHANGE_CHANNEL, (event) => {
        const employeeId = (event as unknown as { employeeId?: string })
          ?.employeeId;
        if (!employeeId) return;
        this.logger.log(`Grant change for ${employeeId} — reconciling`);
        void this.provisioner
          .reconcile(employeeId)
          .catch((e) =>
            this.logger.warn(`reconcile(${employeeId}) failed: ${errMsg(e)}`),
          );
      });
      this.attempts = 0;
      this.resolveReady();
      this.logger.log(`Listening on "${GRANT_CHANGE_CHANNEL}" (PgNotifyBus)`);
    } catch (err) {
      this.logger.warn(`grant listener connect failed, retrying: ${errMsg(err)}`);
      await this.bus?.close().catch(() => {});
      this.bus = undefined;
      this.attempts += 1;
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.attempts - 1));
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => void this.subscribe(), delay);
    }
  }

  /** libpq connection string from POSTGRES_* (a dedicated LISTEN session, separate from the pool). */
  private connectionString(): string {
    const url = new URL(`postgresql://${this.env.get('POSTGRES_HOST')}`);
    url.username = this.env.get('POSTGRES_USER') ?? '';
    url.password = this.env.get('POSTGRES_PASSWORD') ?? '';
    url.port = String(this.env.get('POSTGRES_PORT') ?? 5432);
    url.pathname = `/${this.env.get('POSTGRES_DB') ?? ''}`;
    url.searchParams.set(
      'application_name',
      'agent-playground (grant-change listener)',
    );
    return url.toString();
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
