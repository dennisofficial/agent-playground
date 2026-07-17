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

const LEADER_LOCK_KEY = 4242042042042042;

export type LeaderState = 'follower' | 'leader' | 'draining';

@Injectable()
export class LeaderElectionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LeaderElectionService.name);

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

  isDraining(): boolean {
    return this.state === 'draining';
  }

  onPromote(fn: () => void | Promise<void>): Subscription {
    if (this.state === 'leader') void this.safe(fn);
    return this.promote$.subscribe(() => void this.safe(fn));
  }

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
    if (this.env.get('POSTGRES_DB')?.endsWith('_test')) {
      this.state = 'leader';
      this.logger.log('leader election skipped (test database) — implicit leader');
      return;
    }
    await this.connectAndAcquire();
  }

  beginDrain(): void {
    if (this.state === 'draining') return;
    const wasLeader = this.state === 'leader';
    this.state = 'draining';
    this.stopPoll();
    if (wasLeader) this.demote$.next();
  }

  async releaseLeadership(): Promise<void> {
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
    if (client) await client.end().catch(() => undefined);
  }


  private async connectAndAcquire(): Promise<void> {
    if (this.state === 'draining' || this.connecting || this.client) return;
    this.connecting = true;
    try {
      const client = new pg.Client({
        connectionString: pgConnectionString(this.env),
        ssl: resolveSsl(this.env),
        application_name: 'atlas-leader',
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
