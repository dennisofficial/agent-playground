import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Subscription } from 'rxjs';
import { LeaderElectionService } from '../cluster';
import {
  REDIS_STREAM_PORT,
  type RedisStreamPort,
} from '../../_lib/redis/redis.port';
import { TurnRegistry } from './turn-registry.service';

/** Match every per-turn transport key (`turn:{T}:spec|events|tools|replies`). */
const TURN_KEY_MATCH = 'turn:*';
/** How often the leader reaps orphaned turn streams. Slower than the watchdog — orphans aren't urgent. */
const DEFAULT_INTERVAL_MS = 300_000;
/** SchedulerRegistry interval name (process-unique) for the leader-gated reap sweep. */
const REAPER_INTERVAL = 'sandbox:turn-stream-reaper';
/**
 * A key must be untouched at least this long (no read/write) before it's reap-eligible — the guard that
 * makes a false-delete impossible. A just-kicked turn `xadd`s its `spec` BEFORE it `register`s its
 * `active_turns` row (see `RedisEngineRunner.run`), so for one DB write it has streams but no row; this
 * floor (min idle far above that window) keeps the reaper from ever deleting a mid-registration turn.
 */
const DEFAULT_IDLE_MS = 300_000;

/**
 * LEADER-ONLY reaper for ORPHANED Redis turn streams (ADR 0001, retention/hygiene).
 *
 * Stream cleanup (`redis.del`) normally rides `RedisEngineRunner.runAttached`'s `finally`, but several
 * finalize paths bypass it — the watchdog finalizing a dead-engine turn, non-brain turns that are never
 * re-attached on boot, and re-attach-failure paths — leaking that turn's `turn:{T}:*` streams forever
 * (no `active_turns` row references them, so boot re-attach never rediscovers them). This is Redis
 * hygiene, not data loss (JSONL recovery covers the transcript).
 *
 * The reaper is a PATH-AGNOSTIC backstop: it SCANs `turn:*`, and deletes the streams of any turn id with
 * no live `active_turns` row (any status), guarded by an idle-time floor so it can never touch a live or
 * mid-registration turn. Mirrors `TurnWatchdogService`'s lifecycle — started on leader promotion, stopped
 * on demotion/shutdown, disabled entirely against a `*_test` DB. Fail-soft throughout.
 */
@Injectable()
export class TurnStreamReaperService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(TurnStreamReaperService.name);
  private promoteSub?: Subscription;
  private demoteSub?: Subscription;

  constructor(
    @Inject(REDIS_STREAM_PORT) private readonly redis: RedisStreamPort,
    private readonly registry: TurnRegistry,
    private readonly election: LeaderElectionService,
    private readonly env: EnvService,
    // Prod always injects the scheduler (global ScheduleModule); unit tests omit it and never promote, so
    // the reaper never starts there.
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
    // deleteInterval clears the interval AND removes it from the registry.
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

  /** One reconcile pass: delete the streams of every turn id with no live row that's been idle past the floor. */
  async reap(): Promise<void> {
    let keys: string[];
    try {
      keys = await this.redis.scanKeys(TURN_KEY_MATCH);
    } catch (err) {
      this.logger.debug(`reaper scan failed (will retry): ${err}`);
      return;
    }
    if (keys.length === 0) return;

    // Group the scanned keys by turn id (`turn:{id}:{suffix}` — the id is a colon-free uuid).
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
      // minIdle === Infinity ⇒ every key vanished between scan and check — nothing to do.
      if (minIdle === Infinity || minIdle < floor) continue;
      await this.redis
        .del(...group)
        .then(() => {
          reaped++;
        })
        .catch((err) =>
          this.logger.debug(`reaper del ${turnId} failed (ignored): ${err}`),
        );
    }
    if (reaped > 0) {
      this.logger.warn(
        `reaped ${reaped} orphaned turn stream set(s) — no active_turns row`,
      );
    }
  }
}
