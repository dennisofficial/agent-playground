import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ProposalService } from '../approvals/proposal.service';
import type { WorkerMode } from '../engines/worker-engine.port';
import { EmployeeRegistry } from '../employees/employee.registry';
import { BoardStore } from '../memory/board-store';
import { BoardEventsBus, type BoardEvent } from '../memory/board-events.bus';
import { PlanStore } from '../memory/plan-store';
import { PipelineRunStore, type PipelineRun } from '../memory/pipeline-run-store';
import {
  PipelineRunSectionStore,
  type PipelineRunSection,
  type SectionPhase,
} from '../memory/pipeline-run-section-store';
import { WorktreeService } from '../worktrees/worktree.service';
import { ReviewPipelineService } from './review-pipeline.service';
import {
  SESSION_REGISTRY,
  type Session,
  type SessionRegistry,
} from './session-registry.port';
import { SessionRunnerService } from './session-runner.service';

const pExecFile = promisify(execFile);

/** A section Atlas declares at dispatch — the just-in-time plan + build happen later, per section. */
export interface SectionInput {
  name: string;
  brief?: string;
  /** The phase-config (synthetic worker) id this section runs as, e.g. 'phase_backend'. The sentinel
   * 'design' marks a human design gate (no phase-config) — see DESIGN_ROLE. */
  role: string;
}

/** Sentinel `pipeline` name for a dynamic, section-driven run (vs a static registry pipeline name). */
const DYNAMIC = 'dynamic';
/** Sentinel section role for a DESIGN section — a human gate that produces the `design/` artifact the
 * NEXT section implements, rather than a phase-config that runs engine turns. */
export const DESIGN_ROLE = 'design';

/**
 * The DYNAMIC section-driver. A 'feature' run is a list of strictly-sequential SECTIONS (Atlas
 * declares them at dispatch); each section is planned just-in-time (a plan session whose phase-config
 * self-reviews on Codex → MD#2), gated for Dennis's approval, then BUILT phase-by-phase (one fresh
 * execute session per phase, each followed by a fresh review). Work accumulates in ONE worktree; the
 * last section's last phase ships ONE PR. A 'bugfix' run skips all of it — a single execute session
 * straight to the PR gate.
 *
 * The durable `pipeline_runs` row is the source of truth: the 2-D cursor (section_index, phase_index)
 * + planning_substep ('drafting' | 'gate' | null) + mode ('plan' | 'execute' | 'investigate') encode
 * exactly what is live, so a restart re-enters the identical state. The in-process `sessions.onUpdate`
 * signal only TRIGGERS re-evaluation; it never carries state.
 */
