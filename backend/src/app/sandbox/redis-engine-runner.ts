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
import { dispatchToolRequest } from '../engine/tool-bridge-host';
import type { ToolBridgeOptions, ToolRequestFrame } from '../engine/engine.types';
import { REDIS_STREAM_PORT, type RedisStreamPort } from '../../_lib/redis/redis.port';
import { CONTAINER_ENGINE, type ContainerEngine } from './container-engine.port';
import {
  CONTAINER_AGENT_HOME,
  CONTAINER_CONTEXT,
  CONTAINER_WORKTREE,
} from './container-paths';
import { SandboxActivityRegistry } from './sandbox-activity.registry';
import { TurnRegistry } from './turn-registry.service';
import { turnKeys, TOOLS_GROUP } from './redis-turn-keys';

/** A frame the in-container engine appends to `turn:{T}:events` (mirrors the pipe runner's NDJSON frames). */
type EventFrame =
  | { t: 'event'; e: EngineEvent }
  | { t: 'heartbeat'; ts: number }
  | { t: 'final'; r: EngineRunResult }
  | { t: 'error'; message: string; auth?: boolean; sessionId?: string };

/** How long the host waits with NO new event/heartbeat before declaring the engine dead (safety net). */
const TAIL_IDLE_TIMEOUT_MS = 120_000;

/** The subset of a turn the attach loop needs — shared by a fresh `run` and a boot `reattach`. */
export interface AttachArgs {
  onEvent?: (e: EngineEvent) => void;
  toolBridge?: ToolBridgeOptions;
  signal?: AbortSignal;
}

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
          // ctx carries the real repoId/author/body for `buildTools` reconstruction on re-attach.
          ctx: { ...(args.turnMeta.ctx ?? {}), orgId: args.turnMeta.orgId, threadId: args.turnMeta.threadId },
        })
        .catch((err) => this.logger.warn(`turn ${turnId}: registry.register failed (continuing): ${err}`));
    }

    // 3) Kick the engine detached, then attach (tail events + serve the tool bridge).
    return this.runAttached(turnId, keys, args, target.containerId, target);
  }

  /**
   * RE-ATTACH to an in-flight turn after a backend restart: the engine kept running (detached) and is
   * still writing to its Redis streams. Resume tailing `events` (from the start, replaying the durable
   * log to rebuild the transcript) + serving the tool bridge — WITHOUT re-kicking the engine. Used by the
   * brain's boot reconcile. See ADR 0001.
   */
  async reattach(
    turnId: string,
    containerId: string,
    args: AttachArgs,
  ): Promise<EngineRunResult> {
    this.logger.log(`re-attaching to in-flight turn ${turnId} (container ${containerId})`);
    return this.runAttached(turnId, turnKeys(turnId), args, containerId, undefined);
  }

  /**
   * The shared attach loop: (optionally kick the engine, for a fresh run) then tail events + serve the
   * tool bridge concurrently until the turn ends, and finalize the registry. Used by both `run` (with a
   * kick) and `reattach` (no kick — the engine is already running).
   */
  private async runAttached(
    turnId: string,
    keys: ReturnType<typeof turnKeys>,
    args: AttachArgs,
    containerId: string,
    kickTarget: NonNullable<RunEngineArgs['target']> | undefined,
  ): Promise<EngineRunResult> {
    return this.activity.track(containerId, async () => {
      const done = { value: false };
      try {
        // Tool-bridge turns: create the host consumer group up front so no tool_request is missed.
        if (args.toolBridge) await this.redis.ensureGroup(keys.tools, TOOLS_GROUP);
        if (kickTarget) {
          await this.containers.execDetached(kickTarget.containerId, ['atlas-engine-turn'], {
            ...(kickTarget.user ? { user: kickTarget.user } : {}),
            env: this.execEnv(turnId),
            cwd: CONTAINER_WORKTREE,
          });
        }
        // The tools loop runs CONCURRENTLY with the events tail; it stops when the tail flips `done`.
        const toolsLoop = args.toolBridge
          ? this.consumeTools(turnId, keys, args.toolBridge, done)
          : Promise.resolve();
        const [result] = await Promise.all([this.tailEvents(turnId, keys, args, done), toolsLoop]);
        return result;
      } finally {
        done.value = true;
        await this.registry
          .finalize(turnId, 'done')
          .catch((err) => this.logger.debug(`turn ${turnId}: finalize failed (ignored): ${err}`));
        // Reclaim the turn's Redis streams — the turn is done + its transcript persisted, and the
        // registry row is gone, so a re-attach will never need them again (retention; no MAXLEN needed).
        await this.redis
          .del(keys.spec, keys.events, keys.tools, keys.replies)
          .catch((err) => this.logger.debug(`turn ${turnId}: stream cleanup failed (ignored): ${err}`));
      }
    });
  }

  /**
   * Drain `turn:{T}:tools` (host-bridge tool_requests) via the consumer group + pending recovery,
   * dispatch each to the in-memory tool impls, and XADD the reply to `turn:{T}:replies`. Runs until the
   * events tail flips `done`. Never throws — a failed tool becomes a `tool_error` reply.
   */
  private async consumeTools(
    turnId: string,
    keys: ReturnType<typeof turnKeys>,
    bridge: ToolBridgeOptions,
    done: { value: boolean },
  ): Promise<void> {
    const consumer = `host-${turnId.slice(0, 8)}`;
    let claimedPending = false;
    while (!done.value) {
      try {
        // On (re)attach, first reclaim any delivered-but-unacked request a dead host left behind.
        const pending = claimedPending
          ? []
          : await this.redis.claimStale({ group: TOOLS_GROUP, consumer, stream: keys.tools, minIdleMs: 0, count: 16 });
        claimedPending = true;
        const fresh = await this.redis.xreadGroup({ group: TOOLS_GROUP, consumer, stream: keys.tools, count: 16, blockMs: 500 });
        for (const entry of [...pending, ...fresh]) {
          const req = entry.data as ToolRequestFrame;
          // Idempotency: a redelivered request (crash after execute, before ack) re-posts the cached
          // reply instead of re-running the (often side-effecting) tool.
          const cached = await this.registry.getToolReply(turnId, req.id).catch(() => null);
          const reply = cached ?? (await dispatchToolRequest(bridge, req));
          if (!cached) {
            // Record the reply BEFORE acking so the dedup row exists if we die before the ack lands.
            await this.registry
              .recordToolReply(turnId, req.id, req.name, reply as unknown as Record<string, unknown>)
              .catch(() => undefined);
          }
          await this.redis.xadd(keys.replies, reply);
          await this.redis.ack(keys.tools, TOOLS_GROUP, [entry.id]);
        }
      } catch (err) {
        // A transient redis error (e.g. the connection closing on shutdown) would otherwise tight-spin —
        // back off briefly so we don't busy-loop + spam logs while the process drains.
        this.logger.debug(`turn ${turnId}: tools loop iteration failed (retrying): ${err}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  /** Tail `turn:{T}:events` until `final`/`error`, feeding `onEvent` + advancing the resume cursor. */
  private async tailEvents(
    turnId: string,
    keys: ReturnType<typeof turnKeys>,
    args: AttachArgs,
    done: { value: boolean },
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
      done.value = true; // stop the concurrent tools loop
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
      // Tool-bridge: tell the entrypoint which host tools exist so it builds the MCP proxy for each.
      ...(args.toolBridge ? { toolBridgeTools: Object.keys(args.toolBridge.tools) } : {}),
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
