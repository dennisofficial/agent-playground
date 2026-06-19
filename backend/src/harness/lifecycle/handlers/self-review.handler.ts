import { Injectable, Logger } from '@nestjs/common';
import { traceSessionTurn } from '@workspace/langfuse';
import type { EngineSpec } from '../../engines/engine-spec';
import { withActiveRoot } from '../../engines/guard';
import { DEFAULT_REVIEW_PROMPT } from '../../engines/engine.prompts';
import { REVISION_PROMPT } from '../lifecycle.prompts';
import { type WorkerEvent } from '../../engines/worker-engine.port';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { SELF_REVIEW } from '../../employees/capabilities/self-review.capability';
import { CredentialContext } from '../../llm-keys/credential-context';
import { TenantCredentialService } from '../../llm-keys/tenant-credential.service';
import { BoardStore } from '../../memory/board-store';
import { toGenerationUsage } from '../../llm/usage-format';
import {
  TurnExecutor,
  type TurnRoutingCtx,
} from '../../workspaces/turn-executor.service';
import type { LifecycleHandler } from '../lifecycle.handler';
import {
  LifecycleEvent,
  type LifecyclePayloads,
  type LifecycleResult,
} from '../lifecycle.types';

/**
 * The HOW behind `SelfReviewCapability` — today's `runPlanSelfReview`, now keyed off the capability's
 * REVIEW `EngineSpec` instead of a fixed role tier. A different engine adversarially critiques the
 * freshly produced plan (stateless), then the PLANNING engine revises it once (resuming its session,
 * so the revision keeps full investigation context). Returns the revised plan body (with a self-review
 * note) + the planning engine's new session id; returns void to keep the un-reviewed plan (no
 * critique, empty revision, or abort — the runner also isolates a throw). Both runs are jailed to the
 * workspace and read-only, but in different modes: the critique runs in 'investigate' (read-only,
 * non-planning — it just returns objections), the revision in 'plan' (it re-emits the structured plan).
 */
@Injectable()
export class SelfReviewHandler implements LifecycleHandler {
  readonly capability = SELF_REVIEW;
  private readonly logger = new Logger(SelfReviewHandler.name);

  constructor(
    private readonly turnExecutor: TurnExecutor,
    private readonly employees: EmployeeRegistry,
    private readonly credCtx: CredentialContext,
    private readonly creds: TenantCredentialService,
    private readonly board: BoardStore,
  ) {}

  async handle(
    event: LifecycleEvent,
    payload: LifecyclePayloads[LifecycleEvent],
    reviewSpec: EngineSpec,
  ): Promise<LifecycleResult<LifecycleEvent>> {
    if (event !== LifecycleEvent.PlanFinished) return;
    const {
      employee,
      session,
      planBody,
      engineSessionId,
      workspacePath,
      keys,
      signal,
      onProgress,
    } = payload;

    const onEvent = (e: WorkerEvent) => onProgress?.(e);

    // Routing context for the Phase-7 turn-execution seam — the plan self-review runs in the session's
    // workspace, so it carries the same tenancy + workspace. LOCAL today (isContainerized=false):
    // turnExecutor.run delegates verbatim to engines.get(...).run({ cwd: workspacePath, ... }) inside the
    // unchanged withActiveRoot/credCtx/trace wrapping.
    const routingCtx: TurnRoutingCtx = {
      team: session.team,
      project: session.project,
      workspaceId: session.workspaceId,
      session,
    };

    const task =
      session.boardTaskId !== undefined
        ? await this.board.get(session.team, session.boardTaskId)
        : undefined;
    const ticketText = task
      ? `${task.title}\n\n${task.description}`.trim()
      : session.task;
    const goal = task?.title ?? session.task;

    // 1. Adversarial review on the REVIEW spec's engine (stateless one-shot, cross-engine). Runs in
    // 'investigate' mode, NOT 'plan': this is a read-only CRITIQUE, not a plan-drafting turn, so it
    // wants read-only enforcement WITHOUT the native plan ceremony — no ExitPlanMode/plan artifact to
    // muddy the prose objections the handler reads back from `result`.
    const reviewPrompt = DEFAULT_REVIEW_PROMPT({
      goal,
      ticket: ticketText,
      plan: planBody,
    });
    const reviewAuth = await this.creds.engineAuth(
      session.team,
      reviewSpec.engine,
    );
    const review = await traceSessionTurn(
      () =>
        withActiveRoot(workspacePath, () =>
          this.credCtx.run({ teamId: session.team, keys }, () =>
            this.turnExecutor.run(routingCtx, reviewSpec.engine, {
              task: reviewPrompt,
              cwd: workspacePath,
              systemPrompt: reviewSpec.systemPrompt,
              agentId: employee.id,
              sessionId: undefined,
              model: reviewSpec.model,
              effort: reviewSpec.effort,
              mode: 'investigate',
              engineAuth: reviewAuth,
              team: session.team,
              onEvent,
              signal,
            }),
          ),
        ),
      {
        name: `session.turn:${reviewSpec.engine}:review`,
        asType: 'generation',
        sessionId: session.id,
        input: reviewPrompt,
        metadata: {
          phase: 'review',
          model: reviewSpec.model,
          engine: reviewSpec.engine,
          boardTaskId: session.boardTaskId,
          agentId: employee.id,
        },
        usage: (r) => toGenerationUsage(r.usage),
      },
    );
    if (signal.aborted) return;
    const critique = review.result?.trim();
    if (!critique) return;

    // 2. Revise ONCE on the PLANNING engine, resuming its session (keeps investigation context).
    const planSpec = employee.planEngine(this.employees.context());
    const revisionPrompt = REVISION_PROMPT({ critique });
    const revisionAuth = await this.creds.engineAuth(
      session.team,
      session.engine,
    );
    const revision = await traceSessionTurn(
      () =>
        withActiveRoot(workspacePath, () =>
          this.credCtx.run({ teamId: session.team, keys }, () =>
            this.turnExecutor.run(routingCtx, session.engine, {
              task: revisionPrompt,
              cwd: workspacePath,
              systemPrompt: planSpec.systemPrompt,
              agentId: employee.id,
              sessionId: engineSessionId,
              model: planSpec.model,
              effort: planSpec.effort,
              mode: 'plan',
              engineAuth: revisionAuth,
              team: session.team,
              onEvent,
              signal,
            }),
          ),
        ),
      {
        name: `session.turn:${session.engine}:revision`,
        asType: 'generation',
        sessionId: session.id,
        input: revisionPrompt,
        metadata: {
          phase: 'revision',
          model: planSpec.model,
          engine: session.engine,
          boardTaskId: session.boardTaskId,
          agentId: employee.id,
        },
        usage: (r) => toGenerationUsage(r.usage),
      },
    );
    if (signal.aborted) return;
    const revisedBody = (revision.planText ?? revision.result)?.trim();
    if (!revisedBody) return;

    return {
      planBody: `${revisedBody}\n\n_(self-reviewed by ${reviewSpec.engine} before attaching)_`,
      engineSessionId: revision.sessionId ?? engineSessionId,
    };
  }
}
