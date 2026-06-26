import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DecisionClassifier,
  ParkAndAskService,
  PlanVisibilityService,
  type DecisionClassification,
} from '../decision-gate';
import { AutoFixStage } from '../autofix';
import type { DecisionRecord, Phase, Thread } from '../domain';
import { EngineAuthError, type EngineEvent } from '../engine';
import { GithubPrService, LocalGitService, type FeatureSandbox } from '../git';
import { CHAT_SURFACE, type ChatSurface } from '../surface';
import { CredentialResolver } from '../onboarding';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox';
import type { JobDispatcher } from '../brain';
import { TurnRunnerService } from '../runner';
import { BuildShipService } from './build-ship.service';
import { PipelineAwarenessStore } from './pipeline-awareness.store';
import {
  DriverStoreService,
  type DriverSection,
  type JobRoute,
} from './driver-store.service';
import {
  PLANNER_LLM,
  type PlannedPhase,
  type PlannerLlm,
} from './planner-llm';
import {
  DRIVER_REPO,
  type DriverRepoResolver,
  type ResolvedRepo,
} from './repo-resolver';
import { ThreadLifecycleService } from './thread-lifecycle.service';

/**
 * W4 — the SECTION/PHASE DRIVER. The legible, deterministic, resumable replacement for v1's implicit
 * status-FSM. Read it top-to-bottom: `dispatch` kicks the build off async, `runJob` walks the sections
 * in order, `runSection` does plan → review → gate → execute phases → auto-fix → handoff, `executePhases`
 * runs each phase as a fresh engine session on the shared feature branch, and `finishWithPr` runs the
 * PR-tail auto-fix and opens ONE PR. `resume` re-enters the SAME straight functions on boot, fast-
 * forwarding completed work — no signal racing, no status-enum re-derivation.
 *
 * The "dynamism" (how many sections/phases) is DATA the planner emits; the control flow is a plain
 * `await`-each-step loop. Explicit `status`/`step` rows exist ONLY for resumability — the live path is a
 * straight function. Bound as the real `JOB_DISPATCHER` (overriding W3's logging no-op). Zero v1 imports.
 */
@Injectable()
export class SectionDriver implements JobDispatcher {
  private readonly logger = new Logger(SectionDriver.name);
  /** Jobs being driven right now — guards against a double dispatch / a resume racing a live drive. */
  private readonly active = new Set<string>();

  constructor(
    private readonly store: DriverStoreService,
    @Inject(DRIVER_REPO) private readonly repos: DriverRepoResolver,
    private readonly git: LocalGitService,
    private readonly pr: GithubPrService,
    private readonly turn: TurnRunnerService,
    @Inject(PLANNER_LLM) private readonly planner: PlannerLlm,
    private readonly classifier: DecisionClassifier,
    private readonly park: ParkAndAskService,
    private readonly visibility: PlanVisibilityService,
    private readonly autofix: AutoFixStage,
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    private readonly env: EnvService,
    @Inject(SANDBOX_PROVIDER) private readonly sandboxes: SandboxProvider,
    private readonly creds: CredentialResolver,
    private readonly threadLifecycle: ThreadLifecycleService,
    private readonly ship: BuildShipService,
    private readonly awareness: PipelineAwarenessStore,
  ) {}

  /**
   * Buffer a PASSIVE pipeline milestone for the thread brain (no turn runs; it's drained into the next
   * operator turn). Best-effort + idempotent (deduped by `id`): the driver fires the same stage boundary
   * repeatedly across a resume, so the buffer keeps one. A failed append never breaks the build.
   */
  private async recordMilestone(threadId: string, id: string, text: string): Promise<void> {
    await this.awareness
      .appendMarker(threadId, { id, text, at: new Date().toISOString() })
      .catch((err) => this.logger.debug(`milestone append failed (continuing): ${err}`));
  }

  /** Sanity ceiling on a job's sections — a malformed plan can't drive an unbounded build. */
  private get maxSections(): number {
    return this.env.get('MAX_SECTIONS') ?? 12;
  }

  /** Sanity ceiling on a section's phases — a longer planner output is truncated to this. */
  private get maxPhasesPerSection(): number {
    return this.env.get('MAX_PHASES_PER_SECTION') ?? 8;
  }

  /** Per-phase wall-clock budget — a single engine turn that runs away is aborted + relayed. Default 20m. */
  private get phaseTimeoutMs(): number {
    const raw = Number(this.env.get('PHASE_TIMEOUT_MS'));
    return Number.isFinite(raw) && raw > 0 ? raw : 20 * 60_000;
  }

  /** Per-job wall-clock budget (checked at section boundaries) — backstop against an unbounded build. Default 60m. */
  private get jobTimeoutMs(): number {
    const raw = Number(this.env.get('JOB_TIMEOUT_MS'));
    return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60_000;
  }

  /** How long a mid-build PARK waits for the human before it gives up (fail + relay). Default 60m. The
   *  job/phase timeouts don't cover a park (it's between phases), so this is its dedicated guard. */
  private get parkTimeoutMs(): number {
    const raw = Number(this.env.get('PARK_TIMEOUT_MS'));
    return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60_000;
  }

