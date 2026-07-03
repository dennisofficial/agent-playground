import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { PlanVisibilityService } from '../decision-gate';
import { AutoFixStage, reviewAgentsForThread } from '../autofix';
import type { DecisionRecord, Step, Job, SessionEngine, ThreadStatus } from '../domain';
import {
  EngineAuthError,
  isEngineDetachedError,
  UNRESUMABLE_SESSION_MARKER,
  type ToolBridgeOptions,
} from '../engine';
import { GithubPrService, LocalGitService, type FeatureSandbox } from '../git';
import {
  CHAT_SURFACE,
  type ChatSurface,
  BLOCK_SINK,
  type BlockSink,
  TurnHarnessFactory,
  laneFor,
} from '../surface';
import { CredentialResolver } from '../onboarding';
import { LeaderElectionService } from '../cluster';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox';
// Direct path (not the '../sandbox' barrel, which doesn't re-export it) — mirrors the brain's import.
import { TurnRegistry } from '../sandbox/turn-registry.service';
import type { ActiveTurnEntity, ThreadTerminalRecord } from '../persistence/entities';
import type { JobDispatcher } from '../brain';
import { TurnRunnerService } from '../runner';
import { Agent, LEDGER_COMMIT_MESSAGE, renderAgentPrompt } from '../prompt-kit';
import { BuildShipService } from './build-ship.service';
import { PipelineAwarenessStore } from './pipeline-awareness.store';
import {
  DriverStoreService,
  type DriverThread,
  type JobRoute,
} from './driver-store.service';
import { renderPlan, type PlannedStep } from './render-plan';
import {
  DRIVER_REPO,
  type DriverRepoResolver,
  type ResolvedRepo,
} from './repo-resolver';
import { JobLifecycleService } from './job-lifecycle.service';

/**
 * W4 — the THREAD DRIVER. The legible, deterministic, resumable replacement for v1's implicit
 * status-FSM. Read it top-to-bottom: `dispatch` kicks the build off async, `runJob` walks the threads
 * in order, `runThread` does lock-step → visibility → execute → auto-fix → handoff, `executeSteps`
 * runs the thread as ONE orchestrator session on the shared feature branch, and `finalizeBuild` runs the
 * terminal ship (Atlas opens ONE PR in-sandbox). `resume` re-enters the SAME straight functions on boot, fast-
 * forwarding completed work — no signal racing, no status-enum re-derivation.
 *
 * There is no build-time LLM planning: the brain already authored the plan into `/context/specs` and got
 * operator approval BEFORE dispatch, so the driver locks ONE step per thread (the resume/commit anchor)
 * and hands the whole thread to a single orchestrator turn that decomposes the work live. The one
 * mid-build human seam is `request_operator_input` (the orchestrator pauses to ask when a decision the
 * locked plan does not cover blocks it). Explicit `status`/`step` rows exist ONLY for resumability — the
 * live path is a straight function. Bound as the real `JOB_DISPATCHER` (overriding W3's logging no-op).
 */
/**
 * A thread's resolved terminal outcome (ADR 0004). `done` is the only outcome that advances the build to
 * the next thread + ship; every other outcome HALTS the drive loop (no PR on an unfinished build) and is
 * surfaced. `incomplete` = the turn ended without asserting completion (no `complete_thread`) — the key fix
 * for "clean exit misread as done." `blocked` is written by Phase-3 `block_thread`.
 */
type ThreadOutcome = 'done' | 'blocked' | 'failed' | 'incomplete';

/** A batch turn's result: the engine report plus the terminal outcome the driver resolved for it. */
interface BatchResult {
  outcome: ThreadOutcome;
  report: string;
}

/** A thread's result: its outcome plus the handoff note for the next thread (null unless `done`). */
interface ThreadResult {
  outcome: ThreadOutcome;
  handoff: string | null;
}

/**
 * Whether a thrown drive-loop error is a TRANSIENT infra blip (sandbox/network/engine hiccup) that a bounded
 * silent retry should paper over — NOT a real failure to surface to the operator (ADR 0004, failure #1: a
 * plain retry fixed the last two "errors"). A build FAILURE never throws here — the orchestrator reports it
 * via its `terminal_record`/report — so a raw exception at the driver level is almost always infra. The few
 * exceptions that are genuinely terminal (auth → paused; detached → boot re-attach; unresumable session; a
 * runaway PHASE_TIMEOUT that must not re-run for another full timeout) are excluded so drive() handles them.
 */
function isTransientDriveError(err: unknown): boolean {
  if (err instanceof EngineAuthError) return false; // → paused
  if (isEngineDetachedError(err)) return false; // → leave running for boot re-attach
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes(UNRESUMABLE_SESSION_MARKER.toLowerCase())) return false; // session gone — retry futile
  if (msg.includes('phase_timeout_ms')) return false; // a runaway turn stays terminal (ADR 0001 §52)
  // A SMALL allowlist of known infra shapes (sandbox/container/network/redis/stream blips). Deliberately
  // conservative: an UNRECOGNISED error is NOT retried (it may be a real bug), so we never mask a genuine
  // failure as transient — we only paper over the connection/sandbox hiccups that produced the phantom
  // "errors" a plain retry cleared (ADR 0004, failure #1).
  return TRANSIENT_ERROR_RE.test(msg);
}

/** Infra-blip signatures a bounded silent retry papers over (see {@link isTransientDriveError}). */
const TRANSIENT_ERROR_RE =
  /econnreset|econnrefused|etimedout|epipe|socket hang up|connection reset|connection refused|network error|no such container|container .*(not running|is not running|gone)|exec failed|failed to (start|create) (the )?container|redis|stream .*(closed|reset)|xread|503|502|temporarily unavailable/;

/** The narrow brain surface the driver needs at ship — resolved lazily to avoid the module cycle. */
interface LedgerPromoter {
  promoteDurableDecisionsAtShip(
    jobId: string,
    orgId: string,
    repoId: string,
  ): Promise<void>;
}

@Injectable()
export class ThreadDriver implements JobDispatcher {
  private readonly logger = new Logger(ThreadDriver.name);
  /** Jobs being driven right now — guards against a double dispatch / a resume racing a live drive. */
  private readonly active = new Set<string>();

  constructor(
    private readonly store: DriverStoreService,
    @Inject(DRIVER_REPO) private readonly repos: DriverRepoResolver,
    private readonly git: LocalGitService,
    private readonly pr: GithubPrService,
    private readonly turn: TurnRunnerService,
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
    // The durable registry of in-flight Redis-transport turns — lets a build batch RE-ATTACH its still-live
    // engine stream after a restart (like the brain) instead of re-running. @Global via SandboxModule.
    private readonly turnRegistry: TurnRegistry,
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
    jobId: string,
    id: string,
    text: string,
  ): Promise<void> {
    await this.awareness
      .appendMarker(jobId, { id, text, at: new Date().toISOString() })
      .catch((err) =>
        this.logger.debug(`milestone append failed (continuing): ${err}`),
      );
  }

  /** Sanity ceiling on a job's threads — a malformed plan can't drive an unbounded build. */
  private get maxThreads(): number {
    return this.env.get('MAX_SECTIONS') ?? 12;
  }

  /** Per-thread wall-clock budget for the orchestrator turn — a single engine turn that runs away is
   *  aborted + relayed. One turn spans the WHOLE thread + its writer fan-out, so the budget is large.
   *  Default 60m. A `request_operator_input` pause suspends this clock (see `runTurnBounded`). */
  private get phaseTimeoutMs(): number {
    const raw = Number(this.env.get('PHASE_TIMEOUT_MS'));
    if (Number.isFinite(raw) && raw > 0) return raw;
    return 60 * 60_000;
  }

