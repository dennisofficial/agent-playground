import { Inject, Injectable, Logger } from '@nestjs/common';
import { readyKey, type ReadyFrame } from './daemon-protocol';
import {
  REDIS_STREAM_PORT,
  type RedisStreamPort,
} from '../../_lib/redis/redis.port';

/** Block window per readiness XREAD — re-checks the overall deadline each loop (mirrors the daemon
 * client's event/reply tail). NEVER 0: a 0 `blockMs` is "block forever" in real Redis. */
const READY_BLOCK_MS = 2_000;

/**
 * How long the host waits for a freshly-spawned sandbox's daemon to signal ready before giving up.
 * Must comfortably exceed the DAEMON-side inner-Docker ceiling (`DOCKER_READY_TIMEOUT_MS` = 120s in
 * `DaemonReadinessService`) plus image/daemon boot — a sandbox that's merely slow to bring up dockerd
 * should still gate THROUGH (the daemon signals `innerDocker:false` after its own ceiling and we let
 * the turn proceed) rather than the host erroring first.
 */
const READY_TIMEOUT_MS = 150_000;

/** Back-off after a transient Redis error before retrying within the deadline (lazy-Redis resilience). */
const READY_RETRY_MS = 1_000;

/**
 * The HOST-side READINESS GATE (Phase 10, host half).
 *
 * The in-sandbox `DaemonReadinessService` waits for inner Docker (`docker info`) then XADDs a durable
 * `ReadyFrame` to `ws:{workspaceId}:ready`. Nothing on the host consumed that marker — so a turn that
 * needs `docker compose` (or any engine turn) could be dispatched to a freshly-spawned sandbox before
 * inner Docker / the daemon's consumer loop were up. This service closes that gap: `waitForReady`
 * blocks the FIRST turn dispatched to a workspace until its marker appears (or a bounded timeout
 * elapses).
 *
 * Shape:
 *  - It reads the ready stream from `'0'`. The marker is DURABLE, so a host that asks AFTER the daemon
 *    became ready still sees it (no credential-style timing race) — and a host that asks BEFORE simply
 *    blocks on the XREAD until the XADD wakes it.
 *  - It's a one-shot per workspace: once confirmed ready, the result is cached so every later turn to
 *    that sandbox returns instantly (the gate only ever costs on the first turn). A failed wait is NOT
 *    cached — the next turn re-attempts (a transient slow boot shouldn't poison the workspace forever).
 *  - Concurrent first-turns to the same workspace share ONE in-flight XREAD loop (dedup by id).
 *
 * Resilience mirrors the rest of the bus: the XREAD runs behind the lazy `RedisStreamPort`, so a
 * transient Redis absence is caught, logged, and retried within the deadline rather than crashing the
 * turn. Only an exhausted deadline surfaces as a clear error.
 *
 * Only reached on the REMOTE turn path (`RemoteTurnDispatcher`) + at create_workspace (realizing a work
 * area), i.e. once a sandbox exists for a registered project.
 */
@Injectable()
export class SandboxReadinessService {
  private readonly logger = new Logger(SandboxReadinessService.name);
  /** workspaceIds whose daemon has signaled ready this process — the gate fires only on the FIRST turn. */
  private readonly ready = new Set<string>();
  /** In-flight waits, deduped per workspace so concurrent first-turns share ONE XREAD loop. */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    @Inject(REDIS_STREAM_PORT) private readonly redis: RedisStreamPort,
  ) {}

  /**
   * Block until the workspace's daemon has written its readiness marker to `ws:{id}:ready`, or throw a
   * clear error if it never appears within `timeoutMs`. Idempotent + cheap after the first confirmation
   * (cached); concurrent callers for the same workspace share one wait. `timeoutMs` is overridable for
   * tests; production callers use the default.
   */
  async waitForReady(
    workspaceId: string,
    timeoutMs: number = READY_TIMEOUT_MS,
  ): Promise<void> {
    if (this.ready.has(workspaceId)) return;
    const existing = this.inflight.get(workspaceId);
    if (existing) return existing;
    const wait = this.poll(workspaceId, timeoutMs).finally(() =>
      this.inflight.delete(workspaceId),
    );
    this.inflight.set(workspaceId, wait);
    return wait;
  }

  /** Drop a workspace's cached readiness — the manager calls this on `destroyWorkspace`. */
  forget(workspaceId: string): void {
    this.ready.delete(workspaceId);
  }

  private async poll(workspaceId: string, timeoutMs: number): Promise<void> {
    const stream = readyKey(workspaceId);
    const deadline = Date.now() + timeoutMs;
    // Block window can't exceed the (possibly tiny, in tests) timeout, and never 0 (BLOCK 0 = forever).
    const blockMs = Math.min(READY_BLOCK_MS, Math.max(1, timeoutMs));
    this.logger.log(
      `waiting for sandbox ${workspaceId} to signal ready (${stream})…`,
    );
    for (;;) {
      if (Date.now() >= deadline) {
        throw new Error(
          `sandbox ${workspaceId} did not signal ready within ${timeoutMs}ms — its daemon never wrote ${stream} (inner Docker / the daemon consumer loop may be down)`,
        );
      }
      let entries;
      try {
        entries = await this.redis.xread({
          stream,
          lastId: '0', // durable marker — read from the start so one written before we began is still seen
          count: 1,
          blockMs,
        });
      } catch (err) {
        // Transient Redis absence (lazy client mid-(re)connect) — log, back off, retry within the deadline.
        this.logger.warn(
          `readiness XREAD for ${workspaceId} failed (retrying): ${String(err)}`,
        );
        await sleep(Math.min(READY_RETRY_MS, Math.max(1, deadline - Date.now())));
        continue;
      }
      if (entries.length === 0) continue; // BLOCK timeout, nothing yet — loop (re-checks the deadline).
      const frame = entries[0].data as ReadyFrame | undefined;
      this.ready.add(workspaceId);
      this.logger.log(
        `sandbox ${workspaceId} is ready (innerDocker=${frame?.innerDocker ?? 'unknown'})`,
      );
      return;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}
