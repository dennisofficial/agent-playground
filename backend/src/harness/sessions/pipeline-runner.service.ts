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
      // Persist the resume coordinates on the row so a paused/in-flight run recovers WITHOUT a live
      // stage session (onBoardEvent + resumePipelines read these, not the session).
      notifyThread: opts.notifyThread,
      project: opts.project,
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
    // Inline the approved plan once the pipeline is past the plan gate, so each downstream stage
    // builds against the same north star (the worktree carries the code; the plan carries the intent).
    const plan = await this.plans.get(run.team, run.taskId).catch(() => undefined);
    const prompt = this.stagePrompt(
      def,
      index,
      task.title,
      task.description,
      plan?.planMd,
    );
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
    // PAUSE before proposing, so an approval that races the card (the human approving between the
    // card posting and this update) always finds the run already 'paused' — onBoardEvent resumes a
    // paused run only.
    await this.runs.update(run.team, run.id, { status: 'paused' });
    const outcome = await this.proposals.propose({
      team: run.team,
      taskId: run.taskId,
      summary: `Pipeline '${run.pipeline}' reached the plan gate for #${run.taskId}. Review the attached plan and approve to run the remaining stages.`,
      proposedBy: this.employees.teamLead().id,
      surfaceId: session.notifyThread,
    });
    // A failed proposal means NO approval card was posted (bad status, no/unapproved plan, lost CAS).
    // A run left 'paused' here can never resume — onBoardEvent only fires on 'ticket-approved', which
    // needs a card → approval. Fail it loudly (recoverable via re-dispatch) instead of wedging it.
    if (!outcome.ok) {
      this.logger.warn(
        `pipeline ${run.id}: propose failed (${outcome.kind}) — failing the run (no approval card posted)`,
      );
      await this.runs.update(run.team, run.id, { status: 'failed' });
    }
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
    // Resume coordinates come from the DURABLE row first (boot-safe), falling back to the live session
    // and then the board task — so an approval that lands after the stage session is gone still resumes.
    const session = run.sessionId
      ? await this.sessions.get(run.sessionId)
      : undefined;
    const project =
      run.project ??
      session?.project ??
      (await this.board.get(run.team, run.taskId))?.project;
    const notifyThread = run.notifyThread ?? session?.notifyThread;
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
   * Re-drive in-flight pipelines on boot. The durable `pipeline_runs` row is the source of truth; the
   * in-process engine turn does NOT survive a restart, so a run left 'running' would otherwise stall
   * forever (no `onUpdate` fires for a dead turn). For each active run:
   *   - paused        → waits for human approval; `onBoardEvent` ('ticket-approved') resumes it using
   *                     the row's durable notify_thread/project. Nothing to re-drive here.
   *   - running, session idle/failed → the stage reported back while we were down; process the missed
   *                     turn-end via the normal advance path.
   *   - running, session gone or stale-'running' → the turn died on restart; re-open the CURRENT stage
   *                     in the same worktree (it carries the accumulated work).
   * Best-effort and isolated per run — one bad run never blocks the others.
   */
  async resumePipelines(): Promise<void> {
    const active = await this.runs.listAllActive();
    for (const run of active) {
      if (run.status !== 'running') continue; // paused runs resume via onBoardEvent
      try {
        const def = this.pipelines.get(run.pipeline);
        const session = run.sessionId
          ? await this.sessions.get(run.sessionId)
          : undefined;
        // The stage reported back while the process was down — run the missed advance now.
        if (session && (session.status === 'idle' || session.status === 'failed')) {
          await this.onSessionUpdate(session);
          continue;
        }
        // The owner explicitly closed the session — leave the run for manual handling.
        if (session && session.status === 'closed') continue;
        // Session gone, or its row says 'running' but the in-memory turn died on restart (nothing is
        // live this early in boot): re-open the current stage in the same worktree.
        const project =
          run.project ??
          session?.project ??
          (await this.board.get(run.team, run.taskId))?.project;
        const notifyThread = run.notifyThread ?? session?.notifyThread;
        if (!project || !notifyThread) {
          this.logger.warn(
            `pipeline ${run.id}: can't resume on boot — missing project/thread; failing`,
          );
          await this.runs.update(run.team, run.id, { status: 'failed' });
          continue;
        }
        this.logger.log(
          `pipeline ${run.id} (${def.name}): re-opening stage ${run.stageIndex} on boot`,
        );
        await this.openStage(run, def, run.stageIndex, project, notifyThread);
      } catch (err) {
        this.logger.warn(`pipeline ${run.id}: boot resume failed: ${err}`);
      }
    }
  }

  /**
   * Build the opening message for a stage — the HANDOFF. Conveys that this is ONE stage of a
   * multi-stage pipeline working a single task across sequential sessions (handing off through the
   * shared worktree): which stage, what prior stages already did, the approved plan (once past the
   * plan gate), the work item, the stage's job, and what to leave for the next stage.
   */
  private stagePrompt(
    def: PipelineDefinition,
    index: number,
    title: string,
    description: string,
    plan?: string,
  ): string {
    const stage = def.stages[index];
    const total = def.stages.length;
    const roleName = (r: string) => this.employees.byId(r)?.name ?? r;
    const ticket = `${title}\n\n${description}`.trim();
    const job =
      stage.mode === 'plan'
        ? 'produce a plan for this work and STOP — do not implement; the plan goes to Dennis for approval before any code is written'
        : stage.mode === 'investigate'
          ? 'review the work so far READ-ONLY and report your findings — do not change files'
          : 'implement your part and commit it to the worktree';

    const parts: string[] = [
      `You are running ONE stage of a multi-stage pipeline. The whole pipeline works a SINGLE task across several focused sessions, handing off through the shared worktree — your session is stage ${index + 1} of ${total} in the '${def.name}' pipeline.`,
      `Your stage: ${roleName(stage.role)} — ${stage.mode}.`,
    ];

    if (index > 0) {
      const prior = def.stages
        .slice(0, index)
        .map((s, i) => `${i + 1}. ${roleName(s.role)} (${s.mode})`)
        .join('  →  ');
      parts.push(
        `Earlier stages already ran in THIS worktree and committed their work — it is here for you to build on, not redo. What ran before you: ${prior}. Read the worktree for the current state before you start.`,
      );
    }

    if (plan) {
      parts.push(`The APPROVED plan for this task (your north star):\n${plan}`);
    }

    parts.push(`The work item:\n${ticket}`);
    parts.push(`Your job: ${job}.`);

    const next = def.stages[index + 1];
    parts.push(
      next
        ? `When you're done, the next stage (${roleName(next.role)} — ${next.mode}) picks up from your COMMITTED work in this same worktree — leave it clean and make your report clear so the handoff is smooth.`
        : `This is the FINAL stage of the pipeline.`,
    );
    parts.push(
      `Report back when done; the orchestrator advances the pipeline from your report.`,
    );

    return parts.join('\n\n');
  }
}
