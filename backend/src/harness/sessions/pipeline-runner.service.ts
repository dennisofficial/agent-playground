import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
  phaseGroups,
  type PipelineRunSection,
  type SectionMutation,
  type SectionPhase,
} from '../memory/pipeline-run-section-store';
import {
  PipelineRunPhaseStore,
  type PipelineRunPhase,
} from '../memory/pipeline-run-phase-store';
import {
  PipelineCodingSessionStore,
  type PipelineCodingSession,
} from '../memory/pipeline-coding-session-store';
import { PipelinePhaseReviewStore } from '../memory/pipeline-phase-review-store';
import { TicketNoteStore } from '../memory/ticket-note-store';
import { SandboxRegistry } from '../workspaces/sandbox-registry';
import { WorkspaceGitProvider } from '../workspaces/workspace-git.provider';
import { WorkspaceService } from '../workspaces/workspace.service';
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

/**
 * The shape of the ticket note the approval card writes for a CHANGES-REQUESTED verdict — see
 * `slack-app/approvals/approval-cards.service.ts` (`Requested changes on the proposal … : <feedback>`).
 * Loosely coupled ON PURPOSE: the deny-grill reads the verdict's note (the durable record of Dennis's
 * direction) rather than re-plumbing the feedback through the board event. If the phrasing ever drifts,
 * the match misses and the re-plan degrades to feedback-less (today's behavior) — never throws. Group 1
 * captures the actual direction (everything after the colon); `(no notes)` means he denied without text.
 */
const CHANGES_REQUESTED_NOTE = /requested changes on the proposal[^:]*:\s*([\s\S]*)/i;
/**
 * The stage-decision findings note `pauseForStageDecision` parks on the ticket (`Pipeline <stage> …
 * flagged a blocking issue:\n\n<findings>`). Used two ways: (a) recover the findings for a fixup
 * session — which can't open the ticket from its workspace (no get_ticket) — and (b) keep these machine
 * notes OUT of the generic planning context (the fixup path inlines them instead). Group 1 is the
 * findings body. Same loose-coupling caveat as CHANGES_REQUESTED_NOTE — if the phrasing drifts the
 * match misses and the fixer degrades to a bare "clear the blocker" (the pre-fix behavior); never
 * throws.
 */
const STAGE_FINDINGS_NOTE = /flagged a blocking issue:\s*([\s\S]*)/i;
/** Sentinel section role for a DESIGN section — a human gate that produces the `design/` artifact the
 * NEXT section implements, rather than a phase-config that runs engine turns. */
export const DESIGN_ROLE = 'design';

