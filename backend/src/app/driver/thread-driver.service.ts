import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { threadDirName } from './thread-dir-name';
import { PlanVisibilityService } from '../decision-gate';
import {
  AutoFixStage,
  dedupeFindings,
  meetsSeverity,
  lensById,
  type AutoFixContext,
  type FindingSeverity,
} from '../autofix';
import type {
  DecisionRecord,
  Step,
  Job,
  SessionEngine,
  ThreadCondition,
} from '../domain';
import { HALT_FIX_ATTEMPT_CAP } from '../domain';
import { TICKET_AUTO_SKIP_SIM, TICKET_TERMINAL_STATUSES } from '../domain/ticket';
import {
  EngineAuthError,
  EngineSessionLimitError,
  isSessionLimitError,
  isEngineDetachedError,
  UNRESUMABLE_SESSION_MARKER,
  unwrapBridgeArgs,
  type EngineEvent,
  type EngineHomeKey,
  type EngineHomeType,
  type ToolBridgeOptions,
  type ToolImpl,
} from '../engine';
import { GithubPrService, LocalGitService, type FeatureSandbox } from '../git';
import {
  CHAT_SURFACE,
  type ChatSurface,
  BLOCK_SINK,
  type BlockSink,
  TurnHarnessFactory,
  TASK_EVENT_SINK,
  type TaskEventSink,
  laneFor,
  webShipReviewCard,
} from '../surface';
import { CredentialResolver } from '../onboarding';
import { OauthUsageService } from '../onboarding/oauth-usage.service';
import { McpResolver, McpOAuthService } from '../mcp';
import { ConventionProfileResolver, type ResolvedConventions } from '../conventions';
import { SkillResolver } from '../skills';
import { LeaderElectionService } from '../cluster';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox';
// Direct path (not the '../sandbox' barrel, which doesn't re-export it) — mirrors the brain's import.
import { TurnRegistry } from '../sandbox/turn-registry.service';
import { BRIDGE_SERVER_NAME } from '../sandbox/image/bridge-options';
import type { ActiveTurnEntity, TaskItem, ThreadTerminalRecord } from '../persistence/entities';
import type { JobDispatcher } from '../brain';
import { TurnRunnerService } from '../runner';
import {
  Agent,
  renderAgentPrompt,
  ROTATION_PREAMBLE,
  ROTATION_SOFT_NUDGE,
  ROTATION_REMINDER_NUDGE,
  RECORD_LEG_HANDOFF_STOP,
} from '../prompt-kit';
import { isDriverExecutableKind, threadKindSpec } from '../thread-kind';
import { BuildShipService } from './build-ship.service';
import { PipelineAwarenessStore } from './pipeline-awareness.store';
import {
  LIVE_VERIFICATION_JUDGE,
  type LiveVerificationJudge,
  type LiveVerificationVerdict,
} from './live-verification-judge';
import {
  NON_RUNTIME_FILE_RE,
  renderLockedDecisionsSummary,
  renderTerminalRecordSummary,
} from './live-verification-support';
import {
  DriverStoreService,
  type DriverThread,
  type JobRoute,
  type ReviewChildThread,
} from './driver-store.service';
import { renderPlan, type PlannedStep } from './render-plan';
import {
  LegRotationWatch,
  resolveRotationThresholds,
  freshLegRotationState,
  type LegRotationRunState,
  type LegRotationThresholds,
} from './leg-rotation-watch';
import {
  DRIVER_REPO,
  type DriverRepoResolver,
  type ResolvedRepo,
} from './repo-resolver';
import { JobLifecycleService } from './job-lifecycle.service';
import { TicketService } from '../tickets';

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
  if (err instanceof EngineSessionLimitError) return false; // → parked on session limit
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
  /econnreset|econnrefused|etimedout|epipe|socket hang up|connection reset|connection refused|network error|no such container|container .*(not running|is not running|gone)|exec failed|failed to (start|create) (the )?container|redis|stream .*(closed|reset)|xread|503|502|temporarily unavailable|index\.lock|another git process seems to be running/;

/** The narrow brain surface the driver needs (Phase-3 halt wake) — resolved
 *  lazily to avoid the brain⇄driver module cycle. */
interface BrainSurface {
  /** Wake the job brain to triage a halted thread (ADR 0004 rider 4). The brain loads the job + terminal
   *  record itself and runs a trusted harness turn; a no-op if the thread is no longer owed a wake. */
  notifyThreadHalted(
    jobId: string,
    threadId: string,
    outcome: 'blocked' | 'incomplete' | 'failed',
    gen: number,
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
    // Host-side subscription usage snapshot — the session-limit park reads `getResetAt(orgId, rateLimitType)`
    // to seed the resume clock when the engine didn't surface a precise reset instant. @Global OnboardingModule.
    private readonly usage: OauthUsageService,
    private readonly mcp: McpResolver,
    // Host-authoritative MCP OAuth: before a build drive, refresh any near-expiry OAuth tokens and, if one
    // rotated, re-write the sandbox hub config so a long-lived warm sandbox picks up the fresh Bearer.
    private readonly mcpOAuth: McpOAuthService,
    // This repo's skills for build turns — forwarded on `RunTurnInput.skills` (rendered in-container as
    // SKILL.md the SDK loads), resolved for the 'build' surface exactly like `userMcpServers`.
    private readonly skills: SkillResolver,
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
    // Lazily resolves the brain (AgentSessionManager) for the Phase-3 halt wake,
    // dodging the brain⇄driver constructor cycle.
    private readonly moduleRef: ModuleRef,
    // The ADR-0005 live-verification judge — gates `complete_thread`'s `done` claim (see `gateLiveVerification`).
    @Inject(LIVE_VERIFICATION_JUDGE) private readonly liveVerificationJudge: LiveVerificationJudge,
    // Folds a Codex master-review thread's `task_create`/`task_update` bridge calls into its `tasks` column
    // (the SAME sink the Claude lanes' SDK TaskCreate/TaskUpdate use), so the web renders its checklist
    // identically. Claude builders keep using their native SDK task tools via the transcript harness.
    @Inject(TASK_EVENT_SINK) private readonly taskSink: TaskEventSink,
    // The repo's opt-in house-style profile — injected into every build-facing prompt (WORKER / gate /
    // commit) and forwarded on the run args so the in-container FAN_OUT writer subagents get it too.
    // @Optional so unit tests construct the driver without it (undefined → no house style injected); DI
    // (@Global ConventionsModule) supplies it live.
    @Optional() private readonly conventions?: ConventionProfileResolver,
    // The per-repo ticket board — a builder's `capture_ticket` drops a `bug` here for an out-of-scope defect
    // it found but is deferring (too big to fix inline, not a blocker). @Global TicketsModule; @Optional so
    // unit tests construct the driver without it (undefined → capture_ticket reports it's unavailable).
    @Optional() private readonly tickets?: TicketService,
  ) {}

  /** The repo's attached house-style, or null when none. Best-effort: a resolver hiccup never sinks a build. */
  private async repoConventionsFor(job: Job): Promise<ResolvedConventions | null> {
    if (!this.conventions) return null;
    return this.conventions.resolveForRepo(job.orgId, job.repoId).catch(() => null);
  }

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

