import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { SessionEngine, SessionMode, SessionRef } from '../domain';
import { ENGINE_RUNNER, EngineAuthError, SANDBOX_RESET_NOTICE, type EngineRunnerPort } from '../engine';
import type { EngineAuth, EngineEvent, EngineRunResult, EngineUsage, TurnMeta } from '../engine';
import type { FeatureSandbox } from '../git';
import { DB_CONNECTION } from '../persistence/database.module';
import { StepEntity } from '../persistence/entities';

/** What one turn needs to run. The sandbox supplies the worktree (the engine cwd) + branch. */
export interface RunTurnInput {
  /** The job this turn serves. */
  jobId: string;
  /** The step this turn builds, if any (its `session_id` is the resume handle + is persisted). */
  stepId?: string | null;
  /** The per-feature sandbox (worktree) the turn runs inside. */
  sandbox: FeatureSandbox;
  engine: SessionEngine;
  mode: SessionMode;
  /** The turn instructions. */
  task: string;
  /** The system prompt / persona for the turn. */
  systemPrompt: string;
  /** Override the engine model for this turn. */
  model?: string;
  /** How the turn authenticates (defaults derived from env by the EngineRunner). */
  auth?: EngineAuth;
  /**
   * Authenticated-git for this turn (resolved repo url + org PAT) so the agent can fetch/push/merge from
   * inside the sandbox. Sourced from the RESOLVED repo, NOT `sandbox` (a row-sourced sandbox has empty
   * `gitUrl`/no token). Set by build/execute dispatch; the runner puts it on the docker `target`.
   */
  gitAuth?: { gitUrl: string; token?: string };
  /**
   * Opt into RICH token-level streaming (thinking + tool calls/results + subagent forwarding). Build turns
   * pass this so they ride the shared transcript spine (a full transcript, not coarse text/tool/result).
   */
  richStream?: boolean;
  /** Progress callback. */
  onEvent?: (e: EngineEvent) => void;
  signal?: AbortSignal;
  /**
   * Registry context for a RESTART-SURVIVABLE Redis-transport turn. When set (and `ENGINE_TRANSPORT=redis`),
   * the runner records an `active_turns` row so a fresh backend can RE-ATTACH this turn's live stream after a
   * restart instead of re-running it. Ignored by the pipe runner. The brain always sets this; build turns
   * set it so a build thread recovers like the brain (see `reattach`). See ADR 0001.
   */
  turnMeta?: TurnMeta;
}

/** The result of one turn — the engine report + the live SessionRef for the next turn. */
export interface RunTurnResult {
  /** The turn's report (the plan text on a plan turn, else the closing summary). */
  report: string;
  /** A plan, when the turn was a plan turn that captured one. */
  planText?: string;
  usage?: EngineUsage;
  /** The handle the driver holds for the session's next turn. */
  session: SessionRef;
}

/**
 * Atlas v2's LOCAL turn-runner — the seam tying engine + git together, host-only. It opens or resumes
 * an engine session INSIDE a per-feature worktree, runs ONE turn (plan or execute) by calling the
 * `EngineRunner` directly, and persists the minimal session state (the engine session id onto
 * `steps.session_id`, returned in a `SessionRef`). It deliberately BYPASSES v1's
 * `SessionRunnerService` (which throws off-daemon). Zero v1 imports.
 *
 * Statelessness: a turn is identified by the sandbox + an optional prior session id (resumed from the
 * step row). The runner holds no in-memory session registry — the source of truth is the step row
 * (durable) and the returned `SessionRef` (the driver's in-memory pointer), so it survives restarts.
 */
@Injectable()
export class TurnRunnerService {
  private readonly logger = new Logger(TurnRunnerService.name);

  constructor(
    @Inject(ENGINE_RUNNER) private readonly engine: EngineRunnerPort,
    @InjectRepository(StepEntity, DB_CONNECTION)
    private readonly steps: Repository<StepEntity>,
  ) {}

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const { sandbox, stepId, jobId, engine, mode } = input;

