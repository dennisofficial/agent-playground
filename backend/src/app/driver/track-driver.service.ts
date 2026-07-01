import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DecisionClassifier,
  ParkAndAskService,
  PlanVisibilityService,
  type DecisionClassification,
} from '../decision-gate';
import { AutoFixStage, reviewAgentsForTrack } from '../autofix';
import type { DecisionRecord, Step, Job } from '../domain';
import { EngineAuthError } from '../engine';
import { GithubPrService, LocalGitService, type FeatureSandbox } from '../git';
import {
  CHAT_SURFACE,
  type ChatSurface,
  BLOCK_SINK,
  type BlockSink,
  TurnHarnessFactory,
} from '../surface';
import { CredentialResolver } from '../onboarding';
import { LeaderElectionService } from '../cluster';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox';
import type { JobDispatcher } from '../brain';
import { TurnRunnerService } from '../runner';
import { BuildShipService, LEDGER_COMMIT_MESSAGE } from './build-ship.service';
import { PipelineAwarenessStore } from './pipeline-awareness.store';
import {
  DriverStoreService,
  type DriverTrack,
  type JobRoute,
} from './driver-store.service';
import { PLANNER_LLM, type PlannedStep, type PlannerLlm } from './planner-llm';
import { renderPlan } from './render-plan';
import {
  DRIVER_REPO,
  type DriverRepoResolver,
  type ResolvedRepo,
} from './repo-resolver';
import { JobLifecycleService } from './job-lifecycle.service';

/**
 * W4 — the SECTION/PHASE DRIVER. The legible, deterministic, resumable replacement for v1's implicit
 * status-FSM. Read it top-to-bottom: `dispatch` kicks the build off async, `runJob` walks the tracks
 * in order, `runTrack` does plan → review → gate → execute steps → auto-fix → handoff, `executeSteps`
 * runs each step as a fresh engine session on the shared feature branch, and `finishWithPr` runs the
 * PR-tail auto-fix and opens ONE PR. `resume` re-enters the SAME straight functions on boot, fast-
 * forwarding completed work — no signal racing, no status-enum re-derivation.
 *
 * The "dynamism" (how many tracks/steps) is DATA the planner emits; the control flow is a plain
 * `await`-each-step loop. Explicit `status`/`step` rows exist ONLY for resumability — the live path is a
 * straight function. Bound as the real `JOB_DISPATCHER` (overriding W3's logging no-op). Zero v1 imports.
 */
/** The narrow brain surface the driver needs at ship — resolved lazily to avoid the module cycle. */
interface LedgerPromoter {
  promoteDurableDecisionsAtShip(
    threadId: string,
    orgId: string,
    repoId: string,
  ): Promise<void>;
}

@Injectable()
export class TrackDriver implements JobDispatcher {
  private readonly logger = new Logger(TrackDriver.name);
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
    private readonly threadLifecycle: JobLifecycleService,
    private readonly ship: BuildShipService,
    private readonly awareness: PipelineAwarenessStore,
    // Lets the terminal-error catch tell a shutdown-induced abort (leave the job resumable) apart from a
    // real failure — so a graceful restart mid-build no longer self-marks the job `failed`.
    private readonly election: LeaderElectionService,
    // The shared transcript spine — a build turn rides it on a `phase:<stepId>` lane so the step sub-page
    // renders a full transcript (thinking/prose/tool calls), exactly like a subagent run.
    private readonly turnHarness: TurnHarnessFactory,
    @Inject(BLOCK_SINK) private readonly blockSink: BlockSink,
    // Lazily resolves the brain (AgentSessionManager) for the server-initiated ledger-promotion turn,
    // dodging the brain⇄driver constructor cycle.
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Buffer a PASSIVE pipeline milestone for the thread brain (no turn runs; it's drained into the next
   * operator turn). Best-effort + idempotent (deduped by `id`): the driver fires the same stage boundary
   * repeatedly across a resume, so the buffer keeps one. A failed append never breaks the build.
   */
  private async recordMilestone(
    threadId: string,
    id: string,
    text: string,
  ): Promise<void> {
    await this.awareness
      .appendMarker(threadId, { id, text, at: new Date().toISOString() })
      .catch((err) =>
        this.logger.debug(`milestone append failed (continuing): ${err}`),
      );
  }

  /** Sanity ceiling on a job's tracks — a malformed plan can't drive an unbounded build. */
  private get maxTracks(): number {
    return this.env.get('MAX_SECTIONS') ?? 12;
  }

  /** Sanity ceiling on a track's steps — a longer planner output is truncated to this. */
  private get maxStepsPerTrack(): number {
    return this.env.get('MAX_PHASES_PER_SECTION') ?? 8;
  }

  /** Hard cap on how many steps a single execution BATCH may contain — the deterministic envelope
   *  around the LLM batcher so a group can never swallow a whole large track (keeps the fresh-context
   *  safety reachable). Default 5. */
  private get maxStepsPerBatch(): number {
    const raw = Number(this.env.get('MAX_PHASES_PER_BATCH'));
    return Number.isFinite(raw) && raw > 0 ? raw : 5;
  }

  /** ORCHESTRATE mode (default ON): run each track as ONE Opus orchestrator session that fans the
   *  implementation out to writer subagents, instead of the old programmatic per-step batching. Set
   *  `ORCHESTRATE_TRACKS=off` to fall back to the legacy LLM-batched per-step path. */
  private get orchestrate(): boolean {
    return (this.env.get('ORCHESTRATE_TRACKS') ?? '').toLowerCase() !== 'off';
  }

  /** Per-step wall-clock budget — a single engine turn that runs away is aborted + relayed. Default 20m.
   *  In orchestrate mode one turn spans the WHOLE track + its writer fan-out, so the budget is larger. */
  private get phaseTimeoutMs(): number {
    const raw = Number(this.env.get('PHASE_TIMEOUT_MS'));
    if (Number.isFinite(raw) && raw > 0) return raw;
    return this.orchestrate ? 60 * 60_000 : 20 * 60_000;
  }