  /** Sanity ceiling on a job's threads — a malformed plan can't drive an unbounded build. A code
   *  constant: the approved thread list is human-gated, so this is belt-and-braces, not a deploy knob. */
  private get maxThreads(): number {
    return 12;
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

  /** Wall-clock budget for the WHOLE diagnostics done-gate (every resume iteration combined), and the max
   *  number of resume iterations it gets. `PausableDeadline` is one-shot (`runTurnBounded` clears it in
   *  `finally`), so `runVerificationGate` creates a FRESH deadline per iteration sized to the remaining
   *  budget rather than reusing one — see `runVerificationGate`. */
  private readonly gateBudgetMs = 10 * 60_000;
  private readonly gateMaxIterations = 2;

  /**
   * The DISPATCH SEAM (the brain's "hands" edge). Take ownership of an approved, persisted job and kick
   * off the deterministic drive ASYNC — return promptly so the brain doesn't block on the whole build.
   * Errors inside the drive are caught + recorded (the job flips to `failed`), never surfaced here.
   */
  async dispatch(job: Job): Promise<void> {
    this.logger.log(
      `dispatch thread=${job.id} kind=${job.kind} title="${job.title}"`,
    );
    // HALT INVARIANT: never drive a halted job. dispatch does NOT clear the halt — only an explicit operator
    // re-engagement (retry/resumePaused) or a brain re-drive (redriveThread) may un-halt and re-drive.
    if (job.halt != null) {
      this.logger.warn(
        `dispatch job=${job.id} halted (${job.halt.kind}) — not driving`,
      );
      return;
    }
    // A fresh build cycle (a new plan approval) — clear any prior ship-review approval so this build's ship
    // re-gates. A re-drive AFTER ship-approval goes through `drive()` directly (not `dispatch`), preserving it.
    await this.store.clearShipApproval(job.id).catch(() => undefined);
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
    // Leg rotation is crash-safe WITHOUT a reattach handler: rotation only ever happens on a SELF-authored
    // handoff (`record_leg_handoff`, captured in-memory during the turn) and is committed by the ATOMIC
    // `completeLegRotation` (abandon-marker + NULL session_id + seed in one txn). A crash before that commit
    // simply resumes the fat session and re-nudges; a crash after re-folds the durable seed. There is no
    // in-flight read-only fallback turn to re-tail anymore, so no Stage-6 reattach step is needed here.
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
    // Resumes a credential/401 halt OR a session-limit park (the auto-resume sweep + the operator ping both
    // route here). Any other halt kind (or none) is ignored.
    if (!job || !['blocked_credentials', 'session_limit'].includes(job.halt?.kind ?? '')) {
      this.logger.warn(
        `resumePaused job=${jobId}: not a resumable halt (${job?.halt?.kind ?? 'gone'}) — ignoring`,
      );
      return;
    }
    this.logger.log(
      `resumePaused job=${jobId} — re-driving the halted session`,
    );
    // OPERATOR RE-ARM: a human resume re-grants Atlas's autonomous re-drive budget for any thread it exhausted
    // (a `blocked` thread `haltJob` rested). Boot `resume()` never re-arms — only explicit pings.
    const rearmed = await this.store.rearmHaltedThreads(jobId).catch(() => 0);
    if (rearmed) {
      this.logger.log(`resumePaused job=${jobId} — re-armed ${rearmed} halted thread(s)`);
    }
    // Clear the halt (only retry/resumePaused/redriveThread may un-halt) then re-drive the preserved phase.
    await this.store.clearJobHalt(jobId);
    // Clear the durable auto-resume clock too, so the leader sweep never re-fires this resume (no-op for a
    // credential resume that was never parked on the clock).
    await this.store.setSessionResume(jobId, null, null);
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
    if (!job.halt) {
      this.logger.warn(
        `retry job=${jobId}: not retryable (not halted) — ignoring`,
      );
      return;
    }
    this.logger.log(`retry job=${jobId} — re-driving a ${job.halt.kind} halt`);
    // OPERATOR RE-ARM: an explicit human retry re-grants Atlas its autonomous re-drive budget for any thread
    // it exhausted (a `blocked` thread rested by `haltJob`). Only the explicit operator paths re-arm — NOT
    // boot `resume()` — so the halt loop can't self-perpetuate.
    const rearmed = await this.store.rearmHaltedThreads(jobId).catch(() => 0);
    if (rearmed) {
      this.logger.log(`retry job=${jobId} — re-armed ${rearmed} halted thread(s)`);
    }
    // Clear the halt (the invariant: only retry/resumePaused/redriveThread may un-halt) and re-drive. The
    // status flip is a no-op in practice — a halt is only ever recorded mid-drive, i.e. while `running` — but
    // it self-heals any drifted/backfilled phase so `runJob`'s `running` gate lets the re-drive through.
    await this.store.clearJobHalt(jobId);
    // A Force-resume of a session-limit park routes through here — clear the durable auto-resume clock so the
    // leader sweep never re-fires (harmless no-op for a non-parked retry).
    await this.store.setSessionResume(jobId, null, null);
    await this.store.setJobStatus(jobId, 'running');
    void this.drive(jobId).catch((err) => {
      this.logger.error(
        `retry job=${jobId} crashed: ${err instanceof Error ? err.stack : err}`,
      );
    });
  }

  /**
   * Phase 3 (ADR 0004 rider 4) — the brain's AUTONOMOUS re-drive of a halted thread (the `retry_thread` tool).
   * Distinct from `retry` (which no-ops on a `blocked` job that stays `running`). Owns the whole precondition
   * chain atomically so a claim never outlives a no-op (Codex review High-1/High-2):
   *   1. `active` guard — refuse (not spend budget) if the job is being driven right now;
   *   2. job exists;
   *   3. the thread BELONGS to this job — never clear/mutate another job's thread on a hallucinated/stale id;
   *   4. claim the bounded re-drive budget (only now that we WILL re-drive) when `cap` is given.
   * Then: clear the stale terminal record + halt signal, inject the brain's fix `guidance` into the thread's
   * orientation cheat-sheet (the read hook `renderBatchTask` already honours), flip the job back to `running`,
   * and re-enter the resumable drive. Returns a discriminated result so the brain knows whether to escalate.
   */
  async redriveThread(
    jobId: string,
    threadId: string,
    guidance?: string,
    cap?: number,
  ): Promise<{ ok: boolean; attempt?: number; reason?: string }> {
    if (this.active.has(jobId)) {
      return { ok: false, reason: 'the build is running right now — retry momentarily' };
    }
    const job = await this.store.loadJob(jobId).catch(() => null);
    if (!job) return { ok: false, reason: 'job not found' };
    const ownerJobId = await this.store.threadJobId(threadId).catch(() => null);
    if (ownerJobId !== jobId) {
      this.logger.warn(
        `redriveThread job=${jobId}: thread ${threadId} belongs to ${ownerJobId ?? '(gone)'} — refusing`,
      );
      return { ok: false, reason: `thread ${threadId} is not part of this job` };
    }
    // Refuse to redrive a thread that already finished. A stale `retry_thread` (the brain acting on an old view)
    // must not clear the terminal record + flip the thread back to `executing` — that would erase the very
    // `done` evidence the drive short-circuits on and re-run a completed thread. Bail BEFORE consuming budget.
    const current = await this.store.getThread(threadId).catch(() => null);
    if (current?.status === 'done') {
      this.logger.warn(
        `redriveThread job=${jobId}: thread ${threadId} already done — refusing (won't resurrect a completed thread)`,
      );
      return { ok: false, reason: `thread ${threadId} is already complete` };
    }
    let attempt = 0;
    if (cap != null) {
      const claim = await this.store.claimHaltFixAttempt(threadId, cap);
      if (!claim.ok) {
        return { ok: false, reason: `re-drive budget exhausted (${claim.used}/${cap})` };
      }
      attempt = claim.used;
    }
    await this.store.clearTerminalRecord(threadId).catch(() => undefined);
    await this.store.clearHalt(threadId).catch(() => undefined);
    // Clear the JOB-level phase-preserving halt too (budget-aware recovery path): the brain's authorized
    // re-drive must lift the halt or `runJob`/`drive`'s halt gate would refuse to re-drive.
    await this.store.clearJobHalt(jobId).catch(() => undefined);
    await this.store.setThreadStatus(threadId, 'executing').catch(() => undefined);
    await this.store.setThreadCondition(threadId, 'none').catch(() => undefined);
    if (guidance) {
      await this.store.setThreadOrientation(threadId, guidance).catch(() => undefined);
    }
    if (job.status !== 'running') {
      await this.store.setJobStatus(jobId, 'running').catch(() => undefined);
    }
    this.logger.log(
      `redriveThread job=${jobId} thread=${threadId} — re-driving with brain guidance (attempt ${attempt})`,
    );
    void this.drive(jobId).catch((err) =>
      this.logger.error(
        `redriveThread drive job=${jobId} crashed: ${err instanceof Error ? err.stack : err}`,
      ),
    );
    return { ok: true, attempt };
  }

  /**
   * Phase 3 (ADR 0004 rider 4) — deliver any OWED thread-halt brain wakes. Called from `drive()` once a job
   * leaves the active window (one job) and from the leader boot sweep (all jobs). For each owed thread: wake
   * the brain to triage the halt, then stamp the dedup marker (generation-keyed CAS). Fire-and-forget per
   * thread; a wake-turn failure leaves the marker un-stamped so the boot sweep re-fires (at-least-once).
   */
  async deliverOwedHaltWakes(jobId?: string): Promise<void> {
    const owed = await this.store.threadsAwaitingHaltWake(jobId).catch(() => []);
    for (const t of owed) {
      void this.deliverOneHaltWake(t).catch((err) =>
        this.logger.warn(
          `halt wake failed for thread=${t.threadId} (boot sweep will retry): ${err}`,
        ),
      );
    }
  }

  private async deliverOneHaltWake(t: {
    jobId: string;
    threadId: string;
    gen: number;
    outcome: 'blocked' | 'incomplete' | 'failed';
  }): Promise<void> {
    const brain = await this.brain();
    // The stamp is NOT here — the brain stamps `halt_waked_at` on the wake turn's SUCCESS tail (keyed by the
    // captured `gen`), so a wake turn that fails/steers/detaches leaves the halt owed for the sweeps to retry.
    await brain.notifyThreadHalted(t.jobId, t.threadId, t.outcome, t.gen);
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
        // A credential/401 halt — HALT (don't fail): the phase is preserved and the unfinished step's
        // session_id is persisted, so a ping (`resumePaused`) continues the SAME session once creds are
        // fixed. Re-driving now would just 401 again, so we wait for the human.
        this.logger.warn(
          `job=${jobId} halted on credential error: ${err.message}`,
        );
        await this.store
          .setJobHalt(jobId, {
            kind: 'blocked_credentials',
            reason: err.message,
            at: new Date().toISOString(),
          })
          .catch(() => undefined);
        await this.relayPaused(jobId, err);
      } else if (isSessionLimitError(err)) {
        // A Claude subscription SESSION/USAGE limit — PARK (don't fail): the phase is preserved and the
        // unfinished step's session_id was persisted at the throw, so the lane resumes the SAME session. It
        // auto-resumes once the reset passes (the leader `SessionResumeSweep` → `resumePaused`) or on an
        // operator Force-resume (`POST …/retry`). Do NOT consume `halt_fix_attempts` — this isn't a build failure.
        const limit = err as EngineSessionLimitError;
        this.logger.warn(`job=${jobId} parked on session limit: ${limit.message}`);
        const job = await this.store.loadJob(jobId).catch(() => null);
        const orgId = job?.orgId;
        // Resume-clock precedence (d5): the engine's precise reset instant → the org's harvested usage window.
        const resumeAt =
          limit.resetAt ?? (orgId ? this.usage.getResetAt(orgId, limit.rateLimitType) : undefined);
        // A structured `rateLimitType` means the reset came from the usage frame/API; its absence means the
        // engine fell back to parsing the CLI's printed "resets …" string.
        const resetSource: 'usage_api' | 'parsed_string' = limit.rateLimitType ? 'usage_api' : 'parsed_string';
        const at = new Date().toISOString();
        await this.store
          .setJobHalt(jobId, {
            kind: 'session_limit',
            reason: limit.message,
            at,
            ...(resumeAt ? { resumeAt } : {}),
          })
          .catch(() => undefined);
        await this.store
          .setSessionResume(jobId, resumeAt ?? null, {
            lane: 'build',
            reason: limit.message,
            resetSource,
          })
          .catch(() => undefined);
        await this.relaySessionLimitPaused(jobId, resumeAt);
      } else {
        this.logger.error(
          `job=${jobId} failed: ${err instanceof Error ? err.stack : err}`,
        );
        await this.store
          .setJobHalt(jobId, {
            kind: 'failed',
            reason: shortReason(err),
            at: new Date().toISOString(),
          })
          .catch(() => undefined);
        // RELAY the failure into the thread — a failed job must never dead-end silently (issue #2).
        await this.relayFailure(jobId, err);
      }
    } finally {
      this.active.delete(jobId);
    }
    // Phase 3 (ADR 0004 rider 4): the owed thread-halt brain wake is delivered by the PERIODIC sweep
    // (`startChatDeliverySweep` → `deliverOwedHaltWakes`), NOT fired inline here. Live validation showed an
    // eager inline wake (≈7s after the build turn ends) systematically errors with `error_during_execution`:
    // it resumes the brain session while `dispatch_build`'s compaction turn is still nulling/rewriting it (see
    // engine-core's session-resume note). The sweep fires once the session has settled and works reliably; it
    // also runs strictly outside any active drive, so a brain `retry_thread` → `redriveThread` re-enters
    // cleanly. The boot sweep backstops a crash. (deliverOwedHaltWakes stays a public seam for both sweeps.)
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
   * Post a "parked on a session/usage limit" notice (build lane). Mirrors {@link relayPaused} (durable-first
   * via the block sink, best-effort live post on top) but marks the block `sessionLimit` so the UI can render
   * the park + its Force-resume affordance. The text is STABLE (no live now-timestamp) so a re-drive that
   * re-parks the same limit dedupes against the last notice instead of stacking near-identical boxes.
   */
  private async relaySessionLimitPaused(jobId: string, resumeAt?: string): Promise<void> {
    const text = `You've hit your session limit — resets ${resumeAt ? fmtReset(resumeAt) : 'soon'}. Auto-resumes then; use Force resume now to resume earlier.`;
    await this.blockSink
      .appendBlock(jobId, {
        kind: 'chat',
        text,
        meta: {
          source: 'system_operator',
          severity: 'warning',
          sessionLimit: true,
          ...(resumeAt ? { resumeAt } : {}),
        },
      })
      .catch((e) =>
        this.logger.error(`could not durably record session-limit park for job=${jobId}: ${e}`),
      );
    try {
      const job = await this.store.loadJob(jobId);
      const route = await this.store.route(job);
      await this.post(route, text);
    } catch (e) {
      this.logger.warn(`could not live-relay session-limit park for job=${jobId}: ${e}`);
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
    // HALT INVARIANT: a halted job is NEVER driven — the single chokepoint. `halt` is cleared only by an
    // operator re-engagement (retry/resumePaused) or a brain re-drive (redriveThread), which re-enter here.
    if (job.halt != null) {
      this.logger.warn(
        `job=${jobId} halted (${job.halt.kind}) — not driving`,
      );
      return;
    }
    const record = await this.store.decisionRecord(job.decisionRecordId);
    const route = await this.store.route(job);
    const repo = await this.repos.resolve(job);
    const sandbox = await this.ensureSandbox(job);
    await this.refreshOAuthHubIfRotated(job);

    this.logger.log(
      `job=${jobId} on branch ${sandbox.branch} @ ${sandbox.worktreePath}`,
    );

    const allSections = await this.store.threadsForJob(jobId);
    // EXECUTABLE-KIND SELECTOR (Codex BLOCK): the driver's top loop drives ONLY driver-executable kinds
    // (`builder` + `master_review`). `main`/`plan_review` are render-only rows (their runtime lives in the
    // brain / codex_reviews — the driver never executes them), and `review_lens`/`post_review` are driven as
    // CHILDREN of their builder, never entered here. `threadsForJob` returns every row, so this gate is what
    // keeps the non-executable rows out of the section loop once they exist.
    const executable = allSections.filter((s) => isDriverExecutableKind(s.kind));
    // DIRECT-BUILD / NON-DRIVER GUARD: a job with NO driver-executable threads (`builder`/`master_review`) is
    // not a driver build — it's a brain-owned DIRECT build (only a render-only `main` thread), which implements
    // and opens its OWN PR via the `finalize_build` tool. The driver must not touch it: a reconciler re-drive
    // (boot `resume()`, `retry`, etc.) of a still-`running` direct build would otherwise fall through the empty
    // thread loop to the SHIP GATE and wrongly PARK it at `awaiting_ship_review` (a spurious "Ship it" card) —
    // or, past the gate, re-ship it. Every legitimately-dispatched driver build always carries >=1 builder + a
    // master_review, so this only ever short-circuits brain-owned jobs the driver has nothing to build/ship for.
    if (executable.length === 0) {
      this.logger.log(
        `job=${jobId} has no driver-executable threads (brain-owned/direct build) — driver yielding, nothing to build or ship`,
      );
      return;
    }
    // Cap the BUILDER lanes at MAX_SECTIONS, but NEVER drop the master-review thread (it rides on top of the
    // builders and must always run last) — partition by kind, cap the builders, re-append the review last.
    const featureSections = executable.filter((s) => s.kind === 'builder');
    const reviewSections = executable.filter((s) => s.kind === 'master_review');
    const cappedFeatures = featureSections.slice(0, this.maxThreads);
    const threads = [...cappedFeatures, ...reviewSections];
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
      // LEADERSHIP FENCE: drives are fire-and-forget and NOT gated on leadership mid-flight (see
      // LeaderElectionService), so a leader demoted mid-build (connection blip → a standby promotes and
      // re-drives this same `running` job) would keep driving it — two processes on one worktree/branch.
      // Re-check the ONE shared master lease at each thread boundary and yield if we're no longer leader:
      // a bare `return` leaves the job `running` (NO status write, mirrors the halt-path return below), and
      // the current leader re-drives it (promote-time `resume()` + the reap-tick backstop). Yielding is a
      // cooperative stop, NOT an error — never throw here (a throw on a follower would mark the job failed).
      if (!this.election.isLeader()) {
        this.logger.warn(
          `job=${job.id} lost leadership mid-drive — yielding (a leader will re-drive; job left running)`,
        );
        return;
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
        // to a needs-you state, record the owed brain wake + trail, and SKIP finalizeBuild — no PR on an
        // unfinished build. The brain wake fires from `drive()` once the job leaves the active window.
        await this.haltJob(job, route, thread, res.outcome);
        return;
      }
      handoff = res.handoff;
    }

    // LEADERSHIP FENCE (ship): never open/publish the PR from a process that has lost leadership. finalizeBuild
    // is idempotent (latches by branch / finds the existing PR), so the current leader's re-drive fast-forwards
    // the done threads and ships. Yield without a status write — the job stays `running`.
    if (!this.election.isLeader()) {
      this.logger.warn(
        `job=${job.id} lost leadership before ship — yielding (a leader will re-drive; job left running)`,
      );
      return;
    }
    // SHIP-REVIEW GATE (the terminal human gate): for driver builds (feature/bugfix), all builders +
    // master review are now `done` but nothing is committed-for-ship/pushed/PR'd yet. Park and wait for the
    // operator to eyeball the diff and click "Ship it" before opening the PR. `job` was loaded at the top of
    // runJob, so `shipReviewApprovedAt` reflects the click that re-drove us: null → park + return (no ship);
    // set → fall through and ship. `resolveShipApprovalDurably` flips back to `running` + re-drives, so this
    // re-reaches finalizeBuild (the done threads fast-forward). Other kinds ship straight through as before.
    if (shipGateApplies(job) && job.shipReviewApprovedAt == null) {
      await this.parkForShipReview(job, route);
      return;
    }
    await this.finalizeBuild(job, record, route, repo, sandbox);
  }

  /**
   * Park the job at the ship-review gate: flip `running → awaiting_ship_review` + post the durable "Ship it"
   * card (one txn, single-park-guarded in the store), then a live notice + a passive brain milestone. A
   * concurrent drive that already parked it makes this a no-op (store returns false).
   */
  private async parkForShipReview(job: Job, route: JobRoute): Promise<void> {
    const title = job.title ?? 'this build';
    const summary =
      'All threads built and master review passed. Review the diff, then click **Ship it** to open the PR.';
    const card = webShipReviewCard({ jobId: job.id, title, summary });
    const parked = await this.store.parkForShipReview(
      job.id,
      card as unknown as Record<string, unknown>,
      summary,
    );
    if (!parked) return;
    this.logger.log(`job=${job.id} parked at ship-review gate — awaiting operator "Ship it"`);
    await this.post(
      route,
      `:mag: Build reviewed — ready to ship *${title}*. Review the diff, then click *Ship it* to open the PR.`,
    ).catch(() => undefined);
    await this.recordMilestone(
      job.id,
      `ship-review:${job.id}`,
      'The build finished and passed master review; it is parked awaiting your ship-review approval before the PR opens.',
    ).catch(() => undefined);
  }

