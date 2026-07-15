import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { SessionEngine, SessionMode, SessionRef } from '../domain';
import {
  ENGINE_RUNNER,
  EngineAuthError,
  EngineSessionLimitError,
  SANDBOX_RESET_NOTICE,
  pickKeys,
  type EngineRunnerPort,
} from '../engine';
import type {
  EngineAuth,
  EngineEvent,
  EngineHomeKey,
  EngineRunResult,
  EngineUsage,
  GitAuth,
  ReasoningEffort,
  ResolvedMcpServer,
  ResolvedSkill,
  SessionLimitHit,
  ToolBridgeOptions,
  TurnMeta,
} from '../engine';
import type { FeatureSandbox } from '../git';
import { type AgentMessage } from '../prompt-kit/message';
import { prependNotice } from '../prompt-kit/harness';
import { TurnUsageProjector } from '../analytics/turn-usage-projector.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { ThreadEntity } from '../persistence/entities';
import { TurnRegistry } from '../sandbox/turn-registry.service';

/** What one turn needs to run. The sandbox supplies the worktree (the engine cwd) + branch. */
export interface RunTurnInput {
  /** The org that owns this job — together with `sandbox.repoId` + `jobId`, keys the build engine's
   *  nested home (see {@link EngineHomeKey}). */
  orgId: string;
  /** The job this turn serves. */
  jobId: string;
  /** The step this turn builds, if any (its `session_id` is the resume handle + is persisted). */
  stepId?: string | null;
  /** The per-feature sandbox (worktree) the turn runs inside. */
  sandbox: FeatureSandbox;
  engine: SessionEngine;
  mode: SessionMode;
  /** The turn instructions. */
  task: AgentMessage;
  /** The system prompt / persona for the turn. */
  systemPrompt: AgentMessage;
  /** Override the engine model for this turn. */
  model?: string;
  /** Engine-agnostic reasoning effort, forwarded to `RunEngineArgs.modelReasoningEffort`. The
   *  master-review thread pins `'xhigh'`. */
  modelReasoningEffort?: ReasoningEffort;
  /** How the turn authenticates (defaults derived from env by the EngineRunner). */
  auth?: EngineAuth;
  /**
   * User-defined MCP servers for this turn, RESOLVED host-side (secrets inlined) by
   * `McpResolver.resolveForTurn`. Passed straight through to `RunEngineArgs.userMcpServers`.
   */
  userMcpServers?: ResolvedMcpServer[];
  /**
   * This repo's skills for this turn, RESOLVED host-side by `SkillResolver.resolveForTurn` as dir paths +
   * names (no bodies). Passed straight through to `RunEngineArgs.skills` — the in-container engine
   * symlinks each into `<CLAUDE_CONFIG_DIR>/skills/`, natively discovered by the SDK.
   */
  skills?: ResolvedSkill[];
  /**
   * The repo's saved preview recipe, forwarded to the in-sandbox engine for the `validate` subagent
   * prompt. Absent ⇒ nothing injected.
   */
  previewInstructions?: string | null;
  /**
   * Authenticated-git for this turn (resolved repo url + org PAT) so the agent can fetch/push/merge from
   * inside the sandbox. Sourced from the RESOLVED repo, NOT `sandbox` (a row-sourced sandbox has empty
   * `gitUrl`/no token). Set by build/execute dispatch; the runner puts it on the docker `target`.
   */
  gitAuth?: GitAuth;
  /**
   * Container path this turn's writers send live-run evidence to (thread leg → its per-thread subfolder,
   * brain/direct-build → the evidence root). A DERIVED → target field like `gitAuth`; the runner puts it
   * on the docker `target` as `ATLAS_EVIDENCE_DIR`. Absent → writers fall back to `/context/evidence`.
   */
  evidenceDir?: string;
  /**
   * Opt into RICH token-level streaming (thinking + tool calls/results + subagent forwarding). Build turns
   * pass this so they ride the shared transcript spine (a full transcript, not coarse text/tool/result).
   */
  richStream?: boolean;
  /**
   * Opt into MID-TURN STEERING: the in-container entrypoint runs the SDK in streaming-input mode and
   * subscribes to `turn:{T}:input`, so the host can inject a message into the RUNNING turn (`priority:'now'`)
   * via {@link TurnRunnerService.steer}. The brain always sets this; Leg-rotation sets it on Claude builder
   * batch turns so the SOFT/HARD occupancy nudges land mid-flight (NEVER on Codex turns). Omit elsewhere.
   */
  steerable?: boolean;
  /**
   * ENGINE-LOCAL Leg-rotation nudge (builder Claude batch turns): threshold + SOFT/REMINDER seed prompts the
   * engine injects itself the instant its own occupancy crosses — race-free vs the post-`result` input close.
   * Forwarded verbatim into {@link RunEngineArgs.rotationNudge}. Omit for non-rotating turns.
   */
  rotationNudge?: {
    softTokens: number;
    reminderDeltaTokens: number;
    softText: AgentMessage;
    reminderText: AgentMessage;
  };
  /** Progress callback. */
  onEvent?: (e: EngineEvent) => void;
  signal?: AbortSignal;
  /**
   * Activate the bidirectional host-side tool bridge for this turn (the in-sandbox session calls host
   * tools over the frame protocol). The brain always sets this; the orchestrate build turn sets it to
   * expose `request_operator_input`. Omit for the plain one-shot build turns (backward-compatible).
   */
  toolBridge?: ToolBridgeOptions;
  /**
   * Registry context for a RESTART-SURVIVABLE Redis-transport turn. When set (and `ENGINE_TRANSPORT=redis`),
   * the runner records an `active_turns` row so a fresh backend can RE-ATTACH this turn's live stream after a
   * restart instead of re-running it. Ignored by the pipe runner. The brain always sets this; build turns
   * set it so a build thread recovers like the brain (see `reattach`). See ADR 0001.
   */
  turnMeta?: TurnMeta;
  /**
   * Fired ONCE, host-side, the instant this turn is DURABLY registered (mirrors
   * `RunEngineArgs.onTurnRegistered`, `engine.types.ts:655`). The build-lane drain uses this to stamp each
   * folded seed's `delivered_at` at the restart-survivable hand-off, exactly like the brain does. In-process
   * callback, not a serialized spec field — forwarded host-side alongside `onEvent`/`signal`, NOT via
   * `TURN_INPUT_FORWARD_KEYS`.
   */
  onTurnRegistered?: (turnId: string) => void;
}

