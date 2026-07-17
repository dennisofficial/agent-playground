import { EnvService } from '@core/config/env/env.service';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Subject, type Subscription } from 'rxjs';
import { pgConnectionString, resolveSsl } from '../persistence/database.module';

/**
 * Process-wide singleton-leadership key for `pg_advisory_lock`. ONE global leader per cluster — leader
 * duties (turn processing, the sandbox reaper, boot reconcile, the realtime slot) are process-wide
 * infrastructure, not org-scoped. The literal is arbitrary but stable; never change it.
 */
const LEADER_LOCK_KEY = 4242042042042042;

export type LeaderState = 'follower' | 'leader' | 'draining';

/**
 * Postgres advisory-lock LEADER ELECTION — the backend is a hard singleton (in-memory per-thread turn
 * queues, the provisioning lock, the single realtime replication slot), so exactly ONE instance may run
 * the singleton duties at a time. A dedicated long-lived `pg.Client` holds a session-level advisory
 * lock; Postgres releases it automatically when that session ends (process death / TCP reset), which is
 * the crash-safety property. A follower polls until the lock frees.
 *
 * The graceful rolling handoff is **drain-then-release** (see `DrainService`): on SIGTERM the leader
 * goes `draining` (stops leader duties + rejects new turns, but KEEPS the lock so no standby promotes),
 * finishes in-flight turns, THEN releases the lock — so a successor only ever acquires it after the
 * predecessor is done. Singleton duties never run in two processes at once.
 */