  /**
   * SHIP-REVIEW APPROVAL (the "Ship it" click, routed here by the web surface bridge). Stamp the approval
   * marker + flip `awaiting_ship_review → running` (idempotent in the store — acts only while parked, so a
   * stale/double click is a no-op), then re-drive: `runJob` fast-forwards the `done` threads, re-reaches the
   * gate with the marker now set, and ships. Returns whether it acted.
   */
  async resolveShipApprovalDurably(jobId: string, ruledBy: string): Promise<boolean> {
    const acted = await this.store.approveShip(jobId);
    if (!acted) {
      this.logger.warn(
        `ship approval for job=${jobId} by ${ruledBy}: not awaiting ship review — no-op`,
      );
      return false;
    }
    this.logger.log(`ship approval for job=${jobId} by ${ruledBy} — re-driving to ship`);
    await this.blockSink
      .appendBlock(jobId, {
        kind: 'chat',
        text: ':rocket: Shipping — opening the pull request.',
        meta: { source: 'system_operator' },
      })
      .catch(() => undefined);
    void this.drive(jobId).catch((err) =>
      this.logger.error(
        `ship-approve drive job=${jobId} crashed: ${err instanceof Error ? err.stack : err}`,
      ),
    );
    return true;
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
    const haltOutcome = outcome as 'blocked' | 'incomplete' | 'failed';
    let text: string;
    let severity: 'warning' | 'error' = 'warning';
    // A `blocked` thread whose AUTONOMOUS re-drive budget is spent is no longer something Atlas can recover on
    // its own — it's waiting on the operator. Rest the job instead of leaving it `running`: no owed wake is
    // recorded (`owedWake=false`), so the periodic/boot sweeps stop re-waking the brain to re-escalate a halt
    // it has no budget left to fix (the pre-fix behavior — a wasted brain turn on every boot). `paused` also
    // lights the needs-you dot; `resumePaused`/`retry` re-arm the budget when the operator re-engages.
    let owedWake = true;
    const at = new Date().toISOString();
    if (outcome === 'failed') {
      const why = term?.failure
        ? `${term.failure.kind} failed${term.failure.command ? ` (\`${term.failure.command}\`)` : ''}${
            term.failure.stderrTail ? `:\n${term.failure.stderrTail.slice(0, 500)}` : ''
          }`
        : (term?.summary ?? 'the thread reported a failure');
      await this.store
        .setJobHalt(job.id, { kind: 'failed', reason: why, at })
        .catch(() => undefined);
      text = `:x: Build failed in *${thread.brief}* — ${why}\n_The job is marked failed; reply in this thread to retry or adjust._`;
      severity = 'error';
    } else if (outcome === 'blocked') {
      const spent = await this.store.haltFixAttempts(thread.id).catch(() => 0);
      if (spent >= HALT_FIX_ATTEMPT_CAP) {
        // Autonomous budget exhausted → rest the job for the operator (no more brain wakes owed).
        const reason = term?.blocked?.detail ?? 'needs your input';
        await this.store
          .setJobHalt(job.id, { kind: 'budget_exhausted', reason, at })
          .catch(() => undefined);
        owedWake = false;
        text = `:raising_hand: Thread blocked — *${thread.brief}*: ${reason}. Atlas has used its ${HALT_FIX_ATTEMPT_CAP} autonomous fix attempts — *paused for you*. Reply or resume to re-arm and retry.`;
      } else {
        // Budget remains: job stays `running`; the thread is `awaiting_input` (Phase 3 wakes the brain to fix).
        text = `:raising_hand: Thread blocked — *${thread.brief}*: ${term?.blocked?.detail ?? 'needs your input'}.`;
      }
    } else {
      // incomplete
      const reason = `${thread.brief} ended without asserting completion (no complete_thread)`;
      await this.store
        .setJobHalt(job.id, { kind: 'incomplete', reason, at })
        .catch(() => undefined);
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
    // Phase 3 (ADR 0004 rider 4): AFTER the operator-facing relay, record the "a halt is owed a brain wake"
    // signal + render the durable trail. Both complete before `haltJob` returns — i.e. before `drive()` fires
    // the wake from outside the active window — so the brain sees an owed halt + a readable completion.md.
    // NOT swallowed (Codex review Medium-2): this is the load-bearing signal the sweeps key on — a silent
    // failure here would leave a `failed`/`incomplete` halt (job no longer `running`) permanently un-woken.
    // Log loudly so it's diagnosable; the durable card above still gives the operator a visible halt.
    // SKIPPED when `owedWake` is false — a `blocked` thread with an exhausted budget is now RESTED (`paused`)
    // for the operator; owing a wake would just re-wake the brain to re-hit the same refusal every boot.
    if (owedWake) {
      await this.store
        .setHaltOwed(thread.id, haltOutcome)
        .catch((e) =>
          this.logger.error(
            `FAILED to record owed halt-wake for thread=${thread.id} (${haltOutcome}) — brain will NOT be woken: ${e}`,
          ),
        );
    }
    await this.writeCompletionMd(job, thread, haltOutcome, term).catch((e) =>
      this.logger.warn(`could not write completion.md for thread=${thread.id}: ${e}`),
    );
  }

  /** Render + write the durable halt trail to `<contextDirHost>/generated/threads/<ordinal>-<slug>/completion.md`
   *  (host-written projection like the other `/context/generated` renders — `decision-record.md`,
   *  `deviations.md` — read-only in-sandbox and surfaced in the operator UI, a host-side projection, so it
   *  never lands in the git worktree). NOT committed (the halted batch is un-committed + resumable; the
   *  DB `terminal_record` is the durable source, this is its human-readable projection). Best-effort; never
   *  blocks the halt. */
  private async writeCompletionMd(
    job: Job,
    thread: DriverThread,
    outcome: 'blocked' | 'incomplete' | 'failed',
    term: ThreadTerminalRecord | null,
  ): Promise<void> {
    const dir = join(
      this.threadLifecycle.contextDirHost(job.id, job.orgId),
      'generated',
      'threads',
      threadDirName(thread),
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'completion.md'),
      renderCompletionMd(thread, outcome, term, new Date().toISOString()),
      'utf8',
    );
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
    // Phase 3 (ADR 0004 rider 4): a thread with an EXISTING `blocked` terminal record is OWNED by the brain.
    // A plain (re-)drive — e.g. boot resume, which re-drives every `running` job, and a `blocked` thread
    // leaves the job `running` — must NOT re-run the orchestrator on it: that RACES the brain's own
    // wake-driven recovery (observed live producing a chaotic double-recovery — boot resume shipped while the
    // brain triaged the same halt). Re-halt instead, which re-establishes the owed wake. Only `redriveThread`
    // re-runs a blocked thread, and it CLEARS the record first, so this short-circuit is skipped after a
    // genuine brain-authorized retry.
    //
    // This applies to EVERY kind, master_review included. It once carried a `!thread.isMasterReview` exemption
    // — harmless while the Codex master-review turn had no host tool bridge (it COULDN'T write a `blocked`
    // record). Once Codex gained `block_thread` via the in-sandbox MCP bridge (commit a2a06b2), the exemption
    // became a live runaway hole: a master-review that voluntarily blocks (e.g. the full test suite is red for
    // a reason outside its diff, so it can never satisfy the green-build completion bar) leaves the job
    // `running`, and every boot resume re-ran the WHOLE Codex review — bypassing the brain's bounded re-drive
    // budget (`HALT_FIX_ATTEMPT_CAP`) entirely — which re-hit the same un-fixable blocker and re-blocked,
    // forever. Routing it through the same re-halt path caps the retry at the brain's budget like any other
    // thread. (Live-observed on job 43705139 — the master review "blocked again" hundreds of times.)
    const prior = await this.store.getTerminalRecord(thread.id).catch(() => null);
    if (prior?.status === 'blocked') {
      this.logger.log(
        `thread ${thread.ordinal} "${thread.brief}" — already blocked; re-halting (the brain owns the retry)`,
      );
      await this.store
        .setThreadCondition(thread.id, 'paused')
        .catch(() => undefined);
      return { outcome: 'blocked', handoff: null };
    }

    // A thread already `done` must NOT be re-run. The runJob loop skips `done` threads from its start-of-run
    // snapshot, but that snapshot goes stale: a duplicate/overlapping drive (e.g. a restart-spawned leader
    // re-driving a still-`running` job) can hold a pre-completion view and re-enter this thread. Re-running
    // it re-executes the (already-committed) step AND re-seeds its finalized review agents back to `pending`
    // — observed live freezing a done thread half-reviewed. Re-read the LIVE status and fast-forward if done,
    // carrying the persisted handoff exactly like the loop's skip (`handoffOut ?? handoff`).
    const live = await this.store.getThread(thread.id).catch(() => null);
    if (live?.status === 'done') {
      this.logger.warn(
        `thread ${thread.ordinal} "${thread.brief}" — already done (stale/overlapping drive); fast-forwarding`,
      );
      return { outcome: 'done', handoff: live.handoffOut ?? handoffIn };
    }
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

    // e. EXECUTE — run each step as a fresh session on the shared feature branch. Capture the thread's start
    //    HEAD ONCE and persist it — the review diff (`sectionStartSha..HEAD`) and commit-recording both scope
    //    by it, so re-capturing on a RESUME (after the thread already committed) would collapse it to HEAD →
    //    empty range → the review is silently skipped and the commit mis-recorded as `(nothing)`.
    const sectionStartSha = await this.resolveThreadStartSha(thread, sandbox);
    await this.store.setThreadStatus(thread.id, 'executing');
    // Clear any stale halt overlay from a prior run — this (re)start of the turn puts the step back on the
    // linear ladder, so a resumed/retried thread must not keep a persisted 'incomplete'|'failed'|'paused'.
    await this.store.setThreadCondition(thread.id, 'none').catch(() => undefined);
    const { outcome, reports } = await this.executeSteps(
      job, route, sandbox, thread, record, repo, sectionStartSha,
    );

    // The thread did NOT assert `done` (no `complete_thread`, an explicit block, or a failure) — HALT here:
    // skip auto-fix + handoff, set the thread status, and let runJob relay + skip finalize. NEVER fall through
    // to the done path (ADR 0004: a clean turn is not evidence of completion).
    if (outcome !== 'done') {
      // Leave the STEP at `executing` (where it halted) and record the halt on the orthogonal condition
      // overlay instead. `outcome` here is 'blocked' | 'incomplete' | 'failed'; the latter two are valid
      // conditions verbatim, and 'blocked' maps to the operator-pause condition 'paused'.
      const condition: ThreadCondition =
        outcome === 'blocked' ? 'paused' : outcome;
      await this.store.setThreadCondition(thread.id, condition).catch(() => undefined);
      this.logger.warn(`thread ${thread.ordinal} "${thread.brief}" halted — ${outcome}`);
      return { outcome, handoff: null };
    }

    // f. REVIEW CHILDREN — materialize this builder's review lenses + post-review as real CHILD threads and
    // drive them (lenses concurrently, then the fix). Each lens is its own row with its own status +
    // findings — no shared jsonb, so the "stuck at reviewing" lost-update race is gone. SKIPPED for the
    // master-review thread (it IS the review — a whole-diff Codex review-and-fix — so a per-thread pass over
    // it is redundant): its spec declares no children, so `runReviewChildren` is a no-op there anyway.
    if (threadKindSpec(thread.kind).children) {
      await this.runReviewChildren(job, route, sandbox, thread, record, sectionStartSha, repo);
    }

    // e. HANDOFF — summarize what this thread produced for the next.
    const handoffOut = this.summarizeHandoff(thread, steps, reports);
    await this.store.setThreadHandoffOut(thread.id, handoffOut);
    await this.store.setThreadStatus(thread.id, 'done');
    await this.store.setThreadCondition(thread.id, 'none').catch(() => undefined);
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
   * Drive a builder's post-build review as CHILD threads (everything is a typed thread). Materialize the
   * builder's `review_lens` × N + `post_review` child rows (idempotent across resume / a concurrent drive),
   * run the lenses CONCURRENTLY — each persisting its OWN status + full `review_findings` on its OWN row (no
   * shared array → no lost-update "stuck at reviewing" race) — then run the `post_review` fix pass over the
   * deduped, severity-filtered union of the lenses' findings. Best-effort end-to-end: a review/fix failure
   * marks that child failed but NEVER halts the build (parity with the old swallow-and-continue auto-fix
   * stage); the builder still advances to `done`. Run-exactly-once no longer needs a claim — the top-of-
   * `runThread` live-`done` short-circuit stops a done builder being re-entered, and each child fast-forwards
   * on its own `done` status; the `(job_id, parent_thread_id, ordinal)` unique index rejects duplicate rows.
   */
  /**
   * Resolve the thread's start HEAD, RESUME-SAFE. On the first execute the persisted `start_sha` is null, so
   * capture live HEAD and set-once persist it; on a resume read the stored value back instead of re-capturing
   * (a fresh capture after the thread committed would equal HEAD → an empty review range + a `(nothing)`
   * commit mis-record). Falls back to a live capture if `headSha` fails and nothing was persisted yet
   * (best-effort, mirroring the prior call site). Keeps the in-memory `thread` snapshot consistent for this run.
   */
  private async resolveThreadStartSha(
    thread: DriverThread,
    sandbox: FeatureSandbox,
  ): Promise<string | undefined> {
    if (thread.startSha) return thread.startSha;
    const head = await this.git.headSha(sandbox.worktreePath).catch(() => undefined);
    if (!head) return undefined;
    const persisted = await this.store.ensureThreadStartSha(thread.id, head).catch(() => head);
    thread.startSha = persisted;
    return persisted;
  }

  private async runReviewChildren(
    job: Job,
    route: JobRoute,
    sandbox: FeatureSandbox,
    thread: DriverThread,
    record: DecisionRecord | null,
    sectionStartSha: string | undefined,
    repo: ResolvedRepo,
  ): Promise<void> {
    const spec = threadKindSpec(thread.kind);
    if (!spec.children) return;
    // The review window: show the builder `auto_fixing` (the unchanged web affordance) while children run.
    await this.store.setThreadStatus(thread.id, 'auto_fixing').catch(() => undefined);

    const childSpecs = spec.children({ id: thread.id, config: {} });
    const children = await this.store
      .materializeReviewChildren(
        { id: thread.id, jobId: job.id, orgId: thread.orgId },
        childSpecs,
      )
      .catch((err) => {
        this.logger.warn(`review-children materialize failed (skipping review): ${err}`);
        return [] as ReviewChildThread[];
      });
    if (children.length === 0) return;

    const lensChildren = children.filter((c) => c.kind === 'review_lens');
    const postReview = children.find((c) => c.kind === 'post_review');
    const channel = route.channel ?? job.repoId;

    // The shared review context — derive the diff ONCE and share it across every lens + the fix turn.
    const baseCtx: AutoFixContext = {
      worktreePath: sandbox.worktreePath,
      sandboxKey: jobHomeKey(job, 'autofix'),
      ...(sectionStartSha ? { gitRange: `${sectionStartSha}..HEAD` } : {}),
      intent: `${record?.overview ?? ''}\n\nSection: ${thread.brief}`.trim(),
      label: thread.brief,
      // Streaming identity — ride the shared transcript spine on `autofix:<threadId>:*` lanes (unchanged).
      jobId: job.id,
      channel,
      // Org/repo for house-style resolution — the review/fix lenses render their own system prompts, so
      // they resolve `repos.convention_profile_slug` themselves (the stage has no driver context otherwise).
      orgId: job.orgId,
      repoId: job.repoId,
      autofixId: thread.id,
      scope: 'thread',
      // The fix turn commits + pushes its own work now — give it the authenticated remote (same as the
      // builder/gate/master-review turns carry).
      gitAuth: { gitUrl: repo.projectRepo.gitUrl, token: repo.token },
      ...(sandbox.containerId
        ? {
            containerId: sandbox.containerId,
            ...(sandbox.execUser ? { execUser: sandbox.execUser } : {}),
          }
        : {}),
    };
    const ctx = await this.autofix.ensureContextDiff(baseCtx).catch(() => baseCtx);

    // ANCHOR — same web contract as before: the `autofix_anchor` row + change-signal post (the review card
    // latches `meta.autofixAnchor`; each lens/fix turn streams on `autofix:*` lanes).
    await this.postAutofixAnchor(job, route, {
      autofixId: thread.id,
      scope: 'thread',
      label: thread.brief,
      lensIds: lensChildren.map((c) => String((c.config as { lensId?: string }).lensId ?? c.id)),
    });

    // Empty diff → nothing to review: mark every non-done child `done` (idempotent) and skip the turns. Post
    // a short notice on each child's lane FIRST, so a skipped review reads as an explicit "nothing to review"
    // line in its pane rather than a silent blank (the symptom that hid a stale-`start_sha` empty range).
    if (!ctx.changedFiles?.length) {
      const notice = `No changes to review in this section (empty diff for "${thread.brief}") — this review was skipped.`;
      for (const c of children) {
        if (c.status === 'done') continue;
        const sub =
          c.kind === 'review_lens'
            ? { lensId: String((c.config as { lensId?: string }).lensId ?? c.id) }
            : { fix: true as const };
        await this.autofix.emitReviewNotice(ctx, sub, notice).catch(() => undefined);
        if (c.kind === 'review_lens') {
          await this.store.setThreadReviewFindings(c.id, []).catch(() => undefined);
        }
        // The review lifecycle genuinely completed (there was nothing to review), so the STEP is `done` —
        // this keeps the `=== 'done'` resume-idempotency guards intact — while `skipped` carries the
        // "nothing to do" overlay that used to live in the status value.
        await this.store.setThreadStatus(c.id, 'done').catch(() => undefined);
        await this.store.setThreadCondition(c.id, 'skipped').catch(() => undefined);
      }
      return;
    }

    // Drive the LENSES concurrently (capped) — each an independent row (a `done` lens fast-forwards).
    const concurrency = 3;
    for (let i = 0; i < lensChildren.length; i += concurrency) {
      const batch = lensChildren.slice(i, i + concurrency);
      await Promise.all(batch.map((c) => this.runOneReviewLens(ctx, c)));
    }

    // Then the POST-REVIEW fix pass over the deduped, severity-filtered union of the lenses' findings.
    if (postReview && postReview.status !== 'done') {
      await this.runPostReview(ctx, thread, postReview);
    }

    // Passive milestone: the review pass is transient (builder flips to `done` next), so record it.
    await this.recordMilestone(
      job.id,
      `thread:${thread.id}:autofix`,
      `Post-build review + fix pass ran over the diff for thread "${thread.brief}".`,
    );
  }

  /**
   * Run ONE `review_lens` child: mark it running, run the lens's read-only review turn, and persist its full
   * findings + terminal status on its OWN row. Never throws — a lens failure is isolated to its row (marked
   * `failed`), never blocking its siblings or the build. A lens already `done` (resume) fast-forwards.
   */
  private async runOneReviewLens(ctx: AutoFixContext, child: ReviewChildThread): Promise<void> {
    if (child.status === 'done') return;
    const lensId = String((child.config as { lensId?: string }).lensId ?? '');
    const lens = lensById(lensId);
    if (!lens) {
      this.logger.warn(`review-lens child ${child.id} has unknown lensId "${lensId}" — skipping`);
      // Terminal `done` (matching the empty-diff skip) — nothing to review, so the step genuinely completed;
      // this keeps the `=== 'done'` resume-idempotency guard intact while `skipped` carries the overlay.
      await this.store.setThreadStatus(child.id, 'done').catch(() => undefined);
      await this.store.setThreadCondition(child.id, 'skipped').catch(() => undefined);
      return;
    }
    await this.store.setThreadStatus(child.id, 'executing').catch(() => undefined);
    // Clear any stale halt overlay from a prior run before (re)running the lens's turn.
    await this.store.setThreadCondition(child.id, 'none').catch(() => undefined);
    try {
      const findings = await this.autofix.runReviewLens(ctx, lens);
      await this.store.setThreadReviewFindings(child.id, findings);
      await this.store.setThreadStatus(child.id, 'done');
      await this.store.setThreadCondition(child.id, 'none').catch(() => undefined);
    } catch (err) {
      this.logger.warn(`review lens "${lensId}" failed (continuing): ${err}`);
      // Persist the reason on the lens's OWN lane so its pane explains itself instead of showing a
      // blank (the turn died before streaming, so `abort()` persisted only the prompt snapshot).
      await this.autofix
        .emitReviewNotice(ctx, { lensId }, `This review lens failed to run: ${shortReason(err)}`)
        .catch(() => undefined);
      await this.store.setThreadReviewFindings(child.id, []).catch(() => undefined);
      await this.store.setThreadCondition(child.id, 'failed').catch(() => undefined);
    }
  }

  /**
   * Run the `post_review` fix child: read the FULL findings off the sibling `review_lens` rows, dedupe +
   * filter by the child's `minSeverity` (the exact logic AutoFixStage does), run the fix turn, and commit.
   * Never throws (marks the child `failed` on error). No actionable findings → `done` with no fix turn.
   */
  private async runPostReview(
    ctx: AutoFixContext,
    thread: DriverThread,
    child: ReviewChildThread,
  ): Promise<void> {
    await this.store.setThreadStatus(child.id, 'executing').catch(() => undefined);
    try {
      const siblings = await this.store.reviewChildren(thread.id);
      const all = siblings
        .filter((c) => c.kind === 'review_lens')
        .flatMap((c) => c.reviewFindings ?? []);
      const minSeverity =
        (child.config as { minSeverity?: FindingSeverity }).minSeverity ?? 'medium';
      const deduped = dedupeFindings(all);
      const actionable = deduped.filter((f) => meetsSeverity(f.severity, minSeverity));
      if (actionable.length === 0) {
        // No fix turn runs — post an explicit line so the Post-review fixes pane reads as "nothing to
        // fix" rather than a silent blank (mirrors the empty-diff notice in reviewThreadChildren).
        await this.autofix
          .emitReviewNotice(ctx, { fix: true }, 'No findings met the fix threshold — nothing to fix.')
          .catch(() => undefined);
        await this.store.setThreadStatus(child.id, 'done').catch(() => undefined);
        await this.store.setThreadCondition(child.id, 'none').catch(() => undefined);
        return;
      }
      await this.autofix.applyReviewFindings(ctx, actionable);
      await this.store.setThreadStatus(child.id, 'done');
      await this.store.setThreadCondition(child.id, 'none').catch(() => undefined);
    } catch (err) {
      this.logger.warn(`post-review fix failed (continuing): ${err}`);
      // Persist the reason on the fix lane so a failed post-review explains itself, not a blank pane.
      await this.autofix
        .emitReviewNotice(ctx, { fix: true }, `Post-review fix failed to run: ${shortReason(err)}`)
        .catch(() => undefined);
      await this.store.setThreadCondition(child.id, 'failed').catch(() => undefined);
    }
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
   *    turn that ends without it is `incomplete`, never `done`.
   *  - `block_thread` — the TYPED VOLUNTARY HALT (ADR 0004 Phase 3): the orchestrator cannot make progress
   *    this turn and there's nothing to poll for (a missing secret/service, or a decision needing
   *    deliberation). Writes a `blocked` record; the driver halts + wakes the job brain to triage it.
   */
  private buildTurnBridge(
    job: Job,
    thread: DriverThread,
    route: JobRoute,
    deadline: PausableDeadline,
    sandbox: FeatureSandbox,
    record: DecisionRecord | null,
    sectionStartSha: string | undefined,
    // Leg-rotation holder (builder Claude turns only): the `record_leg_handoff` tool writes the self-authored
    // handoff here; the driver reads it after the turn to rotate. Null ⇒ don't expose the tool (Codex/review).
    rotationHolder: LegRotationRunState | null,
  ): ToolBridgeOptions {
    // TERMINAL LATCH (ADR 0004 Phase 3): the bridge has no engine-turn-termination primitive, so the model
    // could call a terminal assertion twice (e.g. `complete_thread` after `block_thread`) and overwrite the
    // first one. First assertion wins — a second call never touches the record. Host-side downgrades (the
    // ADR-0005 judge + the diagnostics gate) run OUTSIDE this bridge and still intentionally rewrite a `done`
    // record to `blocked` — the latch governs only the in-turn tool calls, not the host.
    //
    // ANTI-SPIN: once latched, the model SHOULD stop — but a model that doesn't will keep calling the terminal
    // tool, and a bare `{ok:false, error}` reads to it as "that failed, try again" → it spins until
    // PHASE_TIMEOUT. The bridge can't force the turn to end (aborting the deadline would mark the job `failed`
    // and discard the recorded outcome). So `afterTerminal` answers a repeat IDEMPOTENTLY and always with an
    // explicit STOP directive: re-asserting the SAME state succeeds (nothing to retry); a CONFLICTING assertion
    // is refused but still told to stop, never to retry.
    let terminated: null | 'done' | 'blocked' = null;
    const afterTerminal = (attempted: 'done' | 'blocked') => {
      const stop =
        `This thread already asserted \`${terminated}\` this turn — it is recorded and final. ` +
        `Do NOT call any terminal tool again; stop here and end your turn now.`;
      return attempted === terminated
        ? { ok: true, alreadyRecorded: true, message: stop }
        : { ok: false, error: stop };
    };
    const tools: Record<string, ToolImpl> = {
        complete_thread: async (args) => {
          if (terminated) {
            return afterTerminal('done');
          }
          const summary = String(args['summary'] ?? '').trim();
          if (!summary) {
            return { ok: false, error: 'summary is required (one line: what this thread built)' };
          }
          const asStrings = (v: unknown): string[] | undefined =>
            Array.isArray(v) && v.length
              ? v.map((x) => String(x).trim()).filter(Boolean)
              : undefined;
          // Tolerate a free-text `verification` (the model sometimes collapses its evidence into one
          // narrative string instead of discrete entries) — never silently drop reported evidence, since
          // an empty `verification[]` reads to the live-verification judge as "nothing was checked" even
          // when genuine evidence was given, just in the wrong shape (live-validated: ADR 0005).
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
            : typeof args['verification'] === 'string' && args['verification'].trim()
              ? [
                  {
                    kind: 'reported',
                    command: '(see outputTail)',
                    exitCode: 0,
                    outputTail: args['verification'].trim().slice(0, 2000),
                  },
                ]
              : undefined;
          const candidate: ThreadTerminalRecord = {
            status: 'done',
            summary,
            ...(asStrings(args['changes']) ? { changes: asStrings(args['changes']) } : {}),
            ...(verification && verification.length ? { verification } : {}),
            ...(asStrings(args['deviations']) ? { deviations: asStrings(args['deviations']) } : {}),
            ...(asStrings(args['gaps']) ? { gaps: asStrings(args['gaps']) } : {}),
          };
          const gated = await this.gateLiveVerification(
            job, thread, sandbox, record, sectionStartSha, candidate,
          );
          // Latch ONLY an ACCEPTED terminal assertion. A Phase-2 judge DOWNGRADE (status still 'blocked',
          // returned with a `warning`) is a REJECTED claim — the orchestrator must be able to capture the
          // missing evidence and call `complete_thread` again in the SAME turn (ADR 0005's warning-retry). A
          // premature latch here silently traps a genuinely-done thread as `blocked` (caught in live
          // validation: the model curl'd a real 200, then its second complete_thread was wrongly rejected).
          if (gated.record.status === 'done') terminated = 'done';
          await this.store.recordThreadTermination(thread.id, gated.record);
          return gated.warning ? { ok: true, warning: gated.warning } : { ok: true };
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
            // The STEP stays `executing` (the turn is still alive, polling for the answer); the pause is
            // recorded on the orthogonal condition overlay instead.
            await this.store
              .setThreadCondition(thread.id, 'paused')
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
            await this.store
              .setThreadCondition(thread.id, 'none')
              .catch(() => undefined);
            return { answer };
          } finally {
            deadline.resume();
          }
        },
        block_thread: async (args) => {
          // The orchestrator VOLUNTARILY halts this build lane (ADR 0004 Phase 3) — it cannot make progress
          // THIS turn and there is nothing to poll for (unlike `request_operator_input`, which keeps the turn
          // alive for an inline answer). Terminal: writes a `blocked` record and returns; the turn ends when
          // the model stops, the driver reads the record → `blocked` outcome → halts + wakes the brain, which
          // triages it (bounded fix or escalate). `reason` is the human-input kind — NOT `'unverified'`, which
          // is reserved for the host's own live-verification/diagnostics downgrades (a self-report must not
          // counterfeit a judge verdict).
          if (terminated) {
            return afterTerminal('blocked');
          }
          const reason = String(args['reason'] ?? '').trim();
          const detail = String(args['detail'] ?? '').trim();
          const ALLOWED = ['question', 'needs_env', 'decision'] as const;
          if (!(ALLOWED as readonly string[]).includes(reason)) {
            return {
              ok: false,
              error: `reason must be one of ${ALLOWED.join('|')} (use complete_thread when done, request_operator_input for an inline question)`,
            };
          }
          if (!detail) {
            return { ok: false, error: 'detail is required (specifically what blocks you, and what you need)' };
          }
          terminated = 'blocked';
          const asStrings = (v: unknown): string[] | undefined =>
            Array.isArray(v) && v.length
              ? v.map((x) => String(x).trim()).filter(Boolean)
              : undefined;
          const record: ThreadTerminalRecord = {
            status: 'blocked',
            summary: detail.slice(0, 200),
            ...(asStrings(args['gaps']) ? { gaps: asStrings(args['gaps']) } : {}),
            blocked: { reason: reason as 'question' | 'needs_env' | 'decision', detail },
          };
          await this.store.recordThreadTermination(thread.id, record);
          return { ok: true };
        },
    };

