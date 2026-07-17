import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { SessionEngine } from '../../_shared/domain';
import {
  AUTH_REFRESH_SINK,
  type AuthRefreshSink,
  EngineAuthError,
  EngineDetachedError,
  type EngineEvent,
  type EngineRunResult,
  type EngineRunnerPort,
  type RunEngineArgs,
} from '../../_shared/engine';
import type {
  HostFrame,
  ToolBridgeOptions,
  ToolRequestFrame,
  TurnSpec,
} from '../../_shared/engine/engine.types';
import { SPEC_VERBATIM_KEYS, pickKeys } from '../../_shared/engine/engine.types';
import { dispatchToolRequest } from '../../_shared/engine/tool-bridge-host';
import { randomUUID } from 'node:crypto';
import { REDIS_STREAM_PORT, type RedisStreamPort } from '../../_lib/redis/redis.port';
import { gitAuthEnv, gitCredHelperEnv } from '../git/git-auth';
import {
  CredentialNeedsReauthError,
  CredentialRefreshService,
} from '../onboarding/credential-refresh.service';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { LiveTurnStore } from '../surface/live-turn-store';
import { CONTAINER_ENGINE, type ContainerEngine } from './container-engine.port';
import {
  CONTAINER_AGENT_HOME,
  CONTAINER_CONTEXT,
  CONTAINER_PLAYGROUND,
  CONTAINER_SKILLS_MANAGED,
  CONTAINER_SKILLS_MANAGED_GIT,
  CONTAINER_SKILLS_STORE,
  CONTAINER_WORKTREE,
  GITHUB_TOKEN_FILE,
} from './container-paths';
import {
  EVENTS_REALTIME_GROUP,
  EVENTS_RUNNER_GROUP,
  EVENTS_WATCHDOG_GROUP,
  TOOLS_GROUP,
  turnKeys,
} from './redis-turn-keys';
import { SandboxActivityRegistry } from './sandbox-activity.registry';
import { SANDBOX_PROVIDER, type SandboxProvider } from './sandbox-provider.port';
import { drainTurnEventConsumer } from './turn-event-consumer';
import { BrainTurnAlreadyRunningError, TurnRegistry } from './turn-registry.service';

type EventFrame =
  | { t: 'event'; e: EngineEvent }
  | { t: 'heartbeat'; ts: number }
  | { t: 'final'; r: EngineRunResult }
  | {
      t: 'error';
      message: string;
      auth?: boolean;
      sessionId?: string;
      engine?: SessionEngine;
    };

export const TAIL_IDLE_TIMEOUT_MS = 120_000;

const TOOL_HEARTBEAT_INTERVAL_MS = Number(process.env['TOOL_HEARTBEAT_INTERVAL_MS']) || 10_000;

export const TAIL_ALIVE_GRACE_CEILING_MS = 600_000;

export const TAIL_INSPECT_THROTTLE_MS = 10_000;

export interface AttachArgs {
  onEvent?: (e: EngineEvent) => void;
  toolBridge?: ToolBridgeOptions;
  signal?: AbortSignal;
  credentialId?: string;
  liveRoute?: { channel: string; jobId: string; lane?: string };
}

@Injectable()
export class RedisEngineRunner implements EngineRunnerPort {
  private readonly logger = new Logger(RedisEngineRunner.name);

  readonly pushesLiveRouteEvents = true;

  private readonly attached = new Set<string>();

  private readonly lastClaim = new Map<string, boolean>();

  constructor(
    @Inject(CONTAINER_ENGINE) private readonly containers: ContainerEngine,
    @Inject(REDIS_STREAM_PORT) private readonly redis: RedisStreamPort,
    private readonly env: EnvService,
    private readonly activity: SandboxActivityRegistry,
    private readonly registry: TurnRegistry,
    @Optional()
    @Inject(AUTH_REFRESH_SINK)
    private readonly authRefreshSink?: AuthRefreshSink,
    @Optional() private readonly creds?: CredentialResolver,
    @Optional()
    @Inject(SANDBOX_PROVIDER)
    private readonly sandboxProvider?: SandboxProvider,
    @Optional() private readonly credRefresh?: CredentialRefreshService,
    @Optional() private readonly liveTurns?: LiveTurnStore,
  ) {}