// ── RunTurnInput → RunEngineArgs forwarding contract (second half of the host↔engine wire) ──────────────
// The other half of the drop the Leg-rotation `rotationNudge` fell through. Fields NOT forwarded verbatim
// are either DERIVED into other RunEngineArgs fields, or host-wrapped, or REQUIRED (handled explicitly in
// `runTurn` where a missing one is already a compile error). Everything else must be listed in
// TURN_INPUT_FORWARD_KEYS — the exhaustiveness check below fails the build if a new optional field is added
// to RunTurnInput without being forwarded (so it can never again be silently dropped at this hop).
type TurnInputDerivedOrRequiredKey =
  | 'orgId' | 'jobId' | 'stepId' | 'sandbox' | 'gitAuth' | 'evidenceDir' // derived (→ target / sandboxKey) / host-only
  | 'onEvent' | 'signal' | 'onTurnRegistered' // host-wrapped, set explicitly
  | 'engine' | 'mode' | 'task' | 'systemPrompt'; // required, forwarded explicitly (omission already errors)
type TurnInputForwardKey = Exclude<keyof RunTurnInput, TurnInputDerivedOrRequiredKey>;
const TURN_INPUT_FORWARD_KEYS = [
  'auth', 'userMcpServers', 'skills', 'previewInstructions', 'model', 'modelReasoningEffort',
  'richStream', 'steerable', 'rotationNudge', 'toolBridge', 'turnMeta',
] as const satisfies readonly TurnInputForwardKey[];
const _TURN_INPUT_FORWARD_KEYS_EXHAUSTIVE: [Exclude<TurnInputForwardKey, (typeof TURN_INPUT_FORWARD_KEYS)[number]>] extends [never]
  ? true
  : { ADD_TO_TURN_INPUT_FORWARD_KEYS: Exclude<TurnInputForwardKey, (typeof TURN_INPUT_FORWARD_KEYS)[number]> } = true;