    // LEG-ROTATION self-handoff (builder Claude turns only): when the SOFT/HARD occupancy nudges steer a fat
    // builder toward yielding, it calls this to author its own handoff for a fresh Leg. We only STASH it here
    // (into the per-Leg holder) + tell the model to STOP; the driver reads the holder after the turn and does
    // the actual rotation (null session_id, seed the next Leg) via `completeLegRotation`. Analogous to how the
    // brain self-authors a compaction summary — but tool-driven, so it can happen mid-turn without a stop-seam.
    if (rotationHolder) {
      tools.record_leg_handoff = async (args) => {
        const handoff = String(args['handoff'] ?? '').trim();
        if (!handoff) {
          return {
            ok: false,
            error: 'handoff is required (a structured markdown handoff — see the tool description)',
          };
        }
        rotationHolder.handoff = handoff;
        return { ok: true, message: RECORD_LEG_HANDOFF_STOP };
      };
    }

    // OUT-OF-SCOPE routing (real builder lanes only, NOT the Codex master_review). A builder that trips over
    // something outside its assignment routes it by cost: a CHEAP, clearly-correct fix it makes inline and
    // logs via `record_deviation`; an EXPENSIVE-but-known defect it defers via `capture_ticket` and keeps
    // building; a genuine open DESIGN gap it hands up via `block_thread`. These two are the first two rungs.
    if (thread.kind !== 'master_review') {
      // record_deviation — the builder made a small out-of-scope fix INLINE. Persist it to the durable
      // per-thread store, then re-project `/context/generated/deviations.md` (host-owned; the sandbox mount
      // is read-only). Idempotent on note text (store-level), so a re-driven turn never double-logs.
      tools.record_deviation = async (args) => {
        const note = String(args['note'] ?? '').trim();
        if (!note) {
          return { ok: false, error: 'note is required (one line: what you changed off-spec and why)' };
        }
        await this.store.recordDeviation(thread.id, { note, ts: new Date().toISOString() });
        await this.writeDeviationsMd(job);
        return { ok: true };
      };

      // capture_ticket — the builder found an out-of-scope defect too big to fix inline (but not a blocker):
      // drop a `bug` on the board and keep building. WRITE-ONLY — no list/update/promote (those stay on the
      // brain). Resume-safe: a re-driven turn that re-captures the same title is deduped against this job's
      // already-captured tickets (create always allocates a fresh number, so we must guard before creating).
      tools.capture_ticket = async (args) => {
        if (!this.tickets) {
          return { ok: false, error: 'ticket board unavailable in this environment' };
        }
        const title = String(args['title'] ?? '').trim();
        if (!title) {
          return { ok: false, error: 'title is required (imperative one-line summary of the out-of-scope defect)' };
        }
        const body = String(args['body'] ?? '').trim() || undefined;
        try {
          const existing = await this.tickets
            .list({ orgId: job.orgId, repoId: job.repoId, originJobId: job.id })
            .catch(() => []);
          const dup = existing.find((t) => t.title.trim().toLowerCase() === title.toLowerCase());
          if (dup) {
            return { ok: true, ticketId: dup.id, number: dup.number, alreadyCaptured: true };
          }
          // Semantic guard on top of the exact-title one: the builder has no human in the loop, so at the
          // HIGH auto-skip bar collapse a near-identical capture into an existing OPEN ticket rather than
          // filing a "same bug, one word off" duplicate (the #6/#7 case). Restricted to non-terminal
          // statuses so a done/cancelled match never suppresses a fresh capture. Fail-soft (no key → skip).
          const semantic = await this.tickets
            .findSimilar({
              orgId: job.orgId,
              repoId: job.repoId,
              title,
              body,
              minSim: TICKET_AUTO_SKIP_SIM,
              limit: 1,
              excludeStatuses: [...TICKET_TERMINAL_STATUSES],
            })
            .catch(() => ({ queryVector: null, matches: [] }));
          const near = semantic.matches[0];
          if (near) {
            return { ok: true, ticketId: near.id, number: near.number, alreadyCaptured: true };
          }
          const ticket = await this.tickets.create({
            orgId: job.orgId,
            repoId: job.repoId,
            title,
            body,
            kind: 'bug',
            status: 'backlog',
            originThreadId: job.id,
            originDecisionRecordId: record?.id ?? job.decisionRecordId ?? null,
          });
          return {
            ok: true,
            ticketId: ticket.id,
            number: ticket.number,
            message: `Captured bug #${ticket.number}: ${title}. Keep building your assigned scope.`,
          };
        } catch (err) {
          return { ok: false, error: shortReason(err) };
        }
      };
    }