  /** Per-job wall-clock budget (checked at track boundaries) — backstop against an unbounded build. Default 60m. */
  private get jobTimeoutMs(): number {
    const raw = Number(this.env.get('JOB_TIMEOUT_MS'));
    return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60_000;
  }

  /** How long a mid-build PARK waits for the human before it gives up (fail + relay). Default 60m. The
   *  job/step timeouts don't cover a park (it's between steps), so this is its dedicated guard. */
  private get parkTimeoutMs(): number {
    const raw = Number(this.env.get('PARK_TIMEOUT_MS'));
    return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60_000;
  }

  /**
   * The DISPATCH SEAM (the brain's "hands" edge). Take ownership of an approved, persisted job and kick
   * off the deterministic drive ASYNC — return promptly so the brain doesn't block on the whole build.
   * Errors inside the drive are caught + recorded (the job flips to `failed`), never surfaced here.
   */
  async dispatch(job: Job): Promise<void> {
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
   * straight drive: `runJob` fast-forwards tracks/steps already `done` and continues at the first
   * unfinished one. An interrupted `executing` step is reopened (re-run) by `executeSteps`. No web of
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
   * unfinished step resumes its SAME engine session (its `session_id` was persisted at the halt) rather
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

  /**
   * Operator RETRY (the halted-build "Retry" button). Re-drive a `failed` OR `paused` build: flip it back
   * to `running` and re-enter the SAME resumable drive — `runJob` fast-forwards `done` tracks/steps and
   * batches that already carry a `commit_sha`, then continues at the first unfinished one (the interrupted
   * step resumes its persisted engine `session_id` rather than restarting). Idempotent: a no-op when the
   * job isn't retryable (already running/done) or is being driven right now. Returns promptly.
   */
  async retry(jobId: string): Promise<void> {
    if (this.active.has(jobId)) {
      this.logger.warn(`retry job=${jobId}: already being driven — ignoring`);
      return;
    }
    const job = await this.store.loadJob(jobId).catch(() => null);
    if (!job) {
      this.logger.warn(`retry job=${jobId}: thread not found — ignoring`);
      return;
    }
    if (job.status !== 'failed' && job.status !== 'paused') {
      this.logger.warn(
        `retry job=${jobId}: not retryable (status=${job.status}) — ignoring`,
      );
      return;
    }
    this.logger.log(`retry job=${jobId} — re-driving from ${job.status}`);
    await this.store.setJobStatus(jobId, 'running');
    void this.drive(jobId).catch((err) => {
      this.logger.error(
        `retry job=${jobId} crashed: ${err instanceof Error ? err.stack : err}`,
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
      if (this.election.isDraining()) {
        // PROCESS SHUTDOWN, not a failure: the drain cut off the in-flight turn's host-side await (the
        // container keeps running, reparented to init). Leave the job `running` so boot-resume re-drives
        // it (`runningJobs()` filters `status:'running'`) and fast-forwards completed steps. Marking it
        // `failed` here would strand the build forever — boot-resume never re-drives a `failed` job. This
        // is keyed to the drain state specifically, NOT to AbortError, so a local watchdog/PHASE_TIMEOUT
        // abort (which fires while still leader/follower) still falls through to the `failed` branch below.
        this.logger.warn(
          `job=${jobId} left running — aborted by shutdown drain; will resume on next boot`,
        );
        return;
      }
      if (err instanceof EngineAuthError) {
        // A credential/401 halt — PAUSE (don't fail): the unfinished step's session_id is persisted, so
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
   * Walk a job's tracks in order. The whole build flow lives here, readable top-to-bottom:
   *   load the job + record + route → ensure the feature sandbox → for each track: runTrack (which
   *   carries the prior handoff forward) → after all tracks: finishWithPr (PR-tail auto-fix + open PR).
   * Fast-forwards `done` tracks (resume): a finished track just yields its persisted handoff_out.
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
    const sandbox = await this.ensureSandbox(job);

    this.logger.log(
      `job=${jobId} on branch ${sandbox.branch} @ ${sandbox.worktreePath}`,
    );

    const allSections = await this.store.tracksForJob(jobId);
    const tracks = allSections.slice(0, this.maxTracks);
    if (allSections.length > tracks.length) {
      this.logger.warn(
        `job=${jobId} has ${allSections.length} tracks > MAX_SECTIONS (${this.maxTracks}) — capping`,
      );
    }
    const pending = tracks.filter((s) => s.status !== 'done').length;
    if (pending > 0) {
      await this.post(
        route,
        `:rocket: Starting the build — ${pending} track(s) on \`${sandbox.branch}\`.`,
      );
    }

    // Per-job wall-clock backstop (issue #3) — checked at each track boundary; the per-step timeout
    // guards within a track. A breach aborts + relays (caught in drive()).
    const deadline = Date.now() + this.jobTimeoutMs;
    let handoff: string | null = null;
    for (const track of tracks) {
      if (track.status === 'done') {
        // Already built (a resume) — carry its persisted handoff to the next track, don't re-run.
        handoff = track.handoffOut ?? handoff;
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `job exceeded JOB_TIMEOUT_MS (${this.jobTimeoutMs}ms) before track "${track.brief}"`,
        );
      }
      handoff = await this.runTrack(
        job,
        record,
        route,
        repo,
        sandbox,
        track,
        handoff,
      );
    }

    await this.finishWithPr(job, record, route, repo, sandbox);
  }

  /**
   * Run ONE track, returning its handoff for the next. The per-track flow, in order:
   *   a. plan just-in-time (an engine plan turn → steps), or resume the locked plan;
   *   b. one Codex-style review → revise pass (clean single loop);
   *   c. the decision gate — classify notable decisions; an uncovered always-ask PARKS & awaits a human;
   *   d. post the plan for visibility (non-blocking);
   *   e. execute the steps (fresh session each) on the shared branch;
   *   f. per-track auto-fix over the track's diff;
   *   g. summarize the handoff for the next track.
   */
  private async runTrack(
    job: Job,
    record: DecisionRecord | null,
    route: JobRoute,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
    track: DriverTrack,
    handoffIn: string | null,
  ): Promise<string | null> {
    this.logger.log(`track ${track.ordinal} "${track.brief}" — planning`);
    await this.post(
      route,
      `:hammer_and_wrench: Planning track — *${track.brief}*`,
    );

    // a. PLAN (just-in-time) — or reuse the locked plan on a resume (steps already exist).
    const { steps, planned } = await this.planTrack(
      job,
      record,
      sandbox,
      track,
      handoffIn,
    );

    // b. REVIEW → revise once (only when freshly planned this run; a resumed lock skips it).
    //    (The locked step ROWS are the source of truth; review only reshapes a fresh plan's prose.)
    if (planned)
      await this.reviewPlan(record, track, handoffIn, planned, job.orgId);

    // The plan view the gate + visibility read — derived from the locked step rows (resume-safe).
    const planView = steps.map(asPlannedStep);

    // c. GATE — classify the plan's notable decisions; an uncovered always-ask parks & awaits a human.
    const classifications = await this.gateSection(
      job,
      route,
      record,
      track,
      planView,
    );

    // d. VISIBILITY — post the detailed plan into the thread (non-blocking; never gates).
    await this.visibility.postSectionPlan({
      channel: route.channel ?? '',
      ...(route.threadTs ? { threadTs: route.threadTs } : {}),
      ...(route.orgId ? { orgId: route.orgId } : {}),
      title: track.brief,
      plan: renderPlan(planView),
      decisions: classifications,
    });

    // e. EXECUTE — run each step as a fresh session on the shared feature branch.
    const sectionStartSha = await this.git
      .headSha(sandbox.worktreePath)
      .catch(() => undefined);
    await this.store.setTrackStatus(track.id, 'executing');
    const reports = await this.executeSteps(job, route, sandbox, track, record);

    // f. AUTO-FIX — fan-out review → fix over this track's diff.
    await this.store.setTrackStatus(track.id, 'auto_fixing');
    // Seed the review agents at `pending` so the navigator shows them queued; the stage's onLensStatus hook
    // transitions each as it runs, and the `finally` resolves any left pending/running (empty diff / throw).
    // `reviewAgentsForTrack` selects by track type; the domain `DriverTrack` doesn't carry it, and the
    // selection is a fixed set today, so call it argless (it ignores the arg).
    const reviewAgents = reviewAgentsForTrack().map((a) => ({
      ...a,
      status: 'pending' as const,
    }));
    await this.store.seedReviewAgents(track.id, reviewAgents);
    let lensesRun: string[] = [];
    try {
      const summary = await this.autofix.autofixTrack(
        {
          worktreePath: sandbox.worktreePath,
          sandboxKey: sandboxKey(sandbox),
          ...(sectionStartSha ? { gitRange: `${sectionStartSha}..HEAD` } : {}),
          intent: `${record?.overview ?? ''}\n\nSection: ${track.brief}`.trim(),
          label: track.brief,
          ...(sandbox.containerId
            ? {
                containerId: sandbox.containerId,
                ...(sandbox.execUser ? { execUser: sandbox.execUser } : {}),
              }
            : {}),
        },
        {
          onLensStatus: (lensId, status, findings) => {
            void this.store
              .setReviewAgentStatus(track.id, lensId, status, findings)
              .catch((err) =>
                this.logger.warn(
                  `review-agent status write failed (ignored): ${err}`,
                ),
              );
          },
        },
      );
      lensesRun = summary.lensesRun;
    } catch (err) {
      this.logger.warn(`track auto-fix failed (continuing): ${err}`);
    } finally {
      // Resolve any agent still pending/running: passed if its lens ran, else skipped. Never leave a stuck
      // pending/running agent once the track leaves auto_fixing.
      await this.store
        .finalizeReviewAgents(track.id, lensesRun)
        .catch((err) =>
          this.logger.warn(`review-agent finalize failed (ignored): ${err}`),
        );
    }
    // Passive milestone: auto-fix is a transient stage (track status is overwritten to `done` next), so
    // the net-state snapshot can't reconstruct that it ran — record it explicitly for the brain.
    await this.recordMilestone(
      job.id,
      `track:${track.id}:autofix`,
      `Auto-fix pass applied over the diff for track "${track.brief}".`,
    );

    // g. HANDOFF — summarize what this track produced for the next.
    const handoffOut = await this.summarizeHandoff(
      track,
      steps,
      reports,
      job.orgId,
    );
    await this.store.setTrackHandoffOut(track.id, handoffOut);
    await this.store.setTrackStatus(track.id, 'done');
    this.logger.log(`track ${track.ordinal} done`);
    await this.recordMilestone(
      job.id,
      `track:${track.id}:done`,
      `Track "${track.brief}" finished building.`,
    );
    await this.post(route, `:white_check_mark: Track done — *${track.brief}*`);
    return handoffOut;
  }

  /**
   * Produce (or resume) the track's locked steps. On a fresh run: an engine PLAN turn in the sandbox
   * grounded in the record + handoff → the planner LLM shapes the step list (fallback: a single step
   * whose brief is the track brief) → persisted. On a resume: the steps already exist, so reuse them
   * (returns `planned: undefined` to signal "no re-review needed").
   */
  private async planTrack(
    job: Job,
    record: DecisionRecord | null,
    sandbox: FeatureSandbox,
    track: DriverTrack,
    handoffIn: string | null,
  ): Promise<{ steps: Step[]; planned: PlannedStep[] | null }> {
    const existing = await this.store.stepsForTrack(track.id);
    if (existing.length > 0) {
      this.logger.log(
        `track ${track.ordinal}: ${existing.length} step(s) already locked — resuming`,
      );
      return { steps: existing, planned: null };
    }

    await this.store.setTrackStatus(track.id, 'planning');

    // An engine PLAN turn explores the worktree read-only; its plan text grounds the structured planner.
    // The full plan (plan.md, decisions, diagrams) lives in /context/specs — the plan turn reads it there.
    const planInput = {
      overview: record?.overview ?? '',
      decisions: record?.decisions ?? [],
      brief: track.brief,
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
        systemPrompt: TRACK_PLAN_SYSTEM,
        task: renderPlanTask(planInput),
        auth: await this.creds.engineAuth(job.orgId, 'claude'),
      },
      `track ${track.ordinal} plan turn`,
    ).catch((err) => {
      this.logger.warn(
        `track ${track.ordinal} plan turn failed (continuing): ${err}`,
      );
      return undefined;
    });

    const planned = (
      (await this.planner.planTrack(planInput).catch(() => undefined)) ??
      fallbackSteps(track.brief, planTurn?.planText ?? planTurn?.report)
    ).slice(0, this.maxStepsPerTrack);

    await this.store.setTrackPlan(track.id, renderPlan(planned), handoffIn);
    const steps = await this.store.lockSteps(track, planned);
    return { steps, planned };
  }

  /**
   * ONE Codex-style review → revise pass over the freshly-drafted plan (a clean single loop). When the
   * reviewer returns a revision it RE-PERSISTS the track's plan prose; the locked step rows stay the
   * execution source of truth (they're already gap-numbered + resumable). Best-effort — a failed review
   * leaves the original plan.
   */
  private async reviewPlan(
    record: DecisionRecord | null,
    track: DriverTrack,
    handoffIn: string | null,
    draft: PlannedStep[],
    orgId?: string,
  ): Promise<void> {
    await this.store.setTrackStatus(track.id, 'reviewing');
    const revised = await this.planner
      .reviewPlan({
        overview: record?.overview ?? '',
        decisions: record?.decisions ?? [],
        brief: track.brief,
        handoffIn,
        draft,
        ...(orgId ? { orgId } : {}),
      })
      .catch(() => undefined);
    if (revised)
      await this.store.setTrackPlan(track.id, renderPlan(revised), handoffIn);
  }

  /**
   * The DECISION GATE (W5). Mine the plan for notable decisions, classify each against the record. An
   * uncovered always-ask (`verdict === 'ask'`) PARKS the track: post the question in-thread and AWAIT
   * the human (the track suspends; resumable across restart). Covered/proceed continue. Returns the
   * non-ask classifications for the visibility post.
   */
  private async gateSection(
    job: Job,
    route: JobRoute,
    record: DecisionRecord | null,
    track: DriverTrack,
    planned: PlannedStep[],
  ): Promise<DecisionClassification[]> {
    const decisions =
      (await this.planner
        .extractDecisions({
          overview: record?.overview ?? '',
          decisions: record?.decisions ?? [],
          brief: track.brief,
          handoffIn: track.handoffIn,
          steps: planned,
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
        await this.store.setTrackStatus(track.id, 'awaiting_approval');
        this.logger.log(
          `track ${track.ordinal} parks on: ${proposed.description}`,
        );
        const handle = await this.park.ask(
          {
            channel: route.channel ?? '',
            ...(route.threadTs ? { threadTs: route.threadTs } : {}),
            ...(route.orgId ? { orgId: route.orgId } : {}),
          },
          parkQuestion(track.brief, proposed.description, c.reason),
        );
        // AWAIT the human — the track is suspended here, the process is not. Bounded by a wall-clock
        // budget so an unanswered park can't hang the build forever (the job/step timeouts don't cover a
        // park, which is between steps): on expiry it throws → the job fails + relays (issue #2/#3).
        const answer = await this.awaitAnswer(
          handle.answer,
          proposed.description,
        );
        this.logger.log(
          `track ${track.ordinal} unparked: ${answer.text.slice(0, 80)}`,
        );
        // Passive milestone: a guard parked on a decision and the human answered it — a transient moment
        // the net-state snapshot can't reconstruct (the track status moves on). Deduped by the decision.
        await this.recordMilestone(
          job.id,
          `track:${track.id}:gate:${proposed.description.slice(0, 60)}`,
          `While planning track "${track.brief}" a decision was raised and the operator answered it: ${proposed.description}`,
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
   * Execute a track's steps. A fresh-context step packs the ordered steps into execution BATCHES —
   * one engine session per batch (fewer sessions than one-per-step, but bounded by `maxStepsPerBatch`
   * so a batch can't swallow a large track and lose the small-context safety). The grouping is
   * assigned + PERSISTED (`batch_ordinal`) the first time the track runs and reused verbatim on
   * resume, so a restarted/halted batch re-groups identically (the resume cursor keys off the batch's
   * anchor-step `session_id`). Each batch: fresh session in the SAME worktree → verify → ONE commit →
   * mark every step in it done. Returns one report per batch.
   */
  private async executeSteps(
    job: Job,
    route: JobRoute,
    sandbox: FeatureSandbox,
    track: DriverTrack,
    record: DecisionRecord | null,
  ): Promise<string[]> {
    let steps = await this.store.stepsForTrack(track.id);

    // First execute of this track (a not-yet-run step is still un-batched): ask the planner how to
    // pack the ordered steps, run it through the deterministic guardrail, and PERSIST the grouping over
    // ALL steps. On resume every step already has a batch_ordinal → skip the LLM and re-group from the
    // stored values (stable membership — the in-flight engine session keeps the same task on restart).
    if (steps.some((p) => p.status !== 'done' && p.batchOrdinal == null)) {
      // ORCHESTRATE: the whole track is ONE batch (one orchestrator session that owns the fan-out) — no
      // LLM batcher, no per-step split. LEGACY: ask the planner how to pack the ordered steps, run it
      // through the deterministic guardrail. Either way the grouping is PERSISTED over ALL steps so a
      // resume re-groups identically.
      const groups = this.orchestrate
        ? [steps.map((_, i) => i)]
        : this.groupSteps(
            steps,
            await this.planner
              .batchSteps({
                steps: steps.map(asPlannedStep),
                overview: record?.overview ?? '',
                brief: track.brief,
                orgId: job.orgId,
              })
              .catch(() => undefined),
          );
      const assignments: Array<[string, number]> = [];
      groups.forEach((g, bi) =>
        g.forEach((idx) => assignments.push([steps[idx].id, bi + 1])),
      );
      await this.store.setBatchOrdinals(assignments);
      this.logger.log(
        `track ${track.ordinal}: ${steps.length} step(s) packed into ${groups.length} batch(es)` +
          (this.orchestrate ? ' (orchestrate)' : ''),
      );
      steps = await this.store.stepsForTrack(track.id);
    }

    // Group the NOT-done steps by their persisted batch_ordinal (done steps fast-forward on resume).
    const byBatch = new Map<number, Step[]>();
    for (const p of steps) {
      if (p.status === 'done') {
        this.logger.log(`step ${p.ordinal} already done — fast-forward`);
        continue;
      }
      const key = p.batchOrdinal ?? p.ordinal;
      const list = byBatch.get(key) ?? [];
      list.push(p);
      byBatch.set(key, list);
    }

    const reports: string[] = [];
    for (const key of [...byBatch.keys()].sort((a, b) => a - b)) {
      const batch = byBatch.get(key)!;
      // Atomic-resume fast-forward (#6): if the batch's anchor already carries a commit_sha, the batch
      // committed before a crash interrupted the done-status writes — re-running would redo work against
      // an already-committed tree. Mark the steps done and skip the session instead.
      if (batch[0].commitSha) {
        this.logger.log(
          `batch [${batch.map((p) => p.ordinal).join(',')}] already committed — fast-forward`,
        );
        for (const p of batch)
          await this.store.setStepState(p.id, 'done', 'done');
        continue;
      }
      reports.push(
        await this.runBatch(job, route, sandbox, track, record, batch),
      );
    }
    return reports;
  }

  /**
   * Validate the planner's step partition and turn it into consecutive index groups, then CAP each
   * group at `maxStepsPerBatch`. An invalid/absent partition falls back to one-step-per-group (the
   * safe default — identical to the pre-batching behavior). The result always covers [0, n) in order.
   */
  private groupSteps(
    steps: Step[],
    llmGroups: number[][] | undefined,
  ): number[][] {
    const n = steps.length;
    const base = isConsecutivePartition(llmGroups, n)
      ? llmGroups!
      : steps.map((_, i) => [i]);
    const cap = this.maxStepsPerBatch;
    const out: number[][] = [];
    for (const g of base) {
      for (let i = 0; i < g.length; i += cap) out.push(g.slice(i, i + cap));
    }
    return out;
  }

  /**
   * Run ONE batch (1+ ordered steps) as a SINGLE fresh execute turn → verify → ONE commit → mark every
   * step in it done. The batch's FIRST step is the resume anchor (its id carries the engine session +
   * the cursor the runner resumes from). A per-batch wall-clock timeout aborts a runaway turn; the
   * optional verify command gates the commit so broken output never advances the cursor (issues #3, #4).
   */
  private async runBatch(
    job: Job,
    route: JobRoute,
    sandbox: FeatureSandbox,
    track: DriverTrack,
    record: DecisionRecord | null,
    steps: Step[],
  ): Promise<string> {
    const anchor = steps[0];
    const label =
      steps.length === 1
        ? (anchor.title ?? anchor.brief ?? `step ${anchor.ordinal}`)
        : `${steps.length} steps (${steps.map((p) => p.title ?? `#${p.ordinal}`).join(', ')})`;
    this.logger.log(
      `track ${track.ordinal} batch [${steps.map((p) => p.ordinal).join(',')}] — building`,
    );
    for (const p of steps)
      await this.store.setStepState(p.id, 'build', 'building');
    await this.post(route, `:gear: ${track.brief} — building: ${label}`);

    // The build turn rides the shared transcript spine on its own `phase:<anchorStepId>` lane, tagging every
    // durable block with `phaseId` so the web peels it into the step sub-page (like a subagent). A batch is
    // ONE turn ⇒ ONE transcript tagged with the ANCHOR step id; every step in the batch maps to it. The
    // channel falls back to the repo id so durable persistence works even if the route has no live channel.
    const channel = route.channel ?? job.repoId;
    const lane = `phase:${anchor.id}`;
    const batchOrdinal = anchor.batchOrdinal ?? null;
    // The instruction the engine receives — the build turn's "first message". Computed once here so it
    // can both kick off the turn AND be persisted on the anchor row (the web renders it like a subagent's
    // Task prompt, so the step transcript shows what was asked, not just the engine's reply).
    const task = renderBatchTask(record, track, steps, this.orchestrate);
    // Synthetic anchor row at batch START — the in-conversation `BuildStepCard` latches onto this (a phase
    // has no spawning Task tool block), and it sorts the card at the batch's chronological position.
    await this.blockSink
      .appendBlock(job.id, {
        kind: 'build_anchor',
        text: `${track.brief} — ${label}`,
        meta: {
          phaseId: anchor.id,
          ...(batchOrdinal != null ? { batchOrdinal } : {}),
          batchStepIds: steps.map((p) => p.id),
          label,
          prompt: task,
        },
      })
      .catch((err) =>
        this.logger.warn(
          `build_anchor append failed for thread=${job.id}: ${err}`,
        ),
      );
    const harness = this.turnHarness.create({
      threadId: job.id,
      channel,
      lane,
      metaTag: {
        phaseId: anchor.id,
        ...(batchOrdinal != null ? { batchOrdinal } : {}),
      },
    });

    // Circuit breaker (#3): bound the engine turn. On breach it both signals the SDK to abort AND hard-
    // rejects so the DRIVER gives up even if the SDK can't interrupt a stuck subprocess. Events attribute
    // to the anchor step (a batch is one turn; minor observability coarsening for the step transcript).
    let result: Awaited<ReturnType<TurnRunnerService['runTurn']>>;
    try {
      result = await this.runTurnBounded(
        {
          jobId: job.id,
          stepId: anchor.id,
          sandbox,
          engine: 'claude',
          mode: 'execute',
          systemPrompt: this.orchestrate
            ? ORCHESTRATE_EXECUTE_SYSTEM
            : steps.length === 1
              ? STEP_EXECUTE_SYSTEM
              : BATCH_EXECUTE_SYSTEM,
          task,
          auth: await this.creds.engineAuth(job.orgId, 'claude'),
          richStream: true, // full transcript (thinking + tool calls/results + subagent forwarding)
          onEvent: (e) => {
            if (e.kind === 'tool') this.logger.debug(`batch tool: ${e.name}`);
            harness.onEvent(e);
          },
        },
        `batch "${label}"`,
      );
    } catch (err) {
      // Timeout / auth / engine error — persist whatever partials streamed and end the lane exactly once.
      await harness.abort();
      throw err;
    }
    // Engine turn done — persist the transcript (+ fallback) and end the live lane.
    await harness.finish(result.report);

    // Surface any off-spec deviations the engine flagged in its report (#7) — never silent.
    const deviations = extractDeviations(result.report);
    if (deviations.length) {
      await this.post(
        route,
        `:warning: Off-spec changes in *${label}*:\n${deviations.map((d) => `• ${d}`).join('\n')}`,
      );
    }

    // Verification is the ORCHESTRATOR'S job, in-turn: ORCHESTRATE_EXECUTE_SYSTEM mandates it discover and
    // run the repo's OWN typecheck/build/test (and fix failures) before finishing, and report rather than
    // claim success on a guess. The host does NOT reach into the sandbox to run commands.

    // ONE commit for the whole batch onto the shared feature branch.
    const sha = await this.git.commitAll(
      sandbox.worktreePath,
      `${track.brief} — ${steps.map((p) => p.title ?? `step ${p.ordinal}`).join(' + ')}`,
    );
    this.logger.log(`batch committed ${sha ? sha.slice(0, 8) : '(nothing)'}`);

    // Atomic-resume marker (#6): stamp the commit on the ANCHOR step FIRST, then flip the steps to done.
    // A crash between the two ⇒ resume sees the commit_sha and fast-forwards (executeSteps) instead of
    // re-running the whole track against an already-committed tree. Empty sha (nothing changed) still
    // marks complete so the batch never re-runs. `NOTHING` is the sentinel for an empty commit.
    await this.store.setStepCommit(anchor.id, sha || NOTHING_COMMITTED);
    for (const p of steps) await this.store.setStepState(p.id, 'done', 'done');
    return result.report;
  }

  /**
   * PR-TAIL. After all tracks: one auto-fix pass over the WHOLE accumulated diff, push the branch,
   * open ONE PR per feature (idempotent — a re-run finds the existing PR), record the url, mark the job
   * done, and post "PR ready" in-thread. Sections stacked on one branch ⇒ one PR.
   */
  private async finishWithPr(
    job: Job,
    record: DecisionRecord | null,
    route: JobRoute,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
  ): Promise<void> {
    this.logger.log(
      `job=${job.id} all tracks done — promoting decisions + shipping`,
    );
    // Promote durable decisions into `.atlas/decisions/` BEFORE shipping, so they ride the build commit.
    // Resumable + idempotent: a re-entered `finishWithPr` (driver resume) just re-promotes/overwrites.
    const promoted = await this.promoteLedger(job);
    await this.ship.ship({
      job,
      record,
      repo,
      sandbox,
      // Sweep the freshly-written ledger files into one commit (a no-op when nothing was promoted).
      commitMessage: LEDGER_COMMIT_MESSAGE,
      notify: (m) => this.post(route, m),
    });
    // Mark COMPLETE only when the promotion turn actually ran — a failed promotion stays non-complete so
    // the boot backstop retries it onto the (now open) PR. Never blocks the PR on the ledger.
    if (promoted) await this.store.markLedgerPromoted(job.id);
  }

  /**
   * Run the SERVER-INITIATED ledger promotion turn (full path). Claims the spine (`running`), then asks
   * the brain — lazily, to avoid the brain⇄driver module cycle — to distill THIS thread's durable
   * decisions into the worktree's `.atlas/decisions/`. Best-effort: a failure marks the spine `failed`
   * (boot backstop retries) and returns false so the PR ships regardless.
   */
  private async promoteLedger(job: Job): Promise<boolean> {
    try {
      await this.store.claimLedgerPromotion(job.id);
      const brain = await this.brain();
      await brain.promoteDurableDecisionsAtShip(job.id, job.orgId, job.repoId);
      return true;
    } catch (err) {
      this.logger.warn(
        `ledger promotion turn failed for ${job.id} (shipping anyway): ${err}`,
      );
      await this.store
        .setLedgerPromotionStatus(job.id, 'failed')
        .catch(() => undefined);
      return false;
    }
  }

  /** Lazily resolve the brain — a dynamic import keeps the brain⇄driver dependency out of module load. */
  private async brain(): Promise<LedgerPromoter> {
    const { AgentSessionManager } =
      await import('../brain/agent-session-manager.service.js');
    return this.moduleRef.get(AgentSessionManager, { strict: false });
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
   * Every thread is lazily provisioned by the brain (`ensureProvisioned`) on its first chat turn, long
   * before any build runs, so `ensureContainer` always finds the row by the time the driver gets here —
   * a null is a real bug (a build dispatched against an unprovisioned/closed thread), so we throw.
   */
  private async ensureSandbox(job: Job): Promise<FeatureSandbox> {
    const ensured = await this.threadLifecycle.ensureContainer(
      job.id,
      job.orgId,
    );
    if (!ensured) {
      throw new Error(
        `job=${job.id}: thread has no sandbox (unprovisioned or closed) — cannot build`,
      );
    }
    const branch = ensured.sandbox.branch; // the thread's feature branch is the source of truth
    if (job.featureBranch !== branch)
      await this.store.setFeatureBranch(job.id, branch);
    this.logger.log(
      `job=${job.id} using thread sandbox on ${branch}${ensured.wasReset ? ' (cold re-attach)' : ''}`,
    );
    return ensured.sandbox;
  }

  /** Summarize a track's handoff (LLM, with a terse rule-based fallback). */
  private async summarizeHandoff(
    track: DriverTrack,
    steps: Step[],
    reports: string[],
    orgId?: string,
  ): Promise<string> {
    const planned = steps.map(asPlannedStep);
    const llm = await this.planner
      .handoff({
        brief: track.brief,
        steps: planned,
        reports,
        ...(orgId ? { orgId } : {}),
      })
      .catch(() => undefined);
    if (llm) return llm;
    const built = steps.map((p) => p.title ?? p.brief).join('; ');
    return `Track "${track.brief}" complete. Built: ${built || '(see commits)'}.`;
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
}

// ── pure render helpers ──────────────────────────────────────────────────────────────────────────

const TRACK_PLAN_SYSTEM =
  'You are Atlas planning ONE track of an approved feature. Explore the codebase read-only and produce ' +
  'a concrete phased plan for this track, respecting the locked decision record. Do not write any files. ' +
  'DOCS BEFORE GREP: if the repo has orienting docs (CLAUDE.md, AGENTS.md, README.md, ARCHITECTURE.md, ' +
  'CONTRIBUTING.md, docs/), read those FIRST to skip a grep-storm rediscovering where things live and how ' +
  'this codebase does things, then Grep/Read to confirm the exact files you will touch. Docs may be stale — ' +
  'the CODE is authoritative; where they disagree, trust the code. ' +
  "The plan MUST end with VERIFICATION: a final step (or explicit step) that runs the repo's OWN " +
  'typecheck/build/tests and confirms the change works. For a DELETION, an early step must PROVE the code ' +
  'is truly unused — search for every intra-file and cross-file reference (and dynamic/string usages) — ' +
  'before anything is removed. Never plan to claim done without verifying.';

// Shared tail for the execute prompts: the read-only/advisory subagents a worker can delegate to via
// Task to stay focused and keep its context clean. `test` runs the verification and reports a diagnosis
// (not raw logs); the rest only read and report. None of them edit files — only the worker does.
const WORKER_SUBAGENTS_NOTE =
  ' To stay focused and keep your context clean, you can delegate to read-only subagents via the Task ' +
  "tool: `explore` (trace how the code works, incl. this repo's own docs), `docs` (look up EXTERNAL " +
  'library/framework/API documentation), `review` ' +
  '(a second pass on your diff for bugs + convention drift before you finish), `debug` (root-cause a ' +
  'failure to its fix site), and `test` (run the repo verification and get back a diagnosis instead of ' +
  'thousands of lines of raw output). They report back; only you change files.';

const STEP_EXECUTE_SYSTEM =
  'You are Atlas executing ONE step of an approved plan in a feature worktree. Implement exactly this ' +
  "step's brief, respecting the locked decisions. Make focused, working changes; do not exceed the step scope. " +
  'If you make ANY change not explicitly called for by this brief, or you depart from a locked decision ' +
  '(e.g. adding a file/dependency/config nobody asked for), you MUST flag it: put each such change on its ' +
  "own line in your final report starting with 'DEVIATION:' and a one-line why. Off-spec work is never silent. " +
  "VERIFY before you finish: discover and run the repository's OWN typecheck/build/test tooling and make " +
  'sure your change compiles and the relevant tests pass — do NOT claim the work is done on the basis of a ' +
  'guess. If this step REMOVES code, first prove it is genuinely unreferenced (grep for every importer AND ' +
  'intra-file caller, plus dynamic/string references) and that the build still passes after removal; if you ' +
  'cannot prove it is unused, do NOT delete it — report the uncertainty instead. If verification fails and ' +
  'you cannot fix it within scope, say so explicitly rather than reporting success.' +
  WORKER_SUBAGENTS_NOTE;

const BATCH_EXECUTE_SYSTEM =
  'You are Atlas executing several ORDERED steps of an approved plan in a feature worktree, in ONE ' +
  'session. Implement each step IN ORDER, exactly to its brief, respecting the locked decisions; finish ' +
  "one step before starting the next and do not exceed the steps' scope. " +
  'If you make ANY change not explicitly called for by these briefs, or you depart from a locked decision ' +
  '(e.g. adding a file/dependency/config nobody asked for), you MUST flag it: put each such change on its ' +
  "own line in your final report starting with 'DEVIATION:' and a one-line why. Off-spec work is never silent. " +
  "VERIFY before you finish: discover and run the repository's OWN typecheck/build/test tooling and make " +
  'sure the changes compile and the relevant tests pass — do NOT claim the work is done on the basis of a ' +
  'guess. If a step REMOVES code, first prove it is genuinely unreferenced (grep for every importer AND ' +
  'intra-file caller, plus dynamic/string references) and that the build still passes after removal; if you ' +
  'cannot prove it is unused, do NOT delete it — report the uncertainty instead. If verification fails and ' +
  'you cannot fix it within scope, say so explicitly rather than reporting success.' +
  WORKER_SUBAGENTS_NOTE;

/** Sentinel `commit_sha` for a batch that completed but changed nothing (empty commit) — distinguishes
 *  "done, no diff" from "never committed" (null) so a resume fast-forwards instead of re-running. */
const NOTHING_COMMITTED = '(nothing)';

// Orchestrator note — the LIVE task list. The orchestrator maintains its decomposition via the task tools
// so the operator can watch progress in the navigator (which derives the per-track checklist from these
// calls). Used by ORCHESTRATE_EXECUTE_SYSTEM.
const ORCHESTRATOR_TASKLIST_NOTE =
  ' Maintain a LIVE TASK LIST as your visible decomposition: at kickoff `TaskCreate` one task per unit of ' +
  'work (seed from the steps below, splitting/merging as the real work demands), `TaskUpdate` it to ' +
  "`in_progress` when you start it and `completed` when it's done, and `TaskUpdate` with `status:'deleted'` " +
  'to drop a task the plan abandons. Keep it current as you go — it is how the operator follows the build.';

// Orchestrator note — adds the WRITER subagents to the read-only set. Used by ORCHESTRATE_EXECUTE_SYSTEM.
const ORCHESTRATOR_SUBAGENTS_NOTE =
  ' You have subagents (Task tool). WRITERS that change files: `implement` (Opus, for code needing ' +
  'judgment) and `implement-fast` (Sonnet, for mechanical/fully-specified slices) — give each a ' +
  'concrete slice and the EXACT files it may touch; it edits and returns a tight summary. Run writers ' +
  'ONE AT A TIME (they share one worktree — concurrent writers corrupt it). Read-only helpers: ' +
  '`explore` (trace the code/own docs), `docs` (external library docs), `review` (a second pass on a ' +
  'diff), `debug` (root-cause a failure), `test` (run the repo verification → diagnosis, not raw logs).';

// The PER-TRACK ORCHESTRATOR system prompt (orchestrate mode): one Opus session owns the whole track and
// fans the implementation out to writer subagents, integrating + verifying as it goes.
const ORCHESTRATE_EXECUTE_SYSTEM =
  'You are Atlas, the ORCHESTRATOR for ONE track of an approved plan, working in a feature worktree. The ' +
  'steps below are your plan and your suggested decomposition — YOU own the fan-out. For each step (or a ' +
  'cluster of tightly-related steps), DELEGATE the actual file changes to a writer subagent via the Task ' +
  'tool — `implement` (Opus) for code that needs judgment, `implement-fast` (Sonnet) for mechanical, ' +
  'fully-specified work — telling it the exact files it may touch. You MAY make small edits yourself ' +
  'directly when spawning a subagent would be overkill. Steps are ORDERED and build on each other: ' +
  'delegate them IN ORDER and run writers ONE AT A TIME (they share this worktree; concurrent writers ' +
  'corrupt it). After each writer returns, sanity-check its work before moving on. When every step is ' +
  "implemented, VERIFY: discover and run the repository's OWN typecheck/build/test tooling and FIX any " +
  'failures (use `debug`/`test` subagents) — do NOT claim done on a guess. If a step REMOVES code, prove ' +
  'it is genuinely unreferenced first. Flag ANY change not called for by the plan, or any departure from a ' +
  "locked decision, on its own line starting with 'DEVIATION:' and a one-line why — off-spec work is " +
  'never silent. If verification fails and you cannot fix it within scope, say so explicitly.' +
  ORCHESTRATOR_TASKLIST_NOTE +
  ORCHESTRATOR_SUBAGENTS_NOTE;

/** A locked step row → the `PlannedStep` view the gate/visibility/render read (title null → brief). */
function asPlannedStep(step: Step): PlannedStep {
  return { title: step.title ?? step.brief, brief: step.brief };
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
    ? `\n\nPrior track handoff:\n${input.handoffIn}`
    : '';
  return [
    `Feature overview:\n${input.overview}`,
    `\nLocked decisions (respect these):\n${decisions}`,
    `\nPlan THIS track:\n${input.brief}${handoff}`,
    '\nYour grounding is the READ-ONLY directory `/context/specs/` (a folder, not a file): read its' +
      " `plan.md` index, this track's `sections/NN-*.md` file, and `data-model.md` before planning steps.",
    '\nProduce an ordered list of steps. Do not write files.',
  ].join('\n');
}

/** Render the execute task for a BATCH of 1+ ordered steps (the unit a single fresh session runs).
 *  In orchestrate mode the batch is the WHOLE track and the steps are the orchestrator's fan-out menu. */
function renderBatchTask(
  record: DecisionRecord | null,
  track: DriverTrack,
  steps: Step[],
  orchestrate = false,
): string {
  const decisions = record?.decisions.length
    ? record.decisions
        .map((d) => `- [${d.decisionClass}] ${d.title}: ${d.ruling}`)
        .join('\n')
    : '(none)';
  const blocks = steps
    .map(
      (p, i) => `### Step ${i + 1}: ${p.title ?? `#${p.ordinal}`}\n${p.brief}`,
    )
    .join('\n\n');
  const intro = orchestrate
    ? `Implement this track. The ${steps.length} step(s) below are your plan + suggested decomposition` +
      ' — delegate them IN ORDER to writer subagents (one at a time), making small edits yourself where' +
      ' a subagent would be overkill, then verify the whole track:'
    : steps.length === 1
      ? 'Implement this step:'
      : `Implement these ${steps.length} steps IN ORDER (each builds on the previous):`;
  return [
    `Feature overview:\n${record?.overview ?? ''}`,
    `\nLocked decisions (respect these):\n${decisions}`,
    `\nTrack: ${track.brief}`,
    `\nYour grounding is the READ-ONLY directory \`/context/specs/\` (a folder): read its \`plan.md\`` +
      ` index, this track's \`sections/NN-*.md\` file, and \`data-model.md\`. Make ALL code changes under` +
      ` \`/workspace\` — never edit anything in \`/context\`.`,
    `\n${intro}\n\n${blocks}`,
  ].join('\n');
}

/** True iff `groups` flattens to exactly [0,1,…,n-1] in order with no empty group — i.e. a valid
 *  consecutive, covering, non-overlapping partition of n ordered steps (the batcher's contract). */
function isConsecutivePartition(
  groups: number[][] | undefined,
  n: number,
): boolean {
  if (!groups || !groups.length || groups.some((g) => g.length === 0))
    return false;
  const flat = groups.flat();
  if (flat.length !== n) return false;
  for (let i = 0; i < n; i++) if (flat[i] !== i) return false;
  return true;
}

function fallbackSteps(
  brief: string,
  planText: string | undefined,
): PlannedStep[] {
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

/** Pull the engine's flagged off-spec deviations out of a step report ('DEVIATION:' lines, #7). */
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