  /** Base backoff between transient-error drive retries (ADR 0004). Grows linearly per attempt. Default 2s;
   *  the tests set it near-zero. */
  private get transientRetryMs(): number {
    const raw = Number(this.env.get('DRIVER_TRANSIENT_RETRY_MS'));
    if (Number.isFinite(raw) && raw >= 0) return raw;
    return 2_000;
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
   * straight drive: `runJob` fast-forwards threads/steps already `done` and continues at the first
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
   * to `running` and re-enter the SAME resumable drive — `runJob` fast-forwards `done` threads/steps and
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
      await this.runJobWithTransientRetry(jobId);
    } catch (err) {
      if (isEngineDetachedError(err)) {
        // The host lost its tail to a still-running turn (see EngineDetachedError) — the engine is alive and
        // writing its durable streams. Leave the job `running` so the next boot re-attaches; never `failed`,
        // and never re-drive here (that would re-kick a live engine's session).
        this.logger.warn(
          `job=${jobId} left running — engine detached (lost tail); boot will re-attach`,
        );
        return;
      }
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

  /**
   * Run the job, silently retrying a bounded number of times on TRANSIENT infra errors (ADR 0004, failure
   * #1). `runJob` is resumable — a re-entry fast-forwards completed threads/batches and resumes the
   * interrupted turn — so a retry is safe. Non-transient errors and an exhausted budget propagate to
   * `drive()`'s classification (paused / detached / failed). Skipped entirely while draining (a shutdown is
   * not a retryable error — drive() leaves the job running for boot-resume).
   */
  private async runJobWithTransientRetry(jobId: string): Promise<void> {
    const maxRetries = 2;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.runJob(jobId);
        return;
      } catch (err) {
        if (
          this.election.isDraining() ||
          attempt >= maxRetries ||
          !isTransientDriveError(err)
        ) {
          throw err;
        }
        const backoffMs = this.transientRetryMs * (attempt + 1);
        this.logger.warn(
          `job=${jobId} transient drive error (attempt ${attempt + 1}/${maxRetries}) — retrying in ${backoffMs}ms: ${
            err instanceof Error ? err.message : err
          }`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  /** Post a "paused on a credential error" notice so the human fixes creds + pings resume. Durable: writes
   *  DIRECTLY to `messages` via the block sink FIRST (independent of route resolution / the live SSE post,
   *  which is only best-effort) — see {@link relayFailure} for why. */
  private async relayPaused(jobId: string, err: unknown): Promise<void> {
    const text = `:lock: Build paused — a credential/auth error halted the engine (${shortReason(err)}).\n_Your work + the engine session are saved; fix the credentials and ping resume (or reply here) to continue the SAME session._`;
    await this.blockSink
      .appendBlock(jobId, {
        kind: 'chat',
        text,
        meta: { source: 'system_operator', severity: 'warning' },
      })
      .catch((e) =>
        this.logger.error(`could not durably record pause for job=${jobId}: ${e}`),
      );
    try {
      const job = await this.store.loadJob(jobId);
      const route = await this.store.route(job);
      await this.post(route, text);
    } catch (e) {
      this.logger.warn(`could not live-relay pause for job=${jobId}: ${e}`);
    }
  }

  /**
   * Post a clear "build failed — why" into the job's thread. Durable: writes DIRECTLY to `messages` via
   * the block sink FIRST — `this.post()` only pushes to the in-memory SSE outbox (see `WebSurface.post`),
   * it never persists a row, so a bare `post()`-only relay is invisible to any client that reconnects or
   * wasn't connected at the moment of failure (the `/messages` REST history reads the DB, not the outbox).
   * That gap is what let job 6e467abe-3a79-4be2-b9a8-951a89ab0c84 flip to `failed` with zero trace in
   * `messages` — `post()`/`route()` themselves didn't even need to throw. The live `post()` below is kept
   * best-effort on top, purely for the immediate SSE nudge.
   */
  private async relayFailure(jobId: string, err: unknown): Promise<void> {
    const text = `:x: Build failed — ${shortReason(err)}\n_The job is marked failed; reply in this thread to retry or adjust the plan._`;
    await this.blockSink
      .appendBlock(jobId, {
        kind: 'chat',
        text,
        meta: { source: 'system_operator', severity: 'error' },
      })
      .catch((e) =>
        this.logger.error(`could not durably record failure for job=${jobId}: ${e}`),
      );
    try {
      const job = await this.store.loadJob(jobId);
      const route = await this.store.route(job);
      await this.post(route, text);
    } catch (e) {
      this.logger.warn(`could not live-relay failure for job=${jobId}: ${e}`);
    }
  }

  /**
   * Walk a job's threads in order. The whole build flow lives here, readable top-to-bottom:
   *   load the job + record + route → ensure the feature sandbox → for each thread: runThread (which
   *   carries the prior handoff forward) → after all threads: finalizeBuild (ship — Atlas opens the PR in-sandbox).
   * Fast-forwards `done` threads (resume): a finished thread just yields its persisted handoff_out.
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

    const allSections = await this.store.threadsForJob(jobId);
    // Cap the FEATURE threads at MAX_SECTIONS, but NEVER drop the appended master-review thread (it rides on
    // top of the feature threads and must always run last) — partition it out, cap the rest, re-append.
    const featureSections = allSections.filter((s) => !s.isMasterReview);
    const reviewSection = allSections.find((s) => s.isMasterReview);
    const cappedFeatures = featureSections.slice(0, this.maxThreads);
    const threads = reviewSection ? [...cappedFeatures, reviewSection] : cappedFeatures;
    if (featureSections.length > cappedFeatures.length) {
      this.logger.warn(
        `job=${jobId} has ${featureSections.length} threads > MAX_SECTIONS (${this.maxThreads}) — capping`,
      );
    }
    const pending = threads.filter((s) => s.status !== 'done').length;
    if (pending > 0) {
      await this.post(
        route,
        `:rocket: Starting the build — ${pending} thread(s) on \`${sandbox.branch}\`.`,
      );
    }

    let handoff: string | null = null;
    for (const thread of threads) {
      if (thread.status === 'done') {
        // Already built (a resume) — carry its persisted handoff to the next thread, don't re-run.
        handoff = thread.handoffOut ?? handoff;
        continue;
      }
      const res = await this.runThread(
        job,
        record,
        route,
        repo,
        sandbox,
        thread,
        handoff,
      );
      if (res.outcome !== 'done') {
        // HALT the build (ADR 0004): an unfinished thread must not ship. Relay a durable card, flip the job
        // to a needs-you state, and SKIP finalizeBuild — no PR on an unfinished build.
        await this.haltJob(job, route, thread, res.outcome);
        return;
      }
      handoff = res.handoff;
    }

    await this.finalizeBuild(job, record, route, repo, sandbox);
  }

  /**
   * HALT the build on a non-`done` thread outcome (ADR 0004): flip the job to a needs-you state and relay a
   * DURABLE card so the halt never dead-ends silently (durable-first via the block sink — see
   * {@link relayFailure} for why a bare `post()` is invisible to reconnecting clients). `incomplete` →
   * `paused` (recoverable via a ping/re-drive; Phase 3 will auto-wake Atlas instead); `failed` → `failed`;
   * `blocked` (Phase 3) leaves the job `running` with the thread `awaiting_input`.
   */
  private async haltJob(
    job: Job,
    route: JobRoute,
    thread: DriverThread,
    outcome: ThreadOutcome,
  ): Promise<void> {
    const term = await this.store.getTerminalRecord(thread.id).catch(() => null);
    let text: string;
    let severity: 'warning' | 'error' = 'warning';
    if (outcome === 'failed') {
      await this.store.setJobStatus(job.id, 'failed').catch(() => undefined);
      const why = term?.failure
        ? `${term.failure.kind} failed${term.failure.command ? ` (\`${term.failure.command}\`)` : ''}${
            term.failure.stderrTail ? `:\n${term.failure.stderrTail.slice(0, 500)}` : ''
          }`
        : (term?.summary ?? 'the thread reported a failure');
      text = `:x: Build failed in *${thread.brief}* — ${why}\n_The job is marked failed; reply in this thread to retry or adjust._`;
      severity = 'error';
    } else if (outcome === 'blocked') {
      // Job stays `running`; the thread is `awaiting_input` (Phase 3 routes the block to the brain).
      text = `:raising_hand: Thread blocked — *${thread.brief}*: ${term?.blocked?.detail ?? 'needs your input'}.`;
    } else {
      // incomplete
      await this.store.setJobStatus(job.id, 'paused').catch(() => undefined);
      text = `:warning: Build halted — *${thread.brief}* ended without asserting completion (no \`complete_thread\`), so nothing shipped. Ping to retry, or open the thread to see what it did.`;
    }
    await this.blockSink
      .appendBlock(job.id, {
        kind: 'chat',
        text,
        meta: { source: 'system_operator', severity },
      })
      .catch((e) =>
        this.logger.error(`could not durably record halt for job=${job.id}: ${e}`),
      );
    await this.post(route, text).catch(() => undefined);
    await this.recordMilestone(
      job.id,
      `thread:${thread.id}:${outcome}`,
      text,
    ).catch(() => undefined);
  }

  /**
   * Run ONE thread, returning its handoff for the next. The per-thread flow, in order:
   *   a. lock the thread's single step (or reuse it on a resume);
   *   b. post the plan for visibility (non-blocking);
   *   c. execute — ONE orchestrator turn owns the thread + its writer fan-out on the shared branch;
   *   d. per-thread auto-fix over the thread's diff;
   *   e. summarize the handoff for the next thread.
   */
  private async runThread(
    job: Job,
    record: DecisionRecord | null,
    route: JobRoute,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
    thread: DriverThread,
    handoffIn: string | null,
  ): Promise<ThreadResult> {
    this.logger.log(`thread ${thread.ordinal} "${thread.brief}" — planning`);
    await this.post(
      route,
      `:hammer_and_wrench: Planning thread — *${thread.brief}*`,
    );

    // a. PLAN — lock the thread's single step (its brief IS the thread brief), or reuse it on a resume.
    //    The brain already authored the real plan (plan.md / sections/NN-*.md / data-model.md) into
    //    `/context/specs`, and the orchestrator reads it there + decomposes live via TaskCreate — so the
    //    driver no longer LLM-plans a step list; the one step row is the resume/commit anchor + UI spine.
    const { steps } = await this.planThread(thread, handoffIn);

    // The plan view visibility reads — derived from the locked step rows (resume-safe).
    const planView = steps.map(asPlannedStep);

    // b. VISIBILITY — post the plan into the thread (non-blocking; never gates). Decisions were locked +
    //    operator-approved UPSTREAM (before dispatch), so there is no per-thread decision gate anymore.
    await this.visibility.postSectionPlan({
      channel: route.channel ?? '',
      ...(route.threadTs ? { threadTs: route.threadTs } : {}),
      ...(route.orgId ? { orgId: route.orgId } : {}),
      title: thread.brief,
      plan: renderPlan(planView),
      decisions: [],
    });

    // e. EXECUTE — run each step as a fresh session on the shared feature branch.
    const sectionStartSha = await this.git
      .headSha(sandbox.worktreePath)
      .catch(() => undefined);
    await this.store.setThreadStatus(thread.id, 'executing');
    const { outcome, reports } = await this.executeSteps(job, route, sandbox, thread, record, repo);

    // The thread did NOT assert `done` (no `complete_thread`, an explicit block, or a failure) — HALT here:
    // skip auto-fix + handoff, set the thread status, and let runJob relay + skip finalize. NEVER fall through
    // to the done path (ADR 0004: a clean turn is not evidence of completion).
    if (outcome !== 'done') {
      const status: ThreadStatus =
        outcome === 'blocked' ? 'awaiting_input' : outcome; // 'incomplete' | 'failed'
      await this.store.setThreadStatus(thread.id, status).catch(() => undefined);
      this.logger.warn(`thread ${thread.ordinal} "${thread.brief}" halted — ${outcome}`);
      return { outcome, handoff: null };
    }

    // f. AUTO-FIX — fan-out review → fix over this thread's diff. SKIPPED for the master-review thread: it
    // IS the review (a whole-diff Codex review-and-fix), so a per-thread auto-fix pass over it is redundant.
    if (!thread.isMasterReview) {
    await this.store.setThreadStatus(thread.id, 'auto_fixing');
    // Seed the review agents at `pending` so the navigator shows them queued; the stage's onLensStatus hook
    // transitions each as it runs, and the `finally` resolves any left pending/running (empty diff / throw).
    // `reviewAgentsForThread` selects by thread type; the domain `DriverThread` doesn't carry it, and the
    // selection is a fixed set today, so call it argless (it ignores the arg).
    const reviewAgents = reviewAgentsForThread().map((a) => ({
      ...a,
      status: 'pending' as const,
    }));
    await this.store.seedReviewAgents(thread.id, reviewAgents);
    // ANCHOR — emit the stage's `autofix_anchor` row PAIRED with a change-signal post (mirrors `build_anchor`:
    // a bare `appendBlock` only writes a DB row; the `post` is what wakes the web at stage start). The future
    // review card latches onto `meta.autofixAnchor`; the stage streams each lens/fix turn on `autofix:*` lanes.
    await this.postAutofixAnchor(job, route, {
      autofixId: thread.id,
      scope: 'thread',
      label: thread.brief,
      lensIds: reviewAgents.map((a) => a.id),
    });
    const channel = route.channel ?? job.repoId;
    let lensesRun: string[] = [];
    try {
      const summary = await this.autofix.autofixThread(
        {
          worktreePath: sandbox.worktreePath,
          sandboxKey: sandboxKey(sandbox),
          ...(sectionStartSha ? { gitRange: `${sectionStartSha}..HEAD` } : {}),
          intent: `${record?.overview ?? ''}\n\nSection: ${thread.brief}`.trim(),
          label: thread.brief,
          // Streaming identity — ride the shared transcript spine on `autofix:<threadId>:*` lanes.
          jobId: job.id,
          channel,
          autofixId: thread.id,
          scope: 'thread',
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
              .setReviewAgentStatus(thread.id, lensId, status, findings)
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
      this.logger.warn(`thread auto-fix failed (continuing): ${err}`);
    } finally {
      // Resolve any agent still pending/running: passed if its lens ran, else skipped. Never leave a stuck
      // pending/running agent once the thread leaves auto_fixing.
      await this.store
        .finalizeReviewAgents(thread.id, lensesRun)
        .catch((err) =>
          this.logger.warn(`review-agent finalize failed (ignored): ${err}`),
        );
    }
    // Passive milestone: auto-fix is a transient stage (thread status is overwritten to `done` next), so
    // the net-state snapshot can't reconstruct that it ran — record it explicitly for the brain.
    await this.recordMilestone(
      job.id,
      `thread:${thread.id}:autofix`,
      `Auto-fix pass applied over the diff for thread "${thread.brief}".`,
    );
    }

    // e. HANDOFF — summarize what this thread produced for the next.
    const handoffOut = this.summarizeHandoff(thread, steps, reports);
    await this.store.setThreadHandoffOut(thread.id, handoffOut);
    await this.store.setThreadStatus(thread.id, 'done');
    this.logger.log(`thread ${thread.ordinal} done`);
    await this.recordMilestone(
      job.id,
      `thread:${thread.id}:done`,
      `Thread "${thread.brief}" finished building.`,
    );
    await this.post(route, `:white_check_mark: Thread done — *${thread.brief}*`);
    return { outcome: 'done', handoff: handoffOut };
  }

  /**
   * Lock (or resume) the thread's SINGLE step — its brief is the thread brief. The build no longer
   * LLM-plans a multi-step list: the brain already authored the real plan into `/context/specs`
   * (`plan.md` / `sections/NN-*.md` / `data-model.md`), and the ONE orchestrator turn reads it there and
   * decomposes the work live via `TaskCreate`. The single step row is the resume/commit anchor + the UI
   * spine — no finer granularity is needed because the whole thread is one orchestrator turn. On a resume
   * the step already exists, so reuse it.
   */
  private async planThread(
    thread: DriverThread,
    handoffIn: string | null,
  ): Promise<{ steps: Step[] }> {
    const existing = await this.store.stepsForThread(thread.id);
    if (existing.length > 0) {
      this.logger.log(
        `thread ${thread.ordinal}: ${existing.length} step(s) already locked — resuming`,
      );
      return { steps: existing };
    }

    await this.store.setThreadStatus(thread.id, 'planning');
    const planned: PlannedStep[] = [{ title: thread.brief, brief: thread.brief }];
    await this.store.setThreadPlan(thread.id, renderPlan(planned), handoffIn);
    const steps = await this.store.lockSteps(thread, planned);
    return { steps };
  }

  /** Run an engine turn under a HARD, PAUSABLE wall-clock bound (PHASE_TIMEOUT_MS). On breach it signals
   *  the SDK to abort (best-effort — may not interrupt a stuck subprocess) AND rejects the await so the
   *  driver gives up regardless. A caller may pass its own {@link PausableDeadline} (the orchestrate turn
   *  does, so its `request_operator_input` tool can PAUSE the clock across a human wait — the human's
   *  reply time must not count against the build budget). Otherwise a fresh deadline is created here. */
  private async runTurnBounded(
    input: Parameters<TurnRunnerService['runTurn']>[0],
    label: string,
    deadline?: PausableDeadline,
  ): Promise<Awaited<ReturnType<TurnRunnerService['runTurn']>>> {
    const dl = deadline ?? new PausableDeadline(this.phaseTimeoutMs, label);
    dl.start(); // idempotent — arms the clock now (a caller-supplied deadline is armed exactly once here)
    try {
      return await Promise.race([
        this.turn.runTurn({ ...input, signal: dl.signal }),
        dl.expired,
      ]);
    } finally {
      dl.clear();
    }
  }

  /**
   * Build the host tool bridge for the orchestrate build turn. Two tools:
   *  - `request_operator_input` — the mid-build "pause and ask" escape hatch (open a durable card → poll →
   *    pause the deadline across the human wait → return the answer so the SAME turn resumes).
   *  - `complete_thread` — the TYPED TERMINAL ASSERTION (ADR 0004): the orchestrator MUST call this to
   *    declare the thread finished, passing what it did + the verification it actually ran. The driver reads
   *    the persisted record after the turn instead of inferring done-ness from "the turn didn't throw." A
   *    turn that ends without it is `incomplete`, never `done`. (Phase 3 adds `block_thread`.)
   */
  private buildTurnBridge(
    job: Job,
    thread: DriverThread,
    route: JobRoute,
    deadline: PausableDeadline,
  ): ToolBridgeOptions {
    return {
      jobId: job.id,
      tools: {
        complete_thread: async (args) => {
          const summary = String(args['summary'] ?? '').trim();
          if (!summary) {
            return { ok: false, error: 'summary is required (one line: what this thread built)' };
          }
          const asStrings = (v: unknown): string[] | undefined =>
            Array.isArray(v) && v.length
              ? v.map((x) => String(x).trim()).filter(Boolean)
              : undefined;
          const verification = Array.isArray(args['verification'])
            ? (args['verification'] as unknown[])
                .map((e) => {
                  const o = (e ?? {}) as Record<string, unknown>;
                  return {
                    kind: String(o['kind'] ?? '').trim(),
                    command: String(o['command'] ?? '').trim(),
                    exitCode: Number.isFinite(Number(o['exitCode'])) ? Number(o['exitCode']) : -1,
                    outputTail: String(o['outputTail'] ?? '').slice(0, 2000),
                  };
                })
                .filter((v) => v.command)
            : undefined;
          const record: ThreadTerminalRecord = {
            status: 'done',
            summary,
            ...(asStrings(args['changes']) ? { changes: asStrings(args['changes']) } : {}),
            ...(verification && verification.length ? { verification } : {}),
            ...(asStrings(args['deviations']) ? { deviations: asStrings(args['deviations']) } : {}),
            ...(asStrings(args['gaps']) ? { gaps: asStrings(args['gaps']) } : {}),
          };
          await this.store.recordThreadTermination(thread.id, record);
          return { ok: true };
        },
        request_operator_input: async (args) => {
          const question = String(args['question'] ?? '').trim();
          if (!question) {
            return { ok: false, error: 'question is required (what you need decided, specifically)' };
          }
          // Reuse an already-open build card (a resumed turn re-issuing its pending question) instead of
          // stacking a duplicate; else open a fresh durable card (+ needs-you bump).
          const existing = await this.store.findOpenOperatorInputCard(job.id);
          const questionId =
            existing?.questionId ??
            (await this.store.openOperatorInputCard(job.id, question)).questionId;
          if (!existing) {
            await this.store
              .setThreadStatus(thread.id, 'awaiting_input')
              .catch(() => undefined);
            await this.post(
              route,
              `:raising_hand: I need your input to continue *${thread.brief}*:\n> ${question}\n_Reply in this thread to continue._`,
            );
            await this.recordMilestone(
              job.id,
              `thread:${thread.id}:input:${questionId.slice(0, 8)}`,
              `The build paused to ask the operator: ${question}`,
            );
          }
          // Suspend the wall-clock budget across the (human-paced) wait, then poll the durable card.
          deadline.pause();
          try {
            const answer = await this.pollOperatorAnswer(job.id, questionId, deadline.signal);
            await this.store.markOperatorInputDelivered(job.id, questionId).catch(() => undefined);
            await this.store
              .setThreadStatus(thread.id, 'executing')
              .catch(() => undefined);
            return { answer };
          } finally {
            deadline.resume();
          }
        },
      },
    };
  }

  /** Poll a build-origin question card until the operator answers it, bounded by OPERATOR_INPUT_TIMEOUT_MS
   *  (default 6h). On timeout it returns guidance telling the orchestrator to proceed on its best judgment
   *  (rather than erroring the turn). Stops early if the turn is aborted (shutdown/kill). */
  private async pollOperatorAnswer(
    jobId: string,
    questionId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const maxMs = Number(this.env.get('OPERATOR_INPUT_TIMEOUT_MS')) || 6 * 60 * 60_000;
    const intervalMs = 3_000;
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('turn aborted while awaiting operator input');
      const answer = await this.store.readOperatorInputAnswer(jobId, questionId);
      if (answer != null) return answer;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return '(No response from the operator within the time limit. Proceed using your best judgment, keep the change minimal and reversible, and clearly note the assumption you made in your report.)';
  }

  /**
   * Execute a thread — ONE orchestrator turn owns the whole thread and fans implementation out to writer
   * subagents (there is no per-step batching anymore). The thread's single step is the resume/commit
   * anchor: fresh session in the worktree → the orchestrator verifies in-turn → ONE commit → mark the
   * step done. Returns the orchestrator's report.
   */
  private async executeSteps(
    job: Job,
    route: JobRoute,
    sandbox: FeatureSandbox,
    thread: DriverThread,
    record: DecisionRecord | null,
    repo: ResolvedRepo,
  ): Promise<{ outcome: ThreadOutcome; reports: string[] }> {
    let steps = await this.store.stepsForThread(thread.id);

    // First execute of this thread (steps not yet batched): the WHOLE thread is ONE batch. Persist a
    // constant batch_ordinal over all steps so a resume re-groups identically (the in-flight engine
    // session keeps the same task on restart).
    if (steps.some((p) => p.status !== 'done' && p.batchOrdinal == null)) {
      // One batch for the whole thread — every step gets batch_ordinal 1.
      await this.store.setBatchOrdinals(steps.map((p) => [p.id, 1]));
      this.logger.log(
        `thread ${thread.ordinal}: ${steps.length} step(s) as one orchestrator batch`,
      );
      steps = await this.store.stepsForThread(thread.id);
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
    let outcome: ThreadOutcome = 'done';
    const keys = [...byBatch.keys()].sort((a, b) => a - b);
    const lastKey = keys[keys.length - 1];
    for (const key of keys) {
      const batch = byBatch.get(key)!;
      // Atomic-resume fast-forward (#6): if the batch's anchor already carries a commit_sha, the batch
      // committed before a crash interrupted the done-status writes — re-running would redo work against
      // an already-committed tree. Mark the steps done and skip the session instead. (Only a `done` batch
      // commits, so a committed terminal batch implies the thread asserted done — outcome stays `done`.)
      if (batch[0].commitSha) {
        this.logger.log(
          `batch [${batch.map((p) => p.ordinal).join(',')}] already committed — fast-forward`,
        );
        for (const p of batch)
          await this.store.setStepState(p.id, 'done', 'done');
        continue;
      }
      const res = await this.runBatch(
        job, route, sandbox, thread, record, batch, repo, key === lastKey,
      );
      reports.push(res.report);
      if (res.outcome !== 'done') {
        // Non-done terminal outcome — halt the thread; don't run later batches on an unfinished thread.
        outcome = res.outcome;
        break;
      }
    }
    return { outcome, reports };
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
    thread: DriverThread,
    record: DecisionRecord | null,
    steps: Step[],
    repo: ResolvedRepo,
    isLastBatch: boolean,
  ): Promise<BatchResult> {
    const anchor = steps[0];
    const label =
      steps.length === 1
        ? (anchor.title ?? anchor.brief ?? `step ${anchor.ordinal}`)
        : `${steps.length} steps (${steps.map((p) => p.title ?? `#${p.ordinal}`).join(', ')})`;
    this.logger.log(
      `thread ${thread.ordinal} batch [${steps.map((p) => p.ordinal).join(',')}] — building`,
    );
    for (const p of steps)
      await this.store.setStepState(p.id, 'build', 'building');

    // The build turn rides the shared transcript spine on the thread's STABLE `thread:<threadId>` lane —
    // exactly like the brain's constant `main` — so the web subscribes to it by thread identity instead of
    // guessing a per-batch lane (the old `phase:<stepId>` lane changed every batch, so a running build
    // thread showed an empty transcript). Every durable block still carries `meta.phaseId` so the web peels
    // it into the step sub-page (like a subagent). The channel falls back to the repo id so durable
    // persistence works even if the route has no live channel.
    const channel = route.channel ?? job.repoId;
    const lane = laneFor('builder', thread.id);
    const batchOrdinal = anchor.batchOrdinal ?? null;
    const metaTag: Record<string, unknown> = {
      phaseId: anchor.id,
      ...(batchOrdinal != null ? { batchOrdinal } : {}),
    };
    // The instruction the engine receives — the build turn's "first message". Computed once here so it
    // can both kick off the turn AND be persisted on the anchor row (the web renders it like a subagent's
    // Task prompt, so the step transcript shows what was asked, not just the engine's reply).
    const task = thread.isMasterReview
      ? renderMasterReviewTask(record, repo)
      : renderBatchTask(record, thread, steps);

    // The orchestrator turn's PAUSABLE wall-clock deadline + the host tool bridge that exposes
    // `request_operator_input` (open a durable question card → poll it → pause the deadline across the
    // human wait). One deadline shared by the bounded kick AND the tool so a pause suspends the clock; the
    // same bridge is re-supplied on re-attach (the host tool closure is in-memory, lost on restart).
    const deadline = new PausableDeadline(this.phaseTimeoutMs, `batch "${label}"`);
    const toolBridge = this.buildTurnBridge(job, thread, route, deadline);

    // RE-ATTACH or KICK. After a backend restart the engine kept running detached (Redis transport) and is
    // still writing to its streams — re-tail its live stream instead of re-running the batch, exactly like
    // the brain. A reattach row exists only for a still-live batch, so look it up only on a RESUME (the
    // anchor already has a persisted session) and only when the bound runner supports reattach (else the
    // pipe transport falls through to a kick that resumes the persisted session — today's recovery).
    const reattachRow =
      this.turn.canReattach() && anchor.sessionId
        ? await this.findReattachableTurn(job.id, lane, anchor.id)
        : null;
    // A batch that has never started (no persisted session, no live turn) is a FRESH start — emit its START
    // markers (the :gear: milestone + the synthetic build_anchor the in-conversation BuildStepCard latches
    // onto) exactly ONCE. On a resume/reattach they already exist (durable), so re-emitting would duplicate.
    if (!reattachRow && !anchor.sessionId) {
      // Fresh start of the TERMINAL batch: clear any stale terminal record from a prior failed attempt so
      // the assertion we read after this turn can only be THIS turn's (staleness guard — ADR 0004). A
      // resume/reattach deliberately does NOT clear, preserving a pre-crash assertion.
      if (isLastBatch && !thread.isMasterReview) {
        await this.store.clearTerminalRecord(thread.id).catch(() => undefined);
      }
      await this.post(route, `:gear: ${thread.brief} — building: ${label}`);
      await this.blockSink
        .appendBlock(job.id, {
          kind: 'build_anchor',
          text: `${thread.brief} — ${label}`,
          meta: {
            phaseId: anchor.id,
            threadId: thread.id,
            ...(batchOrdinal != null ? { batchOrdinal } : {}),
            batchStepIds: steps.map((p) => p.id),
            label,
            prompt: task,
          },
        })
        .catch((err) =>
          this.logger.warn(`build_anchor append failed for thread=${job.id}: ${err}`),
        );
    }

    // Re-attach the in-flight turn if one is live; else (fresh batch, or a re-attach that could no longer be
    // tailed — engine finished + streams reaped, or the container is gone) KICK a fresh turn that resumes the
    // persisted session. Both paths own their harness lifecycle and yield the same RunTurnResult.
    let result: Awaited<ReturnType<TurnRunnerService['runTurn']>> | null = null;
    if (reattachRow?.container_id) {
      result = await this.reattachBatchTurn(job, thread, lane, metaTag, reattachRow, anchor.id, toolBridge);
    }
    if (!result) {
      result = await this.kickBatchTurn(job, sandbox, thread, steps, task, lane, channel, metaTag, label, repo, deadline, toolBridge);
    }

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

    // Resolve the TERMINAL OUTCOME (ADR 0004). A non-terminal batch, or the master-review thread (Codex —
    // no host tool bridge, so it can't call `complete_thread`), keeps exception-shape semantics: the turn
    // returned → done. The terminal Claude batch READS the assertion the orchestrator wrote instead of
    // inferring done-ness. No assertion after a clean turn ⇒ `incomplete` (NEVER silently done).
    let outcome: ThreadOutcome = 'done';
    if (isLastBatch && !thread.isMasterReview) {
      const term = await this.store.getTerminalRecord(thread.id);
      outcome = term?.status ?? 'incomplete';
      if (outcome === 'incomplete') {
        this.logger.warn(
          `thread ${thread.ordinal} batch [${steps.map((p) => p.ordinal).join(',')}] ended WITHOUT complete_thread — marking incomplete`,
        );
      }
    }

    if (outcome !== 'done') {
      // Do NOT commit-as-done or mark steps done — leave the batch resumable (the atomic-resume fast-forward
      // keys on commit_sha + step `done`, so an un-finalized batch correctly re-runs) and let runThread/runJob
      // set the thread status + halt. The working tree is left intact for diagnosis.
      return { outcome, report: result.report };
    }

    // ONE commit for the whole batch onto the shared feature branch.
    const sha = await this.git.commitAll(
      sandbox.worktreePath,
      `${thread.brief} — ${steps.map((p) => p.title ?? `step ${p.ordinal}`).join(' + ')}`,
    );
    this.logger.log(`batch committed ${sha ? sha.slice(0, 8) : '(nothing)'}`);

    // Atomic-resume marker (#6): stamp the commit on the ANCHOR step FIRST, then flip the steps to done.
    // A crash between the two ⇒ resume sees the commit_sha and fast-forwards (executeSteps) instead of
    // re-running the whole thread against an already-committed tree. Empty sha (nothing changed) still
    // marks complete so the batch never re-runs. `NOTHING` is the sentinel for an empty commit.
    await this.store.setStepCommit(anchor.id, sha || NOTHING_COMMITTED);
    for (const p of steps) await this.store.setStepState(p.id, 'done', 'done');
    return { outcome: 'done', report: result.report };
  }

  /**
   * Find the still-running registry row for THIS batch's engine turn (restart re-attach), or null. Matches on
   * (job_id, lane, ctx.anchorStepId) among running `step` turns — the lane is thread-scoped and a thread runs
   * one batch at a time, so the match is unique; the anchor id disambiguates across a thread's batches.
   */
  private async findReattachableTurn(
    jobId: string,
    lane: string,
    anchorStepId: string,
  ): Promise<ActiveTurnEntity | null> {
    const rows = await this.turnRegistry.listRunning().catch((err) => {
      this.logger.warn(`reattach lookup failed (will kick a fresh turn): ${err}`);
      return [] as ActiveTurnEntity[];
    });
    return (
      rows.find(
        (r) =>
          r.kind === 'step' &&
          r.job_id === jobId &&
          r.lane === lane &&
          (r.ctx as { anchorStepId?: string } | null)?.anchorStepId === anchorStepId,
      ) ?? null
    );
  }

  /**
   * RE-ATTACH a batch's in-flight engine turn after a restart: re-tail its live stream (no re-kick) on the
   * thread lane and persist the result — parity with the brain's boot re-attach. Returns null when the turn
   * can no longer be tailed (finished + streams reaped, or the container is gone) so the caller re-runs it.
   * Uses the ORIGINAL turn's channel so replayed frames land on the same SSE key.
   */
  private async reattachBatchTurn(
    job: Job,
    thread: DriverThread,
    lane: string,
    metaTag: Record<string, unknown>,
    row: ActiveTurnEntity,
    anchorStepId: string,
    toolBridge?: ToolBridgeOptions,
  ): Promise<Awaited<ReturnType<TurnRunnerService['runTurn']>> | null> {
    this.logger.log(
      `thread ${thread.ordinal} — re-attaching in-flight build turn ${row.turn_id} (container ${row.container_id})`,
    );
    const harness = this.turnHarness.create({
      jobId: job.id,
      channel: row.channel,
      lane,
      metaTag,
    });
    try {
      const result = await this.turn.reattach({
        turnId: row.turn_id,
        containerId: row.container_id!,
        jobId: job.id,
        stepId: anchorStepId,
        onEvent: (e) => harness.onEvent(e),
        // Re-supply the host tool closure — the in-sandbox session may have an in-flight
        // `request_operator_input` request whose response the re-attached host must still serve.
        ...(toolBridge ? { toolBridge } : {}),
      });
      await harness.finish(result.report);
      return result;
    } catch (err) {
      if (isEngineDetachedError(err)) {
        // We lost our OWN tail mid-turn (shutdown during a watch respawn) — the engine is still running.
        // Persist nothing, finalize nothing (the row + streams are the next boot's re-attach anchor), and
        // crucially do NOT return null: that would re-kick a live engine's session. Propagate instead.
        this.logger.warn(`re-attach turn ${row.turn_id} detached — leaving it for the next boot`);
        throw err;
      }
      // The engine turn already finished (streams reaped) or its container is gone — persist partials, end
      // the lane once, finalize the stale registry row (so the watchdog/reaper don't race it), and signal
      // the caller to re-run the batch (resuming the persisted session).
      await harness.abort();
      await this.turnRegistry.finalize(row.turn_id, 'failed').catch(() => undefined);
      this.logger.warn(`re-attach turn ${row.turn_id} failed; re-running the batch: ${err}`);
      return null;
    }
  }

  /**
   * KICK a fresh engine turn for the batch — a first run, or a resume that reopens the persisted session on
   * the thread lane. Registers the turn (`turnMeta`) so a later restart can RE-ATTACH it (see `runBatch`), and
   * bounds it with the per-batch wall-clock circuit breaker. Owns its harness lifecycle.
   */
  private async kickBatchTurn(
    job: Job,
    sandbox: FeatureSandbox,
    thread: DriverThread,
    steps: Step[],
    task: string,
    lane: string,
    channel: string,
    metaTag: Record<string, unknown>,
    label: string,
    repo: ResolvedRepo,
    deadline: PausableDeadline,
    toolBridge: ToolBridgeOptions,
  ): Promise<Awaited<ReturnType<TurnRunnerService['runTurn']>>> {
    const anchor = steps[0];
    const harness = this.turnHarness.create({ jobId: job.id, channel, lane, metaTag });
    // The master-review thread runs CODEX in execute mode over the whole diff (review + fix + verify) with a
    // dedicated persona and high reasoning effort; every other builder runs Claude with the WORKER persona.
    const isMasterReview = thread.isMasterReview;
    const engine: SessionEngine = isMasterReview ? 'codex' : 'claude';
    const systemPrompt = isMasterReview
      ? renderAgentPrompt(Agent.MASTER_REVIEW)
      : renderAgentPrompt(Agent.WORKER, { jobKind: job.kind });
    // Circuit breaker (#3): bound the engine turn with the shared PAUSABLE deadline (paused across a
    // `request_operator_input` human wait). On breach it both signals the SDK to abort AND hard-rejects so
    // the DRIVER gives up even if the SDK can't interrupt a stuck subprocess. Events attribute to the anchor
    // step (a batch is one turn; minor observability coarsening for the step transcript).
    let result: Awaited<ReturnType<TurnRunnerService['runTurn']>>;
    try {
      result = await this.runTurnBounded(
        {
          jobId: job.id,
          stepId: anchor.id,
          sandbox,
          engine,
          mode: 'execute',
          systemPrompt,
          // High reasoning effort for the whole-diff review pass (parity with plan-review). Ignored by Claude
          // builder turns (undefined). `toolBridge`/steering are unused by `runCodex` on the master path.
          ...(isMasterReview ? { modelReasoningEffort: 'xhigh' as const } : {}),
          task,
          auth: await this.creds.engineAuth(job.orgId, engine),
          // Authenticated git IN the sandbox: the execute turn (orchestrator) can fetch/merge origin,
          // resolve conflicts, and push its own branch. Sourced from the RESOLVED repo (not `sandbox`).
          gitAuth: { gitUrl: repo.projectRepo.gitUrl, token: repo.token },
          richStream: true, // full transcript (thinking + tool calls/results + subagent forwarding)
          // The orchestrator's host tool bridge — exposes `request_operator_input` (pause & ask). The
          // orchestrator's OTHER tools (Edit/Bash/Task) run in-sandbox, not over this bridge.
          toolBridge,
          // Register in `active_turns` so a fresh backend can RE-ATTACH this build turn's live stream after a
          // restart (parity with the brain), not just re-run it.
          turnMeta: {
            jobId: job.id,
            orgId: job.orgId,
            channel,
            lane,
            kind: 'step',
            ctx: {
              repoId: job.repoId,
              threadId: thread.id,
              anchorStepId: anchor.id,
              batchStepIds: steps.map((p) => p.id),
              batchOrdinal: anchor.batchOrdinal ?? null,
            },
          },
          onEvent: (e) => {
            if (e.kind === 'tool') this.logger.debug(`batch tool: ${e.name}`);
            harness.onEvent(e);
          },
        },
        `batch "${label}"`,
        deadline,
      );
    } catch (err) {
      // Timeout / auth / engine error — persist whatever partials streamed and end the lane exactly once.
      await harness.abort();
      throw err;
    }
    // Engine turn done — persist the transcript (+ fallback) and end the live lane.
    await harness.finish(result.report);
    return result;
  }

  /**
   * FINALIZE THE BUILD. After all threads: promote durable decisions into `.atlas/decisions/`, then run
   * the terminal `ship` sequence — Atlas opens the PR ITSELF in-sandbox (git push + `gh pr create`),
   * followed by Master Review as a check on the open PR. The host opens NOTHING; it only kicks the ship
   * turn, then flips the job `done` once it ran (the reconciler backfills `pr_url`/`pr_number` on
   * discovery). Idempotent + resumable — a re-entered finalize just re-promotes and re-ships (ship finds
   * the existing PR). Threads stacked on one branch ⇒ one PR.
   */
  private async finalizeBuild(
    job: Job,
    record: DecisionRecord | null,
    route: JobRoute,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
  ): Promise<void> {
    this.logger.log(
      `job=${job.id} all threads done — promoting decisions + shipping`,
    );
    // Promote durable decisions into `.atlas/decisions/` BEFORE shipping, so they ride the build commit.
    // `promoteLedger` HONORS the claim: if the ledger is already claimed/complete (a concurrent finalize or
    // a prior attempt), it SKIPS the promote turn rather than re-firing it — this is what stops the
    // ship-tail (promote → open-PR → review) from looping.
    const promoted = await this.promoteLedger(job);
    // `ship` runs the terminal in-sandbox steps: Atlas opens the PR ITSELF (git push + `gh pr create`), then
    // reports its url back so `ship` latches `pr_url`/`pr_number` (flipping the job `done`), then Master
    // Review runs as a check on the open PR. See BuildShipService.ship / openPrInSandbox.
    const outcome = await this.ship.ship({
      job,
      record,
      repo,
      sandbox,
      // Sweep the freshly-written ledger files into one commit (a no-op when nothing was promoted).
      commitMessage: LEDGER_COMMIT_MESSAGE,
      notify: (m) => this.post(route, m),
    });
    // Finalize the ledger spine off BOTH signals — did THIS call actually run the promote turn, and did the
    // PR confirm — never leaving the row stuck `running`:
    //  • promoted here AND PR confirmed ⇒ COMPLETE (the ledger files were written + shipped on the PR).
    //  • promoted here but PR not confirmed ⇒ FAILED, so the claim is re-winnable next drive (ship left the
    //    job `running`, so boot-recovery re-runs the idempotent tail).
    //  • NOT promoted here ⇒ the claim was already `complete` (nothing to do), OR a crashed `running` from a
    //    prior attempt whose promote turn may not have written the files. We must NOT mark complete on
    //    confirmation alone — that would stamp the ledger done with no files. The boot backstop
    //    (`reconcileLedgerPromotion`) re-promotes the now-`done`, pr_url-set row onto its open PR instead.
    // Never blocks the PR on the ledger.
    if (promoted && outcome.opened && outcome.prConfirmed) {
      await this.store.markLedgerPromoted(job.id);
    } else if (promoted) {
      await this.store
        .setLedgerPromotionStatus(job.id, 'failed')
        .catch(() => undefined);
    }
  }

  /**
   * Run the SERVER-INITIATED ledger promotion turn (full path). Claims the spine (`running`), then asks
   * the brain — lazily, to avoid the brain⇄driver module cycle — to distill THIS thread's durable
   * decisions into the worktree's `.atlas/decisions/`. Best-effort: a failure marks the spine `failed`
   * (boot backstop retries) and returns false so the PR ships regardless.
   */
  private async promoteLedger(job: Job): Promise<boolean> {
    // HONOR the claim: only run the promote turn when THIS caller won it (`null|pending|failed → running`).
    // A row already `running`/`complete` means a concurrent finalize or a prior attempt owns it — re-firing
    // the promote turn here is exactly the loop that made shipped jobs re-run promote_decisions endlessly.
    const won = await this.store.claimLedgerPromotion(job.id);
    if (!won) {
      this.logger.log(
        `job=${job.id}: ledger promotion already claimed/complete — skipping the promote turn`,
      );
      return false;
    }
    try {
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

  /** Summarize a thread's handoff for the next thread — a terse rule-based note built from the
   *  orchestrator's own report (richest), falling back to the step titles. No LLM. */
  private summarizeHandoff(
    thread: DriverThread,
    steps: Step[],
    reports: string[],
  ): string {
    const report = reports.filter(Boolean).join('\n\n').trim();
    if (report) {
      return `Thread "${thread.brief}" complete.\n\n${report}`.slice(0, 4000);
    }
    const built = steps.map((p) => p.title ?? p.brief).join('; ');
    return `Thread "${thread.brief}" complete. Built: ${built || '(see commits)'}.`;
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
   * Emit the auto-fix stage's `autofix_anchor` row PAIRED with a change-signal post — the same pattern as
   * `build_anchor` (a bare `appendBlock` only writes a DB row; the `post` is what wakes the web). The
   * `autofix_anchor` row is the durable hook the future review card latches onto (`meta.autofixAnchor`);
   * the stage streams each lens + fix turn on `autofix:<autofixId>:*` lanes. Best-effort (never sinks the build).
   */
  private async postAutofixAnchor(
    job: Job,
    route: JobRoute,
    a: { autofixId: string; scope: 'thread' | 'pr'; label: string; lensIds: string[] },
  ): Promise<void> {
    await this.post(route, `:mag: Reviewing the diff — *${a.label}*`);
    await this.blockSink
      .appendBlock(job.id, {
        kind: 'autofix_anchor',
        text: `Reviewing the diff — ${a.label}`,
        meta: {
          autofixId: a.autofixId,
          autofixAnchor: true,
          scope: a.scope,
          label: a.label,
          lensIds: a.lensIds,
        },
      })
      .catch((err) =>
        this.logger.warn(`autofix_anchor append failed for job=${job.id}: ${err}`),
      );
  }
}

// ── pure render helpers ──────────────────────────────────────────────────────────────────────────

/**
 * A hard wall-clock deadline that can be PAUSED and RESUMED — the orchestrate turn's circuit breaker.
 * Armed once via {@link start}; on expiry it aborts (via {@link signal}) and rejects {@link expired}.
 * `request_operator_input` calls {@link pause}/{@link resume} around a human wait so the operator's reply
 * time does NOT count against the build budget. Never armed → never expires (safe for the re-attach path,
 * which shares the tool bridge but does not race {@link expired}).
 */
export class PausableDeadline {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private remaining: number;
  private startedAt = 0;
  private armed = false;
  private paused = false;
  private done = false;
  readonly expired: Promise<never>;
  private rejectExpired!: (e: Error) => void;

  constructor(
    private readonly totalMs: number,
    private readonly label: string,
  ) {
    this.remaining = totalMs;
    // A floating rejected promise is fine: `runTurnBounded` always races it; an unraced deadline is never
    // armed, so `rejectExpired` never fires. Swallow to avoid an unhandledRejection if it ever does.
    this.expired = new Promise<never>((_resolve, reject) => {
      this.rejectExpired = reject;
    });
    this.expired.catch(() => undefined);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Arm the countdown. Idempotent — subsequent calls are ignored (the deadline is armed exactly once). */
  start(): void {
    if (this.armed) return;
    this.armed = true;
    this.arm();
  }

  private arm(): void {
    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      if (this.done) return;
      this.done = true;
      this.controller.abort();
      this.rejectExpired(
        new Error(`${this.label} exceeded PHASE_TIMEOUT_MS (${this.totalMs}ms)`),
      );
    }, this.remaining);
  }

  /** Suspend the countdown, banking the elapsed time. No-op if not armed / already paused / finished. */
  pause(): void {
    if (!this.armed || this.paused || this.done) return;
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.startedAt));
  }

  /** Resume a paused countdown with the banked remaining time. */
  resume(): void {
    if (!this.armed || !this.paused || this.done) return;
    this.paused = false;
    this.arm();
  }

  /** Stop the timer for good (the turn settled) — after this it can never fire. */
  clear(): void {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Sentinel `commit_sha` for a batch that completed but changed nothing (empty commit) — distinguishes
 *  "done, no diff" from "never committed" (null) so a resume fast-forwards instead of re-running. */
const NOTHING_COMMITTED = '(nothing)';

/** A locked step row → the `PlannedStep` view visibility/render read (title null → brief). */
function asPlannedStep(step: Step): PlannedStep {
  return { title: step.title ?? step.brief, brief: step.brief };
}

/** Render the ORCHESTRATOR turn's task — ONE turn owns the whole thread. The single step's brief is the
 *  thread brief; the orchestrator reads the real plan in `/context/specs` and decomposes the work live. */
export function renderBatchTask(
  record: DecisionRecord | null,
  thread: DriverThread,
  steps: Step[],
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
  return [
    `Feature overview:\n${record?.overview ?? ''}`,
    `\nLocked decisions (respect these):\n${decisions}`,
    `\nThread: ${thread.brief}`,
    `\nYour grounding is the READ-ONLY directory \`/context/specs/\` (a folder): read its \`plan.md\`` +
      ` index, this thread's \`sections/NN-*.md\` file, and \`data-model.md\`. Make ALL code changes under` +
      ` \`/workspace\` — never edit anything in \`/context\`.`,
    // Advisory orientation cheat-sheet, when a prior pass captured one (may be absent — the fresh session
    // then orients off the repo docs itself). Kept subordinate to the code + specs (authoritative).
    ...(thread.orientation
      ? [
          `\nRepo orientation (a cheat-sheet from an earlier pass — the CODE and \`/context/specs/\` remain` +
            ` authoritative if anything here is stale):\n` +
            thread.orientation,
        ]
      : []),
    `\nImplement this thread: read the specs, then delegate the work to writer subagents (one at a time),` +
      ` making small edits yourself where a subagent would be overkill, and verify the whole thread before` +
      ` finishing. If you hit a decision the locked plan does NOT cover and you cannot safely proceed, call` +
      ` \`request_operator_input\` with a specific question rather than guessing.\n\n${blocks}`,
  ].join('\n');
}

/**
 * The task for the MASTER-REVIEW thread — a Codex `execute` turn that reviews the whole merged feature diff
 * and applies fixes IN-CONTAINER (where the repo toolchain lives), then verifies with the repo's own build.
 * Execute-voice counterpart to the old read-only `run_master_review` tool prompt. No writer-subagent mention
 * (Codex has none). Does NOT push — the host commits the edits and ships.
 */
export function renderMasterReviewTask(record: DecisionRecord | null, repo: ResolvedRepo): string {
  const decisions = record?.decisions.length
    ? record.decisions.map((d) => `- [${d.decisionClass}] ${d.title}: ${d.ruling}`).join('\n')
    : '(none)';
  return [
    `Feature overview:\n${record?.overview ?? ''}`,
    `\nLocked decisions (respect these):\n${decisions}`,
    `\nThis is the FINAL review-and-fix pass over the whole feature branch before its pull request opens.`,
    `\n1. Review the whole merged diff: \`git diff origin/${repo.defaultBranch}...HEAD\`. Look for real,` +
      ` in-scope defects — correctness bugs, security issues, and cross-thread integration mistakes (where` +
      ` two threads' changes don't line up). Ignore style nits and anything outside this feature's scope.`,
    `\n2. FIX what you find: the smallest safe change per finding, never expanding scope; skip anything` +
      ` unsafe or ambiguous rather than guessing. Make edits directly under \`/workspace\`.`,
    `\n3. VERIFY: run the repo's own typecheck/build/test commands and confirm they pass — do this even if` +
      ` you changed nothing (a clean review still deserves a green build). If verification fails, fix and` +
      ` re-verify rather than leaving it red.`,
    `\nDo NOT \`git push\` or open a PR — the host commits your edits and ships. If the review found nothing` +
      ` actionable, change nothing.`,
  ].join('\n');
}

/**
 * Pull a `<repo-orientation>…</repo-orientation>` cheat-sheet out of some engine output — the trimmed inner
 * text (length-capped), or null when the block is absent/empty. A future orientation pass can persist this
 * onto `thread.orientation` (see {@link renderBatchTask}); the driver no longer runs a dedicated plan turn,
 * so nothing populates it today, but the extractor + injection point are kept for that.
 */
export function extractOrientation(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(/<repo-orientation>([\s\S]*?)<\/repo-orientation>/i);
  const body = m?.[1]?.trim();
  if (!body) return null;
  return body.length > 1500 ? `${body.slice(0, 1500)}…` : body;
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

/** A concise human root-cause for a failure relay — never a stack trace, but never JUST the first line
 *  either: a `child_process.exec`/`execFile` rejection's `.message` is "Command failed: <cmd>\n<stderr>" —
 *  the ACTUAL reason (git's fatal:, a permission error, etc.) is that appended stderr. Keeping only the
 *  first line left every git/shell failure relay saying just "Command failed: git ... add -A" with no way
 *  to tell why (confirmed: Node's execFile error already embeds stderr in `.message`, so there is nothing
 *  further to pull from `.stderr` separately — the bug was purely the truncation below). */
export function shortReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const detail = msg
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' | ');
  return detail.length > 500 ? `${detail.slice(0, 497)}...` : detail || 'unknown error';
}
