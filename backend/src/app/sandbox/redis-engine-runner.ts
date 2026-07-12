import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AUTH_REFRESH_SINK,
  type AuthRefreshSink,
  EngineAuthError,
  EngineDetachedError,
  type EngineEvent,
  type EngineRunResult,
  type EngineRunnerPort,
  type RunEngineArgs,
} from '../engine';
import { dispatchToolRequest } from '../engine/tool-bridge-host';
import { SPEC_VERBATIM_KEYS, pickKeys } from '../engine/engine.types';
import type { HostFrame, ToolBridgeOptions, ToolRequestFrame, TurnSpec } from '../engine/engine.types';
import { gitAuthEnv, gitCredHelperEnv } from '../git';
import { REDIS_STREAM_PORT, type RedisStreamPort } from '../../_lib/redis/redis.port';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import {
  CredentialNeedsReauthError,
  CredentialRefreshService,
} from '../onboarding/credential-refresh.service';
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
import { SandboxActivityRegistry } from './sandbox-activity.registry';
import { SANDBOX_PROVIDER, type SandboxProvider } from './sandbox-provider.port';
import { BrainTurnAlreadyRunningError, TurnRegistry } from './turn-registry.service';
import { turnKeys, TOOLS_GROUP } from './redis-turn-keys';

/** A frame the in-container engine appends to `turn:{T}:events` (mirrors the pipe runner's NDJSON frames). */
type EventFrame =
  | { t: 'event'; e: EngineEvent }
  | { t: 'heartbeat'; ts: number }
  | { t: 'final'; r: EngineRunResult }
  | { t: 'error'; message: string; auth?: boolean; sessionId?: string };

/** How long the host waits with NO new event/heartbeat before checking container liveness (safety net). */
export const TAIL_IDLE_TIMEOUT_MS = 120_000;

/** How often the host pings a tool call's liveness while its handler is awaited. The in-container
 *  reader treats a GAP of several of these (see TOOL_HEARTBEAT_GAP_MS) as a host-side hang. */
const TOOL_HEARTBEAT_INTERVAL_MS = Number(process.env['TOOL_HEARTBEAT_INTERVAL_MS']) || 10_000;

/** Absolute ceiling on extended patience for a container that's still `running` past the idle timeout —
 *  covers a real (if unusual) live-verification turn that starves the heartbeat under heavy CPU/IO, without
 *  granting infinite grace to a container whose engine process died while its own init stayed up. */
export const TAIL_ALIVE_GRACE_CEILING_MS = 600_000;

/** Minimum gap between `docker inspect` liveness re-checks during an extended grace window — the idle poll
 *  ticks roughly every second (`blockMs`), and re-inspecting that often would needlessly load the daemon. */