  /** A repo-specific verify command (e.g. `pnpm typecheck`); when set, a phase must pass it before it
   *  commits + is marked done. Unset → rely on the engine's own in-turn verification (prompt-enforced). */
  private get verifyCmd(): string | undefined {
    const raw = this.env.get('VERIFY_CMD');
    return raw && raw.trim() ? raw.trim() : undefined;
  }

  /**
   * The DISPATCH SEAM (the brain's "hands" edge). Take ownership of an approved, persisted job and kick
   * off the deterministic drive ASYNC — return promptly so the brain doesn't block on the whole build.
   * Errors inside the drive are caught + recorded (the job flips to `failed`), never surfaced here.
   */
  async dispatch(job: Thread): Promise<void> {
    this.logger.log(
      `dispatch thread=${job.id} kind=${job.kind} title="${job.title}"`,
    );
    void this.drive(job.id).catch((err) => {
      this.logger.error(
        `drive job=${job.id} crashed: ${err instanceof Error ? err.stack : err}`,
      );
    });
  }

  /**
   * BOOT RECONCILIATION (legible, not signal-racing). For every job still `running`, re-enter the SAME
   * straight drive: `runJob` fast-forwards sections/phases already `done` and continues at the first
   * unfinished one. An interrupted `executing` phase is reopened (re-run) by `executePhases`. No web of
   * signals — just "read the persisted cursor, continue the function".
   */
  async resume(): Promise<void> {
    const jobs = await this.store.runningJobs();
    if (jobs.length === 0) return;
    this.logger.log(`resume: reconciling ${jobs.length} running job(s)`);
    for (const job of jobs) {
      void this.drive(job.id).catch((err) => {
        this.logger.error(
          `resume job=${job.id} crashed: ${err instanceof Error ? err.stack : err}`,
        );
      });
    }
  }

  /**
   * Resume a job PAUSED on a credential/401 halt (the `/test/resume` ping / a re-engage once creds are
   * fixed). Flips it back to `running` and re-drives: `runJob` fast-forwards completed work and the
   * unfinished phase resumes its SAME engine session (its `session_id` was persisted at the halt) rather
   * than restarting. A no-op if the job isn't paused. NOT auto-called on boot — a paused job would just
   * 401 again, so it waits for an explicit ping.
   */
  async resumePaused(jobId: string): Promise<void> {
    const job = await this.store.loadJob(jobId).catch(() => null);
    if (!job || job.status !== 'paused') {
      this.logger.warn(
        `resumePaused job=${jobId}: not paused (${job?.status ?? 'gone'}) — ignoring`,
      );
      return;
    }
    this.logger.log(
      `resumePaused job=${jobId} — re-driving the paused session`,
    );
    await this.store.setJobStatus(jobId, 'running');
    void this.drive(jobId).catch((err) => {
      this.logger.error(
        `resumePaused job=${jobId} crashed: ${err instanceof Error ? err.stack : err}`,
      );
    });
  }

  // ── the pipeline ───────────────────────────────────────────────────────────────────────────────

  /** Guard the job against a concurrent drive, then run it to a PR (or `failed`). */
  private async drive(jobId: string): Promise<void> {
    if (this.active.has(jobId)) {
      this.logger.warn(
        `drive job=${jobId} already active — skipping duplicate`,
      );
      return;
    }
    this.active.add(jobId);
    try {
      await this.runJob(jobId);
    } catch (err) {
      if (err instanceof EngineAuthError) {
        // A credential/401 halt — PAUSE (don't fail): the unfinished phase's session_id is persisted, so
        // a ping (`resumePaused`) continues the SAME session once creds are fixed. Re-driving now would
        // just 401 again, so we wait for the human.
        this.logger.warn(
          `job=${jobId} paused on credential error: ${err.message}`,
        );
        await this.store.setJobStatus(jobId, 'paused').catch(() => undefined);
        await this.relayPaused(jobId, err);
      } else {
        this.logger.error(
          `job=${jobId} failed: ${err instanceof Error ? err.stack : err}`,
        );
        await this.store.setJobStatus(jobId, 'failed').catch(() => undefined);
        // RELAY the failure into the thread — a failed job must never dead-end silently (issue #2).
        await this.relayFailure(jobId, err);
      }
    } finally {
      this.active.delete(jobId);
    }
  }

  /** Post a "paused on a credential error" notice so the human fixes creds + pings resume (best-effort). */
  private async relayPaused(jobId: string, err: unknown): Promise<void> {
    try {
      const job = await this.store.loadJob(jobId);
      const route = await this.store.route(job);
      await this.post(
        route,
        `:lock: Build paused — a credential/auth error halted the engine (${shortReason(err)}).\n_Your work + the engine session are saved; fix the credentials and ping resume (or reply here) to continue the SAME session._`,
      );
    } catch (e) {
      this.logger.warn(`could not relay pause for job=${jobId}: ${e}`);
    }
  }