/**
 * The DYNAMIC section-driver. A 'feature' run is a list of dependency-ordered SECTIONS (Atlas declares
 * them at dispatch, and may grow/reorder the still-pending tail mid-run); each section is planned
 * just-in-time (a plan session whose phase-config self-reviews on Codex → MD#2), gated for Dennis's
 * approval, then BUILT phase-by-phase (one execute session per phase, each followed by a review). Work
 * accumulates in ONE workspace; the last section's last phase ships ONE PR. A 'bugfix' run skips all of
 * it — a single execute session straight to the PR gate.
 *
 * STATE = EXPLICIT ROWS, not a positional cursor. The section/phase/coding-session/review rows each
 * carry a `status` enum that IS the cursor: `activeSection`/`activePhase` locate what's live and the
 * driver "re-opens whatever the rows say is live", so a restart re-enters the identical state without
 * arithmetic (the off-by-one busy-loop / orphan-session deadlock the old 2-D cursor invited). The
 * legacy `pipeline_runs` cursor (section_index, phase_index, planning_substep, mode) is DUAL-WRITTEN
 * through the transition (boot fallback + the awareness slice) and dropped in a later drain window. The
 * in-process `sessions.onUpdate` signal only TRIGGERS re-evaluation; it never carries state.
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
    private readonly workspaces: WorkspaceService,
    private readonly phaseStore: PipelineRunPhaseStore,
    private readonly codingStore: PipelineCodingSessionStore,
    private readonly reviewStore: PipelinePhaseReviewStore,
    private readonly notes: TicketNoteStore,
    private readonly sandboxes: SandboxRegistry,
    private readonly workspaceGit: WorkspaceGitProvider,
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
    workspaceId: string;
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
        workspaceId: opts.workspaceId,
        notifyThread: opts.notifyThread,
        project: opts.project,
      });
      await this.board
        .update(opts.team, opts.taskId, { status: 'executing' })
        .catch(() => undefined);
      const ctx = await this.bugfixContext(run);
      await this.openSession(run, opts.role, 'execute', this.bugfixPrompt(run, ctx));
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
      workspaceId: opts.workspaceId,
      notifyThread: opts.notifyThread,
      project: opts.project,
      planningSubstep: 'drafting',
      overview: opts.overview,
    });
    const created = await this.sectionStore.createMany(
      run.id,
      opts.team,
      sections.map((s, i) => ({
        ordinal: (i + 1) * 10, // gap-numbered: a mid-run insert needs no renumber
        name: s.name,
        brief: s.brief,
        phaseRole: s.role,
      })),
    );
    await this.openSection(run, created[0].id);
    return (await this.runs.get(opts.team, run.id)) ?? run;
  }

  // ── section-driver: routing ─────────────────────────────────────────────────

  /** Open the section with id `sectionId`: a DESIGN section opens a human gate (no engine turn); any
   * other section opens its just-in-time plan session. The single entry every advance routes through. */
  private async openSection(run: PipelineRun, sectionId: string): Promise<void> {
    const section = await this.sectionStore.get(sectionId);
    if (!section) {
      await this.failRun(run, `no section ${sectionId}`);
      return;
    }
    if (section.phaseRole === DESIGN_ROLE)
      await this.openDesignGate(run, section);
    else await this.openSectionPlan(run, section);
  }

  /** A DESIGN section: pause for the human to produce + attach the artifact (or skip). No engine turn
   * runs here — resume is via attachDesign()/skipDesign(), not a board event. */
  private async openDesignGate(
    run: PipelineRun,
    section: PipelineRunSection,
  ): Promise<void> {
    const index = await this.positionOf(run.id, section.id);
    await this.sectionStore.update(section.id, {
      status: 'awaiting_design',
      activeSessionId: null,
    });
    await this.runs.update(run.team, run.id, {
      sectionIndex: index,
      activeSectionId: section.id,
      status: 'paused',
      planningSubstep: 'awaiting_design',
    });
    this.logger.log(
      `pipeline ${run.id}: design gate at section '${section.name}' — awaiting artifact`,
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

  /** Open a section's just-in-time plan session (its phase-config self-reviews on Codex). `denyFeedback`
   * (Dennis's changes-requested note) is woven into the prompt as authoritative direction for a re-plan. */
  private async openSectionPlan(
    run: PipelineRun,
    section: PipelineRunSection,
    denyFeedback?: string,
  ): Promise<void> {
    const index = await this.positionOf(run.id, section.id);
    await this.sectionStore.update(section.id, { status: 'planning' });
    await this.runs.update(run.team, run.id, {
      sectionIndex: index,
      activeSectionId: section.id,
      phaseIndex: 0,
      planningSubstep: 'drafting',
      status: 'running',
    });
    const refreshed = (await this.runs.get(run.team, run.id)) ?? run;
    const sections = await this.sectionStore.listForRun(run.id);
    const contextNotes = await this.ticketContextNotes(
      refreshed.team,
      refreshed.taskId,
    );
    const sid = await this.openSession(
      refreshed,
      section.phaseRole,
      'plan',
      this.sectionPlanPrompt(
        refreshed,
        section,
        sections,
        denyFeedback,
        contextNotes,
      ),
    );
    if (sid) await this.sectionStore.update(section.id, { activeSessionId: sid });
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
    const all = await this.sectionStore.listForRun(run.id);
    const pos = all.findIndex((s) => s.id === section.id) + 1;
    const outcome = await this.proposals.propose({
      team: run.team,
      taskId: run.taskId,
      summary: `Section '${section.name}' (${pos} of ${all.length}) is planned. Review the attached plan and approve to build it.`,
      proposedBy: this.employees.teamLead().id,
      surfaceId: run.notifyThread ?? session.notifyThread,
    });
    if (!outcome.ok)
      await this.failRun(run, `propose failed (${outcome.kind}) (no card posted)`);
  }

  /** Route a plan-gate verdict to the active section (the section rows, not the event, say which one). */
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
      // 'planning' (the verdict set it); re-open a fresh plan session for the same section. Carry
      // Dennis's feedback INTO the new plan prompt (deny-grill) so the re-plan is steered by his
      // direction rather than dropping it on the floor and re-deriving the same plan.
      const section = await this.sectionStore.activeSection(run.id);
      if (!section) {
        await this.failRun(run, 'changes requested but no active section');
        return;
      }
      const denyFeedback = await this.latestDenyFeedback(run.team, run.taskId);
      this.logger.log(
        `pipeline ${run.id}: section '${section.name}' changes requested — re-planning${denyFeedback ? ' with Dennis’s feedback' : ''}`,
      );
      await this.openSectionPlan(run, section, denyFeedback);
      return;
    }
    if (event.kind === 'ticket-denied') {
      // R1: Dennis released the ticket — fail the run (it's back on the open backlog for Atlas).
      this.logger.log(`pipeline ${run.id}: section plan denied — failing run`);
      const section = await this.sectionStore.activeSection(run.id);
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

  /** The direction text from the most-recent changes-requested verdict note on this task (the
   * deny-grill input), or undefined if none / he denied without notes. Newest-first scan; only the
   * latest changes-requested note matters (a fresh verdict supersedes an earlier one). */
  private async latestDenyFeedback(
    team: string,
    taskId: number,
  ): Promise<string | undefined> {
    const { notes } = await this.notes.listForTask(team, taskId, { pageSize: 20 });
    for (const note of notes) {
      const m = note.body.match(CHANGES_REQUESTED_NOTE);
      if (!m) continue;
      const text = m[1]?.trim();
      return text && text !== '(no notes)' ? text : undefined;
    }
    return undefined;
  }

  /**
   * The freeform research/decision notes parked on a ticket — the durable context a planning (or
   * bugfix) session needs but can't fetch itself (sessions have no get_ticket). Newest-first under a
   * char budget so a long trail can't blow up the seed, rendered oldest-first as a research log.
   * EXCLUDES machine-authored notes: the approval card's changes-requested verdicts (they already reach
   * planning via denyFeedback) and the stage-decision findings (the fixup path inlines those instead).
   * Returns '' when there's nothing worth seeding.
   */
  private async ticketContextNotes(team: string, taskId: number): Promise<string> {
    const { notes } = await this.notes.listForTask(team, taskId, { pageSize: 30 });
    const research = notes.filter(
      (n) =>
        !CHANGES_REQUESTED_NOTE.test(n.body) && !STAGE_FINDINGS_NOTE.test(n.body),
    );
    const MAX = 8000;
    const picked: string[] = [];
    let used = 0;
    for (const n of research) {
      // Newest-first: when the budget is tight, prefer the most recent notes.
      const block = `[${n.author} · ${n.createdAt.slice(0, 10)}]\n${n.body.trim()}`;
      if (picked.length && used + block.length > MAX) break;
      picked.push(block);
      used += block.length;
    }
    if (!picked.length) return '';
    const omitted = research.length - picked.length;
    picked.reverse(); // render oldest-first — reads as a log
    return picked.join('\n\n') + (omitted ? `\n\n(+${omitted} older note(s) on the ticket)` : '');
  }

  /**
   * The defect list from the most-recent stage-decision note on this task — the input a fixup session
   * needs but can't fetch (no get_ticket from a workspace). Newest-first; only the latest blocking
   * finding is live (a fresh stage decision supersedes an earlier one). Mirrors latestDenyFeedback.
   */
  private async latestStageFindings(
    team: string,
    taskId: number,
  ): Promise<string | undefined> {
    const { notes } = await this.notes.listForTask(team, taskId, { pageSize: 20 });
    for (const note of notes) {
      const m = note.body.match(STAGE_FINDINGS_NOTE);
      if (!m) continue;
      const text = m[1]?.trim();
      return text || undefined;
    }
    return undefined;
  }

  /** The ticket context a bugfix session must have inlined — it can't open the ticket from its
   * workspace: title + description (the bug report) + the parked research notes. */
  private async bugfixContext(run: PipelineRun): Promise<{
    title?: string;
    description?: string;
    contextNotes?: string;
  }> {
    const task = await this.board.get(run.team, run.taskId).catch(() => undefined);
    const contextNotes = await this.ticketContextNotes(run.team, run.taskId);
    return {
      title: task?.title,
      description: task?.description || undefined,
      contextNotes: contextNotes || undefined,
    };
  }

  /** Dennis approved the active section's plan: parse its phases, materialize the phase + coding-session
   * rows, freeze the section, flip to building, and open the first coding session. */
  private async handleSectionApproved(run: PipelineRun): Promise<void> {
    const section = await this.sectionStore.activeSection(run.id);
    if (!section) {
      await this.failRun(run, 'approved but no active section');
      return;
    }
    // Idempotency: a racing/replayed approval must not double-materialize the rows.
    const existing = await this.phaseStore.listForSection(section.id);
    if (existing.length > 0) {
      this.logger.warn(
        `pipeline ${run.id}: section '${section.name}' already materialized — ignoring re-approval`,
      );
      return;
    }
    const phases = parsePhases(section.planMd ?? '') ?? [{ id: 1 }];
    const phaseCount = phases.length;
    await this.sectionStore.update(section.id, {
      status: 'building',
      phases,
      phaseCount,
      frozen: true, // committed work — living-section ops may no longer reorder/wedge before it
    });
    // Fold contiguous phases into coding-session GROUPS (Phase 4): one execute session per group,
    // sharing one engine context. With no `group` in the plan this is 1 group per phase (the default).
    const groups = phaseGroups(phases);
    const coding = await this.codingStore.createMany(
      run.id,
      run.team,
      section.id,
      groups.map((_, i) => ({ ordinal: (i + 1) * 10 })),
    );
    // Flatten group membership → each phase row links to its group's coding session (groups partition
    // the phase sequence in order, so this index lines up with `phases`).
    const groupOfPhase: number[] = [];
    groups.forEach((g, gi) => g.phases.forEach(() => groupOfPhase.push(gi)));
    await this.phaseStore.createMany(
      run.id,
      run.team,
      section.id,
      phases.map((p, i) => ({
        ordinal: (i + 1) * 10,
        planPhaseId: p.id,
        title: p.title,
        codingSessionId: coding[groupOfPhase[i]].id,
      })),
    );
    await this.board
      .update(run.team, run.taskId, { status: 'executing' })
      .catch(() => undefined);
    await this.runs.update(run.team, run.id, {
      status: 'running',
      planningSubstep: null,
      phaseIndex: 0,
    });
    const refreshed = (await this.runs.get(run.team, run.id)) ?? run;
    await this.openGroupExecute(refreshed, coding[0]);
  }

  // ── section-driver: building (grouped) ──────────────────────────────────────

  /** The phase rows of a coding-session GROUP (the phases that share its one engine context), in
   * execution order. */
  private async groupPhases(
    sectionId: string,
    codingId: string,
  ): Promise<PipelineRunPhase[]> {
    const all = await this.phaseStore.listForSection(sectionId);
    return all.filter((p) => p.codingSessionId === codingId);
  }

  /**
   * Open ONE execute session for a coding-session group — it builds ALL the group's consecutive phases
   * in a single shared engine context (Phase 4). Prior groups' handoff notes are woven into the prompt
   * (and recorded as this group's `handoff_in`); the group leaves its own `handoff_out` when it reports.
   */
  private async openGroupExecute(
    run: PipelineRun,
    coding: PipelineCodingSession,
  ): Promise<void> {
    const section = await this.sectionStore.get(coding.sectionId);
    if (!section) {
      await this.failRun(run, `coding session for missing section ${coding.sectionId}`);
      return;
    }
    const allPhases = await this.phaseStore.listForSection(section.id);
    const groupPhases = allPhases.filter((p) => p.codingSessionId === coding.id);
    const allCoding = await this.codingStore.listForSection(section.id);
    const groupIndex = Math.max(0, allCoding.findIndex((c) => c.id === coding.id));
    const index = await this.positionOf(run.id, section.id);
    const phaseIndex = groupPhases[0]
      ? Math.max(0, allPhases.findIndex((p) => p.id === groupPhases[0].id))
      : 0;
    for (const p of groupPhases)
      await this.phaseStore.update(p.id, { status: 'building' });
    await this.codingStore.update(coding.id, { status: 'building' });
    await this.runs.update(run.team, run.id, {
      sectionIndex: index,
      activeSectionId: section.id,
      phaseIndex,
      mode: 'execute',
      planningSubstep: null,
      status: 'running',
    });
    const handoffNotes = await this.priorHandoffs(section.id, coding.ordinal);
    if (handoffNotes)
      await this.codingStore.update(coding.id, { handoffIn: handoffNotes });
    const refreshed = (await this.runs.get(run.team, run.id)) ?? run;
    const sid = await this.openSession(
      refreshed,
      section.phaseRole,
      'execute',
      this.phaseGroupExecutePrompt({
        taskId: run.taskId,
        intent: run.overview,
        sectionName: section.name,
        sectionPlan: section.planMd,
        group: groupPhases.map((p) => ({ id: p.planPhaseId, title: p.title })),
        groupIndex,
        groupCount: allCoding.length,
        handoffNotes,
      }),
    );
    if (sid) {
      await this.codingStore.update(coding.id, { engineSessionId: sid });
      await this.sectionStore.update(section.id, { activeSessionId: sid });
    }
  }

  /** The handoff notes left by every PRIOR group in this section (lower ordinal, with a `handoff_out`),
   * assembled in order — the structured context the next group inherits. Undefined when none. */
  private async priorHandoffs(
    sectionId: string,
    beforeOrdinal: number,
  ): Promise<string | undefined> {
    const all = await this.codingStore.listForSection(sectionId);
    const prior = all
      .filter((c) => c.ordinal < beforeOrdinal && c.handoffOut)
      .sort((a, b) => a.ordinal - b.ordinal);
    if (!prior.length) return undefined;
    return prior
      .map((c, i) => `— from coding session ${i + 1}:\n${c.handoffOut}`)
      .join('\n\n');
  }

  /** Open a fresh READ-ONLY review session over the group's just-built phases (tracked via
   * mode='investigate', so its idle is distinguishable from the execute session's). One review attempt
   * per phase in the group, all sharing the review session — the per-phase lineage Phase 5 builds on. */
  private async openGroupReview(
    run: PipelineRun,
    coding: PipelineCodingSession,
  ): Promise<void> {
    const section = await this.sectionStore.get(coding.sectionId);
    if (!section) {
      await this.failRun(run, `review for missing section ${coding.sectionId}`);
      return;
    }
    const groupPhases = await this.groupPhases(section.id, coding.id);
    for (const p of groupPhases)
      await this.phaseStore.update(p.id, { status: 'reviewing' });
    await this.codingStore.update(coding.id, { status: 'reviewing' });
    await this.runs.update(run.team, run.id, { mode: 'investigate' });
    const refreshed = (await this.runs.get(run.team, run.id)) ?? run;
    const sid = await this.openSession(
      refreshed,
      section.phaseRole,
      'investigate',
      this.phaseGroupReviewPrompt(section, groupPhases),
    );
    for (const p of groupPhases) {
      const attempts = await this.reviewStore.listForPhase(p.id);
      await this.reviewStore.create(run.id, run.team, {
        phaseId: p.id,
        attempt: attempts.length + 1,
        engineSessionId: sid ?? undefined,
      });
    }
    if (sid) await this.sectionStore.update(section.id, { activeSessionId: sid });
  }

  /** A group's review finished. v1 is ADVISORY: record the verdict on every phase in the group, mark
   * them (and the coding session) done, advance to the next group / section / PR. (Acting on a blocker
   * verdict — pause/auto-fix — is Phase-5 hardening.) */
  private async advanceAfterGroupReview(
    run: PipelineRun,
    coding: PipelineCodingSession,
    session: Session,
  ): Promise<void> {
    const section = await this.sectionStore.get(coding.sectionId);
    if (!section) return;
    const verdict = parseVerdict(session.lastReport ?? '');
    const groupPhases = await this.groupPhases(section.id, coding.id);
    for (const p of groupPhases) {
      const latest = await this.reviewStore.latestForPhase(p.id);
      if (latest)
        await this.reviewStore.update(latest.id, {
          status: 'done',
          blocker: verdict?.blocker ?? false,
          summary: verdict?.summary ?? null,
        });
      await this.phaseStore.update(p.id, { status: 'done' });
    }
    await this.codingStore.update(coding.id, { status: 'done' });
    // Dual-write the phases_json `reviewed` markers (boot fallback + awareness slice).
    const reviewedIds = new Set(groupPhases.map((p) => p.planPhaseId));
    const marked = (section.phases ?? []).map((p) =>
      reviewedIds.has(p.id) ? { ...p, reviewed: true } : p,
    );
    await this.sectionStore.update(section.id, { phases: marked });
    if (verdict?.summary)
      this.logger.log(
        `pipeline ${run.id}: group ${coding.ordinal / 10} review — ${verdict.summary}`,
      );

    // Phase 5d: a review BLOCKER is Atlas's call, not an auto-advance — PAUSE and wake him with the
    // decision menu (fix-up vs reopen). The work is recorded as built+reviewed-with-blocker above, so
    // whichever action he picks resumes from a consistent state.
    if (verdict?.blocker) {
      await this.pauseForStageDecision(run, {
        stage: 'section review',
        section: section.name,
        findings: verdict.summary ?? '(the review flagged a blocking issue)',
      });
      return;
    }

    const nextCoding = await this.codingStore.nextPending(section.id);
    if (nextCoding) {
      await this.openGroupExecute(run, nextCoding);
      return;
    }
    // Section done — mark it done FIRST (so a re-entrant turn from the lens fix loop finds no active
    // section), run the per-section multi-lens self-review (Phase 5a — advisory: auto-fixes, narrates on
    // exhaustion, never wedges), then advance to the next runnable section or ship the terminal PR.
    await this.sectionStore.update(section.id, {
      status: 'done',
      activeSessionId: null,
    });
    await this.review
      .reviewSectionLenses(session, { sectionName: section.name })
      .catch((err) => {
        this.logger.warn(
          `pipeline ${run.id}: section-lens review failed: ${err}`,
        );
        return { ok: true, findings: [] as string[] };
      });
    await this.advanceToNextSection(run);
  }

  /** Pick the next runnable section (topological over depends_on) and open it; ship the PR when none
   * remain; FAIL LOUDLY when pending sections remain but none are runnable (a dependency deadlock —
   * never hang). The single advance point shared by review-completion and the design gates. */
  private async advanceToNextSection(run: PipelineRun): Promise<void> {
    const next = await this.sectionStore.nextPending(run.id);
    if (next) {
      await this.openSection(run, next.id);
      return;
    }
    const all = await this.sectionStore.listForRun(run.id);
    if (all.some((s) => s.status === 'pending')) {
      await this.failRun(
        run,
        'dependency deadlock — pending sections have unsatisfiable depends_on',
      );
      return;
    }
    await this.handlePrGate(run);
  }

  // ── design gate: human-produced artifact (interim) ──────────────────────────

  /** Attach the human's design artifact (a local zip path): unzip into the workspace's `design/`, mark
   * the design section done, and advance to the implementer section (which builds against it). */
  async attachDesign(
    team: string,
    taskId: number,
    source: string,
  ): Promise<{ ok: boolean; message: string }> {
    const run = await this.runs.getByTask(team, taskId);
    if (!run || run.status !== 'paused' || run.planningSubstep !== 'awaiting_design')
      return { ok: false, message: `#${taskId} isn't waiting at a design gate.` };
    if (!run.workspaceId) return { ok: false, message: `#${taskId} has no workspace.` };
    if (/^https?:\/\//i.test(source))
      return {
        ok: false,
        message:
          'For now, hand me a LOCAL path to the design zip (the online export lands in your Downloads), not a URL.',
      };
    // CONTAINERIZED: the sandbox has no host path — the design must land inside the daemon's clone. Read
    // the local zip, base64-encode it, and ship it over the daemon git RPC (`attachDesign`), which unzips
    // it into the sandbox clone's `design/`. NO session arg: the design gate has no engine session yet (the
    // implementer session opens AFTER this), so the daemon writes to the CLONE ROOT. KNOWN GAP (the broader
    // in-sandbox accumulation gap): the later implementer worktree is cut from origin/<base> and so won't
    // automatically see this clone-root design/ — making it flow into the implementer's tree needs the
    // wider accumulation work and is out of scope for this flag-off closure.
    if (this.workspaceGit.isContainerized({ workspaceId: run.workspaceId })) {
      const daemon = this.workspaceGit.daemonFor({ workspaceId: run.workspaceId });
      if (!daemon)
        return {
          ok: false,
          message: `#${taskId}'s sandbox isn't live — can't attach the design.`,
        };
      let b64: string;
      try {
        b64 = (await readFile(source)).toString('base64');
      } catch (err) {
        return {
          ok: false,
          message: `Couldn't read '${source}': ${err instanceof Error ? err.message : String(err)}.`,
        };
      }
      const res = await daemon.attachDesign(b64).catch((err) => ({
        ok: false as const,
        message: `daemon attachDesign failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
      if (!res.ok)
        return {
          ok: false,
          message: `Couldn't attach the design into the sandbox: ${res.message}`,
        };
    } else {
      const ws = this.workspaces.get(run.workspaceId);
      if (!ws) return { ok: false, message: `Workspace '${run.workspaceId}' not found.` };
      const designDir = join(ws.path, 'design');
      try {
        mkdirSync(designDir, { recursive: true });
        await pExecFile('unzip', ['-o', source, '-d', designDir]);
      } catch (err) {
        return {
          ok: false,
          message: `Couldn't unzip '${source}' into the workspace: ${err instanceof Error ? err.message : String(err)}.`,
        };
      }
    }
    const design = await this.sectionStore.activeSection(run.id);
    if (design)
      await this.sectionStore.update(design.id, {
        status: 'done',
        frozen: true,
        activeSessionId: null,
      });
    await this.runs.update(team, run.id, {
      status: 'running',
      planningSubstep: null,
    });
    const refreshed = (await this.runs.get(team, run.id)) ?? run;
    await this.advanceToNextSection(refreshed);
    return {
      ok: true,
      message: `Design attached to ${run.workspaceId} (design/). The next section is now planning/building against it.`,
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
    const all = await this.sectionStore.listForRun(run.id);
    const design = await this.sectionStore.activeSection(run.id);
    if (design) await this.sectionStore.update(design.id, { status: 'skipped' });
    // The section right after a design gate (by ordinal) is its implementer — skip it too (nothing to
    // implement without a design).
    const idx = design ? all.findIndex((s) => s.id === design.id) : -1;
    const implementer = idx >= 0 ? all[idx + 1] : undefined;
    if (implementer && implementer.status === 'pending')
      await this.sectionStore.update(implementer.id, { status: 'skipped' });
    await this.runs.update(team, run.id, {
      status: 'running',
      planningSubstep: null,
    });
    const refreshed = (await this.runs.get(team, run.id)) ?? run;
    await this.advanceToNextSection(refreshed); // continue, or ship the functional version
    return {
      ok: true,
      message: `Skipped the design (and its implementation) for #${taskId} — the functional version will ship. Ask Dennis whether to backlog the design + redesign for later; add_board_task ONLY if he says yes.`,
    };
  }

  // ── living sections ──────────────────────────────────────────────────────────

  /**
   * Insert a new section into a running feature's still-pending tail (Atlas orchestration call). The new
   * section is born `pending` and hits the normal plan gate when reached (gate the substance). Refuses
   * (helpful message, never throws) when the run isn't a live feature, the anchor is unknown/committed,
   * or the wedge would land before frozen work / form a forward dependency.
   */
  async insertSection(
    team: string,
    taskId: number,
    afterSectionName: string,
    spec: { name: string; brief?: string; phaseRole: string },
  ): Promise<{ ok: boolean; message: string }> {
    const run = await this.livingRun(team, taskId);
    if (!run.ok) return { ok: false, message: run.message };
    if (spec.phaseRole !== DESIGN_ROLE && !this.employees.byId(spec.phaseRole))
      return {
        ok: false,
        message: `Unknown phase-config '${spec.phaseRole}' — use a real one (e.g. 'phase_backend') or '${DESIGN_ROLE}'.`,
      };
    const sections = await this.sectionStore.listForRun(run.run.id);
    const anchor = sections.find((s) => s.name === afterSectionName);
    if (!anchor)
      return {
        ok: false,
        message: `No section '${afterSectionName}' in #${taskId}'s run — sections are: ${sections.map((s) => s.name).join(', ')}.`,
      };
    const result: SectionMutation = await this.sectionStore.insertSection(
      run.run.id,
      team,
      anchor.ordinal,
      spec,
    );
    if (!result.ok) return { ok: false, message: `Couldn't insert: ${result.reason}.` };
    this.logger.log(
      `pipeline ${run.run.id}: inserted section '${spec.name}' after '${afterSectionName}' (ordinal ${result.section.ordinal})`,
    );
    return {
      ok: true,
      message: `Added section '${spec.name}' after '${afterSectionName}' in #${taskId}. It'll plan (and pause for your approval) when the pipeline reaches it.`,
    };
  }

  /**
   * Reorder a running feature's still-pending sections (gate the substance: same sections, new order ⇒
   * no re-approval, Atlas merely notified). Only pending sections move; frozen/active/done ones hold.
   * Refuses with a helpful message on stale state, a non-pending name, or a dependency-breaking order.
   */
  async reorderSections(
    team: string,
    taskId: number,
    orderedNames: string[],
  ): Promise<{ ok: boolean; message: string }> {
    const run = await this.livingRun(team, taskId);
    if (!run.ok) return { ok: false, message: run.message };
    const result = await this.sectionStore.reorderSections(
      run.run.id,
      team,
      orderedNames,
    );
    if (!result.ok) return { ok: false, message: `Couldn't reorder: ${result.reason}.` };
    this.logger.log(
      `pipeline ${run.run.id}: reordered pending sections → ${orderedNames.join(', ')}`,
    );
    return {
      ok: true,
      message: `Reordered the pending sections of #${taskId}: ${orderedNames.join(' → ')}. No re-approval needed — same work, new order.`,
    };
  }

  /** A live feature run for living-section edits, or a helpful refusal. */
  private async livingRun(
    team: string,
    taskId: number,
  ): Promise<{ ok: true; run: PipelineRun } | { ok: false; message: string }> {
    const run = await this.runs.getByTask(team, taskId);
    if (!run)
      return { ok: false, message: `No pipeline run for #${taskId}.` };
    if (run.kind !== 'feature' || run.pipeline !== DYNAMIC)
      return {
        ok: false,
        message: `#${taskId} isn't a section-driven feature run — nothing to reshape.`,
      };
    if (run.status === 'done' || run.status === 'failed')
      return {
        ok: false,
        message: `#${taskId}'s run is already ${run.status} — too late to reshape it.`,
      };
    return { ok: true, run };
  }

  // ── cross-section defect: Atlas decides (fix-up vs reopen) ───────────────────

  /**
   * PAUSE a run at a review-stage decision and wake Atlas with the findings + the action menu (the
   * "walk Atlas's hands" wake-up). The run sits at `paused`/`stage_decision` until he picks an action
   * (dispatch_fixup_session / reopen_section). The findings are also parked as a durable ticket note so
   * they survive a restart (the seed event won't re-fire on boot — like the design gate, it waits).
   */
  private async pauseForStageDecision(
    run: PipelineRun,
    opts: { stage: string; findings: string; section?: string },
  ): Promise<void> {
    await this.runs.update(run.team, run.id, {
      status: 'paused',
      planningSubstep: 'stage_decision',
    });
    await this.notes
      .add(
        run.team,
        run.taskId,
        this.employees.teamLead().id,
        `Pipeline ${opts.stage}${opts.section ? ` ('${opts.section}')` : ''} flagged a blocking issue:\n\n${opts.findings}`,
      )
      .catch(() => undefined);
    this.boardEvents.emit({
      kind: 'stage-decision',
      team: run.team,
      taskId: run.taskId,
      stage: opts.stage,
      findings: opts.findings,
      section: opts.section,
      allowedActions: [
        {
          action: `dispatch_fixup_session(${run.taskId})`,
          description:
            'fix it in a fresh session against the integrated workspace, then auto re-review + ship — the usual call for an integration/seam defect (or to verify a benign finding and ship).',
        },
        {
          action: `reopen_section(${run.taskId}, '<section>')`,
          description:
            "send a section back to planning with this as the brief — only when the section's PLAN was wrong (a design defect), which re-gates to Dennis.",
        },
        {
          action: 'loop Dennis in',
          description:
            "if it's a product/scope call rather than a code defect, bring it to him with your read before acting.",
        },
      ],
      notifyThread: run.notifyThread,
    });
    this.logger.log(
      `pipeline ${run.id}: paused at ${opts.stage}${opts.section ? ` ('${opts.section}')` : ''} — awaiting Atlas's decision`,
    );
  }

  /**
   * dispatch_fixup_session: the ~90% cross-section-defect path. Opens a fresh execute session in the
   * INTEGRATED workspace to fix the flagged defect; its report re-enters the PR gate (re-runs the
   * full-impl review and ships if clean). Re-validates run state (mirror gatedRun) and returns a helpful
   * message — never throws — when the run isn't waiting on a review decision.
   */
  async dispatchFixup(
    team: string,
    taskId: number,
    guidance?: string,
  ): Promise<{ ok: boolean; message: string }> {
    const gated = await this.stageDecisionRun(team, taskId);
    if (!gated.ok) return { ok: false, message: gated.message };
    const run = gated.run;
    if (!run.workspaceId)
      return { ok: false, message: `#${taskId} has no workspace to fix in.` };
    await this.runs.update(team, run.id, { status: 'running' });
    const refreshed = (await this.runs.get(team, run.id)) ?? run;
    const findings = await this.latestStageFindings(
      refreshed.team,
      refreshed.taskId,
    );
    const sid = await this.openSession(
      refreshed,
      refreshed.currentRole ?? '',
      'execute',
      this.fixupPrompt(refreshed, { findings, guidance }),
      refreshed,
    );
    if (!sid)
      return {
        ok: false,
        message: `Couldn't open a fix-up session for #${taskId} — check the workspace/project.`,
      };
    // Mark the run so the fix-up session's report re-enters the PR gate (set AFTER openSession, which
    // doesn't touch planning_substep).
    await this.runs.update(team, run.id, { planningSubstep: 'fixup' });
    this.logger.log(
      `pipeline ${run.id}: dispatched a fix-up session for #${taskId}`,
    );
    return {
      ok: true,
      message: `On it — a fix-up session is fixing the flagged issues in #${taskId}'s integrated workspace. It'll re-run the review and ship if clean; I'll surface the PR gate.`,
    };
  }

  /**
   * reopen_section: the rare design-defect path. Drops a section's built rows so a re-approval
   * re-materializes them, resets it to a fresh plan with the defect injected as authoritative deny-style
   * feedback, and re-opens its plan session → Dennis's gate. Re-validates run state and returns a
   * helpful message on stale state / unknown section — never throws.
   */
  async reopenSection(
    team: string,
    taskId: number,
    sectionName: string,
    defect: string,
  ): Promise<{ ok: boolean; message: string }> {
    const gated = await this.stageDecisionRun(team, taskId);
    if (!gated.ok) return { ok: false, message: gated.message };
    const run = gated.run;
    const sections = await this.sectionStore.listForRun(run.id);
    const section = sections.find((s) => s.name === sectionName);
    if (!section)
      return {
        ok: false,
        message: `No section '${sectionName}' in #${taskId}'s run — sections are: ${sections.map((s) => s.name).join(', ')}.`,
      };
    // Clear the section's built rows (reviews first — they key off the phase ids), then reset the
    // section to a fresh plan. Re-approval (handleSectionApproved) re-materializes from the new plan.
    await this.reviewStore.deleteForSection(section.id);
    await this.phaseStore.deleteForSection(section.id);
    await this.codingStore.deleteForSection(section.id);
    await this.sectionStore.update(section.id, {
      status: 'planning',
      frozen: false,
      planMd: null,
      phases: null,
      phaseCount: null,
      activeSessionId: null,
    });
    await this.runs.update(team, run.id, {
      status: 'running',
      planningSubstep: 'drafting',
    });
    const refreshed = (await this.runs.get(team, run.id)) ?? run;
    const fresh = await this.sectionStore.get(section.id);
    if (fresh) await this.openSectionPlan(refreshed, fresh, defect);
    this.logger.log(
      `pipeline ${run.id}: reopened section '${sectionName}' for re-planning (cross-section defect)`,
    );
    return {
      ok: true,
      message: `Reopened the '${sectionName}' section of #${taskId} — it's re-planning with your defect note as the brief, and will pause at its plan gate for Dennis's approval.`,
    };
  }

  /** The fix-up session reported back → clear the marker and re-enter the PR gate (re-runs the
   * full-impl review, then ships if clean or pauses again if the defect persists). */
  private async handleFixupDone(run: PipelineRun): Promise<void> {
    await this.runs.update(run.team, run.id, { planningSubstep: null });
    const refreshed = (await this.runs.get(run.team, run.id)) ?? run;
    await this.handlePrGate(refreshed);
  }

  /** A run paused at a stage-decision for `taskId`, or a helpful refusal (mirror of gatedRun/livingRun). */
  private async stageDecisionRun(
    team: string,
    taskId: number,
  ): Promise<{ ok: true; run: PipelineRun } | { ok: false; message: string }> {
    const run = await this.runs.getByTask(team, taskId);
    if (!run) return { ok: false, message: `No pipeline run for #${taskId}.` };
    if (run.kind !== 'feature' || run.pipeline !== DYNAMIC)
      return {
        ok: false,
        message: `#${taskId} isn't a section-driven feature run.`,
      };
    if (run.status === 'done' || run.status === 'failed')
      return {
        ok: false,
        message: `#${taskId}'s run is already ${run.status} — nothing to decide.`,
      };
    if (run.status !== 'paused' || run.planningSubstep !== 'stage_decision')
      return {
        ok: false,
        message: `#${taskId} isn't waiting on a review decision right now${run.planningSubstep ? ` (it's at the ${run.planningSubstep} step)` : ''}.`,
      };
    return { ok: true, run };
  }

  // ── shared: PR gate (terminal for feature + bugfix) ─────────────────────────

  /** Ship the accumulated workspace as ONE ready PR (reuse ReviewPipelineService.shipTask — no sibling
   * fan-out). A ship failure fails the run loudly so it never reports a PR that didn't open. Driven
   * off the durable run (notify_thread), so it works with or without a live session (e.g. skip-to-PR). */
  private async handlePrGate(run: PipelineRun): Promise<void> {
    if (!run.workspaceId) {
      await this.failRun(run, 'PR gate with no workspace');
      return;
    }
    // Phase 5b: the ticket-level full-implementation review runs BEFORE the ship (feature runs only — a
    // bugfix is a single session with no cross-section seams). `changes` → Atlas decides (don't ship);
    // `pass` → ship, and any advisory findings ride the PR self-review comment.
    // The run's execute/aggregate session — its id keys the daemon worktree for a CONTAINERIZED review +
    // ship (the host has no tree). Undefined on the local path (the host workspace row carries the tree)
    // or when the session is gone (a containerized ship then loud-fails on the worktree-scoped daemon op,
    // never silently — acceptable for this dormant flag-off path).
    const runSession = run.sessionId
      ? await this.sessions.get(run.sessionId).catch(() => undefined)
      : undefined;
    let advisoryFindings: string | undefined;
    if (run.kind === 'feature') {
      const full = await this.review
        .reviewFullImplementation({
          team: run.team,
          taskId: run.taskId,
          workspaceId: run.workspaceId,
          ...(runSession ? { session: runSession } : {}),
        })
        .catch((err) => {
          this.logger.warn(`pipeline ${run.id}: full-impl review failed: ${err}`);
          return { verdict: 'pass' as const, findings: '' };
        });
      if (full.verdict === 'changes') {
        await this.pauseForStageDecision(run, {
          stage: 'full implementation review',
          findings: full.findings || '(the review flagged cross-section issues)',
        });
        return; // don't ship — wake Atlas to decide (fix-up vs reopen)
      }
      advisoryFindings = full.findings || undefined;
    }
    const shipped = await this.review.shipTask({
      team: run.team,
      taskId: run.taskId,
      workspaceId: run.workspaceId,
      notifyThread: run.notifyThread ?? '',
      findings: advisoryFindings,
      ...(runSession ? { session: runSession } : {}),
    });
    if (!shipped.ok) {
      await this.failRun(run, `shipTask failed — ${shipped.reason}`);
      return;
    }
    this.logger.log(
      `pipeline ${run.id} (${run.kind}) shipped #${run.taskId}: ${shipped.prUrl}`,
    );
    // The run is done — reclaim its final stage session so it doesn't block workspace cleanup later.
    await this.closeRunSession(run.sessionId);
    await this.runs.update(run.team, run.id, {
      status: 'done',
      currentRole: null,
      mode: null,
      activeSectionId: null,
    });
  }

  // ── the dispatcher ──────────────────────────────────────────────────────────

  /** React to a tracked session reporting back: route purely off the durable rows (status = cursor). */
  private async onSessionUpdate(session: Session): Promise<void> {
    if (session.status !== 'idle' && session.status !== 'failed') return;
    if (session.boardTaskId === undefined) return;
    const run = await this.runs.getByTask(session.team, session.boardTaskId);
    if (!run || run.status !== 'running' || run.sessionId !== session.id) return;

    if (session.status === 'failed') {
      await this.failRun(
        run,
        `session ${session.id} (kind=${run.kind}, mode=${run.mode}) failed`,
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
      this.relayStageFindings(run, undefined, session); // out-of-scope discoveries → Atlas (advisory)
      await this.handlePrGate(run); // single execute session done → ship
      return;
    }
    if (run.pipeline !== DYNAMIC) return; // legacy flat runs aren't driven here

    // A harness fix-up session (dispatch_fixup_session) reported → re-enter the PR gate, which re-runs
    // the full-impl review and ships (or pauses again if the defect persists). Checked BEFORE the
    // active-section lookup: a ticket-level fix-up runs with every section already done (no active one).
    if (run.planningSubstep === 'fixup') {
      await this.handleFixupDone(run);
      return;
    }

    const section = await this.sectionStore.activeSection(run.id);
    if (!section) return; // no live section while running — nothing to advance (defensive)

    if (section.status === 'planning') {
      // The plan turn reported. The one-shot codex_advisory self-review already ran INSIDE it (the
      // PlanFinished lifecycle hook resolves before the session reports idle), so stamp 'advisory' as
      // the transient post-advisory marker — observability + a re-plan anchor if a crash lands between
      // here and the gate. handleSectionPlanGate clears it to 'gate' at the pause.
      await this.runs.update(run.team, run.id, { planningSubstep: 'advisory' });
      await this.handleSectionPlanGate(run, section, session);
      return;
    }
    if (section.status === 'building') {
      // The active GROUP's status distinguishes the just-finished execute from its review.
      const coding = await this.codingStore.activeCodingSession(section.id);
      if (!coding) return; // defensive: building section with no live group
      if (coding.status === 'building') {
        // The group's execute session just finished — capture the handoff it left for the NEXT group
        // (parsed from its report), relay any out-of-scope findings to Atlas (advisory), then open the
        // group's review.
        const handoff = parseHandoff(session.lastReport ?? '');
        if (handoff)
          await this.codingStore.update(coding.id, { handoffOut: handoff });
        this.relayStageFindings(run, section, session);
        await this.openGroupReview(run, coding);
        return;
      }
      if (coding.status === 'reviewing') {
        await this.advanceAfterGroupReview(run, coding, session);
        return;
      }
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
        ? await this.sectionStore.activeSection(run.id)
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

  /** Relay a build/execute stage's OUT-OF-SCOPE findings (a ```findings``` block in its report) to
   * Atlas so he can triage them (suggest_task / enqueue_finding / skip). ADVISORY only — emits the
   * event and returns; the run is NOT paused and keeps advancing. No-op when the report has no block. */
  private relayStageFindings(
    run: PipelineRun,
    section: { name: string; phaseRole: string } | undefined,
    session: Session,
  ): void {
    const findings = parseFindings(session.lastReport ?? '');
    if (!findings) return;
    this.logger.log(
      `pipeline ${run.id}: ${section?.name ?? 'bugfix'} stage flagged out-of-scope findings — relaying to Atlas (advisory)`,
    );
    this.boardEvents.emit({
      kind: 'stage-findings',
      team: run.team,
      taskId: run.taskId,
      stage: section?.phaseRole ?? 'bugfix',
      section: section?.name,
      findings,
      notifyThread: run.notifyThread,
    });
  }

  /** Deliver Atlas's answers into the section/bugfix session that asked questions (Atlas can't
   * reply_session — it's not his session). Resumes the SAME session (keeps its context) in its current
   * mode, detached; its report-back re-enters onSessionUpdate (a revised plan → gate, or more
   * questions → relay again). When `regroupedPhases` is supplied (an execute session asked to re-shape
   * the remaining work — a ```regroup``` block in its questions), the still-pending phases/groups are
   * re-materialized FIRST, so the resumed session and every later group run the new grouping. */
  async answerSectionQuestions(
    team: string,
    taskId: number,
    answers: string,
    regroupedPhases?: ReadonlyArray<{ id: number; group: number; title?: string }>,
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
    let regroupNote = '';
    if (regroupedPhases && regroupedPhases.length) {
      const applied = await this.applyRegroup(run, regroupedPhases);
      if (!applied.ok) return { ok: false, message: applied.message };
      regroupNote = ` ${applied.message}`;
    }
    const mode: WorkerMode =
      run.planningSubstep === 'drafting' || run.planningSubstep === 'advisory'
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
        ? await this.sectionStore.activeSection(run.id)
        : undefined;
    return {
      ok: true,
      message: `Answers delivered to the ${section ? `'${section.name}' ` : ''}session for #${taskId}; it's reworking and will report back (a revised plan, or more questions).${regroupNote}`,
    };
  }

  /**
   * Renegotiable grouping (Phase 4c): re-shape the still-PENDING phases of the active building section
   * into a new set of coding-session groups. The live/done groups (and their phases) are IMMUTABLE — you
   * can only regroup work that hasn't started. `regrouped` must list every pending phase exactly once,
   * with its new `group` number; contiguous same-number phases fold into one session. Re-materializes
   * the pending coding-session rows in the new shape and re-links the pending phase rows. Atlas's call
   * (no re-approval — same phases, new packaging), so it's a helpful refusal, never a throw.
   */
  private async applyRegroup(
    run: PipelineRun,
    regrouped: ReadonlyArray<{ id: number; group: number; title?: string }>,
  ): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    const section = await this.sectionStore.activeSection(run.id);
    if (!section || section.status !== 'building')
      return {
        ok: false,
        message: `#${run.taskId} has no building section to regroup right now.`,
      };
    const phaseRows = await this.phaseStore.listForSection(section.id);
    const coding = await this.codingStore.listForSection(section.id);
    const pendingIds = new Set(
      coding.filter((c) => c.status === 'pending').map((c) => c.id),
    );
    const pendingPhaseRows = phaseRows.filter(
      (p) => p.codingSessionId && pendingIds.has(p.codingSessionId),
    );
    const pendingPlanIds = new Set(pendingPhaseRows.map((p) => p.planPhaseId));

    // Validate the regroup covers EXACTLY the pending phases (immutable ones can't move).
    const seen = new Set<number>();
    for (const r of regrouped) {
      if (seen.has(r.id))
        return { ok: false, message: `Regroup lists phase ${r.id} twice.` };
      seen.add(r.id);
      if (!pendingPlanIds.has(r.id))
        return {
          ok: false,
          message: `Phase ${r.id} isn't a pending (not-yet-built) phase — only future phases can be regrouped (pending: ${[...pendingPlanIds].join(', ') || 'none'}).`,
        };
    }
    if (seen.size !== pendingPlanIds.size)
      return {
        ok: false,
        message: `Regroup must list every pending phase exactly once (pending: ${[...pendingPlanIds].join(', ') || 'none'}).`,
      };

    // Rewrite the pending phases' group numbers in phases_json (the frozen ones keep theirs).
    const newGroupById = new Map(regrouped.map((r) => [r.id, r.group]));
    const newPhases = (section.phases ?? []).map((p) =>
      newGroupById.has(p.id) ? { ...p, group: newGroupById.get(p.id) } : p,
    );
    await this.sectionStore.update(section.id, { phases: newPhases });

    // Re-materialize the pending coding sessions for the new grouping of the pending suffix.
    const groups = phaseGroups(newPhases.filter((p) => pendingPlanIds.has(p.id)));
    await this.codingStore.deletePending(section.id);
    const baseOrdinal = coding
      .filter((c) => c.status !== 'pending')
      .reduce((m, c) => Math.max(m, c.ordinal), 0);
    const newCoding = await this.codingStore.createMany(
      run.id,
      run.team,
      section.id,
      groups.map((_, i) => ({ ordinal: baseOrdinal + (i + 1) * 10 })),
    );
    const codingByPlanId = new Map<number, string>();
    groups.forEach((g, gi) =>
      g.phases.forEach((p) => codingByPlanId.set(p.id, newCoding[gi].id)),
    );
    for (const pr of pendingPhaseRows) {
      const csId = codingByPlanId.get(pr.planPhaseId);
      if (csId) await this.phaseStore.update(pr.id, { codingSessionId: csId });
    }
    this.logger.log(
      `pipeline ${run.id}: regrouped ${pendingPhaseRows.length} pending phase(s) of '${section.name}' into ${groups.length} coding session(s)`,
    );
    return {
      ok: true,
      message: `Regrouped the remaining phases into ${groups.length} coding session(s).`,
    };
  }

  // ── boot recovery ────────────────────────────────────────────────────────────

  /**
   * Re-drive in-flight runs on boot — the in-process turn dies on restart, so a 'running' run would
   * otherwise stall. Reads the durable rows for each. R2 (a section approved during downtime — the run
   * left paused at its plan gate while the board already shows 'approved') is re-keyed on the SECTION
   * row (status 'planning' + plan_md present), not the positional cursor.
   */
  async resumePipelines(): Promise<void> {
    const active = await this.runs.listAllActive();
    for (const run of active) {
      if (run.status === 'paused') {
        // A paused feature run sits at a plan gate or a design gate. Re-key R2 on the section row: a
        // plan-gate section approved during downtime must replay (the board event won't re-fire).
        if (run.pipeline === DYNAMIC && run.kind === 'feature') {
          try {
            const section = await this.sectionStore.activeSection(run.id);
            if (section?.status === 'planning' && section.planMd) {
              const task = await this.board.get(run.team, run.taskId);
              if (task?.status === 'approved') await this.handleSectionApproved(run);
            }
          } catch (err) {
            this.logger.warn(`pipeline ${run.id}: boot gate-reconcile failed: ${err}`);
          }
        }
        continue; // paused runs (plan / design gate) otherwise wait for their event
      }
      if (run.status !== 'running') continue;
      if (run.kind !== 'bugfix' && run.pipeline !== DYNAMIC) continue; // legacy: not driven
      try {
        const session = run.sessionId
          ? await this.sessions.get(run.sessionId)
          : undefined;
        if (session?.status === 'idle') {
          // A turn genuinely COMPLETED during downtime — process the missed turn-end (advance the
          // gate / open the next step).
          await this.onSessionUpdate(session);
          continue;
        }
        if (session?.status === 'closed') continue; // owner closed — manual
        // 'failed' (a turn interrupted by the restart, reconciled to 'failed' on boot), stale
        // 'running' (the reconcile hasn't run yet — Nest runs bootstrap hooks concurrently — but at
        // boot no turn is in flight, so the row is still stale), or session gone: RESUME the live
        // step from the durable rows. NOT onSessionUpdate/failRun — a restart is not a pipeline
        // failure; the completed sections/phases survive and the step just re-opens.
        await this.reopenCurrentStep(run);
      } catch (err) {
        this.logger.warn(`pipeline ${run.id}: boot resume failed: ${err}`);
      }
    }
  }

  /** Re-open whatever step the durable rows say is live (boot recovery). IDEMPOTENT: if a turn for
   * the run's active session is genuinely in-flight in THIS process (e.g. we already reopened it
   * earlier in this same boot pass), the step is already live — re-running opens no duplicate. The
   * guard is on the in-process controller, NOT persisted status: at boot a 'running' ROW is stale
   * (its turn died with the old process), so status can't distinguish stale from live. */
  private async reopenCurrentStep(run: PipelineRun): Promise<void> {
    if (run.sessionId && this.runner.isTurnInFlight(run.sessionId)) return;
    if (run.planningSubstep === 'fixup') {
      // A fix-up session died on restart — re-open it (its report re-enters the PR gate). The findings
      // are recovered from the ticket note (the worker can't read the ticket itself); guidance is lost
      // on restart, which is fine — the findings are the authoritative input.
      const findings = await this.latestStageFindings(run.team, run.taskId);
      await this.openSession(
        run,
        '',
        'execute',
        this.fixupPrompt(run, { findings }),
        run,
      );
      return;
    }
    if (run.kind === 'bugfix') {
      const ctx = await this.bugfixContext(run);
      await this.openSession(run, '', 'execute', this.bugfixPrompt(run, ctx), run);
      return;
    }
    const section = await this.sectionStore.activeSection(run.id);
    if (!section) return; // nothing live (between sections / done)
    if (section.status === 'planning') {
      await this.openSectionPlan(run, section);
      return;
    }
    if (section.status === 'building') {
      const coding =
        (await this.codingStore.activeCodingSession(section.id)) ??
        (await this.codingStore.nextPending(section.id));
      if (!coding) return; // defensive
      if (coding.status === 'reviewing') {
        await this.openGroupReview(run, coding);
        return;
      }
      // pending / building → (re)open its grouped execute session.
      await this.openGroupExecute(run, coding);
    }
    // awaiting_design → no reopen (the run is paused; handled in resumePipelines)
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  /**
   * Reclaim a stage session the driver is done with. Pipeline sessions are owned by synthetic
   * phase-configs (e.g. 'phase_backend') that never sit in chat and so never call close_session — so
   * if the driver doesn't close them itself they pile up as idle/failed orphans in the run's workspace.
   * An open session blocks workspace cleanup (remove_workspace refuses while any session is open), so a
   * finished run's orphans deadlock Atlas when he later reclaims the workspace. Uses the runner's
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

  /** Terminal failure: reclaim the active session (a failed run's workspace gets cleaned up later, so
   * its session must not linger as an orphan either), then mark the run failed. */
  private async failRun(run: PipelineRun, reason: string): Promise<void> {
    this.logger.warn(`pipeline ${run.id}: ${reason} — failing`);
    const latest = (await this.runs.get(run.team, run.id)) ?? run;
    await this.closeRunSession(latest.sessionId);
    await this.runs.update(run.team, run.id, { status: 'failed' });
    // The section live at the moment of death — context for Atlas's narration (best-effort).
    const section = await this.sectionStore
      .activeSection(run.id)
      .catch(() => undefined);
    // Dispatch left the ticket in 'planning'/'executing'; a crashed attempt isn't a closed ticket, so put
    // it back on the OPEN backlog — otherwise it's orphaned in an active status and Atlas must hand-reset
    // it before he can re-dispatch (exactly the manual cleanup he had to do). Best-effort, like dispatch.
    await this.board
      .update(run.team, run.taskId, { status: 'open' })
      .catch(() => undefined);
    // Wake Atlas: the orchestrator can't orchestrate blind. Auto-flows through the conductor's relay
    // (boardEventRelayPrompt → injectSeed) the same as every other pipeline board event.
    this.boardEvents.emit({
      kind: 'run-failed',
      team: run.team,
      taskId: run.taskId,
      reason,
      section: section?.name,
      notifyThread: run.notifyThread,
    });
  }

  /** The positional index of a section in its run's ordinal-ordered list (dual-writes section_index
   * for the awareness slice + boot fallback while the cursor columns survive). */
  private async positionOf(runId: string, sectionId: string): Promise<number> {
    const all = await this.sectionStore.listForRun(runId);
    const i = all.findIndex((s) => s.id === sectionId);
    return i < 0 ? 0 : i;
  }

  /** Open a session for `run` as `role`/`mode`, stamping it as the run's active session; returns the new
   * session id (undefined if the open was refused). For bugfix re-open on boot the role is read from the
   * run's current_role. */
  private async openSession(
    run: PipelineRun,
    role: string,
    mode: 'plan' | 'execute' | 'investigate',
    task: string,
    reopen?: PipelineRun,
  ): Promise<string | undefined> {
    const resolvedRole = role || reopen?.currentRole || '';
    if (!run.workspaceId || !run.project || !run.notifyThread) {
      await this.failRun(run, 'missing workspace/project/thread');
      return undefined;
    }
    // Reclaim the session this open supersedes before we overwrite run.sessionId — otherwise each
    // phase/review transition strands the previous one as an idle orphan in the workspace.
    await this.closeRunSession(run.sessionId);
    const session = await this.runner.openStageSession({
      role: resolvedRole,
      team: run.team,
      project: run.project,
      workspaceId: run.workspaceId,
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
    return session.id;
  }

  // ── prompts ──────────────────────────────────────────────────────────────────

  private sectionPlanPrompt(
    run: PipelineRun,
    section: PipelineRunSection,
    sections: PipelineRunSection[],
    denyFeedback?: string,
    contextNotes?: string,
  ): string {
    const idx = sections.findIndex((s) => s.id === section.id);
    const prior = sections
      .filter((s) => s.status === 'done' && s.ordinal < section.ordinal)
      .map((s) => s.name)
      .join(', ');
    const priorSection = idx > 0 ? sections[idx - 1] : undefined;
    const designAvailable =
      priorSection?.phaseRole === DESIGN_ROLE && priorSection.status === 'done';
    const parts = [
      `You are planning the "${section.name}" section of a larger feature, to be built in this workspace.`,
      run.overview
        ? `The agreed HIGH-LEVEL PLAN for the whole feature (your north star — plan this section to fit it):\n${run.overview}`
        : undefined,
      section.brief ? `This section's focus: ${section.brief}` : undefined,
      contextNotes
        ? `CONTEXT captured on the ticket before this work was planned — research, findings, and decisions parked during discovery (you can't open the ticket from here, so it's inlined). Treat it as background to build on; where it conflicts with the high-level plan or Dennis's direction, those win:\n\n${contextNotes}`
        : undefined,
      denyFeedback
        ? `Dennis reviewed your previous plan for this section and SENT IT BACK with this direction — treat it as AUTHORITATIVE; it overrides your earlier assumptions:\n\n${denyFeedback}\n\nRe-plan the section to honor it. Grill the gaps: where his direction is ambiguous or trades off against the high-level plan, ASK before you commit (batch related questions) rather than guessing.`
        : undefined,
      prior
        ? `Earlier sections already shipped into THIS workspace: ${prior}. Read the current workspace state before planning — build on what's there, don't redo it.`
        : undefined,
      designAvailable
        ? `The APPROVED design (specs + reference) is in the workspace under \`design/\` — your plan must implement it faithfully over the existing functional UI.`
        : undefined,
      `Produce a HIGHLY DETAILED, fully-specified implementation plan for THIS section only. Break it into as many sequential PHASES as it needs — each phase a coherent, independently-committable chunk. Do NOT implement; this is a plan and goes to Dennis for approval before any code is written.`,
      `End your plan with a fenced code block tagged \`phases\` containing a JSON array, one object per phase, e.g.:\n\`\`\`phases\n[{"id":1,"title":"DB schema + migration","group":1},{"id":2,"title":"service + API endpoint","group":1},{"id":3,"title":"frontend wiring","group":2}]\n\`\`\`\nThe orchestrator parses it to chunk the build; if you omit it the whole plan runs as one phase. Optional \`"group"\`: CONSECUTIVE phases sharing a group number build in ONE coding session (one engine context — use it when phases are tightly coupled and benefit from shared context); omit it and each phase gets its own session.`,
    ];
    return parts.filter(Boolean).join('\n\n');
  }

  /**
   * The execute prompt for one coding-session GROUP — it builds ALL the group's consecutive phases in a
   * single shared engine context (Phase 4). Plain string factory (no LangChain), co-located with the
   * other private prompt builders. `handoffNotes` (prior groups' structured handoffs) ground it in what
   * came before; the trailing \`handoff\` block is what the NEXT group inherits.
   */
  private phaseGroupExecutePrompt(args: {
    taskId: number;
    intent?: string;
    sectionName: string;
    sectionPlan?: string;
    group: ReadonlyArray<{ id: number; title?: string }>;
    groupIndex: number;
    groupCount: number;
    handoffNotes?: string;
  }): string {
    const { group, groupIndex, groupCount, sectionName } = args;
    const phaseLines = group
      .map((p) => `  - phase ${p.id}${p.title ? ` — ${p.title}` : ''}`)
      .join('\n');
    const groupLabel =
      group.length > 1
        ? `phases ${group.map((p) => p.id).join(', ')}`
        : `phase ${group[0]?.id ?? groupIndex + 1}`;
    const parts = [
      `You are implementing the "${sectionName}" section of a feature (board task #${args.taskId}) in this workspace — coding session ${groupIndex + 1} of ${groupCount}, covering ${groupLabel}.`,
      args.intent
        ? `The agreed HIGH-LEVEL PLAN for the whole feature (your north star):\n${args.intent}`
        : undefined,
      args.sectionPlan
        ? `The APPROVED plan for this section (your north star):\n\n${args.sectionPlan}`
        : undefined,
      `Implement these phases IN ORDER, in THIS one session — they share this context on purpose:\n${phaseLines}`,
      args.handoffNotes
        ? `HANDOFF from the previous coding session(s) in this section — what they left you (interfaces exposed, decisions made, anything stubbed or still pending). Build on it, don't re-derive it:\n\n${args.handoffNotes}`
        : groupIndex > 0
          ? `Earlier coding sessions already committed in this workspace — build on them, don't redo them.`
          : undefined,
      `Implement ONLY these phases, test/smoke-validate your work, and commit cleanly (a commit per phase is fine).`,
      `End your report with a fenced \`handoff\` block for the NEXT coding session — the interfaces you exposed, decisions you made, and anything still stubbed or pending, e.g.:\n\`\`\`handoff\nExposed POST /api/upload (multipart, returns {id}). Stubbed the virus scan — the FE can assume 200 for now. Migration 123 adds the uploads table.\n\`\`\`\nKeep it tight and factual; the next session inherits it verbatim. If this is the last session, leave a short closing summary in the same block.`,
    ];
    return parts.filter(Boolean).join('\n\n');
  }

  private phaseGroupReviewPrompt(
    section: PipelineRunSection,
    groupPhases: ReadonlyArray<{ planPhaseId: number; title?: string }>,
  ): string {
    const label =
      groupPhases.length > 1
        ? `phases ${groupPhases.map((p) => p.planPhaseId).join(', ')}`
        : `phase ${groupPhases[0]?.planPhaseId ?? 1}`;
    return [
      `You are reviewing — READ-ONLY — the work just committed for ${label} of the "${section.name}" section, in this workspace. Do NOT change files.`,
      `Review the recent changes for correctness, regressions, missed edge cases, and obvious quality issues.`,
      `End your report with a fenced block tagged \`verdict\`:\n\`\`\`verdict\n{"blocker": false, "summary": "one line"}\n\`\`\`\nSet "blocker" true ONLY if something must be fixed before the work can continue.`,
    ].join('\n\n');
  }

  private bugfixPrompt(
    run: PipelineRun,
    ctx?: { title?: string; description?: string; contextNotes?: string },
  ): string {
    const report = [ctx?.title && `Title: ${ctx.title}`, ctx?.description?.trim()]
      .filter(Boolean)
      .join('\n\n');
    return [
      `You are fixing a bug in this workspace (board task #${run.taskId}).`,
      report
        ? `The bug report from the ticket (you can't open the ticket from here, so it's inlined):\n\n${report}`
        : undefined,
      ctx?.contextNotes
        ? `CONTEXT parked on the ticket — research, findings, and decisions from discovery:\n\n${ctx.contextNotes}`
        : undefined,
      `Reproduce it, fix it at the root cause, validate the fix (run/curl/test as appropriate), and commit cleanly. Report what was wrong and what you changed.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** The fix-up session prompt (dispatch_fixup_session) — a focused pass over the INTEGRATED workspace to
   * clear a review-flagged cross-section defect before the feature ships. The findings are parked as a
   * ticket note, so the session reads them off the ticket. */
  private fixupPrompt(
    run: PipelineRun,
    opts?: { findings?: string; guidance?: string },
  ): string {
    return [
      `You are clearing a review-flagged defect in the integrated workspace for board task #${run.taskId} — the feature is fully built (every section committed here); this is a focused fix-up pass before it ships.`,
      opts?.findings
        ? `The review findings to clear (you can't open the ticket from here, so they're inlined):\n\n${opts.findings}`
        : `Review flagged a blocking issue on this work — clear it.`,
      opts?.guidance ? `Atlas's steer on top of that: ${opts.guidance}` : undefined,
      `Fix the issues at the root cause across whatever sections they span, validate (run/test as appropriate), and commit cleanly. Don't open or touch any PR — the harness re-reviews and ships once you're done. If a finding turns out to be a non-issue, address the rest and note briefly why you skipped it.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}

/** Extract a fenced ```<tag> … ``` block's body, or null. Tolerant of leading/trailing whitespace. */
function parseFenced(md: string, tag: string): string | null {
  const re = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)```', 'i');
  const m = md.match(re);
  return m ? m[1].trim() : null;
}

/** Parse the plan's `phases` JSON block → SectionPhase[]. Reads the optional per-phase `group` number
 * (Phase 4 — folds consecutive phases into one coding session; omitted ⇒ that phase is its own group).
 * Null on missing/malformed (caller falls back to a single phase) so a bad LLM emission never wedges
 * the build. */
function parsePhases(planMd: string): SectionPhase[] | null {
  const body = parseFenced(planMd, 'phases');
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.map(
      (p: { id?: unknown; title?: unknown; group?: unknown }, i) => ({
        id: typeof p.id === 'number' ? p.id : i + 1,
        title: typeof p.title === 'string' ? p.title : undefined,
        group: typeof p.group === 'number' ? p.group : undefined,
      }),
    );
  } catch {
    return null;
  }
}

/** Extract a build session's trailing `handoff` block — the structured context it leaves the NEXT
 * coding session (interfaces, decisions, stubs). Null when absent. */
function parseHandoff(report: string): string | null {
  return parseFenced(report, 'handoff');
}

/** Extract a build session's `findings` block — OUT-OF-SCOPE discoveries it noticed while working
 * (the worker ethos: "stay in scope, note the rest"). Null/empty when absent. Relayed to Atlas (the
 * single voice) to triage; never auto-acted on. */
function parseFindings(report: string): string | null {
  const body = parseFenced(report, 'findings')?.trim();
  return body ? body : null;
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