@Injectable()
export class LeaderElectionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LeaderElectionService.name);

  /** Unique per process — suffixes this leader's realtime replication slot (see `RealtimeService`). */
  readonly instanceId = randomUUID();

  private state: LeaderState = 'follower';
  private client?: pg.Client;
  private pollTimer?: ReturnType<typeof setInterval>;
  private connecting = false;
  private acquiring = false; // re-entrancy guard so overlapping polls can't stack the advisory lock
  private heldLock = false; // true only while THIS session actually holds the advisory lock
  private readonly promote$ = new Subject<void>();
  private readonly demote$ = new Subject<void>();

  constructor(private readonly env: EnvService) {}

  isLeader(): boolean {
    return this.state === 'leader';
  }

  getState(): LeaderState {
    return this.state;
  }

  /**
   * True once this process has begun shutting down (SIGTERM/SIGINT drain or `onApplicationShutdown`).
   * The canonical "we're going away" signal: set at the very START of the drain, BEFORE in-flight turns
   * are cut off. Terminal-error catches (the driver/plan-review/autofix/gate) check this to distinguish a
   * shutdown-induced abort (leave the job resumable) from a real failure or a local watchdog/timeout abort
   * (which fire while still `leader`/`follower` and must stay terminal).
   */
  isDraining(): boolean {
    return this.state === 'draining';
  }

  /**
   * Run `fn` whenever this instance BECOMES leader — and IMMEDIATELY if it already is (module bootstrap
   * order is non-deterministic, so a late subscriber must not miss an earlier promotion).
   */
  onPromote(fn: () => void | Promise<void>): Subscription {
    if (this.state === 'leader') void this.safe(fn);
    return this.promote$.subscribe(() => void this.safe(fn));
  }

  /** Run `fn` whenever this instance STOPS being leader (demotion, drain, or connection loss). */
  onDemote(fn: () => void | Promise<void>): Subscription {
    return this.demote$.subscribe(() => void this.safe(fn));
  }

  private async safe(fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`leadership hook failed: ${err}`);
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    // Tests boot the full app many times against a `*_test` DB; a single process is the implicit leader,
    // and a real advisory lock would make concurrent int-test workers contend. Skip election in tests.
    if (this.env.get('POSTGRES_DB')?.endsWith('_test')) {
      this.state = 'leader';
      this.logger.log('leader election skipped (test database) — implicit leader');
      return;
    }
    await this.connectAndAcquire();
  }

  /** Begin draining: stop leader duties + the poll, but HOLD the lock so no standby promotes yet. */
  beginDrain(): void {
    if (this.state === 'draining') return;
    const wasLeader = this.state === 'leader';
    this.state = 'draining';
    this.stopPoll();
    // Stop the reaper + realtime engine; in-flight turns keep running (they are NOT gated on leadership).
    if (wasLeader) this.demote$.next();
  }

  /** Release the advisory lock so a standby can promote. Called by the drain flow AFTER a clean drain. */
  async releaseLeadership(): Promise<void> {
    // Only unlock when we actually hold the lock — a follower (or an already-released leader) must not
    // run pg_advisory_unlock on a session that never locked (it would no-op + log misleadingly).
    if (!this.heldLock || !this.client) return;
    try {
      await this.client.query('SELECT pg_advisory_unlock($1::bigint)', [LEADER_LOCK_KEY]);
      this.heldLock = false;
      this.logger.log('released leadership (advisory lock unlocked)');
    } catch (err) {
      this.logger.warn(`advisory unlock failed (lock will release on disconnect): ${err}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.state = 'draining';
    this.stopPoll();
    const client = this.client;
    this.client = undefined;
    // Closing the connection releases the advisory lock server-side (covers the drain-timeout path,
    // where we deliberately did NOT unlock explicitly).
    if (client) await client.end().catch(() => undefined);
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────

  private async connectAndAcquire(): Promise<void> {
    if (this.state === 'draining' || this.connecting || this.client) return;
    this.connecting = true;
    try {
      const client = new pg.Client({
        connectionString: pgConnectionString(this.env),
        ssl: resolveSsl(this.env),
        application_name: 'atlas-leader',
        // Detect a dead peer quickly so a half-open connection releases the lock sooner.
        keepAlive: true,
      });
      client.on('error', (err) => this.onConnectionLost(err));
      client.on('end', () => this.onConnectionLost(new Error('connection ended')));
      await client.connect();
      this.client = client;
      this.connecting = false;
      await this.tryAcquire();
    } catch (err) {
      this.connecting = false;
      this.logger.warn(`leader: connect failed, retrying — ${err}`);
      this.scheduleReconnect();
    }
  }

  private async tryAcquire(): Promise<void> {
    if (this.state === 'draining' || !this.client || this.acquiring) return;
    // `tryAcquire` is async and fired on a timer; without this guard a poll tick arriving while the
    // previous query is still in flight (slow DB) would call pg_try_advisory_lock twice on the SAME
    // session — session advisory locks STACK, so a single releaseLeadership() would leave the lock held.
    this.acquiring = true;
    try {
      const res = await this.client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked',
        [LEADER_LOCK_KEY],
      );
      const locked = res.rows[0]?.locked === true;
      if (locked) {
        this.heldLock = true;
        this.stopPoll();
        if (this.state !== 'leader') {
          this.state = 'leader';
          this.logger.log(`acquired leadership (instance ${this.instanceId})`);
          this.promote$.next();
        }
      } else {
        this.state = 'follower';
        this.startPoll();
      }
    } catch (err) {
      this.onConnectionLost(err);
    } finally {
      this.acquiring = false;
    }
  }

  /** Connection dropped: demote to follower (Postgres has freed our lock) and reconnect from scratch. */
  private onConnectionLost(err: unknown): void {
    if (this.state === 'draining') return; // shutting down — ignore
    if (!this.client) return; // already handled (pg emits BOTH 'error' and 'end' for one drop)
    const wasLeader = this.state === 'leader';
    this.client = undefined;
    this.heldLock = false; // Postgres releases session advisory locks on disconnect
    this.state = 'follower';
    if (wasLeader) {
      this.logger.warn(`lost leadership (connection lost): ${err}`);
      this.demote$.next();
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.state === 'draining') return;
    setTimeout(() => void this.connectAndAcquire(), this.pollMs()).unref?.();
  }

  private startPoll(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.tryAcquire(), this.pollMs());
    this.pollTimer.unref?.();
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private pollMs(): number {
    return 2000; // how often a follower re-tries to acquire the advisory lock.
  }
}
