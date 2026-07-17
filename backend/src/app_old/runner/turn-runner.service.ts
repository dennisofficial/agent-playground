import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { SessionEngine, SessionMode, SessionRef } from '../../_shared/domain';
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
} from '../../_shared/engine';
import {
  ENGINE_RUNNER,
  EngineAuthError,
  EngineDetachedError,
  EngineSessionLimitError,
  SANDBOX_RESET_NOTICE,
  pickKeys,
  type EngineRunnerPort,
} from '../../_shared/engine';
import { type AgentMessage } from '../../_shared/prompt-kit/message';
import { TurnUsageProjector } from '../analytics/turn-usage-projector.service';
import { FeatureSandbox } from '../git/local-git.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { ThreadEntity } from '../persistence/entities';
import { prependNotice } from '../prompt-kit/harness/compose-turn';
import { TurnRegistry } from '../sandbox/turn-registry.service';

export interface RunTurnInput {
  orgId: string;
  jobId: string;
  stepId?: string | null;
  sandbox: FeatureSandbox;
  engine: SessionEngine;
  mode: SessionMode;
  task: AgentMessage;
  systemPrompt: AgentMessage;
  model?: string;
  modelReasoningEffort?: ReasoningEffort;
  auth?: EngineAuth;
  userMcpServers?: ResolvedMcpServer[];
  skills?: ResolvedSkill[];
  previewInstructions?: string | null;
  gitAuth?: GitAuth;
  evidenceDir?: string;
  richStream?: boolean;
  steerable?: boolean;
  rotationNudge?: {
    softTokens: number;
    reminderDeltaTokens: number;
    softText: AgentMessage;
    reminderText: AgentMessage;
  };
  onEvent?: (e: EngineEvent) => void;
  signal?: AbortSignal;
  toolBridge?: ToolBridgeOptions;
  turnMeta?: TurnMeta;
  liveRoute?: { channel: string; jobId: string; lane?: string };
  onTurnRegistered?: (turnId: string) => void;
}

type TurnInputDerivedOrRequiredKey =
  | 'orgId'
  | 'jobId'
  | 'stepId'
  | 'sandbox'
  | 'gitAuth'
  | 'evidenceDir' // derived (→ target / sandboxKey) / host-only
  | 'onEvent'
  | 'signal'
  | 'onTurnRegistered' // host-wrapped, set explicitly
  | 'engine'
  | 'mode'
  | 'task'
  | 'systemPrompt'; // required, forwarded explicitly (omission already errors)
type TurnInputForwardKey = Exclude<keyof RunTurnInput, TurnInputDerivedOrRequiredKey>;
const TURN_INPUT_FORWARD_KEYS = [
  'auth',
  'userMcpServers',
  'skills',
  'previewInstructions',
  'model',
  'modelReasoningEffort',
  'richStream',
  'steerable',
  'rotationNudge',
  'toolBridge',
  'turnMeta',
  'liveRoute',
] as const satisfies readonly TurnInputForwardKey[];
const _TURN_INPUT_FORWARD_KEYS_EXHAUSTIVE: [
  Exclude<TurnInputForwardKey, (typeof TURN_INPUT_FORWARD_KEYS)[number]>,
] extends [never]
  ? true
  : {
      ADD_TO_TURN_INPUT_FORWARD_KEYS: Exclude<
        TurnInputForwardKey,
        (typeof TURN_INPUT_FORWARD_KEYS)[number]
      >;
    } = true;
void _TURN_INPUT_FORWARD_KEYS_EXHAUSTIVE;

export interface RunTurnResult {
  report: string;
  planText?: string;
  usage?: EngineUsage;
  credentialId?: string;
  sessionLimit?: SessionLimitHit;
  session: SessionRef;
}

@Injectable()
export class TurnRunnerService {
  private readonly logger = new Logger(TurnRunnerService.name);

  constructor(
    @Inject(ENGINE_RUNNER) private readonly engine: EngineRunnerPort,
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @Optional() private readonly usage?: TurnUsageProjector,
    @Optional() private readonly turnRegistry?: TurnRegistry,
  ) {}

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const { sandbox, stepId, jobId, engine, mode } = input;

    const priorThread = stepId ? await this.threads.findOne({ where: { id: stepId } }) : null;
    const priorSessionId = priorThread?.session_id ?? undefined;

    const sandboxKey: EngineHomeKey = {
      orgId: input.orgId,
      repoId: sandbox.repoId,
      jobId,
      type: 'build',
    };

    const needsResetNotice = sandbox.warm === false && !!priorSessionId;
    if (sandbox.warm === false) sandbox.warm = true;
    const task = needsResetNotice ? prependNotice(SANDBOX_RESET_NOTICE, input.task) : input.task;

    this.logger.log(
      `Turn: job=${jobId} step=${stepId ?? '-'} engine=${engine} mode=${mode} ` +
        `cwd=${sandbox.worktreePath}${priorSessionId ? ` resume=${priorSessionId}` : ''}`,
    );

