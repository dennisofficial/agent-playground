import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  EngineAuthError,
  type EngineEvent,
  type EngineRunResult,
  type EngineRunnerPort,
  type RunEngineArgs,
} from '../engine';
import { REDIS_STREAM_PORT, type RedisStreamPort } from '../../_lib/redis/redis.port';
import { CONTAINER_ENGINE, type ContainerEngine } from './container-engine.port';
import {
  CONTAINER_AGENT_HOME,
  CONTAINER_CONTEXT,
  CONTAINER_WORKTREE,
} from './docker-engine-runner';
import { SandboxActivityRegistry } from './sandbox-activity.registry';
import { TurnRegistry } from './turn-registry.service';
import { turnKeys } from './redis-turn-keys';

/** A frame the in-container engine appends to `turn:{T}:events` (mirrors the pipe runner's NDJSON frames). */
type EventFrame =
  | { t: 'event'; e: EngineEvent }
  | { t: 'heartbeat'; ts: number }
  | { t: 'final'; r: EngineRunResult }
  | { t: 'error'; message: string; auth?: boolean; sessionId?: string };

/** How long the host waits with NO new event/heartbeat before declaring the engine dead (safety net). */
const TAIL_IDLE_TIMEOUT_MS = 120_000;

/**
 * The `redis` binding of `ENGINE_RUNNER` (`ENGINE_TRANSPORT=redis`) — runs a turn inside a sandbox via a
 * DETACHED `docker exec` whose engine talks to the host over **Redis Streams** instead of the exec pipe.
 * The host XADDs the spec, kicks the engine detached, registers the turn (`active_turns`), then TAILS
 * `turn:{T}:events` — so a backend restart neither kills the turn (the process is reparented to init and
 * keeps writing to Redis) nor loses it (a fresh backend re-attaches from `events_last_id`). See ADR 0001.
 *
 * Phase 2 implements the one-shot (events-egress) path. The bidirectional tool-bridge over Redis is
 * Phase 3 — a `toolBridge` turn under redis transport throws loudly here rather than hanging.
 */
@Injectable()
export class RedisEngineRunner implements EngineRunnerPort {
  private readonly logger = new Logger(RedisEngineRunner.name);

  constructor(
    @Inject(CONTAINER_ENGINE) private readonly containers: ContainerEngine,
    @Inject(REDIS_STREAM_PORT) private readonly redis: RedisStreamPort,
    private readonly env: EnvService,
    private readonly activity: SandboxActivityRegistry,
    private readonly registry: TurnRegistry,
  ) {}

  async run(args: RunEngineArgs): Promise<EngineRunResult> {
    const target = args.target;
    if (!target?.containerId) {
      throw new Error('RedisEngineRunner requires args.target.containerId (docker sandbox mode)');
    }
    if (args.toolBridge) {
      // Brain turns set toolBridge; the bidirectional bridge over Redis is Phase 3. Fail loudly so a
      // misconfigured redis-mode brain turn errors instead of hanging on a reply that never comes.
      throw new Error(
        'RedisEngineRunner: tool-bridge turns over Redis are not yet implemented (Phase 3). Use ENGINE_TRANSPORT=pipe for brain turns.',
      );
    }

    const turnId = randomUUID();
    const keys = turnKeys(turnId);
    const spec = this.buildSpec(args, target, turnId);

    // 1) Publish the spec the engine reads on startup.
    await this.redis.xadd(keys.spec, spec);

    // 2) Register the turn for restart re-attach (best-effort — a turn still runs without a registry row).
    if (args.turnMeta) {
      await this.registry
        .register({
          turnId,
          threadId: args.turnMeta.threadId,
          orgId: args.turnMeta.orgId,
          channel: args.turnMeta.channel,
          lane: args.turnMeta.lane,
          kind: args.turnMeta.kind,
          containerId: target.containerId,
          ctx: { ...(args.turnMeta.ctx ?? {}), orgId: args.turnMeta.orgId, repoId: args.turnMeta.channel, threadId: args.turnMeta.threadId },
        })
        .catch((err) => this.logger.warn(`turn ${turnId}: registry.register failed (continuing): ${err}`));
    }

    // 3) Kick the engine detached — it reads the spec from Redis and writes events back to Redis.
    return this.activity.track(target.containerId, async () => {
      try {
        await this.containers.execDetached(target.containerId, ['atlas-engine-turn'], {
          ...(target.user ? { user: target.user } : {}),
          env: this.execEnv(turnId),
          cwd: CONTAINER_WORKTREE,
        });
        return await this.tailEvents(turnId, keys, args);
      } finally {
        await this.registry
          .finalize(turnId, 'done')
          .catch((err) => this.logger.debug(`turn ${turnId}: finalize failed (ignored): ${err}`));
      }
    });
  }

