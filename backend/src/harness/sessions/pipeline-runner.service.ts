import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ProposalService } from '../approvals/proposal.service';
import { EmployeeRegistry } from '../employees/employee.registry';
import { BoardStore } from '../memory/board-store';
import { BoardEventsBus, type BoardEvent } from '../memory/board-events.bus';
import { PlanStore } from '../memory/plan-store';
import { PipelineRunStore, type PipelineRun } from '../memory/pipeline-run-store';
import { PipelineRegistry } from '../pipelines/pipeline.registry';
import type { PipelineDefinition, PipelineStage } from '../pipelines/pipeline.types';
import { ReviewPipelineService } from './review-pipeline.service';
import {
  SESSION_REGISTRY,
  type Session,
  type SessionRegistry,
} from './session-registry.port';
import { SessionRunnerService } from './session-runner.service';

/**
 * The generic pipeline interpreter. A pipeline is DATA (PipelineRegistry); this service walks ANY
 * definition: it opens each stage as a specialist session (SessionRunner.openStageSession) inside
 * ONE worktree that carries the accumulated work, advances when a stage reports back idle, PAUSES at
 * a gate stage (a human must clear plan approval / PR review before continuing — the gate-resolution
 * wiring resumes the run), and fails the run if a stage errors. The durable `pipeline_runs` row is
 * the source of truth for which stage a task is on; the live `sessions.onUpdate` signal only drives
 * advancement while the process is up.
 */