    // Resume handle: the step row's prior session id (if any) — durable across restarts.
    const priorSessionId = stepId
      ? ((await this.steps.findOne({ where: { id: stepId } }))?.session_id ?? undefined)
      : undefined;

    // The sandbox key namespaces the engine's isolated home + Codex client cache, so two concurrent
    // features never share engine state. The feature branch is unique per job/feature.
    const sandboxKey = `${sandbox.repoId}--${sandbox.branch}`;

    // Cold re-attach + resume: the container was created/restarted fresh (warm === false) but we're
    // resuming a session that remembers prior in-container state — tell it the box was reset. Flip warm
    // so only the FIRST resumed turn in this drive carries the notice.
    const needsResetNotice = sandbox.warm === false && !!priorSessionId;
    if (sandbox.warm === false) sandbox.warm = true;
    const task = needsResetNotice ? `${SANDBOX_RESET_NOTICE}\n\n${input.task}` : input.task;

    this.logger.log(
      `Turn: job=${jobId} step=${stepId ?? '-'} engine=${engine} mode=${mode} ` +
        `cwd=${sandbox.worktreePath}${priorSessionId ? ` resume=${priorSessionId}` : ''}`,
    );

    // Persist the session id the instant the engine surfaces it (turn START) — so a mid-turn halt
    // (process crash, container/host restart, kill) recovers by RESUMING this same session rather than
    // spawning a fresh one. Best-effort write; the turn-end + auth-error persists below are belt-and-braces.
    const onEvent = (e: EngineEvent): void => {
      if (e.kind === 'session' && stepId && e.sessionId) {
        void this.steps.update({ id: stepId }, { session_id: e.sessionId }).catch(() => undefined);
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
              },
            }
          : {}),
        ...(input.auth ? { auth: input.auth } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.richStream ? { richStream: true } : {}),
        // Register the turn (Redis transport only) so a fresh backend can RE-ATTACH it after a restart.
        ...(input.turnMeta ? { turnMeta: input.turnMeta } : {}),
        onEvent,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (err) {
      // On a 401/auth failure, PERSIST the session id so a re-ping resumes this same session (the
      // agent's partial work is on disk in the worktree) instead of starting the step from scratch.
      if (err instanceof EngineAuthError && stepId && err.sessionId) {
        await this.steps.update({ id: stepId }, { session_id: err.sessionId });
      }
      throw err;
    }

    // Persist the engine session id so the next turn (or a post-restart resume) picks up the thread.
    if (stepId && result.sessionId) {
      await this.steps.update({ id: stepId }, { session_id: result.sessionId });
    }

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
   * RE-ATTACH an already-running turn's live stream after a restart — resume tailing its durable Redis
   * streams WITHOUT re-kicking the engine (which kept running detached), persisting the resumed engine
   * session id onto the step so a later re-run can still resume it. Returns the same {@link RunTurnResult}
   * shape as {@link runTurn}. Throws if the bound runner has no `reattach` (guard with {@link canReattach}).
   * Build turns pass no tool bridge (their tools run in-sandbox) — only `onEvent` is forwarded.
   */
  async reattach(input: {
    turnId: string;
    containerId: string;
    jobId: string;
    stepId?: string | null;
    onEvent?: (e: EngineEvent) => void;
    signal?: AbortSignal;
  }): Promise<RunTurnResult> {
    if (!this.engine.reattach) {
      throw new Error('bound ENGINE_RUNNER has no reattach() — cannot re-attach turn');
    }
    const { turnId, containerId, stepId } = input;
    const onEvent = (e: EngineEvent): void => {
      if (e.kind === 'session' && stepId && e.sessionId) {
        void this.steps.update({ id: stepId }, { session_id: e.sessionId }).catch(() => undefined);
      }
      input.onEvent?.(e);
    };
    this.logger.log(`Re-attach turn=${turnId} container=${containerId} step=${stepId ?? '-'}`);
    const result = await this.engine.reattach(turnId, containerId, {
      onEvent,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (stepId && result.sessionId) {
      await this.steps.update({ id: stepId }, { session_id: result.sessionId }).catch(() => undefined);
    }
    return {
      report: result.result,
      ...(result.planText ? { planText: result.planText } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
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
