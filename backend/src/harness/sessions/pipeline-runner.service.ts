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
import {
  PipelineRunSectionStore,
  type PipelineRunSection,
  type SectionPhase,
} from '../memory/pipeline-run-section-store';
import { ReviewPipelineService } from './review-pipeline.service';
import {
  SESSION_REGISTRY,
  type Session,
  type SessionRegistry,
} from './session-registry.port';
import { SessionRunnerService } from './session-runner.service';

/** A section Atlas declares at dispatch — the just-in-time plan + build happen later, per section. */
export interface SectionInput {
  name: string;
  brief?: string;
  /** The phase-config (synthetic worker) id this section runs as, e.g. 'phase_backend'. */
  role: string;
}

/** Sentinel `pipeline` name for a dynamic, section-driven run (vs a static registry pipeline name). */
const DYNAMIC = 'dynamic';

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
      if (!this.employees.byId(s.role))
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
    await this.openSectionPlan(run, 0);
    return (await this.runs.get(opts.team, run.id)) ?? run;
  }

  // ── section-driver: planning ──────────────────────────────────────────────

  /** Open section `index`'s just-in-time plan session (its phase-config self-reviews on Codex). */
  private async openSectionPlan(run: PipelineRun, index: number): Promise<void> {
    const sections = await this.sectionStore.listForRun(run.id);
    const section = sections[index];
    if (!section) {
      this.logger.warn(`pipeline ${run.id}: no section at index ${index} — failing`);
      await this.runs.update(run.team, run.id, { status: 'failed' });
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
    if (!outcome.ok) {
      this.logger.warn(
        `pipeline ${run.id}: propose failed (${outcome.kind}) — failing the run (no card posted)`,
      );
      await this.runs.update(run.team, run.id, { status: 'failed' });
    }
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
      this.logger.warn(`pipeline ${run.id}: approved but no active section — failing`);
      await this.runs.update(run.team, run.id, { status: 'failed' });
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
    // Section done — advance to the next section's plan, or ship the terminal PR.
    await this.sectionStore.update(section.id, { status: 'done' });
    const sections = await this.sectionStore.listForRun(run.id);
    const nextSection = run.sectionIndex + 1;
    if (nextSection < sections.length) {
      await this.openSectionPlan(run, nextSection);
      return;
    }
    await this.handlePrGate(run, session);
  }

  // ── shared: PR gate (terminal for feature + bugfix) ─────────────────────────

  /** Ship the accumulated worktree as ONE ready PR (reuse ReviewPipelineService.shipTask — no sibling
   * fan-out). A ship failure fails the run loudly so it never reports a PR that didn't open. */
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
      notifyThread: run.notifyThread ?? session.notifyThread,
    });
    if (!shipped.ok) {
      this.logger.warn(`pipeline ${run.id}: shipTask failed — ${shipped.reason}`);
      await this.runs.update(run.team, run.id, { status: 'failed' });
      return;
    }
    this.logger.log(
      `pipeline ${run.id} (${run.kind}) shipped #${run.taskId}: ${shipped.prUrl}`,
    );
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
      this.logger.warn(
        `pipeline ${run.id}: session ${session.id} (kind=${run.kind}, section=${run.sectionIndex}, phase=${run.phaseIndex}, mode=${run.mode}) failed — failing run`,
      );
      await this.runs.update(run.team, run.id, { status: 'failed' });
      return;
    }

    if (run.kind === 'bugfix') {
      await this.handlePrGate(run, session); // single execute session done → ship
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
      this.logger.warn(`pipeline ${run.id}: missing worktree/project/thread — failing`);
      await this.runs.update(run.team, run.id, { status: 'failed' });
      return;
    }
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
      .map((s) => s.name)
      .join(', ');
    const parts = [
      `You are planning the "${section.name}" section of a larger feature, to be built in this worktree.`,
      section.brief ? `This section's focus: ${section.brief}` : undefined,
      prior
        ? `Earlier sections already shipped into THIS worktree: ${prior}. Read the current worktree state before planning — build on what's there, don't redo it.`
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