@Injectable()
export class PipelineRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PipelineRunnerService.name);

  constructor(
    private readonly runs: PipelineRunStore,
    private readonly sectionStore: PipelineRunSectionStore,
    private readonly runner: SessionRunnerService,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    private readonly board: BoardStore,
    private readonly employees: EmployeeRegistry,
    private readonly plans: PlanStore,
    private readonly proposals: ProposalService,
    private readonly review: ReviewPipelineService,
    private readonly boardEvents: BoardEventsBus,
    private readonly worktrees: WorktreeService,
  ) {}

  onApplicationBootstrap(): void {
    this.sessions.onUpdate((s) => {
      void this.onSessionUpdate(s).catch((err) =>
        this.logger.warn(`pipeline onSessionUpdate(${s.id}) failed: ${err}`),
      );
    });
    // A section's plan gate resumes when Dennis approves (board CAS → ticket-approved).
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
   * Start a run. AWAITED (the dispatch tool surfaces a throw as the tool result — never a swallowed
   * log): all the durable setup + opening the first session happen here; only the engine TURN itself
   * is detached (inside openStageSession). 'feature' creates the section rows + opens section 0's plan;
   * 'bugfix' opens a single execute session.
   */
  async start(opts: {
    team: string;
    project: string;
    taskId: number;
    worktreeId: string;
    notifyThread: string;
    kind: 'feature' | 'bugfix';
    /** feature: the declared section list (≥1). */
    sections?: ReadonlyArray<SectionInput>;
    /** bugfix: the phase-config to run the single fix session as. */
    role?: string;
    /** feature: the agreed high-level plan from scoping — seeds every section's plan prompt. */
    overview?: string;
  }): Promise<PipelineRun> {
    if (opts.kind === 'bugfix') {
      if (!opts.role) throw new Error('bugfix run requires a role');
      const run = await this.runs.create({
        team: opts.team,
        taskId: opts.taskId,
        pipeline: 'bugfix',
        kind: 'bugfix',
        worktreeId: opts.worktreeId,
        notifyThread: opts.notifyThread,
        project: opts.project,
      });
      await this.board
        .update(opts.team, opts.taskId, { status: 'executing' })
        .catch(() => undefined);
      await this.openSession(run, opts.role, 'execute', this.bugfixPrompt(run));
      return (await this.runs.get(opts.team, run.id)) ?? run;
    }

    const sections = opts.sections ?? [];
    if (sections.length === 0)
      throw new Error('feature run requires at least one section');
    for (const s of sections) {
      if (s.role !== DESIGN_ROLE && !this.employees.byId(s.role))
        throw new Error(`unknown phase-config '${s.role}' for section '${s.name}'`);
    }
    const run = await this.runs.create({
      team: opts.team,
      taskId: opts.taskId,
      pipeline: DYNAMIC,
      kind: 'feature',
      worktreeId: opts.worktreeId,
      notifyThread: opts.notifyThread,
      project: opts.project,
      planningSubstep: 'drafting',
      overview: opts.overview,
    });
    await this.sectionStore.createMany(
      run.id,
      opts.team,
      sections.map((s, i) => ({
        ordinal: (i + 1) * 10, // gap-numbered: a mid-run insert needs no renumber
        name: s.name,
        brief: s.brief,
        phaseRole: s.role,
      })),
    );
    await this.openSection(run, 0);
    return (await this.runs.get(opts.team, run.id)) ?? run;
  }

  // ── section-driver: routing ─────────────────────────────────────────────────

  /** Advance to section `index`: a DESIGN section opens a human gate (no engine turn); any other
   * section opens its just-in-time plan session. The single entry every advance routes through. */
  private async openSection(run: PipelineRun, index: number): Promise<void> {
    const sections = await this.sectionStore.listForRun(run.id);
    const section = sections[index];
    if (!section) {
      await this.failRun(run, `no section at index ${index}`);
      return;
    }
    if (section.phaseRole === DESIGN_ROLE)
      await this.openDesignGate(run, index, section);
    else await this.openSectionPlan(run, index);
  }

  /** A DESIGN section: pause for the human to produce + attach the artifact (or skip). No engine turn
   * runs here — resume is via attachDesign()/skipDesign(), not a board event. */
  private async openDesignGate(
    run: PipelineRun,
    index: number,
    section: PipelineRunSection,
  ): Promise<void> {
    await this.sectionStore.update(section.id, { status: 'awaiting_design' });
    await this.runs.update(run.team, run.id, {
      sectionIndex: index,
      status: 'paused',
      planningSubstep: 'awaiting_design',
    });
    this.logger.log(
      `pipeline ${run.id}: design gate at section ${index} (${section.name}) — awaiting artifact`,
    );
    this.boardEvents.emit({
      kind: 'design-gate',
      team: run.team,
      taskId: run.taskId,
      section: section.name,
      notifyThread: run.notifyThread,
    });
  }

  // ── section-driver: planning ──────────────────────────────────────────────

  /** Open section `index`'s just-in-time plan session (its phase-config self-reviews on Codex). */
  private async openSectionPlan(run: PipelineRun, index: number): Promise<void> {
    const sections = await this.sectionStore.listForRun(run.id);
    const section = sections[index];
    if (!section) {
      await this.failRun(run, `no section at index ${index}`);
      return;
    }
    await this.sectionStore.update(section.id, { status: 'planning' });
    await this.runs.update(run.team, run.id, {
      sectionIndex: index,
      phaseIndex: 0,
      planningSubstep: 'drafting',
      status: 'running',
    });
    const refreshed = (await this.runs.get(run.team, run.id)) ?? run;
    await this.openSession(
      refreshed,
      section.phaseRole,
      'plan',
      this.sectionPlanPrompt(refreshed, section, sections),
    );
  }

  /**
   * The section's plan session reported back its (self-reviewed) MD#2: archive it on the section row,
   * attach + auto-clear the lead layer, move the board to 'planning', PAUSE the run at the gate, then
   * propose for Dennis's approval. Sequentiality lets this reuse the single board gate per section.
   */
  private async handleSectionPlanGate(
    run: PipelineRun,
    section: PipelineRunSection,
    session: Session,
  ): Promise<void> {
    const planMd = session.lastReport?.trim() || '(no plan produced)';
    await this.sectionStore.update(section.id, { planMd, status: 'planning' });
    await this.plans
      .attach({
        team: run.team,
        taskId: run.taskId,
        employee: section.phaseRole,
        planMd,
        sessionId: session.id,
      })
      .catch((err) =>
        this.logger.warn(`pipeline ${run.id}: plan attach failed: ${err}`),
      );
    // Atlas auto-clears the lead-review layer (no separate lead pass). Must use the SAME employee the
    // plan was attached as, or approve() no-ops and the proposal guard rejects an unapproved plan.
    await this.plans
      .approve(run.team, run.taskId, section.phaseRole)
      .catch(() => undefined);
    await this.board
      .update(run.team, run.taskId, { status: 'planning' })
      .catch(() => undefined);
    // PAUSE (at the gate) BEFORE proposing, so an approval that races the card always finds the run
    // already paused — onBoardEvent resumes a paused+gate run only.
    await this.runs.update(run.team, run.id, {
      status: 'paused',
      planningSubstep: 'gate',
    });
    const outcome = await this.proposals.propose({
      team: run.team,
      taskId: run.taskId,
      summary: `Section '${section.name}' (${run.sectionIndex + 1} of ${(await this.sectionStore.listForRun(run.id)).length}) is planned. Review the attached plan and approve to build it.`,
      proposedBy: this.employees.teamLead().id,
      surfaceId: run.notifyThread ?? session.notifyThread,
    });
    if (!outcome.ok)
      await this.failRun(run, `propose failed (${outcome.kind}) (no card posted)`);
  }

  /** Route a plan-gate verdict to the active section (the cursor, not the event, says which one). */
  private async onBoardEvent(event: BoardEvent): Promise<void> {
    if (
      event.kind !== 'ticket-approved' &&
      event.kind !== 'ticket-changes-requested' &&
      event.kind !== 'ticket-denied'
    )
      return;
    const run = await this.gatedRun(event.team, event.taskId);
    if (!run) return;
    if (event.kind === 'ticket-changes-requested') {
      // R1: Dennis sent the plan back — re-plan THIS section (no wedge). The board is already
      // 'planning' (the verdict set it); re-open a fresh plan session for the same section.
      this.logger.log(
        `pipeline ${run.id}: section ${run.sectionIndex} changes requested — re-planning`,
      );
      await this.openSectionPlan(run, run.sectionIndex);
      return;
    }
    if (event.kind === 'ticket-denied') {
      // R1: Dennis released the ticket — fail the run (it's back on the open backlog for Atlas).
      this.logger.log(`pipeline ${run.id}: section plan denied — failing run`);
      const { section } = await this.activeSection(run);
      if (section) await this.sectionStore.update(section.id, { status: 'failed' });
      await this.closeRunSession(run.sessionId); // reclaim the idle plan session
      await this.runs.update(run.team, run.id, { status: 'failed' });
      return;
    }
    await this.handleSectionApproved(run);
  }

  /** A run parked at a plan gate for `taskId`, or undefined. */
  private async gatedRun(
    team: string,
    taskId: number,
  ): Promise<PipelineRun | undefined> {
    const run = await this.runs.getByTask(team, taskId);
    if (!run || run.status !== 'paused' || run.planningSubstep !== 'gate')
      return undefined;
    if (run.kind !== 'feature' || run.pipeline !== DYNAMIC) return undefined;
    return run;
  }

  /** Dennis approved the active section's plan: parse its phases, flip to building, open phase 0. */
  private async handleSectionApproved(run: PipelineRun): Promise<void> {
    const sections = await this.sectionStore.listForRun(run.id);
    const section = sections[run.sectionIndex];
    if (!section) {
      await this.failRun(run, 'approved but no active section');
      return;
    }
    const phases = parsePhases(section.planMd ?? '');
    const phaseCount = phases?.length ?? 1;
    await this.sectionStore.update(section.id, {
      status: 'building',
      phases: phases ?? [{ id: 1 }],
      phaseCount,
    });
    await this.board
      .update(run.team, run.taskId, { status: 'executing' })
      .catch(() => undefined);
    await this.runs.update(run.team, run.id, {
      status: 'running',
      planningSubstep: null,
      phaseIndex: 0,
    });
    const refreshed = (await this.runs.get(run.team, run.id)) ?? run;
    await this.openPhaseExecute(refreshed, 0);
  }

  // ── section-driver: building ────────────────────────────────────────────────

  /** Open a fresh execute session for build-phase `phaseIndex` of the active section. */
  private async openPhaseExecute(
    run: PipelineRun,
    phaseIndex: number,
  ): Promise<void> {
    const { section, phases } = await this.activeSection(run);
    if (!section) return;
    await this.runs.update(run.team, run.id, {
      phaseIndex,
      mode: 'execute',
      planningSubstep: null,
      status: 'running',
    });
    const refreshed = (await this.runs.get(run.team, run.id)) ?? run;
    await this.openSession(
      refreshed,
      section.phaseRole,
      'execute',
      this.phaseExecutePrompt(section, phaseIndex, phases),
    );
  }

  /** Open a fresh READ-ONLY review session over the just-built phase (tracked via mode='investigate',
   * so its idle is distinguishable from the phase execute session's — no onSessionUpdate re-entry). */
  private async openPhaseReview(run: PipelineRun): Promise<void> {
    const { section, phases } = await this.activeSection(run);
    if (!section) return;
    await this.runs.update(run.team, run.id, { mode: 'investigate' });
    const refreshed = (await this.runs.get(run.team, run.id)) ?? run;
    await this.openSession(
      refreshed,
      section.phaseRole,
      'investigate',
      this.phaseReviewPrompt(section, refreshed.phaseIndex, phases),
    );
  }

  /** A phase review finished. v1 is ADVISORY: capture the report, mark the phase reviewed, advance.
   * (Acting on a blocker verdict — pause/auto-fix — is Phase-5 hardening; for now it never wedges.) */
  private async advanceAfterReview(
    run: PipelineRun,
    session: Session,
  ): Promise<void> {
    const { section, phases } = await this.activeSection(run);
    if (!section) return;
    const marked = phases.map((p, i) =>
      i === run.phaseIndex ? { ...p, reviewed: true } : p,
    );
    await this.sectionStore.update(section.id, { phases: marked });
    const verdict = parseVerdict(session.lastReport ?? '');
    if (verdict?.summary)
      this.logger.log(
        `pipeline ${run.id}: phase ${run.phaseIndex + 1} review — ${verdict.summary}`,
      );

    const nextPhase = run.phaseIndex + 1;
    const phaseCount = section.phaseCount ?? phases.length;
    if (nextPhase < phaseCount) {
      await this.openPhaseExecute(run, nextPhase);
      return;
    }
    // Section done — advance to the next section (build or design gate), or ship the terminal PR.
    await this.sectionStore.update(section.id, { status: 'done' });
    const sections = await this.sectionStore.listForRun(run.id);
    const nextSection = run.sectionIndex + 1;
    if (nextSection < sections.length) {
      await this.openSection(run, nextSection);
      return;
    }
    await this.handlePrGate(run);
  }

  // ── design gate: human-produced artifact (interim) ──────────────────────────

  /** Attach the human's design artifact (a local zip path): unzip into the worktree's `design/`, mark
   * the design section done, and advance to the implementer section (which builds against it). */
  async attachDesign(
    team: string,
    taskId: number,
    source: string,
  ): Promise<{ ok: boolean; message: string }> {
    const run = await this.runs.getByTask(team, taskId);
    if (!run || run.status !== 'paused' || run.planningSubstep !== 'awaiting_design')
      return { ok: false, message: `#${taskId} isn't waiting at a design gate.` };
    if (!run.worktreeId) return { ok: false, message: `#${taskId} has no worktree.` };
    const wt = this.worktrees.get(run.worktreeId);
    if (!wt) return { ok: false, message: `Worktree '${run.worktreeId}' not found.` };
    if (/^https?:\/\//i.test(source))
      return {
        ok: false,
        message:
          'For now, hand me a LOCAL path to the design zip (the online export lands in your Downloads), not a URL.',
      };
    const designDir = join(wt.path, 'design');
    try {
      mkdirSync(designDir, { recursive: true });
      await pExecFile('unzip', ['-o', source, '-d', designDir]);
    } catch (err) {
      return {
        ok: false,
        message: `Couldn't unzip '${source}' into the worktree: ${err instanceof Error ? err.message : String(err)}.`,
      };
    }
    const sections = await this.sectionStore.listForRun(run.id);
    const section = sections[run.sectionIndex];
    if (section) await this.sectionStore.update(section.id, { status: 'done' });
    await this.runs.update(team, run.id, {
      status: 'running',
      planningSubstep: null,
    });
    const refreshed = (await this.runs.get(team, run.id)) ?? run;
    await this.openSection(refreshed, run.sectionIndex + 1);
    return {
      ok: true,
      message: `Design attached to ${run.worktreeId} (design/). The next section is now planning/building against it.`,
    };
  }

  /** Skip the design gate: mark the design section AND its implementer skipped, ship the functional
   * version (or continue to later sections). The tool result asks Atlas to offer Dennis a backlog. */
  async skipDesign(
    team: string,
    taskId: number,
  ): Promise<{ ok: boolean; message: string }> {
    const run = await this.runs.getByTask(team, taskId);
    if (!run || run.status !== 'paused' || run.planningSubstep !== 'awaiting_design')
      return { ok: false, message: `#${taskId} isn't waiting at a design gate.` };
    const sections = await this.sectionStore.listForRun(run.id);
    const design = sections[run.sectionIndex];
    if (design) await this.sectionStore.update(design.id, { status: 'skipped' });
    // The section right after a design gate is its implementer — skip it too (nothing to implement
    // without a design).
    const implementer = sections[run.sectionIndex + 1];
    let nextIndex = run.sectionIndex + 1;
    if (implementer) {
      await this.sectionStore.update(implementer.id, { status: 'skipped' });
      nextIndex = run.sectionIndex + 2;
    }
    await this.runs.update(team, run.id, {
      status: 'running',
      planningSubstep: null,
      sectionIndex: nextIndex,
    });
    const refreshed = (await this.runs.get(team, run.id)) ?? run;
    if (nextIndex < sections.length) await this.openSection(refreshed, nextIndex);
    else await this.handlePrGate(refreshed); // no more sections → ship the functional version
    return {
      ok: true,
      message: `Skipped the design (and its implementation) for #${taskId} — the functional version will ship. Ask Dennis whether to backlog the design + redesign for later; add_board_task ONLY if he says yes.`,
    };
  }

  // ── shared: PR gate (terminal for feature + bugfix) ─────────────────────────

  /** Ship the accumulated worktree as ONE ready PR (reuse ReviewPipelineService.shipTask — no sibling
   * fan-out). A ship failure fails the run loudly so it never reports a PR that didn't open. Driven
   * off the durable run (notify_thread), so it works with or without a live session (e.g. skip-to-PR). */
  private async handlePrGate(run: PipelineRun): Promise<void> {
    if (!run.worktreeId) {
      await this.failRun(run, 'PR gate with no worktree');
      return;
    }
    const shipped = await this.review.shipTask({
      team: run.team,
      taskId: run.taskId,
      worktreeId: run.worktreeId,
      notifyThread: run.notifyThread ?? '',
    });
    if (!shipped.ok) {
      await this.failRun(run, `shipTask failed — ${shipped.reason}`);
      return;
    }
    this.logger.log(
      `pipeline ${run.id} (${run.kind}) shipped #${run.taskId}: ${shipped.prUrl}`,
    );
    // The run is done — reclaim its final stage session so it doesn't block worktree cleanup later.
    await this.closeRunSession(run.sessionId);
    await this.runs.update(run.team, run.id, {
      status: 'done',
      currentRole: null,
      mode: null,
    });
  }

  // ── the dispatcher ──────────────────────────────────────────────────────────

  /** React to a tracked session reporting back: route purely off the durable cursor. */
  private async onSessionUpdate(session: Session): Promise<void> {
    if (session.status !== 'idle' && session.status !== 'failed') return;
    if (session.boardTaskId === undefined) return;
    const run = await this.runs.getByTask(session.team, session.boardTaskId);
    if (!run || run.status !== 'running' || run.sessionId !== session.id) return;

    if (session.status === 'failed') {
      await this.failRun(
        run,
        `session ${session.id} (kind=${run.kind}, section=${run.sectionIndex}, phase=${run.phaseIndex}, mode=${run.mode}) failed`,
      );
      return;
    }

    // A turn that ended with QUESTIONS is NOT a finished plan/build — never treat it as one (that bug
    // proposed an approval card for a clarifying question). Relay it to Atlas (he answers or asks
    // Dennis) and leave the session open for answer_section; the run stays where it is.
    if (session.lastReportKind === 'questions') {
      await this.relaySectionQuestions(run, session);
      return;
    }

    if (run.kind === 'bugfix') {
      await this.handlePrGate(run); // single execute session done → ship
      return;
    }
    if (run.pipeline !== DYNAMIC) return; // legacy flat runs aren't driven here

    if (run.planningSubstep === 'drafting') {
      const { section } = await this.activeSection(run);
      if (section) await this.handleSectionPlanGate(run, section, session);
      return;
    }
    // Building: mode distinguishes the phase execute session from its review session.
    if (run.mode === 'execute') {
      await this.openPhaseReview(run);
      return;
    }
    if (run.mode === 'investigate') {
      await this.advanceAfterReview(run, session);
      return;
    }
  }

  /** A session asked questions instead of finishing — relay them to Atlas (answer_section or ask
   * Dennis). The run is left untouched (still running, session idle), so a later answer resumes it. */
  private async relaySectionQuestions(
    run: PipelineRun,
    session: Session,
  ): Promise<void> {
    const section =
      run.kind === 'feature' && run.pipeline === DYNAMIC
        ? (await this.activeSection(run)).section
        : undefined;
    this.logger.log(
      `pipeline ${run.id}: ${section?.name ?? 'bugfix'} session asked questions — relaying to Atlas (no gate)`,
    );
    this.boardEvents.emit({
      kind: 'section-questions',
      team: run.team,
      taskId: run.taskId,
      section: section?.name,
      questions: session.lastReport ?? '(no questions text)',
      notifyThread: run.notifyThread,
    });
  }

  /** Deliver Atlas's answers into the section/bugfix session that asked questions (Atlas can't
   * reply_session — it's not his session). Resumes the SAME session (keeps its context) in its current
   * mode, detached; its report-back re-enters onSessionUpdate (a revised plan → gate, or more
   * questions → relay again). */
  async answerSectionQuestions(
    team: string,
    taskId: number,
    answers: string,
  ): Promise<{ ok: boolean; message: string }> {
    const run = await this.runs.getByTask(team, taskId);
    if (!run || run.status !== 'running' || !run.sessionId)
      return { ok: false, message: `#${taskId} has no open session waiting on answers.` };
    const session = await this.sessions.get(run.sessionId);
    if (
      !session ||
      session.status !== 'idle' ||
      session.lastReportKind !== 'questions'
    )
      return {
        ok: false,
        message: `#${taskId}'s session isn't waiting on answers right now.`,
      };
    const mode: WorkerMode =
      run.planningSubstep === 'drafting'
        ? 'plan'
        : run.mode === 'investigate'
          ? 'investigate'
          : 'execute';
    const res = await this.runner.replySession(run.sessionId, answers, mode);
    if (!res.ok)
      return {
        ok: false,
        message: `Couldn't deliver the answers to #${taskId}: ${res.reason}`,
      };
    const section =
      run.kind === 'feature' && run.pipeline === DYNAMIC
        ? (await this.activeSection(run)).section
        : undefined;
    return {
      ok: true,
      message: `Answers delivered to the ${section ? `'${section.name}' ` : ''}session for #${taskId}; it's reworking and will report back (a revised plan, or more questions).`,
    };
  }

  // ── boot recovery ────────────────────────────────────────────────────────────

  /**
   * Re-drive in-flight runs on boot — the in-process turn dies on restart, so a 'running' run would
   * otherwise stall. Reads the durable cursor for each. (R2 — a section approved during downtime, run
   * left paused+gate while the board is already 'approved' — is Phase-5 hardening; here a paused+gate
   * run simply waits for the next ticket-approved.)
   */
  async resumePipelines(): Promise<void> {
    const active = await this.runs.listAllActive();
    for (const run of active) {
      // R2: a section approved while we were down — announceIfApproved won't re-fire on boot, so a
      // run parked at its gate would stall though the board already shows 'approved'. Replay it.
      if (
        run.status === 'paused' &&
        run.planningSubstep === 'gate' &&
        run.pipeline === DYNAMIC
      ) {
        try {
          const task = await this.board.get(run.team, run.taskId);
          if (task?.status === 'approved') await this.handleSectionApproved(run);
        } catch (err) {
          this.logger.warn(`pipeline ${run.id}: boot gate-reconcile failed: ${err}`);
        }
        continue;
      }
      if (run.status !== 'running') continue; // paused (gate) waits for onBoardEvent
      if (run.kind !== 'bugfix' && run.pipeline !== DYNAMIC) continue; // legacy: not driven
      try {
        const session = run.sessionId
          ? await this.sessions.get(run.sessionId)
          : undefined;
        if (session && (session.status === 'idle' || session.status === 'failed')) {
          await this.onSessionUpdate(session); // process the missed turn-end
          continue;
        }
        if (session && session.status === 'closed') continue; // owner closed — manual
        // Session gone / stale-'running' (turn died on restart): re-open the current step.
        await this.reopenCurrentStep(run);
      } catch (err) {
        this.logger.warn(`pipeline ${run.id}: boot resume failed: ${err}`);
      }
    }
  }

  /** Re-open whatever step the durable cursor says is live (boot recovery). */
  private async reopenCurrentStep(run: PipelineRun): Promise<void> {
    if (run.kind === 'bugfix') {
      await this.openSession(run, '', 'execute', this.bugfixPrompt(run), run);
      return;
    }
    if (run.planningSubstep === 'drafting') {
      await this.openSectionPlan(run, run.sectionIndex);
      return;
    }
    if (run.mode === 'execute') await this.openPhaseExecute(run, run.phaseIndex);
    else if (run.mode === 'investigate') await this.openPhaseReview(run);
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  /**
   * Reclaim a stage session the driver is done with. Pipeline sessions are owned by synthetic
   * phase-configs (e.g. 'phase_backend') that never sit in chat and so never call close_session — so
   * if the driver doesn't close them itself they pile up as idle/failed orphans in the run's worktree.
   * An open session blocks worktree cleanup (remove_worktree refuses while any session is open), so a
   * finished run's orphans deadlock Atlas when he later reclaims the worktree. Uses the runner's
   * low-level close (no ownership gate) and skips the worklog (intermediate stage turns aren't
   * standup-worthy; the PR + board events narrate the real outcome). Best-effort — never derails a run.
   */
  private async closeRunSession(
    sessionId: string | null | undefined,
  ): Promise<void> {
    if (!sessionId) return;
    const session = await this.sessions.get(sessionId);
    if (!session || session.status === 'closed') return;
    const res = await this.runner.closeSession(sessionId, { logWork: false });
    if (!res.ok)
      this.logger.warn(`pipeline: couldn't close session ${sessionId} — ${res.reason}`);
  }

  /** Terminal failure: reclaim the active session (a failed run's worktree gets cleaned up later, so
   * its session must not linger as an orphan either), then mark the run failed. */
  private async failRun(run: PipelineRun, reason: string): Promise<void> {
    this.logger.warn(`pipeline ${run.id}: ${reason} — failing`);
    const latest = (await this.runs.get(run.team, run.id)) ?? run;
    await this.closeRunSession(latest.sessionId);
    await this.runs.update(run.team, run.id, { status: 'failed' });
  }

  /** The active section + its parsed phases (empty array if none parsed yet). */
  private async activeSection(
    run: PipelineRun,
  ): Promise<{ section?: PipelineRunSection; phases: SectionPhase[] }> {
    const sections = await this.sectionStore.listForRun(run.id);
    const section = sections[run.sectionIndex];
    return { section, phases: section?.phases ?? [] };
  }

  /** Open a session for `run` as `role`/`mode`, stamping it as the run's active session. For bugfix
   * re-open on boot the role is read from the run's current_role. */
  private async openSession(
    run: PipelineRun,
    role: string,
    mode: 'plan' | 'execute' | 'investigate',
    task: string,
    reopen?: PipelineRun,
  ): Promise<void> {
    const resolvedRole = role || reopen?.currentRole || '';
    if (!run.worktreeId || !run.project || !run.notifyThread) {
      await this.failRun(run, 'missing worktree/project/thread');
      return;
    }
    // Reclaim the session this open supersedes before we overwrite run.sessionId — otherwise each
    // phase/review transition strands the previous one as an idle orphan in the worktree.
    await this.closeRunSession(run.sessionId);
    const session = await this.runner.openStageSession({
      role: resolvedRole,
      team: run.team,
      project: run.project,
      worktreeId: run.worktreeId,
      task,
      mode,
      notifyThread: run.notifyThread,
      boardTaskId: run.taskId,
    });
    await this.runs.update(run.team, run.id, {
      sessionId: session.id,
      currentRole: resolvedRole,
      mode,
      status: 'running',
    });
  }

  // ── prompts ──────────────────────────────────────────────────────────────────

  private sectionPlanPrompt(
    run: PipelineRun,
    section: PipelineRunSection,
    sections: PipelineRunSection[],
  ): string {
    const prior = sections
      .slice(0, run.sectionIndex)
      .filter((s) => s.status === 'done')
      .map((s) => s.name)
      .join(', ');
    const priorSection = sections[run.sectionIndex - 1];
    const designAvailable =
      priorSection?.phaseRole === DESIGN_ROLE && priorSection.status === 'done';
    const parts = [
      `You are planning the "${section.name}" section of a larger feature, to be built in this worktree.`,
      run.overview
        ? `The agreed HIGH-LEVEL PLAN for the whole feature (your north star — plan this section to fit it):\n${run.overview}`
        : undefined,
      section.brief ? `This section's focus: ${section.brief}` : undefined,
      prior
        ? `Earlier sections already shipped into THIS worktree: ${prior}. Read the current worktree state before planning — build on what's there, don't redo it.`
        : undefined,
      designAvailable
        ? `The APPROVED design (specs + reference) is in the worktree under \`design/\` — your plan must implement it faithfully over the existing functional UI.`
        : undefined,
      `Produce a HIGHLY DETAILED, fully-specified implementation plan for THIS section only. Break it into as many sequential PHASES as it needs — each phase a coherent, independently-committable chunk. Do NOT implement; this is a plan and goes to Dennis for approval before any code is written.`,
      `End your plan with a fenced code block tagged \`phases\` containing a JSON array, one object per phase, e.g.:\n\`\`\`phases\n[{"id":1,"title":"DB schema + migration"},{"id":2,"title":"service + API endpoint"}]\n\`\`\`\nThe orchestrator parses it to chunk the build; if you omit it the whole plan runs as one phase.`,
    ];
    return parts.filter(Boolean).join('\n\n');
  }

  private phaseExecutePrompt(
    section: PipelineRunSection,
    phaseIndex: number,
    phases: SectionPhase[],
  ): string {
    const total = section.phaseCount ?? phases.length;
    const phase = phases[phaseIndex];
    const label = phase
      ? `phase ${phase.id}${phase.title ? ` — ${phase.title}` : ''}`
      : `phase ${phaseIndex + 1}`;
    const parts = [
      `You are implementing the "${section.name}" section of a feature in this worktree — ${label} (${phaseIndex + 1} of ${total}).`,
      section.planMd
        ? `The APPROVED plan for this section (your north star):\n\n${section.planMd}`
        : undefined,
      phaseIndex > 0
        ? `Earlier phases already committed in this worktree — build on them, don't redo them.`
        : undefined,
      `Implement ONLY this phase, test/smoke-validate your work, and commit it cleanly. Report what you did so the orchestrator can advance.`,
    ];
    return parts.filter(Boolean).join('\n\n');
  }

  private phaseReviewPrompt(
    section: PipelineRunSection,
    phaseIndex: number,
    phases: SectionPhase[],
  ): string {
    const phase = phases[phaseIndex];
    const label = phase
      ? `phase ${phase.id}${phase.title ? ` — ${phase.title}` : ''}`
      : `phase ${phaseIndex + 1}`;
    return [
      `You are reviewing — READ-ONLY — the work just committed for ${label} of the "${section.name}" section, in this worktree. Do NOT change files.`,
      `Review the recent changes for correctness, regressions, missed edge cases, and obvious quality issues.`,
      `End your report with a fenced block tagged \`verdict\`:\n\`\`\`verdict\n{"blocker": false, "summary": "one line"}\n\`\`\`\nSet "blocker" true ONLY if something must be fixed before the work can continue.`,
    ].join('\n\n');
  }

  private bugfixPrompt(run: PipelineRun): string {
    return [
      `You are fixing a bug in this worktree (board task #${run.taskId}). The ticket has the description, logs, and repro.`,
      `Reproduce it, fix it at the root cause, validate the fix (run/curl/test as appropriate), and commit cleanly. Report what was wrong and what you changed.`,
    ].join('\n\n');
  }
}

/** Extract a fenced ```<tag> … ``` block's body, or null. Tolerant of leading/trailing whitespace. */
function parseFenced(md: string, tag: string): string | null {
  const re = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)```', 'i');
  const m = md.match(re);
  return m ? m[1].trim() : null;
}

/** Parse the plan's `phases` JSON block → SectionPhase[]. Null on missing/malformed (caller falls
 * back to a single phase) so a bad LLM emission never wedges the build. */
function parsePhases(planMd: string): SectionPhase[] | null {
  const body = parseFenced(planMd, 'phases');
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.map((p: { id?: unknown; title?: unknown }, i) => ({
      id: typeof p.id === 'number' ? p.id : i + 1,
      title: typeof p.title === 'string' ? p.title : undefined,
    }));
  } catch {
    return null;
  }
}

/** Parse a review's `verdict` JSON block, or null. */
function parseVerdict(
  report: string,
): { blocker: boolean; summary?: string } | null {
  const body = parseFenced(report, 'verdict');
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { blocker?: unknown; summary?: unknown };
    return {
      blocker: parsed.blocker === true,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
    };
  } catch {
    return null;
  }
}