  /** Post a clear "build failed — why" into the job's thread (best-effort). Root cause, not a stack trace. */
  private async relayFailure(jobId: string, err: unknown): Promise<void> {
    try {
      const job = await this.store.loadJob(jobId);
      const route = await this.store.route(job);
      await this.post(
        route,
        `:x: Build failed — ${shortReason(err)}\n_The job is marked failed; reply in this thread to retry or adjust the plan._`,
      );
    } catch (e) {
      this.logger.warn(`could not relay failure for job=${jobId}: ${e}`);
    }
  }

  /**
   * Walk a job's sections in order. The whole build flow lives here, readable top-to-bottom:
   *   load the job + record + route → ensure the feature sandbox → for each section: runSection (which
   *   carries the prior handoff forward) → after all sections: finishWithPr (PR-tail auto-fix + open PR).
   * Fast-forwards `done` sections (resume): a finished section just yields its persisted handoff_out.
   */
  private async runJob(jobId: string): Promise<void> {
    const job = await this.store.loadJob(jobId);
    if (job.status !== 'running') {
      this.logger.warn(
        `job=${jobId} not running (status=${job.status}) — not driving`,
      );
      return;
    }
    const record = await this.store.decisionRecord(job.decisionRecordId);
    const route = await this.store.route(job);
    const repo = await this.repos.resolve(job);
    const sandbox = await this.ensureSandbox(job, repo);

    this.logger.log(
      `job=${jobId} on branch ${sandbox.branch} @ ${sandbox.worktreePath}`,
    );

    const allSections = await this.store.sectionsForJob(jobId);
    const sections = allSections.slice(0, this.maxSections);
    if (allSections.length > sections.length) {
      this.logger.warn(
        `job=${jobId} has ${allSections.length} sections > MAX_SECTIONS (${this.maxSections}) — capping`,
      );
    }
    const pending = sections.filter((s) => s.status !== 'done').length;
    if (pending > 0) {
      await this.post(
        route,
        `:rocket: Starting the build — ${pending} section(s) on \`${sandbox.branch}\`.`,
      );
    }

    // Per-job wall-clock backstop (issue #3) — checked at each section boundary; the per-phase timeout
    // guards within a section. A breach aborts + relays (caught in drive()).
    const deadline = Date.now() + this.jobTimeoutMs;
    let handoff: string | null = null;
    for (const section of sections) {
      if (section.status === 'done') {
        // Already built (a resume) — carry its persisted handoff to the next section, don't re-run.
        handoff = section.handoffOut ?? handoff;
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `job exceeded JOB_TIMEOUT_MS (${this.jobTimeoutMs}ms) before section "${section.brief}"`,
        );
      }
      handoff = await this.runSection(
        job,
        record,
        route,
        repo,
        sandbox,
        section,
        handoff,
      );
    }