void _TURN_INPUT_FORWARD_KEYS_EXHAUSTIVE;

/** The result of one turn — the engine report + the live SessionRef for the next turn. */
export interface RunTurnResult {
  /** The turn's report (the plan text on a plan turn, else the closing summary). */
  report: string;
  /** A plan, when the turn was a plan turn that captured one. */
  planText?: string;
  usage?: EngineUsage;
  /** The claude_credentials.id this turn authed on; absent for Codex / no-credential turns. */
  credentialId?: string;
  /** Set when the turn ended on a Claude subscription session/usage limit (see {@link EngineRunResult.sessionLimit}).
   *  Pure pass-through from the engine result; the caller decides how to park/resume. */
  sessionLimit?: SessionLimitHit;
  /** The handle the driver holds for the session's next turn. */
  session: SessionRef;
}

/**
 * Atlas v2's LOCAL turn-runner — the seam tying engine + git together, host-only. It opens or resumes
 * an engine session INSIDE a per-feature worktree, runs ONE turn (plan or execute) by calling the
 * `EngineRunner` directly, and persists the minimal session state (the engine session id onto
 * `threads.session_id`, returned in a `SessionRef`). It deliberately BYPASSES v1's
 * `SessionRunnerService` (which throws off-daemon). Zero v1 imports.
 *
 * Statelessness: a turn is identified by the sandbox + an optional prior session id (resumed from the
 * thread row — a thread's single step IS the thread row, so the `stepId` the driver passes is the
 * thread's own id). The runner holds no in-memory session registry — the source of truth is the thread
 * row (durable) and the returned `SessionRef` (the driver's in-memory pointer), so it survives restarts.
 */
@Injectable()
export class TurnRunnerService {
  private readonly logger = new Logger(TurnRunnerService.name);

  constructor(
    @Inject(ENGINE_RUNNER) private readonly engine: EngineRunnerPort,
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    // @Optional so unit tests can construct the runner without wiring analytics; DI (@Global) supplies it live.
    @Optional() private readonly usage?: TurnUsageProjector,
    // @Optional so unit tests can construct the runner without the registry; DI (@Global sandbox module)
    // supplies it live. Needed by the lane-generic host steer/stop resolvers below.
    @Optional() private readonly turnRegistry?: TurnRegistry,
  ) {}

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const { sandbox, stepId, jobId, engine, mode } = input;

    // Resume handle: the thread row's prior session id (if any) — durable across restarts. A thread's single
    // step IS the thread row, so the `stepId` the driver passes is the thread's own id (see driver-store's
    // `toSyntheticStep`). Rotation is now "insert the next builder thread row" (d1), so there is no per-step
    // rotation state to fold here — a rotated Leg is simply a fresh thread row born with `session_id = null`.
    const priorThread = stepId ? await this.threads.findOne({ where: { id: stepId } }) : null;
    const priorSessionId = priorThread?.session_id ?? undefined;

    // The engine-home key namespaces the isolated home + Codex client cache, so two concurrent jobs never
    // share engine state. Keyed by JOB, not branch — a job owns its branch 1:1 (every step/thread of the
    // job commits to the same branch), so the leaf stays STABLE across the job's whole build, not per-turn.
    const sandboxKey: EngineHomeKey = { orgId: input.orgId, repoId: sandbox.repoId, jobId, type: 'build' };

    // Cold re-attach + resume: the container was created/restarted fresh (warm === false) but we're
    // resuming a session that remembers prior in-container state — tell it the box was reset. Flip warm
    // so only the FIRST resumed turn in this drive carries the notice.
    const needsResetNotice = sandbox.warm === false && !!priorSessionId;
    if (sandbox.warm === false) sandbox.warm = true;
    const task = needsResetNotice
      ? prependNotice(SANDBOX_RESET_NOTICE, input.task)
      : input.task;