    // LIVE TASK LIST for the Codex master-review thread (parity with Claude Code's TaskCreate/TaskUpdate).
    // Codex has no native SDK task tools, so bridge `task_create`/`task_update` into the SAME `tasks` column
    // the Claude lanes fold into — the web then renders its checklist identically. Scoped to master_review:
    // Claude builders already carry their in-process SDK task tools, so adding these there would duplicate.
    if (thread.kind === 'master_review') {
      const scope = { kind: 'thread' as const, id: thread.id };
      // Per-turn sequential ids, matching Claude's per-session id space — `task_create` returns the id in a
      // `"Task #N created"` string so the shared `createdTaskId` parser (task-fold.ts) reads it back, and the
      // model echoes it into `task_update({ taskId })`. A resumed turn rebuilds its list from #1, exactly as
      // a fresh Claude session re-derives its todos.
      let taskSeq = 0;
      tools.task_create = async (args) => {
        const subject = String(args['subject'] ?? '').trim();
        if (!subject) return { ok: false, error: 'subject is required (a one-line task title)' };
        const id = String(++taskSeq);
        await this.taskSink
          .applyTaskEvent(scope, 'taskcreate', args, `Task #${id} created`)
          .catch((err) => this.logger.debug(`task_create fold failed (display-only): ${shortReason(err)}`));
        return `Task #${id} created: ${subject}`;
      };
      tools.task_update = async (args) => {
        const taskId = String(args['taskId'] ?? '').trim();
        if (!taskId) return { ok: false, error: 'taskId is required (the id task_create returned)' };
        await this.taskSink
          .applyTaskEvent(scope, 'taskupdate', args, null)
          .catch((err) => this.logger.debug(`task_update fold failed (display-only): ${shortReason(err)}`));
        return { ok: true };
      };
    }