    const onEvent = (e: EngineEvent): void => {
      if (e.kind === 'session' && stepId && e.sessionId) {
        void this.threads
          .update({ id: stepId }, { session_id: e.sessionId })
          .catch(() => undefined);
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
        ...pickKeys(input, TURN_INPUT_FORWARD_KEYS),
        onEvent,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onTurnRegistered ? { onTurnRegistered: input.onTurnRegistered } : {}),
      });
    } catch (err) {
      if (err instanceof EngineAuthError && stepId && err.sessionId) {
        await this.threads.update({ id: stepId }, { session_id: err.sessionId });
      }
      throw err;
    }

    if (result.streamClosedCount) {
      this.logger.warn(
        `turn saw ${result.streamClosedCount} "Stream closed" tool-result(s) job=${jobId} step=${stepId ?? '-'} session=${result.sessionId ?? '-'}`,
      );
    }

    if (result.sessionLimit) {
      if (stepId && result.sessionId) {
        await this.threads.update({ id: stepId }, { session_id: result.sessionId });
      }
      const { resetAt, rateLimitType, source } = result.sessionLimit;
      const message = `Claude session limit${rateLimitType ? ` (${rateLimitType})` : ''}${resetAt ? `; resets ${resetAt}` : ''}`;
      throw new EngineSessionLimitError(
        message,
        resetAt,
        rateLimitType,
        result.sessionId,
        input.auth?.refreshBack?.credentialId,
        source ?? 'structured',
      );
    }

    if (stepId && result.sessionId) {
      await this.threads.update({ id: stepId }, { session_id: result.sessionId });
    }

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

  canReattach(): boolean {
    return typeof this.engine.reattach === 'function';
  }

  canSteer(): boolean {
    return typeof this.engine.steer === 'function';
  }

  async steer(turnId: string, id: string, text: string): Promise<void> {
    if (!this.engine.steer) return;
    await this.engine.steer(turnId, id, text);
  }

  canStop(): boolean {
    return typeof this.engine.stop === 'function';
  }

  async stop(turnId: string): Promise<void> {
    if (!this.engine.stop) return;
    await this.engine.stop(turnId);
  }

  async steerLane(jobId: string, lane: string, id: string, text: string): Promise<boolean> {
    if (!this.turnRegistry || !this.engine.steer) return false;
    const live = await this.turnRegistry.runningSteerableTurn(jobId, lane).catch(() => null);
    if (!live?.turn_id) return false;
    await this.engine.steer(live.turn_id, id, text);
    return true;
  }

  async stopLane(jobId: string, lane: string): Promise<boolean> {
    if (!this.turnRegistry || !this.engine.stop) return false;
    const live = await this.turnRegistry.runningSteerableTurn(jobId, lane).catch(() => null);
    if (!live?.turn_id) return false;
    await this.engine.stop(live.turn_id);
    return true;
  }

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
    credentialId?: string;
    liveRoute?: { channel: string; jobId: string; lane?: string };
  }): Promise<RunTurnResult> {
    if (!this.engine.reattach) {
      throw new Error('bound ENGINE_RUNNER has no reattach() — cannot re-attach turn');
    }
    const { turnId, containerId, stepId } = input;
    const claimedAttach = this.engine.tryClaimAttach?.(turnId) ?? true;
    if (!claimedAttach) {
      this.logger.warn(
        `Re-attach turn=${turnId}: already attached in this process — refusing to double-attach`,
      );
      throw new EngineDetachedError(`turn ${turnId} already attached in this process`);
    }
    try {
      const onEvent = (e: EngineEvent): void => {
        if (e.kind === 'session' && stepId && e.sessionId) {
          void this.threads
            .update({ id: stepId }, { session_id: e.sessionId })
            .catch(() => undefined);
        }
        input.onEvent?.(e);
      };
      this.logger.log(`Re-attach turn=${turnId} container=${containerId} step=${stepId ?? '-'}`);
      const result = await this.engine.reattach(turnId, containerId, {
        onEvent,
        ...(input.toolBridge ? { toolBridge: input.toolBridge } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.credentialId ? { credentialId: input.credentialId } : {}),
        ...(input.liveRoute ? { liveRoute: input.liveRoute } : {}),
      });
      if (stepId && result.sessionId) {
        await this.threads
          .update({ id: stepId }, { session_id: result.sessionId })
          .catch(() => undefined);
      }
      if (result.sessionLimit) {
        const { resetAt, rateLimitType, source } = result.sessionLimit;
        const message = `Claude session limit${rateLimitType ? ` (${rateLimitType})` : ''}${resetAt ? `; resets ${resetAt}` : ''}`;
        throw new EngineSessionLimitError(
          message,
          resetAt,
          rateLimitType,
          result.sessionId,
          input.credentialId,
          source ?? 'structured',
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
    } finally {
      this.engine.releaseAttach?.(turnId);
    }
  }
}