    this.logger.log(
      `Turn: job=${jobId} step=${stepId ?? '-'} engine=${engine} mode=${mode} ` +
        `cwd=${sandbox.worktreePath}${priorSessionId ? ` resume=${priorSessionId}` : ''}`,
    );

    // Persist the session id the instant the engine surfaces it (turn START) — so a mid-turn halt
    // (process crash, container/host restart, kill) recovers by RESUMING this same session rather than
    // spawning a fresh one. Best-effort write; the turn-end + auth-error persists below are belt-and-braces.
    const onEvent = (e: EngineEvent): void => {
      if (e.kind === 'session' && stepId && e.sessionId) {
        void this.threads.update({ id: stepId }, { session_id: e.sessionId }).catch(() => undefined);
      }
      input.onEvent?.(e);
    };

    let result: EngineRunResult;
    try {
      result = await this.engine.run({
        engine,
        task,
        cwd: sandbox.worktreePath,
        systemPrompt: input.systemPrompt,
        sandboxKey,
        ...(priorSessionId ? { sessionId: priorSessionId } : {}),
        mode,
        // Docker mode: the sandbox carries the container to exec the turn into (set by SANDBOX_PROVIDER).
        ...(sandbox.containerId
          ? {
              target: {
                containerId: sandbox.containerId,
                worktreeHost: sandbox.worktreePath,
                ...(sandbox.execUser ? { user: sandbox.execUser } : {}),
                ...(input.gitAuth ? { gitAuth: input.gitAuth } : {}),
                ...(input.evidenceDir ? { evidenceDir: input.evidenceDir } : {}),
              },
            }
          : {}),
        // All verbatim pass-through fields (auth, userMcpServers, model, modelReasoningEffort, richStream,
        // steerable, rotationNudge, toolBridge, turnMeta) forwarded via the exhaustiveness-checked manifest —
        // so a new RunEngineArgs/RunTurnInput field can never again be silently dropped at this hop.
        ...pickKeys(input, TURN_INPUT_FORWARD_KEYS),
        onEvent,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onTurnRegistered ? { onTurnRegistered: input.onTurnRegistered } : {}),
      });
    } catch (err) {
      // On a 401/auth failure, PERSIST the session id so a re-ping resumes this same session (the
      // agent's partial work is on disk in the worktree) instead of starting the step from scratch.
      if (err instanceof EngineAuthError && stepId && err.sessionId) {
        await this.threads.update({ id: stepId }, { session_id: err.sessionId });
      }
      throw err;
    }

    // Instrumentation: a control-channel "Stream closed" blip that did NOT trip the engine circuit-breaker
    // still leaves a durable trace here — so a near-miss (or a recurrence of the mid-turn stdin-severance
    // incident) is diagnosable after the fact even when no live turn subscriber was attached to observe the
    // in-memory `turn_debug` events. See engine-core's stream-closed circuit-breaker.
    if (result.streamClosedCount) {
      this.logger.warn(
        `turn saw ${result.streamClosedCount} "Stream closed" tool-result(s) job=${jobId} step=${stepId ?? '-'} session=${result.sessionId ?? '-'}`,
      );
    }

    // Session/usage limit — the turn ended CLEANLY on a Claude subscription limit (not a crash). Persist the
    // step session id first (so a resume continues the SAME session, exactly like the auth-error path above),
    // then THROW so the driver's halt-classification chokepoint parks the lane on a resume clock instead of
    // failing the build. Only the build lane calls runTurn (the brain reads result.sessionLimit directly).
    if (result.sessionLimit) {
      if (stepId && result.sessionId) {
        await this.threads.update({ id: stepId }, { session_id: result.sessionId });
      }
      const { resetAt, rateLimitType } = result.sessionLimit;
      const message = `Claude session limit${rateLimitType ? ` (${rateLimitType})` : ''}${resetAt ? `; resets ${resetAt}` : ''}`;
      throw new EngineSessionLimitError(
        message, resetAt, rateLimitType, result.sessionId, input.auth?.refreshBack?.credentialId,
      );
    }

    // Persist the engine session id so the next turn (or a post-restart resume) picks up the thread —
    // belt-and-braces for the turn-START `session` event above (a turn that surfaced no session event
    // still records its id here).
    if (stepId && result.sessionId) {
      await this.threads.update({ id: stepId }, { session_id: result.sessionId });
    }

    // Durable per-model usage/cost analytics (best-effort; never blocks the turn). Every build/step/
    // review/gate turn flows through here with its step + turnMeta identity in scope.
    void this.usage?.record(
      {
        jobId,
        orgId: input.turnMeta?.orgId,
        lane: input.turnMeta?.lane ?? 'main',
        kind: input.turnMeta?.kind ?? 'step',
        engine,
        credentialId: result.credentialId ?? null,
        ...(stepId ? { metaTag: { phaseId: stepId } } : {}),
      },
      result.usage,
    );

    const session: SessionRef = {
      id: result.sessionId ?? priorSessionId ?? '',
      jobId: jobId,
      stepId: stepId ?? null,
      engine,
      mode,
      branch: sandbox.branch,
      worktreePath: sandbox.worktreePath,
    };

    return {
      report: result.result,
      ...(result.planText ? { planText: result.planText } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.credentialId ? { credentialId: result.credentialId } : {}),
      ...(result.sessionLimit ? { sessionLimit: result.sessionLimit } : {}),
      session,
    };
  }

  /**
   * Whether the bound engine runner can RE-ATTACH an in-flight turn (Redis transport only). The pipe runner
   * has no restart-survivable turns, so callers fall back to re-running the turn from its persisted session.
   */
  canReattach(): boolean {
    return typeof this.engine.reattach === 'function';
  }

  /**
   * Whether the bound engine runner can STEER a running (`steerable`) turn (Redis transport only). The pipe
   * runner has no mid-turn steering, so Leg-rotation callers skip the nudge and fall back to the post-turn
   * safety-net rotation.
   */
  canSteer(): boolean {
    return typeof this.engine.steer === 'function';
  }

  /**
   * STEER a running (`steerable`) turn — publish `text` to `turn:{turnId}:input` so the in-container SDK
   * session injects it mid-flight (`priority:'now'`). Used by Leg-rotation to nudge a fat builder toward
   * authoring its handoff. `id` correlates the engine's `input_ack`; a fresh uuid is fine for host-originated
   * nudges (they carry no delivery-tracking obligation). No-op if the bound runner can't steer.
   */
  async steer(turnId: string, id: string, text: string): Promise<void> {
    if (!this.engine.steer) return;
    await this.engine.steer(turnId, id, text);
  }

  /** Whether the bound engine runner can STOP a running turn (Redis transport only). */
  canStop(): boolean {
    return typeof this.engine.stop === 'function';
  }

  /** STOP a running turn — cooperative abort to `turn:{turnId}:abort`. No-op if the runner can't stop. */
  async stop(turnId: string): Promise<void> {
    if (!this.engine.stop) return;
    await this.engine.stop(turnId);
  }

  /**
   * Lane-generic host STEER: resolve the running steerable turn on `lane` (brain `main` OR a build thread
   * `thread:<id>`) and inject `text` into the LIVE turn as `priority:'now'`. Returns true iff a live
   * steerable turn was found and the steer was issued — the caller stamps delivery on the engine's
   * correlated `input_ack`, never on this call. A null resolution (no live steerable turn — a Codex builder /
   * master-review leg is running, or nothing is) returns false so the caller queues into the next-turn drain
   * rather than an unread input stream. Mirrors the brain's `steerIntoLiveBrainTurn`, lane-generic.
   */
  async steerLane(jobId: string, lane: string, id: string, text: string): Promise<boolean> {
    if (!this.turnRegistry || !this.engine.steer) return false;
    const live = await this.turnRegistry.runningSteerableTurn(jobId, lane).catch(() => null);
    if (!live?.turn_id) return false;
    await this.engine.steer(live.turn_id, id, text);
    return true;
  }

  /**
   * Lane-generic host STOP: resolve the running steerable turn on `lane` and cooperatively abort it.
   * Returns true iff a live steerable turn was found and stopped.
   */
  async stopLane(jobId: string, lane: string): Promise<boolean> {
    if (!this.turnRegistry || !this.engine.stop) return false;
    const live = await this.turnRegistry.runningSteerableTurn(jobId, lane).catch(() => null);
    if (!live?.turn_id) return false;
    await this.engine.stop(live.turn_id);
    return true;
  }

  /**
   * RE-ATTACH an already-running turn's live stream after a restart — resume tailing its durable Redis
   * streams WITHOUT re-kicking the engine (which kept running detached), persisting the resumed engine
   * session id onto the step so a later re-run can still resume it. Returns the same {@link RunTurnResult}
   * shape as {@link runTurn}. Throws if the bound runner has no `reattach` (guard with {@link canReattach}).
   * The caller must RE-SUPPLY `toolBridge` on re-attach when the original turn had one (the host tool
   * closure is in-memory and lost on restart) — else the in-sandbox session's tool requests go unserved.
   */
  async reattach(input: {
    turnId: string;
    containerId: string;
    jobId: string;
    orgId?: string;
    stepId?: string | null;
    lane?: string;
    kind?: string;
    engine?: SessionEngine;
    onEvent?: (e: EngineEvent) => void;
    toolBridge?: ToolBridgeOptions;
    signal?: AbortSignal;
    /** Dispatch-time credential the turn ran on — re-stamped onto rate_limit events (parity with runTurn). */
    credentialId?: string;
  }): Promise<RunTurnResult> {
    if (!this.engine.reattach) {
      throw new Error('bound ENGINE_RUNNER has no reattach() — cannot re-attach turn');
    }
    const { turnId, containerId, stepId } = input;
    const onEvent = (e: EngineEvent): void => {
      if (e.kind === 'session' && stepId && e.sessionId) {
        void this.threads.update({ id: stepId }, { session_id: e.sessionId }).catch(() => undefined);
      }
      input.onEvent?.(e);
    };
    this.logger.log(`Re-attach turn=${turnId} container=${containerId} step=${stepId ?? '-'}`);
    const result = await this.engine.reattach(turnId, containerId, {
      onEvent,
      ...(input.toolBridge ? { toolBridge: input.toolBridge } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    });
    if (stepId && result.sessionId) {
      await this.threads.update({ id: stepId }, { session_id: result.sessionId }).catch(() => undefined);
    }
    if (result.sessionLimit) {
      const { resetAt, rateLimitType } = result.sessionLimit;
      const message = `Claude session limit${rateLimitType ? ` (${rateLimitType})` : ''}${resetAt ? `; resets ${resetAt}` : ''}`;
      throw new EngineSessionLimitError(
        message, resetAt, rateLimitType, result.sessionId, input.credentialId,
      );
    }
    const credentialId = result.credentialId ?? input.credentialId ?? null;
    if (result.claimed !== false) {
      void this.usage?.record(
        {
          jobId: input.jobId,
          orgId: input.orgId,
          lane: input.lane ?? 'main',
          kind: input.kind ?? 'step',
          engine: input.engine ?? 'claude',
          credentialId,
          ...(stepId ? { metaTag: { phaseId: stepId } } : {}),
        },
        result.usage,
      );
    }
    return {
      report: result.result,
      ...(result.planText ? { planText: result.planText } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(credentialId ? { credentialId } : {}),
      ...(result.sessionLimit ? { sessionLimit: result.sessionLimit } : {}),
      // The driver's reattach continuation only reads `report`; the SessionRef is the legacy return shape.
      session: {
        id: result.sessionId ?? '',
        jobId: input.jobId,
        stepId: stepId ?? null,
        engine: 'claude',
        mode: 'execute',
        branch: '',
        worktreePath: '',
      },
    };
  }
}