    return { jobId: job.id, tools };
  }

  /**
   * ADR 0005 (Phase 2 of ADR 0004) — gate a thread's `complete_thread` `done` claim through the live-
   * verification judge before it is persisted. Never throws (a judge failure resolves to the conservative
   * default); the caller always gets back SOME record to persist. Always enforces — there is no rollout
   * dial: Atlas runs as a single-operator R&D tool with no staged audience to roll out to, so the gate
   * either behaves correctly or gets fixed, not phased in.
   *
   * Skips the gate entirely (passes `candidate` through unchanged) for: the master-review thread (it's a
   * separate whole-diff review pass, not a per-thread contract), and a missing `sectionStartSha`
   * (best-effort — `headSha` can fail; matches how the rest of the codebase treats it as optional).
   */
  private async gateLiveVerification(
    job: Job,
    thread: DriverThread,
    sandbox: FeatureSandbox,
    record: DecisionRecord | null,
    sectionStartSha: string | undefined,
    candidate: ThreadTerminalRecord,
  ): Promise<{ record: ThreadTerminalRecord; warning?: string }> {
    if (thread.kind === 'master_review' || !sectionStartSha) {
      return { record: candidate };
    }

    const changedFiles = await this.git.changedFileNames(sandbox.worktreePath, sectionStartSha);
    // Cheap deterministic pre-filter (ADR 0005 §2f): a docs/test/lockfile-only change (or no changed files
    // at all — `.every` is vacuously true on `[]`) never reaches the judge call — this shrinks the blast
    // radius of a missing judge key considerably.
    const nonRuntime = changedFiles.every((f) => NON_RUNTIME_FILE_RE.test(f));

    let verdict: LiveVerificationVerdict | undefined;
    if (!nonRuntime) {
      verdict = await this.liveVerificationJudge
        .judge({
          terminalRecordSummary: renderTerminalRecordSummary(candidate),
          changedFiles,
          lockedDecisionsSummary: renderLockedDecisionsSummary(record),
          orgId: job.orgId,
        })
        .catch(() => undefined);
    }

    // Conservative default (mirrors ClassifierLlm's "defaults to ask" exactly): unavailable/malformed →
    // treat as touched-but-unverified, never toward a silent `done`.
    const effective: LiveVerificationVerdict = nonRuntime
      ? {
          runtimeSurfaceTouched: false,
          liveVerificationAdequate: true,
          reason: 'non-runtime file set (pre-filter)',
        }
      : (verdict ?? {
          runtimeSurfaceTouched: true,
          liveVerificationAdequate: false,
          reason: 'live-verification judge unavailable',
        });

    if (effective.runtimeSurfaceTouched && !effective.liveVerificationAdequate) {
      let detail = [effective.reason, effective.missingChecks].filter(Boolean).join(' — ');
      // Distinguish "no key configured" from a generic judge failure so an operator isn't left guessing.
      if (!nonRuntime && !verdict) {
        const hasKey = await this.creds.anthropicKey(job.orgId).catch(() => undefined);
        if (!hasKey) {
          detail = `no Anthropic API key configured for the live-verification judge — configure one. (${detail})`;
        }
      }
      const blocked: ThreadTerminalRecord = {
        status: 'blocked',
        summary: candidate.summary,
        ...(candidate.changes ? { changes: candidate.changes } : {}),
        ...(candidate.verification ? { verification: candidate.verification } : {}),
        ...(candidate.deviations ? { deviations: candidate.deviations } : {}),
        ...(candidate.gaps ? { gaps: candidate.gaps } : {}),
        blocked: { reason: 'unverified', detail },
        liveVerification: { verdict: effective },
      };
      return {
        record: blocked,
        warning: `Downgraded to blocked (unverified) by the live-verification judge: ${detail}`,
      };
    }

    return { record: { ...candidate, liveVerification: { verdict: effective } } };
  }

  /** Poll a build-origin question card until the operator answers it, bounded by OPERATOR_INPUT_TIMEOUT_MS
   *  (default 6h). On timeout it returns guidance telling the orchestrator to proceed on its best judgment
   *  (rather than erroring the turn). Stops early if the turn is aborted (shutdown/kill). */
  private async pollOperatorAnswer(
    jobId: string,
    questionId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const maxMs = 6 * 60 * 60_000; // 6h — the wall-clock budget is suspended while a pause polls.
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
    sectionStartSha: string | undefined,
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
        job, route, sandbox, thread, record, batch, repo, key === lastKey, sectionStartSha,
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
    sectionStartSha: string | undefined,
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
    // The Leg the anchor's build session is currently on (1-based). Stamped into every build block's
    // `meta.legOrdinal` so the web slices this thread's transcript into one node per Leg. Bumped in the
    // rotation loop below as the session rotates, so each Leg's turns carry its own ordinal.
    let currentLeg = anchor.legOrdinal;
    const metaTag: Record<string, unknown> = {
      phaseId: anchor.id,
      legOrdinal: currentLeg,
      ...(batchOrdinal != null ? { batchOrdinal } : {}),
    };
    // The instruction the engine receives — the build turn's "first message". Computed once here so it
    // can both kick off the turn AND be persisted on the anchor row (the web renders it like a subagent's
    // Task prompt, so the step transcript shows what was asked, not just the engine's reply).
    const baseTask = thread.kind === 'master_review'
      ? renderMasterReviewTask(record, repo)
      : renderBatchTask(record, thread, steps);
    // LEG-ROTATION SEED FOLD: if a prior Leg rotated, its structured handoff is stashed on the anchor step.
    // Prepend it so the FRESH Leg session continues mid-flight (its WIP is already on disk in the worktree)
    // instead of restarting the batch. The seed is cleared the instant the fresh session is born (turn-runner
    // clear-on-birth). Mirrors the brain's `pending_compaction_seed` fold in `runChatTurnInner`.
    const legSeed = await this.store.getPendingLegSeed(anchor.id);
    const task = legSeed ? `${legSeed}\n\n---\n\n${baseTask}` : baseTask;

    // RESTART-SAFE SHORT-CIRCUIT (ADR 0004 rider 3): the orchestrator may have ALREADY asserted `done` on a
    // prior attempt (its `complete_thread` call persisted a terminal record) before a crash/restart hit
    // during the verification gate or commit that follows — a much bigger window now that the gate can run
    // for minutes, across multiple resumed turns. Re-kicking the orchestrator here would re-send its
    // ORIGINAL batch task into an already-finished conversation (confusing it, and exposing the WRONG tool
    // bridge — the batch bridge, not the gate's) instead of resuming the gate that's actually in progress.
    // So: if a `done` terminal record already exists for the terminal batch, skip the kick/reattach dance
    // entirely and fall straight through to the gate below with the EXISTING assertion.
    const priorTerm = isLastBatch ? await this.store.getTerminalRecord(thread.id) : null;

    let report: string;
    let outcome: ThreadOutcome = 'done';

    if (priorTerm?.status === 'done') {
      this.logger.log(
        `thread ${thread.ordinal} batch [${steps.map((p) => p.ordinal).join(',')}] — terminal record already 'done' from a prior attempt; resuming the verification gate without re-kicking the orchestrator`,
      );
      report = priorTerm.summary;
    } else {
      // The orchestrator turn's PAUSABLE wall-clock deadline + the host tool bridge that exposes
      // `request_operator_input` (open a durable question card → poll it → pause the deadline across the
      // human wait). One deadline shared by the bounded kick AND the tool so a pause suspends the clock; the
      // same bridge is re-supplied on re-attach (the host tool closure is in-memory, lost on restart).
      const deadline = new PausableDeadline(this.phaseTimeoutMs, `batch "${label}"`);
      // LEG-ROTATION arming: only the builder's OWN Claude execute session rotates (context-rot mitigation).
      // Codex master-review emits no per-call occupancy (never latches) and has no `record_leg_handoff`; review
      // children run elsewhere. The per-Leg run state is filled DURING the turn (by the watch + the handoff tool)
      // and read AFTER it to decide whether to rotate; `record_leg_handoff` is exposed only when armed.
      const rotationArmed = thread.kind === 'builder' && threadKindSpec(thread.kind).engine === 'claude';
      const rotationThresholds = resolveRotationThresholds();
      const rotationState = freshLegRotationState();
      const toolBridge = this.buildTurnBridge(
        job, thread, route, deadline, sandbox, record, sectionStartSha,
        rotationArmed ? rotationState : null,
      );

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
        if (isLastBatch) {
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
      // LEG-ROTATION LOOP: kick the Leg's turn; if its context filled and it rotated (self-authored handoff, or
      // the post-turn safety-net), the fat session is abandoned + a handoff is seeded on the anchor — re-fold
      // that seed and kick a FRESH Leg. Loops until a turn completes WITHOUT rotating (the normal case: one
      // Leg, no rotation). Bounded so a pathological rotate-every-turn thread can't spin forever.
      let legTask = task;
      for (let leg = 0; ; leg++) {
        if (!result) {
          // Fresh per-Leg run state (the prior Leg's handoff/latch/peak must not leak into this one).
          rotationState.handoff = null;
          rotationState.softReached = false;
          rotationState.peakTokens = null;
          result = await this.kickBatchTurn(
            job, sandbox, thread, steps, legTask, lane, channel, metaTag, label, repo, deadline, toolBridge,
            rotationArmed ? { state: rotationState, thresholds: rotationThresholds } : null,
          );
        }
        // After the turn ends, rotate ONLY if the builder self-authored a handoff via `record_leg_handoff`.
        // There is NO forced rotation: a fat turn that never handed off just ends (its context is reminded, not
        // seized). Not armed / model asserted done / no handoff ⇒ false.
        const rotated = rotationArmed && (await this.maybeRotateLeg(job, route, thread, anchor, rotationState));
        if (!rotated) break;
        // The session rotated: the anchor is now on the next Leg — bump the tag so the fresh Leg's turns are
        // sliced under their own thread node.
        currentLeg += 1;
        metaTag.legOrdinal = currentLeg;
        if (leg + 1 >= MAX_LEGS_PER_BATCH) {
          this.logger.warn(
            `leg-rotation: thread ${thread.ordinal} hit MAX_LEGS_PER_BATCH (${MAX_LEGS_PER_BATCH}) — ` +
              `continuing the fresh Leg to completion without further rotation this batch`,
          );
          result = null;
          const seed = await this.store.getPendingLegSeed(anchor.id);
          legTask = seed ? `${seed}\n\n---\n\n${baseTask}` : baseTask;
          // Kick the final Leg but do NOT loop again (fall through after this kick).
          rotationState.handoff = null;
          rotationState.softReached = false;
          rotationState.peakTokens = null;
          result = await this.kickBatchTurn(
            job, sandbox, thread, steps, legTask, lane, channel, metaTag, label, repo, deadline, toolBridge,
            null, // disarm rotation for the capped final Leg
          );
          break;
        }
        // Re-fold the freshly-stashed seed for the next Leg (session_id was NULLed by completeLegRotation).
        result = null;
        const seed = await this.store.getPendingLegSeed(anchor.id);
        legTask = seed ? `${seed}\n\n---\n\n${baseTask}` : baseTask;
      }
      report = result!.report;

      // Record/refresh the current Leg's read-model row (Stage 7 UI): its live session id + peak occupancy.
      // For a thread that never rotated this creates the implicit Leg-1 row; after a rotation
      // `completeLegRotation` already opened Leg N+1 and this refreshes its session/peak. Display-only.
      if (rotationArmed) {
        await this.store
          .recordActiveLeg(anchor.id, result!.session?.id ?? null, rotationState.peakTokens)
          .catch((err) => this.logger.debug(`recordActiveLeg failed (display-only): ${shortReason(err)}`));
      }

      // Surface any off-spec deviations the engine flagged in its report (#7) — never silent.
      const deviations = extractDeviations(report);
      if (deviations.length) {
        await this.post(
          route,
          `:warning: Off-spec changes in *${label}*:\n${deviations.map((d) => `• ${d}`).join('\n')}`,
        );
      }

      // Verification is the ORCHESTRATOR'S job, in-turn: ORCHESTRATE_EXECUTE_SYSTEM mandates it discover and
      // run the repo's OWN typecheck/build/test (and fix failures) before finishing, and report rather than
      // claim success on a guess. The host does NOT reach into the sandbox to run commands.

      // Resolve the TERMINAL OUTCOME (ADR 0004). A non-terminal batch keeps exception-shape semantics: the
      // turn returned → done. The terminal batch — Claude builders AND the Codex master-review thread (which
      // now has a host tool bridge via the in-sandbox MCP server) — READS the assertion the orchestrator
      // wrote via `complete_thread` instead of inferring done-ness. No assertion after a clean turn ⇒
      // `incomplete` (NEVER silently done).
      if (isLastBatch) {
        const term = await this.store.getTerminalRecord(thread.id);
        outcome = term?.status ?? 'incomplete';
        if (outcome === 'incomplete') {
          this.logger.warn(
            `thread ${thread.ordinal} batch [${steps.map((p) => p.ordinal).join(',')}] ended WITHOUT complete_thread — marking incomplete`,
          );
        }
      }
    }

    if (outcome !== 'done') {
      // Do NOT commit-as-done or mark steps done — leave the batch resumable (the atomic-resume fast-forward
      // keys on commit_sha + step `done`, so an un-finalized batch correctly re-runs) and let runThread/runJob
      // set the thread status + halt. The working tree is left intact for diagnosis.
      return { outcome, report };
    }

    // DIAGNOSTICS DONE-GATE (ADR 0004 rider 3) — a `done` claim is asked-for-verification, never enforced:
    // resume the SAME orchestrator session to run a real diagnostics + typecheck pass and fix what it finds,
    // before the driver trusts the claim enough to commit. Claude worker batches ONLY — master-review is
    // Codex, which has no host tool bridge (`report_verification` would be uncallable there), and it already
    // carries its own typecheck/verify mandate in `renderMasterReviewTask`.
    if (thread.kind !== 'master_review') {
      const gate = await this.runVerificationGate(
        job, thread, sandbox, anchor, lane, channel, repo, sectionStartSha,
      );
      if (!gate.passed) {
        this.logger.warn(
          `thread ${thread.ordinal} batch [${steps.map((p) => p.ordinal).join(',')}] — verification gate failed, not committing: ${gate.detail}`,
        );
        // Downgrade the claim to `blocked` (reusing the EXACT status/reason vocabulary the ADR-0005
        // live-verification judge already uses for the same shape of claim) — reuses haltJob's existing
        // "Thread blocked" relay + `awaiting_input` status, no new plumbing needed.
        const prior = await this.store.getTerminalRecord(thread.id).catch(() => null);
        await this.store.recordThreadTermination(thread.id, {
          status: 'blocked',
          summary: prior?.summary ?? 'verification gate failed',
          ...(prior?.changes ? { changes: prior.changes } : {}),
          ...(prior?.verification ? { verification: prior.verification } : {}),
          blocked: { reason: 'unverified', detail: gate.detail.slice(0, 2000) },
        });
        return { outcome: 'blocked', report };
      }
    }

    // The WRITER committed + pushed its own work (its batch prompt + the gate directive both require a
    // clean tree). The host no longer creates commits — it only READS what the writer produced. If the tree
    // is still dirty (the model forgot), nudge the SAME session to commit + push, bounded; if it stays dirty
    // we block rather than committing on the writer's behalf.
    const committed = await this.ensureCommitted(job, thread, sandbox, anchor, lane, channel, repo);
    if (!committed.ok) {
      this.logger.warn(`thread ${thread.ordinal} — ${committed.detail}`);
      const prior = await this.store.getTerminalRecord(thread.id).catch(() => null);
      await this.store.recordThreadTermination(thread.id, {
        status: 'blocked',
        summary: prior?.summary ?? 'writer left uncommitted changes',
        ...(prior?.changes ? { changes: prior.changes } : {}),
        ...(prior?.verification ? { verification: prior.verification } : {}),
        blocked: { reason: 'unverified', detail: committed.detail.slice(0, 2000) },
      });
      return { outcome: 'blocked', report };
    }

    // Atomic-resume marker (#6): the sha the WRITER committed (READ via `headSha`, never created here). HEAD
    // unchanged from the thread's base ⇒ nothing was committed (a clean review) ⇒ the `NOTHING` sentinel.
    // Stamp on the ANCHOR step FIRST, then flip steps to done — a crash between the two fast-forwards on
    // resume (executeSteps) instead of re-running against an already-committed tree.
    const head = await this.git.headSha(sandbox.worktreePath).catch(() => null);
    const sha = head && head !== sectionStartSha ? head : NOTHING_COMMITTED;
    this.logger.log(`batch commit (writer-authored) ${sha === NOTHING_COMMITTED ? '(nothing)' : sha.slice(0, 8)}`);
    await this.store.setStepCommit(anchor.id, sha);
    for (const p of steps) await this.store.setStepState(p.id, 'done', 'done');
    // Live-branch backstop: an autonomous build turn may also switch branches. Sample HEAD once here (the
    // brain's per-tool listener doesn't observe driver-run build turns). Best-effort + guarded so it never
    // writes null over a known branch or churns the row when unchanged.
    void this.git
      .currentBranch(sandbox.worktreePath)
      .then((live) =>
        live && live !== job.currentBranch
          ? this.store.setCurrentBranch(job.id, live)
          : undefined,
      )
      .catch((err) => this.logger.warn(`live-branch build backstop failed: ${err}`));
    return { outcome: 'done', report };
  }

  /**
   * Ensure the WRITER left a clean tree (its own commit + push). Writers own their commits now (prompt + gate
   * directive); this only handles the forgot-to-commit case. Re-checks the tree and, if dirty, resumes the
   * SAME session (via `stepId`) with a commit + push directive — bounded, same resumed-turn pattern as the
   * verification gate. Returns `ok:false` if the tree stays dirty (the driver then blocks the thread).
   */
  private async ensureCommitted(
    job: Job,
    thread: DriverThread,
    sandbox: FeatureSandbox,
    anchor: Step,
    lane: string,
    channel: string,
    repo: ResolvedRepo,
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    for (let attempt = 0; attempt <= COMMIT_NUDGE_MAX; attempt++) {
      if (!(await this.git.hasChanges(sandbox.worktreePath))) return { ok: true };
      if (attempt === COMMIT_NUDGE_MAX) break;
      const deadline = new PausableDeadline(this.phaseTimeoutMs, `commit nudge "${thread.brief}"`);
      try {
        await this.kickCommitTurn(job, sandbox, thread, anchor, lane, channel, repo, attempt + 1, deadline);
      } catch (err) {
        if (isEngineDetachedError(err)) throw err; // leave running for the next boot to re-attach
        this.logger.warn(`commit nudge ${attempt + 1} for thread ${thread.ordinal} errored: ${shortReason(err)}`);
      }
    }
    return {
      ok: false,
      detail: 'working tree still dirty after commit nudges — the writer did not commit its changes',
    };
  }

  /** Resume the writer's session (via `stepId`) with a directive to commit + push its uncommitted changes.
   *  No host tool bridge — committing is plain in-sandbox git (the turn carries `gitAuth` so it can push).
   *  Engine/persona come from the thread-kind spec (Codex for master-review, Claude for builders). */
  private async kickCommitTurn(
    job: Job,
    sandbox: FeatureSandbox,
    thread: DriverThread,
    anchor: Step,
    lane: string,
    channel: string,
    repo: ResolvedRepo,
    attempt: number,
    deadline: PausableDeadline,
  ): Promise<Awaited<ReturnType<TurnRunnerService['runTurn']>>> {
    const spec = threadKindSpec(thread.kind);
    const metaTag = { phaseId: anchor.id, commitNudge: attempt };
    const harness = this.turnHarness.create({ jobId: job.id, orgId: job.orgId, channel, lane, metaTag });
    const task =
      `You have UNCOMMITTED changes in the working tree, but the thread is otherwise finished. Commit them` +
      ` now: run \`git add -A\` (your \`.gitignore\` governs what's tracked — if build/cache junk appears,` +
      ` add it to \`.gitignore\` instead of committing it), commit with a clear message, and \`git push\`` +
      ` your branch. Leave the tree CLEAN, then stop. Do nothing else.`;
    await harness.emitPrompt(task, `commit:${anchor.id}:${attempt}`);
    const repoConventions = await this.repoConventionsFor(job);
    let result: Awaited<ReturnType<TurnRunnerService['runTurn']>>;
    try {
      result = await this.runTurnBounded(
        {
          orgId: job.orgId,
          jobId: job.id,
          stepId: anchor.id, // resumes the writer's persisted session — same conversation as its build turn
          sandbox,
          engine: spec.engine,
          mode: 'execute',
          systemPrompt: renderAgentPrompt(spec.agent, {
            jobKind: job.kind,
            settings: { repoConventions },
          }),
          ...(spec.reasoningEffort ? { modelReasoningEffort: spec.reasoningEffort } : {}),
          task,
          auth: await this.creds.engineAuth(job.orgId, spec.engine),
          userMcpServers: await this.mcp.resolveForTurn(job.orgId, job.repoId, 'build'),
          skills: await this.skills.resolveForTurn(job.orgId, job.repoId, 'build'),
          ...(repoConventions ? { repoConventions } : {}),
          gitAuth: { gitUrl: repo.projectRepo.gitUrl, token: repo.token },
          richStream: true,
          turnMeta: {
            jobId: job.id,
            orgId: job.orgId,
            channel,
            lane,
            kind: 'gate', // reuse the gate's reattach path (short resumed turn keyed on the anchor)
            ctx: { repoId: job.repoId, threadId: thread.id, anchorStepId: anchor.id, commitNudge: attempt },
          },
          onEvent: (e) => harness.onEvent(e),
        },
        `commit nudge "${thread.brief}" #${attempt}`,
        deadline,
      );
    } catch (err) {
      await harness.abort();
      throw err;
    }
    await harness.finish(result.report, result.usage ? { usage: result.usage } : undefined);
    return result;
  }

  /**
   * Find the still-running registry row for THIS batch's engine turn (restart re-attach), or null. Matches on
   * (job_id, lane, ctx.anchorStepId) among running turns of the given `kind` — the lane is thread-scoped and a
   * thread runs one batch (or one gate iteration) at a time, so the match is unique; the anchor id
   * disambiguates across a thread's batches. `kind` defaults to `'step'` (the batch turn); the verification
   * gate passes `'gate'` to find its OWN in-flight iteration instead of the (by-then-finished) batch turn.
   */
  private async findReattachableTurn(
    jobId: string,
    lane: string,
    anchorStepId: string,
    kind: 'step' | 'gate' = 'step',
  ): Promise<ActiveTurnEntity | null> {
    const rows = await this.turnRegistry.listRunning().catch((err) => {
      this.logger.warn(`reattach lookup failed (will kick a fresh turn): ${err}`);
      return [] as ActiveTurnEntity[];
    });
    return (
      rows.find(
        (r) =>
          r.kind === kind &&
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
      orgId: job.orgId,
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
      await harness.finish(result.report, result.usage ? { usage: result.usage } : undefined);
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
    // Leg-rotation control (Claude builder turns only): the per-Leg run state the live watch fills + the
    // thresholds to steer at. Null ⇒ rotation disarmed (Codex, review children, or the capped final Leg) —
    // the watch stays observe-only and the turn is not steerable.
    rotation: { state: LegRotationRunState; thresholds: LegRotationThresholds } | null,
  ): Promise<Awaited<ReturnType<TurnRunnerService['runTurn']>>> {
    const anchor = steps[0];
    const harness = this.turnHarness.create({ jobId: job.id, orgId: job.orgId, channel, lane, metaTag });
    // Engine / persona / reasoning effort come from the thread-kind spec (the prompt-kit `Agent` binding).
    // The master-review kind runs CODEX in execute mode over the whole diff (review + fix + verify) with a
    // dedicated persona + high reasoning effort; a builder runs Claude with the WORKER persona. `jobKind` is
    // ignored by MASTER_REVIEW's fragments, so passing it uniformly is byte-identical for both.
    const spec = threadKindSpec(thread.kind);
    const engine: SessionEngine = spec.engine;
    // The repo's house-style, folded into the builder's system prompt AND forwarded on the run args so the
    // FAN_OUT writer subagents this turn spawns in-container render the same envelope (Layer B).
    const repoConventions = await this.repoConventionsFor(job);
    const systemPrompt = renderAgentPrompt(spec.agent, {
      jobKind: job.kind,
      settings: { repoConventions },
    });
    // Leg-rotation occupancy watch: fires SOFT once, then a REMINDER on each further +delta as this builder
    // session's main-agent context fills. Codex/master-review turns emit no per-call occupancy, so the watch
    // never latches for them (positive-signal only). When ARMED (Claude builder) each crossing (a) records that
    // the session went fat and (b) persists a VISIBLE harness row into this Leg's transcript, so the operator
    // sees the exact pressure ask; when disarmed it stays observe-only (logs the crossing). See the plan.
    const legOrdinal = (metaTag['legOrdinal'] as number | undefined) ?? 1;
    const rotationWatch = new LegRotationWatch(rotation?.thresholds ?? resolveRotationThresholds(), (sig) => {
      this.logger.warn(
        `leg-rotation ${sig.phase.toUpperCase()} threshold crossed${rotation ? '' : ' [observe-only]'} — ` +
          `thread ${thread.ordinal} anchor ${anchor.id} (${engine}): contextTokens=${sig.contextTokens}` +
          (sig.contextLimit ? `/${sig.contextLimit}` : ''),
      );
      if (!rotation) return;
      // The MID-TURN nudge itself is injected ENGINE-LOCALLY (`RunEngineArgs.rotationNudge`, keyed off the same
      // threshold) so it lands like a manual steer and can never race the post-`result` input close. Here we
      // (a) flag that the session went fat and (b) mirror the nudge as a VISIBLE, per-Leg harness row so the
      // operator can see it in the UI. Rotation itself only ever happens on a self-authored `record_leg_handoff`.
      rotation.state.softReached = true;
      const nudgeText = stripContextPressureTag(sig.phase === 'soft' ? ROTATION_SOFT_NUDGE : ROTATION_REMINDER_NUDGE);
      void this.store
        .recordBuildSystemChunk({
          jobId: job.id,
          phaseId: anchor.id,
          legOrdinal,
          kind: 'system_reminder',
          text: nudgeText,
          chunkKey: `rot-nudge:${anchor.id}:leg${legOrdinal}:${sig.phase}${sig.reminderIndex}`,
          reminderKind: 'context_pressure',
        })
        .catch((err) => this.logger.debug(`rotation nudge row failed (display-only): ${shortReason(err)}`));
    });
    // Circuit breaker (#3): bound the engine turn with the shared PAUSABLE deadline (paused across a
    // `request_operator_input` human wait). On breach it both signals the SDK to abort AND hard-rejects so
    // the DRIVER gives up even if the SDK can't interrupt a stuck subprocess. Events attribute to the anchor
    // step (a batch is one turn; minor observability coarsening for the step transcript).
    let result: Awaited<ReturnType<TurnRunnerService['runTurn']>>;
    try {
      result = await this.runTurnBounded(
        {
          orgId: job.orgId,
          jobId: job.id,
          stepId: anchor.id,
          sandbox,
          engine,
          mode: 'execute',
          systemPrompt,
          // High reasoning effort for the whole-diff review pass (parity with plan-review), from the spec.
          // Undefined for Claude builder turns. The `toolBridge` below now reaches Codex too — `runCodex`
          // renders its tool names into a config.toml `[mcp_servers.atlasbridge]` block (the MCP bridge).
          ...(spec.reasoningEffort ? { modelReasoningEffort: spec.reasoningEffort } : {}),
          task,
          auth: await this.creds.engineAuth(job.orgId, engine),
          userMcpServers: await this.mcp.resolveForTurn(job.orgId, job.repoId, 'build'),
          skills: await this.skills.resolveForTurn(job.orgId, job.repoId, 'build'),
          ...(repoConventions ? { repoConventions } : {}),
          // Authenticated git IN the sandbox: the execute turn (orchestrator) can fetch/merge origin,
          // resolve conflicts, and push its own branch. Sourced from the RESOLVED repo (not `sandbox`).
          gitAuth: { gitUrl: repo.projectRepo.gitUrl, token: repo.token },
          richStream: true, // full transcript (thinking + tool calls/results + subagent forwarding)
          // Mid-turn steering — armed for Claude builder turns so operator steers AND the engine-local
          // Leg-rotation SOFT/REMINDER nudges land in the LIVE turn (`priority:'now'`). Never for Codex (no
          // streaming-input steering there). `rotationNudge` gives the engine the threshold + seed prompts so
          // it injects the nudge itself the instant its own occupancy crosses — race-free vs the input close.
          ...(rotation
            ? {
                steerable: true,
                rotationNudge: {
                  softTokens: rotation.thresholds.softTokens,
                  reminderDeltaTokens: rotation.thresholds.reminderDeltaTokens,
                  softText: ROTATION_SOFT_NUDGE,
                  reminderText: ROTATION_REMINDER_NUDGE,
                },
              }
            : {}),
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
            if (e.kind === 'usage') {
              rotationWatch.observe(e);
              // Track the peak main-agent occupancy for the closing Leg's `build_legs` row (armed turns only).
              if (rotation && e.contextTokens != null) {
                rotation.state.peakTokens = Math.max(rotation.state.peakTokens ?? 0, e.contextTokens);
              }
            }
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
    await harness.finish(result.report, result.usage ? { usage: result.usage } : undefined);
    return result;
  }


  /**
   * Decide whether the Leg that just ended should ROTATE — and if so, do it (the builder analog of the brain's
   * compaction). Called ONLY for an armed builder turn. Rotation happens ONLY when the builder SELF-authored a
   * handoff via `record_leg_handoff` — there is no forced/fallback rotation. On a successful rotation the fat
   * session is abandoned, a seed is stashed on the anchor, a fresh `build_legs` row opens, and the handoff +
   * continuation-seed are persisted as VISIBLE per-Leg transcript rows — the caller re-folds the seed + kicks a
   * fresh Leg. Returns false (no rotation) when the batch is genuinely finished or the builder never handed off.
   */
  private async maybeRotateLeg(
    job: Job,
    route: JobRoute,
    thread: DriverThread,
    anchor: Step,
    state: LegRotationRunState,
  ): Promise<boolean> {
    // NEVER rotate over a genuinely-finished batch: if the builder asserted `done` this turn, the work is done
    // (even if it ended fat) — let the normal outcome/gate/commit path run; the NEXT thread starts fresh anyway.
    const term = await this.store.getTerminalRecord(thread.id).catch(() => null);
    if (term?.status === 'done') return false;

    // No forced rotation: a fat turn that never called `record_leg_handoff` simply ends (it was reminded, not
    // seized). Only a self-authored handoff rotates.
    const handoff = state.handoff;
    if (!handoff) return false;

    // The seed carries the preamble + handoff + the OPEN task list (the SDK's in-memory todo dies with the
    // session; the durable `threads.tasks` is folded back in so the fresh Leg continues its checklist — B5).
    const seed = await this.buildLegSeed(thread.id, handoff);
    const res = await this.store
      .completeLegRotation({
        anchorStepId: anchor.id,
        handoff,
        seed,
        ...(state.peakTokens != null ? { contextTokensPeak: state.peakTokens } : {}),
      })
      .catch((err) => {
        this.logger.error(`leg-rotation: completeLegRotation failed for thread ${thread.ordinal}: ${err}`);
        return null;
      });
    if (!res) return false; // nothing live to rotate (already rotated / raced), or the txn failed — don't loop

    // Persist the closing Leg's handoff as a DURABLE FILE under `/context/generated` — NOT into the git
    // worktree. `res.fromLeg` is the DB-accurate closing Leg (survives multi-rotation). Awaited so the file
    // exists before the fresh Leg (which can re-read it via the read-only `/context/generated` mount) starts.
    await this.writeLegHandoffArtifact(job, res.fromLeg, handoff);

    this.logger.log(
      `leg-rotation: thread ${thread.ordinal} rotated Leg ${res.fromLeg}→${res.toLeg} ` +
        `(abandoned ${res.abandonedSessionId.slice(0, 8)}; handoff ${handoff.length} chars; ` +
        `peak ${state.peakTokens ?? '?'})`,
    );
    // VISIBLE per-Leg rows: the handoff the closing Leg authored (tail of Leg N) and the continuation seed the
    // fresh Leg opens with (head of Leg N+1 — "the initial prompt for the new session"). Insert-once by chunkKey
    // so a resume re-fold can't duplicate them. Best-effort (display-only).
    await this.store
      .recordBuildSystemChunk({
        jobId: job.id,
        phaseId: anchor.id,
        legOrdinal: res.fromLeg,
        kind: 'system_notice',
        text: handoff,
        chunkKey: `rot-handoff:${anchor.id}:leg${res.fromLeg}`,
        reminderKind: 'leg_handoff',
      })
      .catch((err) => this.logger.debug(`rotation handoff row failed (display-only): ${shortReason(err)}`));
    await this.store
      .recordBuildSystemChunk({
        jobId: job.id,
        phaseId: anchor.id,
        legOrdinal: res.toLeg,
        kind: 'system_notice',
        text: seed,
        chunkKey: `rot-seed:${anchor.id}:leg${res.toLeg}`,
        reminderKind: 'leg_seed',
      })
      .catch((err) => this.logger.debug(`rotation seed row failed (display-only): ${shortReason(err)}`));
    // Operator-visible liveness line on the main lane. Best-effort.
    await this.post(
      route,
      `:recycle: Rotated *${thread.brief}* to a fresh session (Leg ${res.toLeg}) — its context was filling; ` +
        `work continues from a handoff with the in-progress files intact.`,
    ).catch(() => undefined);
    return true;
  }

  /**
   * Compose the FRESH Leg's seed: the `ROTATION_PREAMBLE` wrapper + the structured handoff + the thread's OPEN
   * task list (B5 — cross-Leg task carry). The SDK's in-memory to-do dies with the abandoned session, but the
   * list is durable on `threads.tasks` (folded from the builder's own TaskCreate/TaskUpdate calls), so we read
   * it back and render the still-open items into the seed — the fresh Leg continues the checklist instead of
   * restarting it. The web checklist stays authoritative across Legs regardless (it reads the same column).
   */
  private async buildLegSeed(threadId: string, handoff: string): Promise<string> {
    const tasks = await this.store.getThreadTasks(threadId).catch(() => [] as TaskItem[]);
    const tasksBlock = renderOpenLegTasks(tasks);
    return [ROTATION_PREAMBLE, handoff, ...(tasksBlock ? [tasksBlock] : [])].join('\n\n');
  }

  /**
   * Persist the closing Leg's handoff as a DURABLE FILE at `/context/generated/handoffs/leg-<N>.md` — a
   * legible, inspectable artifact that lives OUTSIDE the git worktree (so it never becomes a dirty commit or
   * a PR file). `/context/generated` is the host-written bucket (mounted READ-ONLY into the container), so the
   * fresh Leg can re-read its own handoff, and it surfaces in the web's GENERATED panel. Best-effort: a write
   * failure is logged and swallowed — it must never block the rotation (the seed still carries the handoff text).
   */
  private async writeLegHandoffArtifact(job: Job, leg: number, handoff: string): Promise<void> {
    try {
      const generated = join(this.threadLifecycle.contextDirHost(job.id, job.orgId), 'generated');
      await mkdir(join(generated, 'handoffs'), { recursive: true });
      await writeFile(join(generated, 'handoffs', `leg-${leg}.md`), `${handoff}\n`, 'utf8');
    } catch (err) {
      this.logger.debug(`leg handoff artifact write failed (display-only): ${shortReason(err)}`);
    }
  }

  /**
   * Re-render `/context/generated/deviations.md` — the operator's log of the small out-of-scope fixes builders
   * made INLINE across this job's threads. A pure PROJECTION of the durable `threads.deviations` store (never
   * an append), mirroring how `decision-record.md` re-renders from its store: idempotency + resume-safety fall
   * out of re-rendering a deduped source. Host-written because `/context/generated` is mounted read-only in the
   * sandbox. Best-effort — a write failure is logged and swallowed (the durable store is the real record).
   */
  private async writeDeviationsMd(job: Job): Promise<void> {
    try {
      const groups = await this.store.getJobDeviations(job.id);
      const generated = join(this.threadLifecycle.contextDirHost(job.id, job.orgId), 'generated');
      await mkdir(generated, { recursive: true });
      const body = groups.length
        ? groups
            .map((g) => {
              const lines = g.deviations
                .map((d) => `- ${d.note}  \n  _(${d.ts})_`)
                .join('\n');
              return `## Thread ${g.ordinal} — ${g.brief}\n\n${lines}`;
            })
            .join('\n\n')
        : '_No deviations recorded._';
      await writeFile(
        join(generated, 'deviations.md'),
        `# Deviations — out-of-scope fixes made inline during the build\n\n${body}\n`,
        'utf8',
      );
    } catch (err) {
      this.logger.debug(`deviations projection write failed (display-only): ${shortReason(err)}`);
    }
  }

  /** Host tool bridge for a verification-gate turn — exposes ONLY `report_verification`, the structured
   *  verdict the gate reads instead of parsing prose (mirrors `complete_thread`'s typed-assertion contract).
   *  `onVerdict` is a plain closure callback (one gate iteration, one verdict) rather than a store write —
   *  the gate loop decides what to do with it (pass / feed the remainder into the next iteration). */
  private buildGateToolBridge(
    jobId: string,
    onVerdict: (verdict: { passed: boolean; remaining?: string[] }) => void,
  ): ToolBridgeOptions {
    return {
      jobId,
      tools: {
        report_verification: async (args) => {
          const passed = args['passed'] === true;
          const remaining = Array.isArray(args['remaining'])
            ? (args['remaining'] as unknown[]).map((x) => String(x).trim()).filter(Boolean)
            : undefined;
          onVerdict({ passed, ...(remaining?.length ? { remaining } : {}) });
          return { ok: true };
        },
      },
    };
  }

  /**
   * DIAGNOSTICS DONE-GATE (ADR 0004 rider 3). A `complete_thread` claim is only as good as the verification
   * the prompt ASKED for — nothing enforced it. This resumes the SAME orchestrator session (via `stepId`,
   * exactly like a batch resume) after it claims `done`, hands it a directive to run a real diagnostics +
   * typecheck pass over what it changed and fix what it finds, and reads back a structured verdict via the
   * `report_verification` host tool — never trusting prose. Called from `runBatch` for Claude worker
   * batches only, right before the builder commits its batch.
   *
   * Skips (passes through) when there's no `sectionStartSha` (best-effort, mirrors `gateLiveVerification`)
   * or no changed TS/JS file (nothing to typecheck — an empty diff never reaches the gate, same cheap
   * pre-filter philosophy as ADR-0005 §2f).
   *
   * Bounded by a ~10-minute total wall-clock budget across at most 2 resume iterations. Codex review:
   * `PausableDeadline` is one-shot (`runTurnBounded` calls `.clear()` in `finally`), so each iteration gets
   * its OWN deadline sized to the REMAINING budget — never a reused/rearmed one. A restart mid-gate is
   * reattachable exactly like the batch turn: the gate iteration registers `turnMeta.kind:'gate'`, and a
   * fresh call into this method looks for that live row (`findReattachableTurn(..., 'gate')`) before kicking
   * a new one.
   */
  private async runVerificationGate(
    job: Job,
    thread: DriverThread,
    sandbox: FeatureSandbox,
    anchor: Step,
    lane: string,
    channel: string,
    repo: ResolvedRepo,
    sectionStartSha: string | undefined,
  ): Promise<{ passed: true } | { passed: false; detail: string }> {
    if (!sectionStartSha) return { passed: true };
    const changed = await this.git.changedFileNames(sandbox.worktreePath, sectionStartSha);
    const tsFiles = changed.filter((f) => /\.(ts|tsx|js|jsx)$/i.test(f));
    if (tsFiles.length === 0) return { passed: true };

    const gateStart = Date.now();
    let priorErrors: string[] = [];
    for (let iteration = 1; iteration <= this.gateMaxIterations; iteration++) {
      const remainingMs = this.gateBudgetMs - (Date.now() - gateStart);
      if (remainingMs <= 0) break;

      let verdict: { passed: boolean; remaining?: string[] } | undefined;
      const toolBridge = this.buildGateToolBridge(job.id, (v) => (verdict = v));
      const task = renderGateTask(tsFiles, iteration, priorErrors);
      const label = `gate "${thread.brief}" iter ${iteration}`;

      const reattachRow =
        this.turn.canReattach() && anchor.sessionId
          ? await this.findReattachableTurn(job.id, lane, anchor.id, 'gate')
          : null;

      let result: Awaited<ReturnType<TurnRunnerService['runTurn']>> | null = null;
      try {
        if (reattachRow?.container_id) {
          result = await this.reattachGateTurn(
            job, lane, channel, { phaseId: anchor.id, gateIteration: iteration }, reattachRow, anchor.id, toolBridge,
          );
        }
        if (!result) {
          result = await this.kickGateTurn(
            job, sandbox, thread, anchor, task, lane, channel, repo, iteration,
            new PausableDeadline(remainingMs, label), toolBridge,
          );
        }
      } catch (err) {
        if (isEngineDetachedError(err)) throw err; // leave running for the next boot to re-attach
        priorErrors = [`gate iteration ${iteration} error: ${shortReason(err)}`];
        continue;
      }

      if (verdict?.passed) return { passed: true };
      priorErrors = verdict?.remaining?.length
        ? verdict.remaining
        : [
            'no report_verification verdict was recorded for this gate turn' +
              ' (the orchestrator ended the turn without calling it, or its verdict could not be recovered on resume)',
          ];
    }
    return { passed: false, detail: priorErrors.join('\n') || 'verification gate exhausted its budget' };
  }

  /** RE-ATTACH an in-flight gate iteration after a restart — same contract as {@link reattachBatchTurn} but
   *  for the gate's `kind:'gate'` turn (kept separate: the gate's tool bridge/lifecycle is simpler — just
   *  `report_verification`, no deviations/complete_thread). Returns null when it can no longer be tailed
   *  (the caller re-runs the iteration); rethrows on a detached tail (leave for the next boot). */
  private async reattachGateTurn(
    job: Job,
    lane: string,
    channel: string,
    metaTag: Record<string, unknown>,
    row: ActiveTurnEntity,
    anchorStepId: string,
    toolBridge: ToolBridgeOptions,
  ): Promise<Awaited<ReturnType<TurnRunnerService['runTurn']>> | null> {
    const harness = this.turnHarness.create({ jobId: job.id, orgId: job.orgId, channel, lane, metaTag });
    try {
      const result = await this.turn.reattach({
        turnId: row.turn_id,
        containerId: row.container_id!,
        jobId: job.id,
        stepId: anchorStepId,
        onEvent: (e) => {
          harness.onEvent(e);
          this.recoverGateVerdictFromReplay(e, toolBridge);
        },
        toolBridge,
      });
      await harness.finish(result.report, result.usage ? { usage: result.usage } : undefined);
      return result;
    } catch (err) {
      if (isEngineDetachedError(err)) throw err;
      await harness.abort();
      await this.turnRegistry.finalize(row.turn_id, 'failed').catch(() => undefined);
      this.logger.warn(`re-attach gate turn ${row.turn_id} failed; re-running the iteration: ${err}`);
      return null;
    }
  }

  /** Recover the gate verdict from the REPLAYED events log on a gate reattach. The gate's verdict lives only
   *  in an in-process closure driven by the tools-bridge channel, which is consumed-once + acked — so a
   *  `report_verification` call made before an engine-detach is NOT redelivered on reattach, and the gate
   *  would falsely halt with "…without calling report_verification" even though the call demonstrably
   *  happened. But the authoritative events log IS replayed from the start on reattach (to rebuild the
   *  transcript), so the call's `tool_use` event still arrives here — drive the matching bridge handler with
   *  it to restore the verdict. Guarded to the MAIN agent (a subagent's `tool_use` must not drive the gate).
   *  Safe ONLY because the gate's sole bridged tool (`report_verification`) is pure — do NOT reuse this on a
   *  batch reattach, whose tools have real side effects a genuinely-pending live redelivery must own. */
  private recoverGateVerdictFromReplay(e: EngineEvent, toolBridge: ToolBridgeOptions): void {
    if (e.kind !== 'tool_use' || e.parentToolUseId) return;
    const prefix = `mcp__${BRIDGE_SERVER_NAME}__`;
    const bareName = e.name.startsWith(prefix) ? e.name.slice(prefix.length) : e.name;
    const impl = toolBridge.tools[bareName];
    if (!impl) return;
    // The replayed `tool_use` carries `block.input` verbatim — the model's raw (often MIS-NESTED) payload:
    // the proxy tools use a generic `{ args }` schema and the model double-wraps / stringifies against it
    // (`{ args: { args: { passed: true } } }`, `{ args: "{…}" }`). Normalise it the same way the live dispatch
    // does (`unwrapBridgeArgs`), or the handler reads `args['passed']` off a wrapper → undefined → a false
    // `passed:false` → the gate falsely halts even though the orchestrator reported passed.
    void impl(unwrapBridgeArgs(e.input));
  }

  /** KICK a fresh gate-iteration turn — resumes the orchestrator's persisted session (via `stepId`) with the
   *  gate directive as its task. Registers `turnMeta.kind:'gate'` so a restart mid-iteration can re-attach
   *  (see {@link reattachGateTurn}) instead of losing the tail. */
  private async kickGateTurn(
    job: Job,
    sandbox: FeatureSandbox,
    thread: DriverThread,
    anchor: Step,
    task: string,
    lane: string,
    channel: string,
    repo: ResolvedRepo,
    iteration: number,
    deadline: PausableDeadline,
    toolBridge: ToolBridgeOptions,
  ): Promise<Awaited<ReturnType<TurnRunnerService['runTurn']>>> {
    const metaTag = { phaseId: anchor.id, gateIteration: iteration };
    const harness = this.turnHarness.create({ jobId: job.id, orgId: job.orgId, channel, lane, metaTag });
    // Surface this gate iteration's directive (the verify/fix task the orchestrator resumes with) on the
    // build lane, inline before its activity — the gate resumes the build session with no anchor of its own,
    // so without this the operator sees the fix work but never what was asked. Keyed per (step, iteration)
    // so a re-kick after a restart never duplicates it. The reattach path deliberately does NOT emit.
    await harness.emitPrompt(task, `gate:${anchor.id}:${iteration}`);
    const repoConventions = await this.repoConventionsFor(job);
    let result: Awaited<ReturnType<TurnRunnerService['runTurn']>>;
    try {
      result = await this.runTurnBounded(
        {
          orgId: job.orgId,
          jobId: job.id,
          stepId: anchor.id, // resumes the persisted engine session — same conversation as the build turn
          sandbox,
          engine: 'claude',
          mode: 'execute',
          systemPrompt: renderAgentPrompt(Agent.WORKER, {
            jobKind: job.kind,
            settings: { repoConventions },
          }),
          task,
          auth: await this.creds.engineAuth(job.orgId, 'claude'),
          userMcpServers: await this.mcp.resolveForTurn(job.orgId, job.repoId, 'build'),
          skills: await this.skills.resolveForTurn(job.orgId, job.repoId, 'build'),
          ...(repoConventions ? { repoConventions } : {}),
          gitAuth: { gitUrl: repo.projectRepo.gitUrl, token: repo.token },
          richStream: true,
          toolBridge,
          turnMeta: {
            jobId: job.id,
            orgId: job.orgId,
            channel,
            lane,
            kind: 'gate',
            ctx: { repoId: job.repoId, threadId: thread.id, anchorStepId: anchor.id, iteration },
          },
          onEvent: (e) => harness.onEvent(e),
        },
        `gate "${thread.brief}" iter ${iteration}`,
        deadline,
      );
    } catch (err) {
      await harness.abort();
      throw err;
    }
    await harness.finish(result.report, result.usage ? { usage: result.usage } : undefined);
    return result;
  }

  /**
   * FINALIZE THE BUILD. After all threads: run the terminal `ship` sequence — Atlas opens the PR ITSELF
   * in-sandbox (git push + `gh pr create`), followed by Master Review as a check on the open PR. The host
   * opens NOTHING; it only kicks the ship turn, then flips the job `done` once it ran (the reconciler
   * backfills `pr_url`/`pr_number` on discovery). Idempotent + resumable — a re-entered finalize just
   * re-ships (ship finds the existing PR). Threads stacked on one branch ⇒ one PR.
   */
  private async finalizeBuild(
    job: Job,
    record: DecisionRecord | null,
    route: JobRoute,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
  ): Promise<void> {
    this.logger.log(`job=${job.id} all threads done — shipping`);
    // `ship` runs the terminal in-sandbox steps: Atlas opens the PR ITSELF (git push + `gh pr create`), then
    // reports its url back so `ship` latches `pr_url`/`pr_number` (flipping the job `done`), then Master
    // Review runs as a check on the open PR. See BuildShipService.ship / openPrInSandbox.
    await this.ship.ship({
      job,
      record,
      repo,
      sandbox,
      notify: (m) => this.post(route, m),
    });
  }

  /** Lazily resolve the brain — a dynamic import keeps the brain⇄driver dependency out of module load. */
  private async brain(): Promise<BrainSurface> {
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

  /**
   * Host-authoritative OAuth refresh for the hub: a cold/warm re-attach already bakes a fresh Bearer (the
   * provisioner resolves through `McpResolver` → `currentAccessToken`), but a sandbox that stays WARM and keeps
   * building past a token's ~expiry never re-provisions. So before each build drive we proactively refresh the
   * org+repo's OAuth servers; only when a token actually rotated do we re-write the hub config (`kickMcpHubRefresh`)
   * so the hub reconnects with the new token. Cheap no-op when the repo has no OAuth servers. Best-effort — an
   * error here never blocks the build (a stale token surfaces later as the hub's own auth failure).
   */
  private async refreshOAuthHubIfRotated(job: Job): Promise<void> {
    if (!this.sandboxes.kickMcpHubRefresh) return;
    try {
      const { rotated } = await this.mcpOAuth.refreshForSandbox(job.orgId, job.repoId);
      if (!rotated) return;
      const servers = await this.mcp.resolveForSandbox(job.orgId, job.repoId).catch(() => []);
      await this.sandboxes.kickMcpHubRefresh({ jobId: job.id, servers });
      this.logger.log(`job=${job.id} re-kicked mcp hub after oauth token rotation`);
    } catch (err) {
      this.logger.debug(`oauth hub refresh skipped (continuing): ${String(err)}`);
    }
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

/** How many times the host re-nudges a writer that finished with an uncommitted tree (writers own their
 *  commits now — this is the forgot-to-commit safety net before the thread is blocked). */
const COMMIT_NUDGE_MAX = 2;

/** Backstop on Leg rotations within a single batch: a runaway thread that re-crosses the HARD threshold every
 *  Leg can't spin forever. On the cap we kick one final Leg with rotation DISARMED and run it to completion. */
const MAX_LEGS_PER_BATCH = 8;

/** Render the still-OPEN task-list items into a `<carried_tasks>` block for the fresh Leg's seed (B5). The
 *  durable `threads.tasks` outlives the abandoned session's in-memory to-do, so the fresh Leg keeps its
 *  checklist. Returns '' when nothing is open (all done / no list) — the caller then omits the block. */
function renderOpenLegTasks(tasks: TaskItem[]): string {
  const open = tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  if (!open.length) return '';
  const lines = open.map((t) => `- [${t.status === 'in_progress' ? '~' : ' '}] ${t.subject}`);
  return [
    '<carried_tasks>',
    "Your task list carried across the rotation (the previous session's in-memory to-do is gone; this is the",
    'durable checklist). Continue these — do NOT recreate completed items or restart finished ones:',
    ...lines,
    '</carried_tasks>',
  ].join('\n');
}

/** Strip the `<context_pressure …>` wrapper off a rotation nudge so the VISIBLE transcript row shows the
 *  clean ask (the XML framing is engine-only; the operator sees prose). Trims the outer tag lines only. */
function stripContextPressureTag(nudge: string): string {
  return nudge
    .replace(/^<context_pressure[^>]*>\s*/, '')
    .replace(/\s*<\/context_pressure>\s*$/, '')
    .trim();
}

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
    `\nYour grounding is \`/context/specs/\` — read its \`plan.md\` index, this thread's \`sections/NN-*.md\`` +
      ` file, and \`data-model.md\`; treat \`/context/specs\` and \`/context/generated\` as READ-ONLY. Make ALL` +
      ` code changes under \`/workspace\`. The one \`/context\` bucket you may write is \`/context/artifacts/\`:` +
      ` leave your live-validation evidence there (logs, screenshots, a \`RESULTS.md\` index) so it surfaces in` +
      ` the operator's ARTIFACTS panel.`,
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
      ` finishing. If you hit a decision the locked plan does NOT cover: if a one-line human answer would` +
      ` unblock you right now, call \`request_operator_input\` and wait; if you genuinely cannot make progress` +
      ` this turn (a missing secret/service, or a substantive decision that needs deliberation), call` +
      ` \`block_thread\` to hand it to Atlas rather than guessing or stopping silently.\n\n${blocks}`,
    COMMIT_AND_PUSH_INSTRUCTION,
  ].join('\n');
}

/**
 * Shared writer instruction — YOU (the writer session) own the commit. The host no longer commits your
 * work; it only reads what you leave. So before you call `complete_thread`, LEAVE A CLEAN TREE: stage,
 * commit, and push your own changes. `.gitignore` governs what's tracked — if build/cache junk (a
 * package store, node_modules, a build dir) shows up in `git status`, add it to `.gitignore` rather than
 * committing it. Used by every writer prompt (builder batch, verification gate, master-review).
 */
export const COMMIT_AND_PUSH_INSTRUCTION =
  `\nCOMMIT YOUR WORK (required — the host does NOT commit for you): once the work is done and verified,` +
  ` run \`git add -A\` (your \`.gitignore\` governs what's tracked; if build or cache junk appears in` +
  ` \`git status\`, add it to \`.gitignore\` instead of committing it), commit with a clear message, and` +
  ` \`git push\` your branch. Leave the working tree CLEAN. THEN call \`complete_thread\`. If you finish` +
  ` without committing, your work is treated as unfinished.`;

/**
 * Render the durable halt trail for `/context/generated/threads/<ordinal>-<slug>/completion.md` (ADR 0004 Phase 3). Pure
 * — every section is guarded on presence and tails are already length-capped in the record. The brain reads
 * this on its wake turn (alongside the fenced record in the wake body) to triage the halt.
 */
export function renderCompletionMd(
  thread: DriverThread,
  outcome: 'blocked' | 'incomplete' | 'failed',
  term: ThreadTerminalRecord | null,
  at: string,
): string {
  const lines: string[] = [
    `# Thread halted: ${thread.brief}`,
    ``,
    `- **Outcome:** ${outcome}`,
    `- **Thread:** \`${thread.id}\` (ordinal ${thread.ordinal})`,
    `- **When:** ${at}`,
  ];
  if (term?.summary) lines.push(``, `## Summary`, term.summary);
  if (term?.blocked) {
    lines.push(
      ``,
      `## Why blocked`,
      `- **reason:** ${term.blocked.reason}`,
      `- **detail:** ${term.blocked.detail}`,
    );
  }
  if (term?.failure) {
    const f = term.failure;
    lines.push(
      ``,
      `## Failure`,
      `- **kind:** ${f.kind}${f.command ? ` — \`${f.command}\`` : ''}${
        f.exitCode != null ? ` (exit ${f.exitCode})` : ''
      }`,
    );
    if (f.stderrTail) lines.push('```', f.stderrTail, '```');
  }
  if (outcome === 'incomplete' && !term) {
    lines.push(
      ``,
      `## Why incomplete`,
      `The build turn ended without asserting completion (no \`complete_thread\`) — nothing was verified or shipped.`,
    );
  }
  if (term?.changes?.length)
    lines.push(``, `## Changes so far`, ...term.changes.map((c) => `- ${c}`));
  if (term?.gaps?.length)
    lines.push(``, `## Known gaps`, ...term.gaps.map((g) => `- ${g}`));
  if (term?.verification?.length) {
    lines.push(``, `## Verification run`);
    for (const v of term.verification) {
      lines.push(`- [${v.kind}] \`${v.command}\` → exit ${v.exitCode}`);
      if (v.outputTail) lines.push('```', v.outputTail, '```');
    }
  }
  return lines.join('\n') + '\n';
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
    `\nTRACK YOUR WORK: use the \`task_create\` / \`task_update\` host tools (the "atlasbridge" MCP server) to` +
      ` keep a live checklist the operator can watch — up front, \`task_create\` one task for each step below,` +
      ` then \`task_update({ taskId, status: "in_progress" })\` as you start each and \`"completed"\` when it's` +
      ` done (\`task_create\` returns the id to pass back). Keep exactly one task in_progress at a time.`,
    `\n1. Review the whole merged diff: \`git diff origin/${repo.defaultBranch}...HEAD\`. Look for real,` +
      ` in-scope defects — correctness bugs, security issues, and cross-thread integration mistakes (where` +
      ` two threads' changes don't line up). Ignore style nits and anything outside this feature's scope.`,
    `\n2. FIX what you find: the smallest safe change per finding, never expanding scope; skip anything` +
      ` unsafe or ambiguous rather than guessing. Make edits directly under \`/workspace\`.`,
    `\n3. VERIFY: run the repo's own typecheck/build/test commands and confirm they pass — do this even if` +
      ` you changed nothing (a clean review still deserves a green build). If verification fails, fix and` +
      ` re-verify rather than leaving it red.`,
    `\n4. COMMIT: if you made fixes, \`git add -A\`, commit with a clear message, and \`git push\` — leave a` +
      ` CLEAN tree. Do NOT open a PR (Atlas does the final ship). If the review found nothing actionable,` +
      ` change nothing and skip the commit.`,
    `\n5. FINISH: when done and the build is green (and your fixes, if any, are committed + pushed), you MUST` +
      ` call the \`complete_thread\` host tool (available via the "atlasbridge" MCP server) with a one-line` +
      ` \`summary\` of what you reviewed/fixed and the \`verification\` you ran. This is how you signal` +
      ` completion — the review is NOT recorded as done until you call it. If you genuinely cannot proceed,` +
      ` call \`block_thread\` with a reason and detail instead.`,
  ].join('\n');
}

/** The task for a verification-gate turn (ADR 0004 rider 3) — resumes the SAME orchestrator session after
 *  it claimed `done`, to run a real diagnostics + typecheck pass before the driver trusts the claim.
 *  `priorErrors` carries the previous iteration's reported remainder, when this is a retry. */
export function renderGateTask(
  changedFiles: string[],
  iteration: number,
  priorErrors: string[],
): string {
  const fileList = changedFiles.map((f) => `- ${f}`).join('\n');
  const priorBlock = priorErrors.length
    ? `\nYour last attempt still left these unresolved:\n${priorErrors.map((e) => `- ${e}`).join('\n')}\n`
    : '';
  return [
    `Verification gate (required before your work is accepted) — attempt ${iteration}.`,
    `\nTHIS TURN'S TOOLS ARE DIFFERENT from your last one: the ONLY host tool available right now is` +
      ` \`report_verification\`. Your system prompt's mention of \`complete_thread\`/\`request_operator_input\`` +
      ` describes the BATCH turn you just finished, not this one — they are NOT callable here, and you` +
      ` already called \`complete_thread\` to get here. Do not ask the operator anything; just do the work` +
      ` below and call \`report_verification\` when you're done — it IS registered for this turn even though` +
      ` your system prompt doesn't mention it by name.`,
    `\nThis thread's changes touched these files:\n${fileList}`,
    priorBlock,
    `\n1. Run \`mcp__atlas-lsp-ts__diagnostics\` on each changed file above — a fast per-file check.`,
    `\n2. Run the repo's own typecheck command (authoritative, whole-program) — discover it the same way` +
      ` you would for a normal build (package.json scripts / repo conventions).`,
    `\n3. Fix every error you find, in THIS session, then re-run both checks to confirm they're clean.`,
    `\n4. COMMIT: once both checks are clean, \`git add -A\`, commit any fixes with a clear message, and` +
      ` \`git push\` — leave a CLEAN working tree (the host does NOT commit for you; it reads what you leave).`,
    `\nWhen both are clean AND your tree is committed + pushed, call \`report_verification\` with` +
      ` \`{ passed: true }\`. If you cannot get the checks clean, call \`report_verification\` with` +
      ` \`{ passed: false, remaining: [...] }\`, listing the specific remaining errors (file:line — message)` +
      ` — never end the turn without calling one or the other.`,
  ]
    .filter(Boolean)
    .join('\n');
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

/** A job's engine-home key for a given surface `type` — STABLE across every thread/step/lens of the job (all
 *  its turns of that type share the job's own nested engine home), keyed by (org,repo,job), never per-branch. */
function jobHomeKey(job: Job, type: EngineHomeType): EngineHomeKey {
  return { orgId: job.orgId, repoId: job.repoId, jobId: job.id, type };
}

/** The ship-review gate applies only to the driver builds the operator drives to a PR — `feature` + `bugfix`.
 *  Other kinds ship straight through: `onboarding` never PRs, `review` reviews an external PR (never builds),
 *  and an `event`-seeded build is an autonomous CI/notification response the operator isn't gating by hand. */
function shipGateApplies(job: Job): boolean {
  return job.kind === 'feature' || job.kind === 'bugfix';
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

/** Render a session-limit reset instant as a short human time (e.g. "3:20 PM"); falls back to the raw ISO
 *  string if it can't be parsed. Kept simple + STABLE so the park notice dedupes on exact text. */
export function fmtReset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