  /** Tail `turn:{T}:events` until `final`/`error`, feeding `onEvent` + advancing the resume cursor. */
  private async tailEvents(
    turnId: string,
    keys: ReturnType<typeof turnKeys>,
    args: RunEngineArgs,
  ): Promise<EngineRunResult> {
    let lastId = '0-0';
    let lastActivity = Date.now();
    let result: EngineRunResult | undefined;
    let errorMsg: string | undefined;
    let errorAuth = false;
    let errorSession: string | undefined;

    const onAbort = (): void => {
      // Cooperative cancel: the in-container engine subscribes to this channel and stops the SDK turn.
      void this.redis.publish(keys.abort, { t: 'abort' });
    };
    if (args.signal) {
      if (args.signal.aborted) onAbort();
      else args.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      while (result === undefined && errorMsg === undefined) {
        const entries = await this.redis.xread({
          stream: keys.events,
          lastId,
          count: 128,
          blockMs: 1000,
        });
        if (entries.length === 0) {
          if (Date.now() - lastActivity > TAIL_IDLE_TIMEOUT_MS) {
            errorMsg = `engine produced no events for ${Math.round(TAIL_IDLE_TIMEOUT_MS / 1000)}s (presumed dead)`;
            break;
          }
          continue;
        }
        lastActivity = Date.now();
        for (const entry of entries) {
          lastId = entry.id;
          const frame = entry.data as EventFrame;
          if (frame.t === 'event') args.onEvent?.(frame.e);
          else if (frame.t === 'final') result = frame.r;
          else if (frame.t === 'error') {
            errorMsg = frame.message;
            errorAuth = !!frame.auth;
            errorSession = frame.sessionId;
          }
          // 'heartbeat' just refreshes liveness (lastActivity above).
        }
        // Persist the resume cursor + liveness so a fresh backend re-attaches from here.
        await this.registry
          .heartbeat(turnId, lastId)
          .catch(() => undefined);
      }
    } finally {
      args.signal?.removeEventListener('abort', onAbort);
    }

    if (errorMsg) {
      if (errorAuth) throw new EngineAuthError(errorMsg, errorSession);
      throw new Error(`in-sandbox engine turn failed: ${errorMsg}`);
    }
    if (!result) throw new Error(`in-sandbox engine turn produced no result (turn ${turnId})`);
    return result;
  }

  /** The serializable turn spec — identical shape to the pipe runner's (the same EngineCore reads it). */
  private buildSpec(
    args: RunEngineArgs,
    target: NonNullable<RunEngineArgs['target']>,
    turnId: string,
  ): object {
    return {
      turnId,
      engine: args.engine,
      task: args.task,
      cwd: this.toContainerCwd(args.cwd, target),
      writableRoots: [CONTAINER_CONTEXT, ...(args.writableRoots ?? [])],
      systemPrompt: args.systemPrompt,
      sandboxKey: args.sandboxKey,
      mode: args.mode,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      ...(args.auth ? { auth: args.auth } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.richStream ? { richStream: args.richStream } : {}),
    };
  }

  private toContainerCwd(hostCwd: string, target: NonNullable<RunEngineArgs['target']>): string {
    const root = target.worktreeHost;
    if (root && (hostCwd === root || hostCwd.startsWith(`${root}/`))) {
      return `${CONTAINER_WORKTREE}${hostCwd.slice(root.length)}`;
    }
    return CONTAINER_WORKTREE;
  }

  /** Credentials + the redis transport config the in-container engine reads from process.env (per-exec). */
  private execEnv(turnId: string): Record<string, string> {
    const e: Record<string, string> = {};
    const put = (key: string, value: string | undefined): void => {
      if (value) e[key] = value;
    };
    put('CLAUDE_OAUTH_TOKEN', this.env.get('CLAUDE_OAUTH_TOKEN'));
    put('CODEX_OAUTH_TOKEN', this.env.get('CODEX_OAUTH_TOKEN'));
    e.AGENT_HOME_ROOT = CONTAINER_AGENT_HOME;
    // Redis transport: the engine reads its spec from / writes events to Redis under this turn id.
    e.ENGINE_TRANSPORT = 'redis';
    e.TURN_ID = turnId;
    // The container-reachable Redis URL (the sandbox joins the internal atlas-bus net; falls back to the
    // host REDIS_URL for same-host/dev). Phase 5 swaps this for a per-turn ACL-scoped credential.
    e.REDIS_URL = this.env.get('SANDBOX_REDIS_URL') ?? this.env.get('REDIS_URL') ?? 'redis://redis:6379';
    return e;
  }
}