@Injectable()
export class PipelineRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PipelineRunnerService.name);

  constructor(
    private readonly pipelines: PipelineRegistry,
    private readonly runs: PipelineRunStore,
    private readonly runner: SessionRunnerService,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    private readonly board: BoardStore,
    private readonly employees: EmployeeRegistry,
    private readonly plans: PlanStore,
    private readonly proposals: ProposalService,
    private readonly review: ReviewPipelineService,
    private readonly boardEvents: BoardEventsBus,
  ) {}

  onApplicationBootstrap(): void {
    // Advance a run when its active stage session reports back (idle/failed).
    this.sessions.onUpdate((s) => {
      void this.onSessionUpdate(s).catch((err) =>
        this.logger.warn(`pipeline onSessionUpdate(${s.id}) failed: ${err}`),
      );
    });
    // The plan gate resumes when the human approves the proposed ticket (board CAS → ticket-approved).
    this.boardEvents.onEvent((event) => {
      void this.onBoardEvent(event).catch((err) =>
        this.logger.warn(`pipeline board-event (${event.kind}) failed: ${err}`),
      );
    });
    void this.resumePipelines().catch((err) =>
      this.logger.warn(`resumePipelines failed: ${err}`),
    );
  }

  /**
   * Start a pipeline run for a board task: create the durable row and open stage 0 in `worktreeId`.
   * The stage session is ALS-detached inside openStageSession, so call this fire-and-forget.
   */
  async start(opts: {
    team: string;
    project: string;
    taskId: number;
    pipeline: string;
    worktreeId: string;
    notifyThread: string;
  }): Promise<PipelineRun> {
    const def = this.pipelines.get(opts.pipeline); // throws on unknown — caller validated
    const run = await this.runs.create({
      team: opts.team,
      taskId: opts.taskId,
      pipeline: opts.pipeline,
      stageIndex: 0,
      status: 'running',
      worktreeId: opts.worktreeId,
    });
    await this.openStage(run, def, 0, opts.project, opts.notifyThread);
    return (await this.runs.get(opts.team, run.id)) ?? run;
  }

  /** Open stage `index` of `def` for `run`, persisting the stage session id + role/mode. */
  private async openStage(
    run: PipelineRun,
    def: PipelineDefinition,
    index: number,
    project: string,
    notifyThread: string,
  ): Promise<void> {
    if (!run.worktreeId) {
      this.logger.warn(`pipeline ${run.id}: no worktree — failing run`);
      await this.runs.update(run.team, run.id, { status: 'failed' });
      return;
    }
    const stage = def.stages[index];
    const task = await this.board.get(run.team, run.taskId);
    if (!task) {
      this.logger.warn(
        `pipeline ${run.id}: board task #${run.taskId} gone — failing run`,
      );
      await this.runs.update(run.team, run.id, { status: 'failed' });
      return;
    }
    const prompt = this.stagePrompt(def, index, task.title, task.description);
    const session = await this.runner.openStageSession({
      role: stage.role,
      team: run.team,
      project,
      worktreeId: run.worktreeId,
      task: prompt,
      mode: stage.mode,
      notifyThread,
      boardTaskId: run.taskId,
    });
    await this.runs.update(run.team, run.id, {
      stageIndex: index,
      status: 'running',
      currentRole: stage.role,
      mode: stage.mode,
      sessionId: session.id,
    });
    this.logger.log(
      `pipeline ${run.id} (${def.name}) stage ${index} [${stage.role}/${stage.mode}] → ${session.id}`,
    );
  }

  /** React to a stage session reporting back: advance, pause at a gate, finish, or fail. */
  private async onSessionUpdate(session: Session): Promise<void> {
    if (session.status !== 'idle' && session.status !== 'failed') return;
    if (session.boardTaskId === undefined) return;
    const run = await this.runs.getByTask(session.team, session.boardTaskId);
    if (!run || run.status !== 'running' || run.sessionId !== session.id) return;
    const def = this.pipelines.get(run.pipeline);
    const stage = def.stages[run.stageIndex];

    if (session.status === 'failed') {
      this.logger.warn(
        `pipeline ${run.id}: stage ${run.stageIndex} (${session.id}) failed — pausing run`,
      );
      await this.runs.update(run.team, run.id, { status: 'failed' });
      return;
    }

    // A gate stage produces something a human must clear before the run continues.
    //  - plan gate → propose the produced plan to the human (ProposalService posts the approval card)
    //    and PAUSE; the run resumes from `onBoardEvent` when the ticket is approved.
    //  - PR gate → ship the accumulated work as a PR (ReviewPipelineService.shipTask) and finish; the
    //    human reviews/merges on GitHub.
    if (stage.gate === 'plan') {
      this.logger.log(
        `pipeline ${run.id}: stage ${run.stageIndex} hit the plan gate — proposing for review`,
      );
      await this.handlePlanGate(run, session, stage);
      return;
    }
    if (stage.gate === 'pr') {
      this.logger.log(
        `pipeline ${run.id}: stage ${run.stageIndex} hit the PR gate — shipping`,
      );
      await this.handlePrGate(run, session);
      return;
    }

    const next = run.stageIndex + 1;
    if (next >= def.stages.length) {
      this.logger.log(`pipeline ${run.id} (${def.name}) complete`);
      await this.runs.update(run.team, run.id, {
        status: 'done',
        currentRole: null,
        mode: null,
      });
      return;
    }
    // Advance: the next stage runs in the SAME worktree (it carries the accumulated work).
    await this.openStage(run, def, next, session.project, session.notifyThread);
  }

  /**
   * Plan gate: attach the stage's produced plan to the board task, auto-clear the lead-review layer
   * (Atlas IS the orchestrator — there's no separate lead), move the ticket into 'planning', and
   * propose it to the human via ProposalService (the SHARED guard+CAS+present path — never present()
   * raw). Then PAUSE the run; `onBoardEvent` resumes it when the ticket is approved.
   */
  private async handlePlanGate(
    run: PipelineRun,
    session: Session,
    stage: PipelineStage,
  ): Promise<void> {
    const planMd = session.lastReport?.trim() || '(no plan produced)';
    await this.plans
      .attach({
        team: run.team,
        taskId: run.taskId,
        employee: stage.role,
        planMd,
        sessionId: session.id,
      })
      .catch((err) =>
        this.logger.warn(`pipeline ${run.id}: plan attach failed: ${err}`),
      );
    // Atlas auto-clears the lead-review layer (the pipeline has no separate lead pass).
    await this.plans
      .approve(run.team, run.taskId, stage.role)
      .catch(() => undefined);
    // Land in 'planning' so ProposalService's CAS planning→awaiting_approval holds.
    await this.board
      .update(run.team, run.taskId, { status: 'planning' })
      .catch(() => undefined);
    const outcome = await this.proposals.propose({
      team: run.team,
      taskId: run.taskId,
      summary: `Pipeline '${run.pipeline}' reached the plan gate for #${run.taskId}. Review the attached plan and approve to run the remaining stages.`,
      proposedBy: this.employees.teamLead().id,
      surfaceId: session.notifyThread,
    });
    if (!outcome.ok)
      this.logger.warn(
        `pipeline ${run.id}: propose failed (${outcome.kind}) — the run stays paused`,
      );
    await this.runs.update(run.team, run.id, { status: 'paused' });
  }

  /**
   * PR gate: ship the accumulated pipeline work as a single-task PR (open + mark ready) via
   * ReviewPipelineService.shipTask — NO sibling/sharedSlug fan-out — then finish the run. A ship
   * failure fails the run loudly so it never reports a PR that didn't open.
   */
  private async handlePrGate(run: PipelineRun, session: Session): Promise<void> {
    if (!run.worktreeId) {
      this.logger.warn(`pipeline ${run.id}: PR gate with no worktree — failing`);
      await this.runs.update(run.team, run.id, { status: 'failed' });
      return;
    }
    const shipped = await this.review.shipTask({
      team: run.team,
      taskId: run.taskId,
      worktreeId: run.worktreeId,
      notifyThread: session.notifyThread,
    });
    if (!shipped.ok) {
      this.logger.warn(
        `pipeline ${run.id}: shipTask failed — ${shipped.reason}`,
      );
      await this.runs.update(run.team, run.id, { status: 'failed' });
      return;
    }
    this.logger.log(
      `pipeline ${run.id} (${run.pipeline}) shipped #${run.taskId}: ${shipped.prUrl}`,
    );
    await this.runs.update(run.team, run.id, {
      status: 'done',
      currentRole: null,
      mode: null,
    });
  }

  /**
   * Resume a plan-gated run when the human approves the proposed ticket — the board CAS
   * (awaiting_approval→approved) fires `ticket-approved`, and we advance the paused run to its next
   * stage in the SAME worktree. Only the plan gate resumes on approval; the PR gate is terminal.
   */
  private async onBoardEvent(event: BoardEvent): Promise<void> {
    if (event.kind !== 'ticket-approved') return;
    const run = await this.runs.getByTask(event.team, event.taskId);
    if (!run || run.status !== 'paused') return;
    const def = this.pipelines.get(run.pipeline);
    const stage = def.stages[run.stageIndex];
    if (stage?.gate !== 'plan') return;
    const session = run.sessionId
      ? await this.sessions.get(run.sessionId)
      : undefined;
    const project =
      session?.project ?? (await this.board.get(run.team, run.taskId))?.project;
    const notifyThread = session?.notifyThread;
    if (!project || !notifyThread) {
      this.logger.warn(
        `pipeline ${run.id}: can't resume after approval — missing project/thread`,
      );
      return;
    }
    const next = run.stageIndex + 1;
    if (next >= def.stages.length) {
      await this.runs.update(run.team, run.id, {
        status: 'done',
        currentRole: null,
        mode: null,
      });
      return;
    }
    await this.openStage(run, def, next, project, notifyThread);
  }

  /**
   * Resume in-flight pipelines on boot. The durable `pipeline_runs` row is the source of truth and
   * the stage session (PostgresSessionRegistry) survives restarts too. Full re-drive (re-evaluating
   * each active run against its stage session's status) is owned by the cutover phase, which enumerates
   * team context at boot; here the live `onUpdate` covers still-running sessions.
   */
  async resumePipelines(): Promise<void> {
    return;
  }

  /** Build the opening message for a stage from the board task + the stage's role/mode. */
  private stagePrompt(
    def: PipelineDefinition,
    index: number,
    title: string,
    description: string,
  ): string {
    const stage = def.stages[index];
    const ticket = `${title}\n\n${description}`.trim();
    const roleName = this.employees.byId(stage.role)?.name ?? stage.role;
    const verb =
      stage.mode === 'plan'
        ? 'Plan'
        : stage.mode === 'investigate'
          ? 'Review (read-only)'
          : 'Implement';
    return `Pipeline '${def.name}', stage ${index + 1}/${def.stages.length} — ${roleName} (${stage.mode}).\n\n${verb} the following work item:\n\n${ticket}`;
  }
}