    await this.finishWithPr(job, record, route, repo, sandbox);
  }

  /**
   * Run ONE section, returning its handoff for the next. The per-section flow, in order:
   *   a. plan just-in-time (an engine plan turn → phases), or resume the locked plan;
   *   b. one Codex-style review → revise pass (clean single loop);
   *   c. the decision gate — classify notable decisions; an uncovered always-ask PARKS & awaits a human;
   *   d. post the plan for visibility (non-blocking);
   *   e. execute the phases (fresh session each) on the shared branch;
   *   f. per-section auto-fix over the section's diff;
   *   g. summarize the handoff for the next section.
   */
  private async runSection(
    job: Thread,
    record: DecisionRecord | null,
    route: JobRoute,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
    section: DriverSection,
    handoffIn: string | null,
  ): Promise<string | null> {
    this.logger.log(`section ${section.ordinal} "${section.brief}" — planning`);
    await this.post(
      route,
      `:hammer_and_wrench: Planning section — *${section.brief}*`,
    );

    // a. PLAN (just-in-time) — or reuse the locked plan on a resume (phases already exist).
    const { phases, planned } = await this.planSection(
      job,
      record,
      sandbox,
      section,
      handoffIn,
    );

    // b. REVIEW → revise once (only when freshly planned this run; a resumed lock skips it).
    //    (The locked phase ROWS are the source of truth; review only reshapes a fresh plan's prose.)
    if (planned) await this.reviewPlan(record, section, handoffIn, planned, job.orgId);

    // The plan view the gate + visibility read — derived from the locked phase rows (resume-safe).
    const planView = phases.map(asPlannedPhase);

    // c. GATE — classify the plan's notable decisions; an uncovered always-ask parks & awaits a human.
    const classifications = await this.gateSection(
      job,
      route,
      record,
      section,
      planView,
    );

    // d. VISIBILITY — post the detailed plan into the thread (non-blocking; never gates).
    await this.visibility.postSectionPlan({
      channel: route.channel ?? '',
      ...(route.threadTs ? { threadTs: route.threadTs } : {}),
      ...(route.orgId ? { orgId: route.orgId } : {}),
      title: section.brief,
      plan: renderPlan(planView),
      decisions: classifications,
    });

    // e. EXECUTE — run each phase as a fresh session on the shared feature branch.
    const sectionStartSha = await this.git
      .headSha(sandbox.worktreePath)
      .catch(() => undefined);
    await this.store.setSectionStatus(section.id, 'executing');
    const reports = await this.executePhases(
      job,
      route,
      sandbox,
      section,
      record,
    );

    // f. AUTO-FIX — fan-out review → fix over this section's diff.
    await this.store.setSectionStatus(section.id, 'auto_fixing');
    await this.autofix
      .autofixSection({
        worktreePath: sandbox.worktreePath,
        sandboxKey: sandboxKey(sandbox),
        ...(sectionStartSha ? { gitRange: `${sectionStartSha}..HEAD` } : {}),
        intent: `${record?.overview ?? ''}\n\nSection: ${section.brief}`.trim(),
        label: section.brief,
        ...(sandbox.containerId
          ? {
              containerId: sandbox.containerId,
              ...(sandbox.execUser ? { execUser: sandbox.execUser } : {}),
            }
          : {}),
      })
      .catch((err) =>
        this.logger.warn(`section auto-fix failed (continuing): ${err}`),
      );
    // Passive milestone: auto-fix is a transient stage (section status is overwritten to `done` next), so
    // the net-state snapshot can't reconstruct that it ran — record it explicitly for the brain.
    await this.recordMilestone(
      job.id,
      `section:${section.id}:autofix`,
      `Auto-fix pass applied over the diff for section "${section.brief}".`,
    );

    // g. HANDOFF — summarize what this section produced for the next.
    const handoffOut = await this.summarizeHandoff(section, phases, reports, job.orgId);
    await this.store.setSectionHandoffOut(section.id, handoffOut);
    await this.store.setSectionStatus(section.id, 'done');
    this.logger.log(`section ${section.ordinal} done`);
    await this.recordMilestone(
      job.id,
      `section:${section.id}:done`,
      `Section "${section.brief}" finished building.`,
    );
    await this.post(
      route,
      `:white_check_mark: Section done — *${section.brief}*`,
    );
    return handoffOut;
  }

  /**
   * Produce (or resume) the section's locked phases. On a fresh run: an engine PLAN turn in the sandbox
   * grounded in the record + handoff → the planner LLM shapes the phase list (fallback: a single phase
   * whose brief is the section brief) → persisted. On a resume: the phases already exist, so reuse them
   * (returns `planned: undefined` to signal "no re-review needed").
   */
  private async planSection(
    job: Thread,
    record: DecisionRecord | null,
    sandbox: FeatureSandbox,
    section: DriverSection,
    handoffIn: string | null,
  ): Promise<{ phases: Phase[]; planned: PlannedPhase[] | null }> {
    const existing = await this.store.phasesForSection(section.id);
    if (existing.length > 0) {
      this.logger.log(
        `section ${section.ordinal}: ${existing.length} phase(s) already locked — resuming`,
      );
      return { phases: existing, planned: null };
    }

    await this.store.setSectionStatus(section.id, 'planning');

    // An engine PLAN turn explores the worktree read-only; its plan text grounds the structured planner.
    // The full plan (plan.md, decisions, diagrams) lives in /context/specs — the plan turn reads it there.
    const planInput = {
      overview: record?.overview ?? '',
      decisions: record?.decisions ?? [],
      brief: section.brief,
      handoffIn,
      orgId: job.orgId,
    };
    // Bound the plan turn too (issue #3): exploring a large repo read-only can run away just like an
    // execute turn. Hard-bounded so the driver gives up even if the SDK won't yield; on breach it falls
    // back to the structured planner below (graceful — the engine plan text is only grounding).
    const planTurn = await this.runTurnBounded(
      {
        jobId: job.id,
        sandbox,
        engine: 'claude',
        mode: 'plan',
        systemPrompt: SECTION_PLAN_SYSTEM,
        task: renderPlanTask(planInput),
        auth: await this.creds.engineAuth(job.orgId, 'claude'),
      },
      `section ${section.ordinal} plan turn`,
    ).catch((err) => {
      this.logger.warn(
        `section ${section.ordinal} plan turn failed (continuing): ${err}`,
      );
      return undefined;
    });

    const planned = (
      (await this.planner.planSection(planInput).catch(() => undefined)) ??
      fallbackPhases(section.brief, planTurn?.planText ?? planTurn?.report)
    ).slice(0, this.maxPhasesPerSection);

    await this.store.setSectionPlan(section.id, renderPlan(planned), handoffIn);
    const phases = await this.store.lockPhases(section, planned);
    return { phases, planned };
  }

  /**
   * ONE Codex-style review → revise pass over the freshly-drafted plan (a clean single loop). When the
   * reviewer returns a revision it RE-PERSISTS the section's plan prose; the locked phase rows stay the
   * execution source of truth (they're already gap-numbered + resumable). Best-effort — a failed review
   * leaves the original plan.
   */
  private async reviewPlan(
    record: DecisionRecord | null,
    section: DriverSection,
    handoffIn: string | null,
    draft: PlannedPhase[],
    orgId?: string,
  ): Promise<void> {
    await this.store.setSectionStatus(section.id, 'reviewing');
    const revised = await this.planner
      .reviewPlan({
        overview: record?.overview ?? '',
        decisions: record?.decisions ?? [],
        brief: section.brief,
        handoffIn,
        draft,
        ...(orgId ? { orgId } : {}),
      })
      .catch(() => undefined);
    if (revised)
      await this.store.setSectionPlan(
        section.id,
        renderPlan(revised),
        handoffIn,
      );
  }

  /**
   * The DECISION GATE (W5). Mine the plan for notable decisions, classify each against the record. An
   * uncovered always-ask (`verdict === 'ask'`) PARKS the section: post the question in-thread and AWAIT
   * the human (the section suspends; resumable across restart). Covered/proceed continue. Returns the
   * non-ask classifications for the visibility post.
   */
  private async gateSection(
    job: Thread,
    route: JobRoute,
    record: DecisionRecord | null,
    section: DriverSection,
    planned: PlannedPhase[],
  ): Promise<DecisionClassification[]> {
    const decisions =
      (await this.planner
        .extractDecisions({
          overview: record?.overview ?? '',
          decisions: record?.decisions ?? [],
          brief: section.brief,
          handoffIn: section.handoffIn,
          phases: planned,
          orgId: job.orgId,
        })
        .catch(() => undefined)) ?? [];

    const classifications: DecisionClassification[] = [];
    for (const proposed of decisions) {
      const c = await this.classifier.classify(
        proposed,
        { decisions: record?.decisions ?? [] },
        job.orgId,
      );
      if (c.verdict === 'ask') {
        await this.store.setSectionStatus(section.id, 'awaiting_approval');
        this.logger.log(
          `section ${section.ordinal} parks on: ${proposed.description}`,
        );
        const handle = await this.park.ask(
          {
            channel: route.channel ?? '',
            ...(route.threadTs ? { threadTs: route.threadTs } : {}),
            ...(route.orgId ? { orgId: route.orgId } : {}),
          },
          parkQuestion(section.brief, proposed.description, c.reason),
        );
        // AWAIT the human — the section is suspended here, the process is not. Bounded by a wall-clock
        // budget so an unanswered park can't hang the build forever (the job/phase timeouts don't cover a
        // park, which is between phases): on expiry it throws → the job fails + relays (issue #2/#3).
        const answer = await this.awaitAnswer(
          handle.answer,
          proposed.description,
        );
        this.logger.log(
          `section ${section.ordinal} unparked: ${answer.text.slice(0, 80)}`,
        );
        // Passive milestone: a guard parked on a decision and the human answered it — a transient moment
        // the net-state snapshot can't reconstruct (the section status moves on). Deduped by the decision.
        await this.recordMilestone(
          job.id,
          `section:${section.id}:gate:${proposed.description.slice(0, 60)}`,
          `While planning section "${section.brief}" a decision was raised and the operator answered it: ${proposed.description}`,
        );
        // The human answered → treat the always-ask as now-settled and continue (it was visible + ruled).
      } else {
        classifications.push(c);
      }
    }
    return classifications;
  }

  /** Run an engine turn under a HARD wall-clock bound (PHASE_TIMEOUT_MS). On breach it signals the
   *  SDK to abort (best-effort — may not interrupt a stuck subprocess) AND rejects the await so the driver
   *  gives up regardless. A still-running orphaned turn is harmless (nothing awaits it). */
  private async runTurnBounded(
    input: Parameters<TurnRunnerService['runTurn']>[0],
    label: string,
  ): Promise<Awaited<ReturnType<TurnRunnerService['runTurn']>>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const hardTimeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new Error(
            `${label} exceeded PHASE_TIMEOUT_MS (${this.phaseTimeoutMs}ms)`,
          ),
        );
      }, this.phaseTimeoutMs);
    });
    try {
      return await Promise.race([
        this.turn.runTurn({ ...input, signal: controller.signal }),
        hardTimeout,
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /** Await a parked human answer, bounded by PARK_TIMEOUT_MS. On expiry it rejects so the build
   *  fails + relays (instead of suspending forever); the human can re-engage in-thread to restart. */
  private async awaitAnswer<T>(
    answer: Promise<T>,
    decisionDesc: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `timed out after ${this.parkTimeoutMs}ms waiting for your input on: ${decisionDesc}`,
            ),
          ),
        this.parkTimeoutMs,
      );
    });
    try {
      return await Promise.race([answer, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /**
   * Execute a section's phases — each a FRESH engine session (context reset) in the SAME worktree so
   * later phases build on earlier code. Walks the explicit `step`/`status` cursor: a `done` phase is
   * fast-forwarded (resume); an unfinished one is (re)run from `building`, committed, marked `done`.
   * Returns each phase's report (the handoff inputs).
   */
  private async executePhases(
    job: Thread,
    route: JobRoute,
    sandbox: FeatureSandbox,
    section: DriverSection,
    record: DecisionRecord | null,
  ): Promise<string[]> {
    const phases = await this.store.phasesForSection(section.id);
    const reports: string[] = [];
    for (const phase of phases) {
      if (phase.status === 'done') {
        this.logger.log(`phase ${phase.ordinal} already done — fast-forward`);
        continue;
      }
      reports.push(
        await this.runPhase(job, route, sandbox, section, record, phase),
      );
    }
    return reports;
  }

  /** Run ONE phase: a fresh execute turn → verify → commit → mark done. The explicit cursor moves with
   *  the work. A per-phase wall-clock timeout aborts a runaway turn; an optional verify command gates
   *  the commit so broken output never advances the cursor (issues #3, #4). */
  private async runPhase(
    job: Thread,
    route: JobRoute,
    sandbox: FeatureSandbox,
    section: DriverSection,
    record: DecisionRecord | null,
    phase: Phase,
  ): Promise<string> {
    const label = phase.title ?? phase.brief ?? `phase ${phase.ordinal}`;
    this.logger.log(`phase ${phase.ordinal} "${label}" — building`);
    await this.store.setPhaseState(phase.id, 'build', 'building');
    await this.post(route, `:gear: ${section.brief} — building: ${label}`);

    // Circuit breaker (#3): bound the engine turn. On breach it both signals the SDK to abort AND hard-
    // rejects so the DRIVER gives up even if the SDK can't interrupt a stuck subprocess (a non-yielding
    // Bash/exploration). The rejection propagates → the job fails + relays.
    const result = await this.runTurnBounded(
      {
        jobId: job.id,
        phaseId: phase.id,
        sandbox,
        engine: 'claude',
        mode: 'execute',
        systemPrompt: PHASE_EXECUTE_SYSTEM,
        task: renderPhaseTask(record, section, phase),
        auth: await this.creds.engineAuth(job.orgId, 'claude'),
        onEvent: (e) => {
          if (e.kind === 'tool') {
            this.logger.debug(`phase ${phase.ordinal} tool: ${e.name}`);
          }
          // R5: relay engine events to the surface so the web UI can render per-phase transcripts.
          // Best-effort — a failed post never breaks the build pipeline.
          void this.postPhaseEvent(route, phase.id, section.ordinal, phase.ordinal, e);
        },
      },
      `phase "${label}"`,
    );

    // Surface any off-spec deviations the engine flagged in its report (#7) — never silent.
    const deviations = extractDeviations(result.report);
    if (deviations.length) {
      await this.post(
        route,
        `:warning: Off-spec changes in *${label}*:\n${deviations.map((d) => `• ${d}`).join('\n')}`,
      );
    }

    // Verify BEFORE committing (#4): an optional repo verify command must pass, else fail the phase so
    // broken output never commits or advances the cursor. Unset → rely on the engine's in-turn verify.
    await this.verifyPhase(route, sandbox, label);

    // Commit whatever the phase produced onto the shared feature branch.
    const sha = await this.git.commitAll(
      sandbox.worktreePath,
      `${section.brief} — ${phase.title ?? `phase ${phase.ordinal}`}`,
    );
    this.logger.log(
      `phase ${phase.ordinal} committed ${sha ? sha.slice(0, 8) : '(nothing)'}`,
    );

    await this.store.setPhaseState(phase.id, 'done', 'done');
    return result.report;
  }

  /** Run VERIFY_CMD in the worktree (when set); a non-zero exit fails the phase (caught → relayed).
   *  Repo-agnostic by being opt-in: the operator points it at their own typecheck/test/build. */
  private async verifyPhase(
    route: JobRoute,
    sandbox: FeatureSandbox,
    label: string,
  ): Promise<void> {
    const cmd = this.verifyCmd;
    if (!cmd) return;
    this.logger.log(`phase "${label}" — verifying: ${cmd}`);
    try {
      await execShell(cmd, sandbox.worktreePath, this.phaseTimeoutMs);
    } catch (err) {
      await this.post(
        route,
        `:warning: Verification failed after *${label}* (\`${cmd}\`) — failing the phase.`,
      );
      throw new Error(
        `verify command "${cmd}" failed after phase "${label}": ${shortReason(err)}`,
      );
    }
  }

  /**
   * PR-TAIL. After all sections: one auto-fix pass over the WHOLE accumulated diff, push the branch,
   * open ONE PR per feature (idempotent — a re-run finds the existing PR), record the url, mark the job
   * done, and post "PR ready" in-thread. Sections stacked on one branch ⇒ one PR.
   */
  private async finishWithPr(
    job: Thread,
    record: DecisionRecord | null,
    route: JobRoute,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
  ): Promise<void> {
    this.logger.log(`job=${job.id} all sections done — shipping`);
    await this.ship.ship({
      job,
      record,
      repo,
      sandbox,
      notify: (m) => this.post(route, m),
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Ensure the job's sandbox (worktree) exists and the feature branch is recorded. Idempotent — a resume
   * reuses the existing worktree/branch.
   *
   * R2 path (per-thread sandbox): the thread owns a durable worktree + feature branch (cut at
   * thread-creation). `ensureContainer` (re-)attaches a live container against that worktree — reusing a
   * warm one, or re-attaching a fresh one (cold) after an idle reap / crash. The thread's `feature_branch`
   * is the SOURCE OF TRUTH (we record it onto the job; we do NOT derive a branch from the job). On a cold
   * re-attach the returned sandbox carries `warm: false`, so the turn-runner prepends the reset notice to
   * the first resumed turn.
   *
   * Legacy path (per-feature sandbox): if no thread sandbox exists (inbound-message-derived threads,
   * or pre-R2 jobs), fall back to the old job-derived branch + `createFeatureSandbox` + `attach` — branch
   * keyed (one container per branch), byte-identical to before R2.
   */
  private async ensureSandbox(
    job: Thread,
    repo: ResolvedRepo,
  ): Promise<FeatureSandbox> {
    // ── R2: per-thread sandbox path ──────────────────────────────────────────────────────────────
    const ensured = await this.threadLifecycle.ensureContainer(job.id, job.orgId);
    if (ensured) {
      const branch = ensured.sandbox.branch; // the thread's feature branch is the source of truth
      if (job.featureBranch !== branch) await this.store.setFeatureBranch(job.id, branch);
      this.logger.log(
        `job=${job.id} using thread sandbox on ${branch}${ensured.wasReset ? ' (cold re-attach)' : ''}`,
      );
      return ensured.sandbox;
    }

    // ── Legacy path: per-feature worktree + attach ───────────────────────────────────────────────
    const branch = job.featureBranch ?? `atlas/${job.kind}-${job.id.slice(0, 8)}`;
    const sandbox = await this.git.createFeatureSandbox(repo.projectRepo, branch);
    if (!job.featureBranch) await this.store.setFeatureBranch(job.id, branch);
    return this.sandboxes.attach({ sandbox, orgId: job.orgId });
  }

  /** Summarize a section's handoff (LLM, with a terse rule-based fallback). */
  private async summarizeHandoff(
    section: DriverSection,
    phases: Phase[],
    reports: string[],
    orgId?: string,
  ): Promise<string> {
    const planned = phases.map(asPlannedPhase);
    const llm = await this.planner
      .handoff({ brief: section.brief, phases: planned, reports, ...(orgId ? { orgId } : {}) })
      .catch(() => undefined);
    if (llm) return llm;
    const built = phases.map((p) => p.title ?? p.brief).join('; ');
    return `Section "${section.brief}" complete. Built: ${built || '(see commits)'}.`;
  }

  /** Post into the job's thread (best-effort — visibility never breaks the pipeline). */
  private async post(route: JobRoute, text: string): Promise<void> {
    if (!route.channel) return;
    try {
      await this.surface.post(route.channel, text, {
        ...(route.threadTs ? { threadTs: route.threadTs } : {}),
        ...(route.orgId ? { orgId: route.orgId } : {}),
      });
    } catch (err) {
      this.logger.warn(`post failed (continuing): ${err}`);
    }
  }

  /**
   * R5: relay a per-phase engine event to the web surface (SSE) so the UI can render the live
   * phase transcript. Only text/tool/result events are relayed (session events carry no useful text).
   * Posts with a `meta.kind='build_event'` marker so SSE subscribers can distinguish them from
   * conversational messages. Best-effort — a failed post never breaks the build.
   */
  private async postPhaseEvent(
    route: JobRoute,
    phaseId: string,
    sectionOrdinal: number,
    phaseOrdinal: number,
    e: EngineEvent,
  ): Promise<void> {
    if (!route.channel) return;
    // Only relay events that carry useful text — skip bare session events.
    const text =
      e.kind === 'text'
        ? e.text.trim()
        : e.kind === 'tool'
          ? `[tool] ${e.name}${e.detail ? `: ${e.detail}` : ''}`
          : e.kind === 'result'
            ? e.text.trim()
            : '';
    if (!text) return;
    try {
      await this.surface.post(route.channel, text, {
        ...(route.threadTs ? { threadTs: route.threadTs } : {}),
        ...(route.orgId ? { orgId: route.orgId } : {}),
        meta: {
          kind: 'build_event',
          phaseId,
          sectionOrdinal,
          phaseOrdinal,
          eventKind: e.kind,
        },
      });
    } catch {
      // Silently drop — phase event relay is purely informational.
    }
  }
}

// ── pure render helpers ──────────────────────────────────────────────────────────────────────────

const SECTION_PLAN_SYSTEM =
  'You are Atlas planning ONE section of an approved feature. Explore the codebase read-only and produce ' +
  'a concrete phased plan for this section, respecting the locked decision record. Do not write any files. ' +
  "The plan MUST end with VERIFICATION: a final phase (or explicit step) that runs the repo's OWN " +
  'typecheck/build/tests and confirms the change works. For a DELETION, an early phase must PROVE the code ' +
  'is truly unused — search for every intra-file and cross-file reference (and dynamic/string usages) — ' +
  'before anything is removed. Never plan to claim done without verifying.';

const PHASE_EXECUTE_SYSTEM =
  'You are Atlas executing ONE phase of an approved plan in a feature worktree. Implement exactly this ' +
  "phase's brief, respecting the locked decisions. Make focused, working changes; do not exceed the phase scope. " +
  'If you make ANY change not explicitly called for by this brief, or you depart from a locked decision ' +
  '(e.g. adding a file/dependency/config nobody asked for), you MUST flag it: put each such change on its ' +
  "own line in your final report starting with 'DEVIATION:' and a one-line why. Off-spec work is never silent. " +
  "VERIFY before you finish: discover and run the repository's OWN typecheck/build/test tooling and make " +
  'sure your change compiles and the relevant tests pass — do NOT claim the work is done on the basis of a ' +
  'guess. If this phase REMOVES code, first prove it is genuinely unreferenced (grep for every importer AND ' +
  'intra-file caller, plus dynamic/string references) and that the build still passes after removal; if you ' +
  'cannot prove it is unused, do NOT delete it — report the uncertainty instead. If verification fails and ' +
  'you cannot fix it within scope, say so explicitly rather than reporting success.';

/** A locked phase row → the `PlannedPhase` view the gate/visibility/render read (title null → brief). */
function asPlannedPhase(phase: Phase): PlannedPhase {
  return { title: phase.title ?? phase.brief, brief: phase.brief };
}

function renderPlan(phases: PlannedPhase[]): string {
  return phases
    .map((p, i) => `${i + 1}. **${p.title}** — ${p.brief}`)
    .join('\n');
}

function renderPlanTask(input: {
  overview: string;
  decisions: { decisionClass: string; title: string; ruling: string }[];
  brief: string;
  handoffIn: string | null;
}): string {
  const decisions = input.decisions.length
    ? input.decisions
        .map((d) => `- [${d.decisionClass}] ${d.title}: ${d.ruling}`)
        .join('\n')
    : '(none)';
  const handoff = input.handoffIn
    ? `\n\nPrior section handoff:\n${input.handoffIn}`
    : '';
  return [
    `Feature overview:\n${input.overview}`,
    `\nLocked decisions (respect these):\n${decisions}`,
    `\nPlan THIS section:\n${input.brief}${handoff}`,
    '\nThe full plan (plan.md, decisions, diagrams) is in /context/specs — read it before planning phases.',
    '\nProduce an ordered list of phases. Do not write files.',
  ].join('\n');
}

function renderPhaseTask(
  record: DecisionRecord | null,
  section: DriverSection,
  phase: Phase,
): string {
  const decisions = record?.decisions.length
    ? record.decisions
        .map((d) => `- [${d.decisionClass}] ${d.title}: ${d.ruling}`)
        .join('\n')
    : '(none)';
  return [
    `Feature overview:\n${record?.overview ?? ''}`,
    `\nLocked decisions (respect these):\n${decisions}`,
    `\nSection: ${section.brief}`,
    `\nThe full plan (plan.md, decisions, diagrams) is in /context/specs — read it for grounding.`,
    `\nImplement this phase:\n**${phase.title ?? `Phase ${phase.ordinal}`}** — ${phase.brief}`,
  ].join('\n');
}

function fallbackPhases(
  brief: string,
  planText: string | undefined,
): PlannedPhase[] {
  return [
    { title: brief, brief: planText ? `${brief}\n\n${planText}` : brief },
  ];
}

function parkQuestion(
  sectionBrief: string,
  decision: string,
  reason: string,
): string {
  return [
    `:raising_hand: While planning *${sectionBrief}* I hit a decision I should check with you first:`,
    `> ${decision}`,
    `_${reason}_`,
    "How would you like me to proceed? (Reply in this thread and I'll continue.)",
  ].join('\n');
}

function sandboxKey(sandbox: FeatureSandbox): string {
  return `${sandbox.repoId}--${sandbox.branch}`;
}

/** Pull the engine's flagged off-spec deviations out of a phase report ('DEVIATION:' lines, #7). */
function extractDeviations(report: string): string[] {
  return report
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^DEVIATION:/i.test(l))
    .map((l) => l.replace(/^DEVIATION:\s*/i, '').trim())
    .filter(Boolean);
}

/** A concise human root-cause for a failure relay — the error's first line, never a stack trace. */
function shortReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const firstLine = msg.split('\n')[0]?.trim() || 'unknown error';
  return firstLine.length > 300 ? `${firstLine.slice(0, 297)}...` : firstLine;
}

const execAsync = promisify(exec);

/** Run a shell command string in `cwd` with a wall-clock timeout; throws (with captured stderr) on a
 *  non-zero exit or timeout. Used by the optional VERIFY_CMD phase gate. */
async function execShell(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await execAsync(cmd, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || '')
      .toString()
      .trim()
      .split('\n')
      .slice(-3)
      .join(' ');
    throw new Error(detail || 'command failed');
  }
}