  async run(args: RunEngineArgs): Promise<EngineRunResult> {
    const target = args.target;
    if (!target?.containerId) {
      throw new Error('RedisEngineRunner requires args.target.containerId (docker sandbox mode)');
    }

    let auth =
      args.auth ??
      (this.creds ? await this.creds.engineAuth(args.sandboxKey.orgId, args.engine) : undefined);
    if (
      auth?.kind === 'personal' &&
      auth.refreshBack?.engine === 'claude' &&
      auth.refreshBack.credentialId &&
      this.credRefresh
    ) {
      try {
        const fresh = await this.credRefresh.ensureFresh(
          args.sandboxKey.orgId,
          auth.refreshBack.credentialId,
        );
        auth = { ...auth, secret: fresh };
      } catch (err) {
        if (err instanceof CredentialNeedsReauthError) {
          throw new EngineAuthError(
            'Claude login expired — reconnect it in Settings.',
            undefined,
            'claude',
            true,
          );
        }
        this.logger.warn(`pre-turn claude refresh failed (continuing with stored secret): ${err}`);
      }
    }
    if (auth && auth !== args.auth) args = { ...args, auth };

    const turnId = randomUUID();
    const keys = turnKeys(turnId);
    const spec = this.buildSpec(args, target, turnId);

    await this.redis.xadd(keys.spec, spec);

    let registered = false;
    if (args.turnMeta) {
      try {
        await this.registry.register({
          turnId,
          jobId: args.turnMeta.jobId,
          orgId: args.turnMeta.orgId,
          channel: args.turnMeta.channel,
          lane: args.turnMeta.lane,
          kind: args.turnMeta.kind,
          containerId: target.containerId,
          steerable: args.steerable ?? false,
          ctx: {
            ...(args.turnMeta.ctx ?? {}),
            orgId: args.turnMeta.orgId,
            jobId: args.turnMeta.jobId,
            ...(auth?.refreshBack?.credentialId
              ? { credentialId: auth.refreshBack.credentialId }
              : {}),
          },
        });
        registered = true;
      } catch (err) {
        if (err instanceof BrainTurnAlreadyRunningError) {
          throw err;
        }
        if (args.onTurnRegistered) throw err;
        this.logger.warn(`turn ${turnId}: registry.register failed (continuing): ${err}`);
      }
    }

    const onKicked =
      args.turnMeta && args.onTurnRegistered ? () => args.onTurnRegistered!(turnId) : undefined;
    if (
      target.gitAuth?.mode === 'app' &&
      target.gitAuth.token &&
      args.turnMeta?.jobId &&
      this.sandboxProvider?.writeGithubTokenFile
    ) {
      await this.sandboxProvider
        .writeGithubTokenFile(args.turnMeta.jobId, target.gitAuth.token)
        .catch((err) => this.logger.warn(`seed github-token file failed: ${err}`));
    }

    try {
      const result = await this.runAttached(
        turnId,
        keys,
        {
          onEvent: args.onEvent,
          toolBridge: args.toolBridge,
          signal: args.signal,
          credentialId: auth?.refreshBack?.credentialId,
          liveRoute: args.liveRoute,
        },
        target.containerId,
        target,
        onKicked,
        registered,
      );
      await this.persistAuthRefresh(args, result);
      return result;
    } catch (err) {
      this.lastClaim.delete(turnId);
      throw err;
    }
  }