export const TAIL_INSPECT_THROTTLE_MS = 10_000;

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

  /** Turn ids THIS process is currently attach-looping (see {@link isAttached}). */
  private readonly attached = new Set<string>();

  /** Transient per-turn finalize outcome, read once by the error path (no `result` to carry it). */
  private readonly lastClaim = new Map<string, boolean>();

  constructor(
    @Inject(CONTAINER_ENGINE) private readonly containers: ContainerEngine,
    @Inject(REDIS_STREAM_PORT) private readonly redis: RedisStreamPort,
    private readonly env: EnvService,
    private readonly activity: SandboxActivityRegistry,
    private readonly registry: TurnRegistry,
    // Optional so direct-instantiation unit tests (and any runner built without the onboarding module)
    // still construct — absent → the auth-refresh write-back is simply skipped.
    @Optional() @Inject(AUTH_REFRESH_SINK) private readonly authRefreshSink?: AuthRefreshSink,
    // Optional for the same reason (direct-instantiation tests). Absent → auth resolution is skipped and a
    // turn relies on the caller-supplied `args.auth` exactly as before. In the real (@Global onboarding) app
    // it is always present, so this seam authoritatively resolves per-org auth for EVERY engine turn.
    @Optional() private readonly creds?: CredentialResolver,
    // Optional for the same reason (direct-instantiation unit tests). Absent → the app-mode token-file seed
    // at spawn is simply skipped (the leader-gated refresh sweep still converges the file on its next tick).
    @Optional() @Inject(SANDBOX_PROVIDER) private readonly sandboxProvider?: SandboxProvider,
    // Optional for the same reason. Absent → no host-side pre-turn refresh; a turn relies on the in-container
    // SDK self-refresh exactly as before. Present in the real app (exported by the @Global onboarding module).
    @Optional() private readonly credRefresh?: CredentialRefreshService,
  ) {}

  async run(args: RunEngineArgs): Promise<EngineRunResult> {
    const target = args.target;
    if (!target?.containerId) {
      throw new Error('RedisEngineRunner requires args.target.containerId (docker sandbox mode)');
    }

    // Resolve the per-org subscription secret HERE — the single seam EVERY engine turn flows through — so no
    // individual call site (builder, review lens, brain, gate, autofix fix) can forget it: a claude turn is a
    // claude turn, authenticated the same way regardless of who dispatched it. Keyed by the turn's own org
    // (`sandboxKey.orgId`, always present) + engine; an explicit caller-supplied `args.auth` still wins. When
    // the org has no secret this stays undefined and the in-sandbox `EngineCore.resolveAuth` throws the clear
    // "no credential" error — same outcome as before, just no longer dependent on each caller remembering.
    if (!args.auth && this.creds) {
      let auth = await this.creds.engineAuth(args.sandboxKey.orgId, args.engine);
      // Proactively refresh a personal Claude OAuth token on the HOST before the turn materializes it —
      // serialized per-credential by `ensureFresh`'s row lock so concurrent turns share ONE refresh instead of
      // racing the rotating refresh token. A hard failure (dead refresh token) short-circuits the sandbox
      // spin-up and surfaces through the existing EngineAuthError relay/catch path; a transient failure falls
      // through to the stored secret (the in-container SDK self-refresh remains the mid-turn fallback).
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
            throw new EngineAuthError('Claude login expired — reconnect it in Settings.');
          }
          this.logger.warn(
            `pre-turn claude refresh failed (continuing with stored secret): ${err}`,
          );
        }
      }
      if (auth) args = { ...args, auth };
    }

    const turnId = randomUUID();
    const keys = turnKeys(turnId);
    const spec = this.buildSpec(args, target, turnId);

    // 1) Publish the spec the engine reads on startup.
    await this.redis.xadd(keys.spec, spec);

    // 2) Register the turn for restart re-attach. Best-effort by default (a turn still runs without a
    //    registry row), BUT when the caller passes `onTurnRegistered` it stamps an operator message
    //    `delivered_at` off this registration — so the row MUST be durable: await + rethrow, aborting the
    //    turn on failure (the message stays pending; the delivery pump retries) rather than claiming a
    //    hand-off that can't be re-attached.
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
          // ctx carries the real repoId/author/body for `buildTools` reconstruction on re-attach.
          ctx: { ...(args.turnMeta.ctx ?? {}), orgId: args.turnMeta.orgId, jobId: args.turnMeta.jobId },
        });
        registered = true;
      } catch (err) {
        if (err instanceof BrainTurnAlreadyRunningError) {
          // The single-running-brain-turn guard rejected us: a brain turn is already live for this job. Do
          // NOT kick a second engine (the whole point) — the spec XADD'd above is unread and TTL-reaped. The
          // caller (AgentSessionManager) catches this and steers this stimulus into the live turn instead.
          throw err;
        }
        // Any other registry failure: a delivery hand-off (`onTurnRegistered` stamps `delivered_at` off the
        // row) needs a durable row, so rethrow — the message stays pending and the pump retries. Without a
        // hand-off the turn can still run un-registered (loses restart re-attach only), so warn + continue.
        if (args.onTurnRegistered) throw err;
        this.logger.warn(`turn ${turnId}: registry.register failed (continuing): ${err}`);
      }
    }

    // 3) Kick the engine detached, then attach (tail events + serve the tool bridge). `onTurnRegistered`
    //    fires from INSIDE runAttached once the kick lands — the true restart-survivable hand-off point
    //    (registered row + a running engine; boot re-attach never re-kicks). Only when the row exists.
    const onKicked =
      args.turnMeta && args.onTurnRegistered ? () => args.onTurnRegistered!(turnId) : undefined;
    // App-mode in-sandbox git reads its token from a host-refreshed file (mid-turn refresh). Seed it fresh
    // at spawn — the exec env is frozen for the turn's lifetime, so the file (not the env) carries rolls.
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
        args,
        target.containerId,
        target,
        onKicked,
        registered,
      );
      await this.persistAuthRefresh(args, result);
      return result;
    } catch (err) {
      // `run()` callers do not know the generated turn id when the turn throws, so any no-result claim
      // stored under that id is unreachable. Reattach callers pass the turn id explicitly and still consume
      // their error-path claim via consumeClaim(turnId).
      this.lastClaim.delete(turnId);
      throw err;
    }
  }

  /**
   * Auth-refresh write-back (best-effort, host-side). When a Codex turn refreshed its `auth.json` the
   * in-container engine relays the fresh blob on `result.refreshedAuthSecret`; persist it to the org
   * credential via the sink, keyed by the host-only `auth.refreshBack` provenance (never serialized into
   * the container). Never throws — a failed persist must not fail an already-completed turn. NOTE: this
   * runs after `runAttached` has reclaimed the Redis streams, so the refreshed blob only survives in the
   * in-memory `result`; a host crash in this window drops that one refresh (self-corrects next turn).
   */
  private async persistAuthRefresh(args: RunEngineArgs, result: EngineRunResult): Promise<void> {
    const provenance = args.auth?.refreshBack;
    if (!result.refreshedAuthSecret || !provenance || !this.authRefreshSink) return;
    try {
      await this.authRefreshSink.persist(provenance, result.refreshedAuthSecret);
    } catch (err) {
      this.logger.warn(`auth-refresh write-back failed (ignored): ${err instanceof Error ? err.message : err}`);
    }
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
    return this.runAttached(turnId, turnKeys(turnId), args, containerId, undefined, undefined, true);
  }

  /** True while this process has a live attach loop on `turnId` (guards the promotion re-attach sweep). */
  isAttached(turnId: string): boolean {
    return this.attached.has(turnId);
  }

  /** Read+delete this turn's finalize outcome — for the error path where no `result` carries `claimed`. */
  consumeClaim(turnId: string): boolean | undefined {
    const v = this.lastClaim.get(turnId);
    this.lastClaim.delete(turnId);
    return v;
  }

  /** Atomically claim the in-process attach slot for a turn (single synchronous check-and-add ⇒ no TOCTOU). */
  tryClaimAttach(turnId: string): boolean {
    if (this.attached.has(turnId)) return false;
    this.attached.add(turnId);
    return true;
  }

  /** Release an attach slot claimed by {@link tryClaimAttach} when the caller bails before attaching. */
  releaseAttach(turnId: string): void {
    this.attached.delete(turnId);
  }

  /**
   * STEER a running turn: XADD an operator message to `turn:{T}:input`. The in-container entrypoint reads
   * the durable stream and injects it into the live SDK session with `priority:'now'`. Durable so a steer
   * published a beat before the engine's input reader attaches is still delivered (read from '0-0'). The
   * `id` (the steer's stimulus id) rides the frame so the engine emits a correlated `input_ack` once it
   * PUSHES the message — the caller stamps `delivered_at` on that ack, never on this write. A redelivered
   * id is a no-op push in-container (exactly-once injection) but still re-acks, so re-drives converge.
   */
  async steer(turnId: string, id: string, text: string): Promise<void> {
    await this.redis.xadd(turnKeys(turnId).input, { id, text });
  }

  /**
   * STOP a running turn: publish a cooperative abort to `turn:{T}:abort`. The entrypoint aborts the SDK
   * query; the engine returns its partial result gracefully, writes `final`, and the normal completion
   * path (tailEvents → runAttached finally) finalizes the registry row + reclaims the streams.
   */
  async stop(turnId: string): Promise<void> {
    await this.redis.publish(turnKeys(turnId).abort, { t: 'abort' });
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
    onKicked: (() => void) | undefined,
    wasRegistered: boolean,
  ): Promise<EngineRunResult> {
    return this.activity.thread(containerId, async () => {
      const done = { value: false };
      let result: EngineRunResult | undefined;
      // Distinguishes "the TURN concluded" (final/error frame, idle-timeout verdict) from "WE lost the
      // tail" (our Redis client died — typically this process's own shutdown during a watch respawn).
      // Only a concluded turn may finalize the registry row + reclaim the streams: they are exactly the
      // state the next boot's re-attach needs to resume a still-running detached engine (ADR 0001).
      let detached = false;
      this.attached.add(turnId);
      try {
        // Tool-bridge turns: create the host consumer group up front so no tool_request is missed.
        if (args.toolBridge) await this.redis.ensureGroup(keys.tools, TOOLS_GROUP);
        if (kickTarget) {
          await this.containers.execDetached(kickTarget.containerId, ['atlas-engine-turn'], {
            ...(kickTarget.user ? { user: kickTarget.user } : {}),
            env: this.execEnv(turnId, kickTarget),
            cwd: CONTAINER_WORKTREE,
          });
          // Hand-off point: the row is registered AND the engine is running detached, so the turn is now
          // restart-survivable (boot re-attach resumes it without re-kicking). Fire the caller's stamp hook.
          try {
            onKicked?.();
          } catch (err) {
            this.logger.debug(`turn ${turnId}: onTurnRegistered hook threw (ignored): ${err}`);
          }
        }
        // The tools loop runs CONCURRENTLY with the events tail; it stops when the tail flips `done`.
        const toolsLoop = args.toolBridge
          ? this.consumeTools(turnId, keys, args.toolBridge, done)
          : Promise.resolve();
        result = (
          await Promise.all([this.tailEvents(turnId, keys, containerId, args, done), toolsLoop])
        )[0];
        result.turnId = turnId;
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
          // finalize deletes the row and reports whether THIS caller deleted it. An UNREGISTERED turn has no
          // row to race on ⇒ it is always the sole finisher ⇒ claimed = true regardless of affected count.
          const deletedByUs = await this.registry
            .finalize(turnId, 'done')
            .catch((err) => {
              this.logger.debug(`turn ${turnId}: finalize failed (ignored): ${err}`);
              return true; // finalize error ⇒ default to claimed: dropping a real transcript is worse than a rare dup
            });
          const won = wasRegistered ? deletedByUs : true;
          // Carry the outcome on `result` when there is one; only the error path (no `result`) needs the
          // Map, and consumeClaim() drains that entry. Stashing a result-carried outcome would leak an
          // entry per turn forever (the success paths gate on `result.claimed` and never consume it).
          if (result) result.claimed = won;
          else this.lastClaim.set(turnId, won);
          // Reclaim the turn's Redis streams — the turn is done + its transcript persisted, and the
          // registry row is gone, so a re-attach will never need them again (retention; no MAXLEN needed).
          await this.redis
            .del(keys.spec, keys.events, keys.tools, keys.replies)
            .catch((err) => this.logger.debug(`turn ${turnId}: stream cleanup failed (ignored): ${err}`));
        }
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
    // Route bridged-tool throws to the real Logger so the true cause (message + stack) lands in the
    // host logs — the sandbox only ever sees a bounded `.message`, so without this an empty/opaque
    // handler error is invisible except as a bare `Error:` in the operator UI.
    bridge.onToolError ??= (line: string) => this.logger.error(`turn ${turnId}: ${line}`);
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
          // `getToolReply` returns the reply as a plain decoded-JSON record (its storage shape), not the
          // narrower `HostFrame` union — cast here as the dispatch path below already does for the write.
          const cached = await this.registry.getToolReply(turnId, req.id).catch(() => null);
          let reply: HostFrame | null = cached as HostFrame | null;
          if (!reply) {
            // Emit an IMMEDIATE heartbeat on pickup (before starting the interval) so the in-container
            // reader's idle timer is refreshed the moment the host begins the call, then keep beating on
            // an interval while the (possibly long-running) handler is awaited.
            const beat = () =>
              void this.redis
                .xadd(keys.replies, { t: 'tool_progress', id: req.id, ts: Date.now() })
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
    containerId: string,
    args: AttachArgs,
    done: { value: boolean },
  ): Promise<EngineRunResult> {
    let lastId = '0-0';
    let lastActivity = Date.now();
    // First moment we saw a live container past the idle deadline — null while genuinely active. Tracks
    // total time spent in "confirmed alive but quiet" grace, separate from `lastActivity` (which a mere
    // liveness re-check must NOT reset, or a wedged-forever container would grant itself infinite grace).
    let aliveGraceSince: number | null = null;
    /** Last time we actually asked docker — throttles `inspect` calls during an extended grace window. */
    let lastInspectAt = 0;
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
        let entries;
        try {
          entries = await this.redis.xread({
            stream: keys.events,
            lastId,
            count: 128,
            blockMs: 1000,
          });
        } catch (err) {
          // OUR transport failed, not the engine — most often this process's own shutdown closing the
          // Redis client mid-`XREAD` (a watch respawn). The detached engine is still running and still
          // writing; throw the marker error so `runAttached` leaves the registry row + streams intact
          // for the next boot's re-attach instead of finalizing a live turn as done. One quick retry
          // rides out a transient blip without misclassifying it as a detach.
          try {
            await new Promise((r) => setTimeout(r, 250));
            entries = await this.redis.xread({ stream: keys.events, lastId, count: 128, blockMs: 1000 });
          } catch {
            throw new EngineDetachedError(
              `events tail lost its Redis transport mid-turn (turn ${turnId}): ${err}`,
            );
          }
        }
        if (entries.length === 0) {
          if (Date.now() - lastActivity > TAIL_IDLE_TIMEOUT_MS) {
            // A quiet tail does NOT mean a dead engine: the in-container heartbeat is an independent 5s
            // timer (engine-entrypoint.ts), so it should keep landing even mid a long silent tool call —
            // but under heavy CPU/IO contention (the engine's OWN verify step building/testing/booting the
            // repo it just changed) the container can genuinely starve the Node event loop long enough to
            // miss several beats. Ask docker directly rather than presuming death. NOTE: this can't reuse
            // `EngineDetachedError` — that leaves the job `running` for a BOOT re-attach, but this backend
            // runs as a long-lived dev process with no periodic re-attach sweep, so a live-but-quiet verdict
            // here would strand the job `running` forever with no path back. Instead: extend patience while
            // the container keeps proving itself alive, capped by an absolute ceiling so a container whose
            // engine process silently died (while the container's own init/supervisor stays up) still ends
            // the turn instead of hanging indefinitely.
            if (aliveGraceSince !== null) {
              if (Date.now() - aliveGraceSince >= TAIL_ALIVE_GRACE_CEILING_MS) {
                errorMsg = `engine produced no events for ${Math.round((Date.now() - aliveGraceSince) / 1000)}s despite the container staying 'running' (exceeded the ${Math.round(TAIL_ALIVE_GRACE_CEILING_MS / 1000)}s alive-grace ceiling — presumed dead)`;
                break;
              }
              // Already in a confirmed-alive grace window — don't hammer `docker inspect` on every ~1s
              // poll tick, just keep waiting until the next throttled re-check is due.
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
  /**
   * Project a host `RunEngineArgs` onto the on-the-wire {@link TurnSpec}. The VERBATIM fields are forwarded by
   * `pickKeys(args, SPEC_VERBATIM_KEYS)` — a single manifest that is compile-checked exhaustive against
   * `RunEngineArgs` (see engine.types), so a new field can never again be silently dropped here. Only the
   * boundary-TRANSFORMED fields are mapped by hand below (cwd/writableRoots → container paths, auth → secret
   * only, toolBridge → tool names). Typed `: TurnSpec`, the same type the in-container entrypoint consumes.
   */
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
      // Send the secret + the non-secret `kind` discriminator into the container — STRIP the host-only
      // `refreshBack` provenance so org ids never ride Redis into the sandbox. Carry the non-secret
      // `persistAuthRefresh` gate ONLY when set so the in-container engine reads its refreshed auth.json
      // back solely for org-sourced credentials.
      ...(args.auth
        ? {
            auth: { secret: args.auth.secret, ...(args.auth.kind ? { kind: args.auth.kind } : {}) },
            ...(args.auth.refreshBack ? { persistAuthRefresh: true } : {}),
          }
        : {}),
      // Tool-bridge: the host closure can't cross — send only the tool NAMES so the entrypoint builds the proxy.
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
  private execEnv(
    turnId: string,
    target?: NonNullable<RunEngineArgs['target']>,
  ): Record<string, string> {
    const e: Record<string, string> = {};
    const put = (key: string, value: string | undefined): void => {
      if (value) e[key] = value;
    };
    // Engine subscription auth is NOT injected via env — it rides the turn spec as explicit `args.auth`
    // (resolved per-org by CredentialResolver.engineAuth). There is no ambient-env fallback.
    e.AGENT_HOME_ROOT = CONTAINER_AGENT_HOME;
    // The central skills store is bind-mounted (this org's whole subtree) at CONTAINER_SKILLS_STORE — see
    // SandboxManager's orgSkillsDir bind. The engine joins each resolved skill's `dirPath` against this.
    e.SKILLS_ROOT = CONTAINER_SKILLS_STORE;
    // Atlas's own MANAGED (system-tier) skills — ONE fixed dir bind-mounted read-only at this path (see
    // SandboxManager's managedSkillsDir bind). The engine joins a `managed: true` skill's `dirPath` here.
    e.SKILLS_MANAGED_ROOT = CONTAINER_SKILLS_MANAGED;
    // Atlas's GIT-SOURCED managed skills — ManagedSkillSyncService's sync target, bind-mounted read-only
    // (see SandboxManager's managedGitSkillsDir bind). The engine joins a `managedGit: true` skill's
    // `dirPath` here.
    e.SKILLS_MANAGED_GIT_ROOT = CONTAINER_SKILLS_MANAGED_GIT;
    // Redis transport: the engine reads its spec from / writes events to Redis under this turn id.
    e.ENGINE_TRANSPORT = 'redis';
    e.TURN_ID = turnId;
    // The container-reachable Redis URL (the sandbox joins the internal atlas-bus net; falls back to the
    // host REDIS_URL for same-host/dev). Phase 5 swaps this for a per-turn ACL-scoped credential.
    e.REDIS_URL = this.env.get('SANDBOX_REDIS_URL') ?? this.env.get('REDIS_URL') ?? 'redis://redis:6379';
    // Authenticated git for mutation turns (brain / build): the agent can fetch/push/merge against the
    // remote from inside the sandbox. The GIT_CONFIG_* extraheader keeps the token out of argv/.git/config
    // (same mechanism as host git + SandboxRefsService); GITHUB_TOKEN/GH_TOKEN let it drive the API/`gh`.
    // GIT_TERMINAL_PROMPT=0 makes a missing/expired token fail fast instead of hanging on a prompt.
    if (target?.gitAuth) {
      const { gitUrl, token, mode } = target.gitAuth;
      if (mode === 'app') {
        // App mode: token rides a host-refreshed FILE via a url-scoped credential helper, not a baked header.
        Object.assign(e, gitCredHelperEnv(gitUrl, GITHUB_TOKEN_FILE));
      } else {
        Object.assign(e, gitAuthEnv(gitUrl, token));
      }
      if (e.GIT_CONFIG_COUNT) {
        // Auth config was actually injected (https github url) — fail fast instead of prompting/falling back
        // to ambient helpers. Only expose GH_TOKEN/GITHUB_TOKEN when a live token exists.
        e.GIT_TERMINAL_PROMPT = '0';
        // NOTE (app mode): GITHUB_TOKEN/GH_TOKEN are baked with the SPAWN-TIME installation token into this
        // frozen exec env and are NOT refreshed mid-turn. Only `git` survives the ~hourly expiry, via the
        // host-refreshed credential FILE above; `gh` and any GITHUB_TOKEN-driven API call read this static
        // value, so they are guaranteed correct only for the token's initial lifetime (normal/short turns).
        // On a >1h turn app-mode in-sandbox `gh` can hit an expired token while `git` keeps working —
        // accepted for now (routing `gh` through the refreshed file needs an in-sandbox wrapper; out of scope).
        if (token) {
          e.GITHUB_TOKEN = token;
          e.GH_TOKEN = token;
        }
      }
      // Attribute the in-sandbox agent's commits to the PAT's own GitHub account (resolved host-side by
      // GitIdentityService) instead of git's ambient default.
      const id = target.gitAuth.identity;
      if (id) {
        put('GIT_AUTHOR_NAME', id.name);
        put('GIT_AUTHOR_EMAIL', id.email);
        put('GIT_COMMITTER_NAME', id.name);
        put('GIT_COMMITTER_EMAIL', id.email);
      }
    }
    return e;
  }
}
