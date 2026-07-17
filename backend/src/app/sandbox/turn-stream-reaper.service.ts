import { EnvService } from '@core/config/env/env.service';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Subscription } from 'rxjs';
import { REDIS_STREAM_PORT, type RedisStreamPort } from '../../_lib/redis/redis.port';
import { LeaderElectionService } from '../cluster/leader-election.service';
import { TurnRegistry } from './turn-registry.service';

const TURN_KEY_MATCH = 'turn:*';
const DEFAULT_INTERVAL_MS = 300_000;
const REAPER_INTERVAL = 'sandbox:turn-stream-reaper';
const DEFAULT_IDLE_MS = 300_000;

@Injectable()
export class TurnStreamReaperService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TurnStreamReaperService.name);
  private promoteSub?: Subscription;
  private demoteSub?: Subscription;

  constructor(
    @Inject(REDIS_STREAM_PORT) private readonly redis: RedisStreamPort,
    private readonly registry: TurnRegistry,
    private readonly election: LeaderElectionService,
    private readonly env: EnvService,
    @Optional() private readonly scheduler?: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.get('POSTGRES_DB')?.endsWith('_test')) {
      this.logger.log('turn stream reaper off (test database)');
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
    if (this.scheduler.doesExist('interval', REAPER_INTERVAL)) return;
    void this.reap(); // boot cleanup — sweep any orphans accumulated before this leader took over
    const iv = setInterval(() => void this.reap(), this.intervalMs);
    iv.unref?.(); // never keep the process alive (SchedulerRegistry does not unref for us)
    this.scheduler.addInterval(REAPER_INTERVAL, iv);
    this.logger.log('turn stream reaper started (leader)');
  }

  private stop(): void {
    if (this.scheduler?.doesExist('interval', REAPER_INTERVAL)) {
      this.scheduler.deleteInterval(REAPER_INTERVAL);
    }
  }

  private get intervalMs(): number {
    return DEFAULT_INTERVAL_MS;
  }

  private get idleSeconds(): number {
    const raw = Number(this.env.get('TURN_STREAM_REAP_IDLE_MS'));
    const ms = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MS;
    return Math.ceil(ms / 1000);
  }

  async reap(): Promise<void> {
    let keys: string[];
    try {
      keys = await this.redis.scanKeys(TURN_KEY_MATCH);
    } catch (err) {
      this.logger.debug(`reaper scan failed (will retry): ${err}`);
      return;
    }
    if (keys.length === 0) return;

    const byTurn = new Map<string, string[]>();
    for (const key of keys) {
      const turnId = key.split(':')[1];
      if (!turnId) continue;
      const group = byTurn.get(turnId) ?? [];
      group.push(key);
      byTurn.set(turnId, group);
    }

    let active: Set<string>;
    try {
      active = await this.registry.allTurnIds();
    } catch (err) {
      this.logger.debug(`reaper active-turn query failed (will retry): ${err}`);
      return;
    }

    const floor = this.idleSeconds;
    let reaped = 0;
    for (const [turnId, group] of byTurn) {
      if (active.has(turnId)) continue; // a live (or lingering-terminal) turn — never touch its streams
      let minIdle = Infinity;
      for (const key of group) {
        const idle = await this.redis.objectIdleTime(key).catch(() => null);
        if (idle !== null) minIdle = Math.min(minIdle, idle);
      }
      if (minIdle === Infinity || minIdle < floor) continue;
      await this.redis
        .del(...group)
        .then(() => {
          reaped++;
        })
        .catch((err) => this.logger.debug(`reaper del ${turnId} failed (ignored): ${err}`));
    }
    if (reaped > 0) {
      this.logger.warn(`reaped ${reaped} orphaned turn stream set(s) — no active_turns row`);
    }
  }
}