  private async persistAuthRefresh(args: RunEngineArgs, result: EngineRunResult): Promise<void> {
    const provenance = args.auth?.refreshBack;
    if (!result.refreshedAuthSecret || !provenance || !this.authRefreshSink) return;
    try {
      await this.authRefreshSink.persist(provenance, result.refreshedAuthSecret);
    } catch (err) {
      this.logger.warn(
        `auth-refresh write-back failed (ignored): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async reattach(turnId: string, containerId: string, args: AttachArgs): Promise<EngineRunResult> {
    this.logger.log(`re-attaching to in-flight turn ${turnId} (container ${containerId})`);
    return this.runAttached(
      turnId,
      turnKeys(turnId),
      args,
      containerId,
      undefined,
      undefined,
      true,
    );
  }

  isAttached(turnId: string): boolean {
    return this.attached.has(turnId);
  }

  consumeClaim(turnId: string): boolean | undefined {
    const v = this.lastClaim.get(turnId);
    this.lastClaim.delete(turnId);
    return v;
  }

  tryClaimAttach(turnId: string): boolean {
    if (this.attached.has(turnId)) return false;
    this.attached.add(turnId);
    return true;
  }

  releaseAttach(turnId: string): void {
    this.attached.delete(turnId);
  }

  async steer(turnId: string, id: string, text: string): Promise<void> {
    await this.redis.xadd(turnKeys(turnId).input, { id, text });
  }

  async stop(turnId: string): Promise<void> {
    await this.redis.publish(turnKeys(turnId).abort, { t: 'abort' });
  }

  private async runAttached(
    turnId: string,
    keys: ReturnType<typeof turnKeys>,
    args: AttachArgs,
    containerId: string,
    kickTarget: NonNullable<RunEngineArgs['target']> | undefined,
    onKicked: (() => void) | undefined,
    wasRegistered: boolean,
  ): Promise<EngineRunResult> {
    return this.activity.thread(containerId, async () => {
      const done = { value: false };
      let result: EngineRunResult | undefined;
      let detached = false;
      this.attached.add(turnId);
      try {
        if (args.toolBridge) await this.redis.ensureGroup(keys.tools, TOOLS_GROUP);
        await this.redis.ensureGroup(keys.events, EVENTS_RUNNER_GROUP);
        await this.redis.ensureGroup(keys.events, EVENTS_WATCHDOG_GROUP);
        if (kickTarget) {
          await this.containers.execDetached(kickTarget.containerId, ['atlas-engine-turn'], {
            ...(kickTarget.user ? { user: kickTarget.user } : {}),
            env: this.execEnv(turnId, kickTarget),
            cwd: CONTAINER_WORKTREE,
          });
          try {
            onKicked?.();
          } catch (err) {
            this.logger.debug(`turn ${turnId}: onTurnRegistered hook threw (ignored): ${err}`);
          }
        }
        const toolsLoop = args.toolBridge
          ? this.consumeTools(turnId, keys, args.toolBridge, done)
          : Promise.resolve();
        const realtimeLoop =
          args.liveRoute && this.liveTurns
            ? this.consumeRealtime(turnId, keys, args.liveRoute, done)
            : Promise.resolve();
        result = (
          await Promise.all([
            this.tailEvents(turnId, keys, containerId, args, done),
            toolsLoop,
            realtimeLoop,
            this.consumeWatchdog(turnId, keys, done),
          ])
        )[0];
        result.turnId = turnId;
        if (args.credentialId) result.credentialId = args.credentialId;
        return result;
      } catch (err) {
        detached = err instanceof EngineDetachedError;
        throw err;
      } finally {
        done.value = true;
        this.attached.delete(turnId);
        if (detached) {
          this.logger.warn(
            `turn ${turnId}: tail detached mid-turn — leaving registry row + streams for boot re-attach`,
          );
        } else {
          const deletedByUs = await this.registry.finalize(turnId, 'done').catch((err) => {
            this.logger.debug(`turn ${turnId}: finalize failed (ignored): ${err}`);
            return true; // finalize error ⇒ default to claimed: dropping a real transcript is worse than a rare dup
          });
          const won = wasRegistered ? deletedByUs : true;
          if (result) result.claimed = won;
          else this.lastClaim.set(turnId, won);
          await this.redis
            .del(keys.spec, keys.events, keys.tools, keys.replies)
            .catch((err) =>
              this.logger.debug(`turn ${turnId}: stream cleanup failed (ignored): ${err}`),
            );
        }
      }
    });
  }

  private async consumeTools(
    turnId: string,
    keys: ReturnType<typeof turnKeys>,
    bridge: ToolBridgeOptions,
    done: { value: boolean },
  ): Promise<void> {
    const consumer = `host-${turnId.slice(0, 8)}`;
    bridge.onToolError ??= (line: string) => this.logger.error(`turn ${turnId}: ${line}`);
    await drainTurnEventConsumer({
      redis: this.redis,
      stream: keys.tools,
      group: TOOLS_GROUP,
      consumer,
      count: 16,
      blockMs: 500,
      isDone: () => done.value,
      onEntry: async (entry) => {
        const req = entry.data as ToolRequestFrame;
        const cached = await this.registry.getToolReply(turnId, req.id).catch(() => null);
        let reply: HostFrame | null = cached as HostFrame | null;
        if (!reply) {
          const beat = () =>
            void this.redis
              .xadd(keys.replies, {
                t: 'tool_progress',
                id: req.id,
                ts: Date.now(),
              })
              .catch(() => undefined);
          beat();
          const hb = setInterval(beat, TOOL_HEARTBEAT_INTERVAL_MS);
          if (typeof hb.unref === 'function') hb.unref();
          try {
            reply = await dispatchToolRequest(bridge, req);
          } finally {
            clearInterval(hb);
          }
        }
        if (!cached) {
          await this.registry
            .recordToolReply(turnId, req.id, req.name, reply as unknown as Record<string, unknown>)
            .catch(() => undefined);
        }
        await this.redis.xadd(keys.replies, reply);
        return false;
      },
    });
  }

  private async consumeRealtime(
    turnId: string,
    keys: ReturnType<typeof turnKeys>,
    route: { channel: string; jobId: string; lane?: string },
    done: { value: boolean },
  ): Promise<void> {
    const consumer = `realtime-${turnId.slice(0, 8)}`;
    await drainTurnEventConsumer({
      redis: this.redis,
      stream: keys.events,
      group: EVENTS_REALTIME_GROUP,
      consumer,
      isDone: () => done.value,
      onEntry: (entry) => {
        const frame = entry.data as EventFrame;
        if (frame.t === 'event') {
          this.liveTurns!.push(route.channel, route.jobId, frame.e, route.lane);
        }
        return frame.t === 'final' || frame.t === 'error';
      },
    });
  }

  private async consumeWatchdog(
    turnId: string,
    keys: ReturnType<typeof turnKeys>,
    done: { value: boolean },
  ): Promise<void> {
    const consumer = `watchdog-${turnId.slice(0, 8)}`;
    await drainTurnEventConsumer({
      redis: this.redis,
      stream: keys.events,
      group: EVENTS_WATCHDOG_GROUP,
      consumer,
      isDone: () => done.value,
      onEntry: async (entry) => {
        await this.registry.heartbeat(turnId, entry.id).catch(() => undefined);
        const frame = entry.data as EventFrame;
        return frame.t === 'final' || frame.t === 'error';
      },
    });
  }

  private async tailEvents(
    turnId: string,
    keys: ReturnType<typeof turnKeys>,
    containerId: string,
    args: AttachArgs,
    done: { value: boolean },
  ): Promise<EngineRunResult> {
    const consumer = `runner-${turnId.slice(0, 8)}`;
    let claimedPending = false;
    let lastId = '0-0';
    let lastActivity = Date.now();
    let aliveGraceSince: number | null = null;
    let lastInspectAt = 0;
    let result: EngineRunResult | undefined;
    let errorMsg: string | undefined;
    let errorAuth = false;
    let errorSession: string | undefined;
    let errorEngine: SessionEngine | undefined;

    const onAbort = (): void => {
      void this.redis.publish(keys.abort, { t: 'abort' });
    };
    if (args.signal) {
      if (args.signal.aborted) onAbort();
      else args.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      while (result === undefined && errorMsg === undefined) {
        let entries;
        try {
          const pending = claimedPending
            ? []
            : await this.redis.claimStale({
                group: EVENTS_RUNNER_GROUP,
                consumer,
                stream: keys.events,
                minIdleMs: 0,
                count: 128,
              });
          const fresh = await this.redis.xreadGroup({
            group: EVENTS_RUNNER_GROUP,
            consumer,
            stream: keys.events,
            count: 128,
            blockMs: 1000,
          });
          claimedPending = true;
          entries = [...pending, ...fresh];
        } catch (err) {
          try {
            await new Promise((r) => setTimeout(r, 250));
            entries = await this.redis.xreadGroup({
              group: EVENTS_RUNNER_GROUP,
              consumer,
              stream: keys.events,
              count: 128,
              blockMs: 1000,
            });
          } catch {
            throw new EngineDetachedError(
              `events tail lost its Redis transport mid-turn (turn ${turnId}): ${err}`,
            );
          }
        }
        if (entries.length === 0) {
          if (Date.now() - lastActivity > TAIL_IDLE_TIMEOUT_MS) {
            if (aliveGraceSince !== null) {
              if (Date.now() - aliveGraceSince >= TAIL_ALIVE_GRACE_CEILING_MS) {
                errorMsg = `engine produced no events for ${Math.round((Date.now() - aliveGraceSince) / 1000)}s despite the container staying 'running' (exceeded the ${Math.round(TAIL_ALIVE_GRACE_CEILING_MS / 1000)}s alive-grace ceiling — presumed dead)`;
                break;
              }
              if (Date.now() - lastInspectAt < TAIL_INSPECT_THROTTLE_MS) continue;
            }
            lastInspectAt = Date.now();
            const info = await this.containers.inspect(containerId).catch(() => null);
            if (info?.state === 'running') {
              aliveGraceSince ??= Date.now();
              this.logger.warn(
                `turn ${turnId}: no events for ${Math.round((Date.now() - lastActivity) / 1000)}s but container ${containerId} is still running — extending patience (grace elapsed ${Math.round((Date.now() - aliveGraceSince) / 1000)}s / ${Math.round(TAIL_ALIVE_GRACE_CEILING_MS / 1000)}s ceiling)`,
              );
              continue;
            }
            errorMsg = aliveGraceSince
              ? `engine produced no events and container ${containerId} went from 'running' to '${info?.state ?? 'gone'}' mid-grace (presumed dead)`
              : `engine produced no events for ${Math.round(TAIL_IDLE_TIMEOUT_MS / 1000)}s and container is ${info?.state ?? 'gone'} (presumed dead)`;
            break;
          }
          continue;
        }
        lastActivity = Date.now();
        aliveGraceSince = null;
        for (const entry of entries) {
          lastId = entry.id;
          const frame = entry.data as EventFrame;
          if (frame.t === 'event') {
            const e = frame.e;
            args.onEvent?.(e.kind === 'rate_limit' ? { ...e, credentialId: args.credentialId } : e);
          } else if (frame.t === 'final') result = frame.r;
          else if (frame.t === 'error') {
            errorMsg = frame.message;
            errorAuth = !!frame.auth;
            errorSession = frame.sessionId;
            errorEngine = frame.engine;
          }
        }
        try {
          await this.redis.ack(
            keys.events,
            EVENTS_RUNNER_GROUP,
            entries.map((e) => e.id),
          );
        } catch (err) {
          try {
            await new Promise((r) => setTimeout(r, 250));
            await this.redis.ack(
              keys.events,
              EVENTS_RUNNER_GROUP,
              entries.map((e) => e.id),
            );
          } catch {
            throw new EngineDetachedError(
              `events tail lost its Redis transport acking a batch mid-turn (turn ${turnId}): ${err}`,
            );
          }
        }
      }
    } finally {
      args.signal?.removeEventListener('abort', onAbort);
      done.value = true; // stop the concurrent tools loop
    }

    if (errorMsg) {
      if (errorAuth) throw new EngineAuthError(errorMsg, errorSession, errorEngine);
      throw new Error(`in-sandbox engine turn failed: ${errorMsg}`);
    }
    if (!result) throw new Error(`in-sandbox engine turn produced no result (turn ${turnId})`);
    return result;
  }

  private buildSpec(
    args: RunEngineArgs,
    target: NonNullable<RunEngineArgs['target']>,
    turnId: string,
  ): TurnSpec {
    return {
      ...pickKeys(args, SPEC_VERBATIM_KEYS),
      turnId,
      cwd: this.toContainerCwd(args.cwd, target),
      writableRoots: [CONTAINER_CONTEXT, CONTAINER_PLAYGROUND, ...(args.writableRoots ?? [])],
      ...(args.auth
        ? {
            auth: {
              secret: args.auth.secret,
              ...(args.auth.kind ? { kind: args.auth.kind } : {}),
            },
            ...(args.auth.refreshBack ? { persistAuthRefresh: true } : {}),
          }
        : {}),
      ...(args.toolBridge
        ? {
            toolBridgeTools: Object.keys(args.toolBridge.tools).filter((n) => !n.startsWith('__')),
          }
        : {}),
    };
  }

  private toContainerCwd(hostCwd: string, target: NonNullable<RunEngineArgs['target']>): string {
    const root = target.worktreeHost;
    if (root && (hostCwd === root || hostCwd.startsWith(`${root}/`))) {
      return `${CONTAINER_WORKTREE}${hostCwd.slice(root.length)}`;
    }
    return CONTAINER_WORKTREE;
  }

  private execEnv(
    turnId: string,
    target?: NonNullable<RunEngineArgs['target']>,
  ): Record<string, string> {
    const e: Record<string, string> = {};
    const put = (key: string, value: string | undefined): void => {
      if (value) e[key] = value;
    };
    e.AGENT_HOME_ROOT = CONTAINER_AGENT_HOME;
    e.SKILLS_ROOT = CONTAINER_SKILLS_STORE;
    e.SKILLS_MANAGED_ROOT = CONTAINER_SKILLS_MANAGED;
    e.SKILLS_MANAGED_GIT_ROOT = CONTAINER_SKILLS_MANAGED_GIT;
    e.ENGINE_TRANSPORT = 'redis';
    e.TURN_ID = turnId;
    e.REDIS_URL =
      this.env.get('SANDBOX_REDIS_URL') ?? this.env.get('REDIS_URL') ?? 'redis://redis:6379';
    if (target?.gitAuth) {
      const { gitUrl, token, apiToken, mode } = target.gitAuth;
      if (mode === 'app') {
        Object.assign(e, gitCredHelperEnv(gitUrl, GITHUB_TOKEN_FILE));
      } else {
        Object.assign(e, gitAuthEnv(gitUrl, token));
      }
      if (e.GIT_CONFIG_COUNT) {
        e.GIT_TERMINAL_PROMPT = '0';
        const ghToken = apiToken ?? token;
        if (ghToken) {
          e.GITHUB_TOKEN = ghToken;
          e.GH_TOKEN = ghToken;
        }
      }
      const id = target.gitAuth.identity;
      if (id) {
        put('GIT_AUTHOR_NAME', id.name);
        put('GIT_AUTHOR_EMAIL', id.email);
        put('GIT_COMMITTER_NAME', id.name);
        put('GIT_COMMITTER_EMAIL', id.email);
      }
    }
    put('ATLAS_EVIDENCE_DIR', target?.evidenceDir);
    return e;
  }
}
