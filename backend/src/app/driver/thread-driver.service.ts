import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Sema } from 'async-sema';
import { modeApprovesShip } from '@workspace/shared';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { threadDirName } from '../prompt-kit/harness/thread-dir-name';
import { PlanVisibilityService } from '../decision-gate';
import { BrainGateway } from '../brain-gateway';
import {
  AutoFixStage,
  dedupeFindings,
  meetsSeverity,
  lensById,
  reviewAgentsForThread,
  type AutoFixContext,
  type FindingSeverity,
  type ReviewFinding,
} from '../autofix';
import type {
  DecisionRecord,
  Step,
  Job,
  SessionEngine,
  ThreadCondition,
} from '@shared/domain';
import { CODEX_REVIEW_OUTAGE_RETRY_MS } from '@shared/domain';
import {
  EngineAuthError,
  EngineSessionLimitError,
  cleanAuthHaltReason,
  isSessionLimitError,
  isEngineDetachedError,
  UNRESUMABLE_SESSION_MARKER,
  type EngineHomeKey,
  type EngineHomeType,
  type ToolBridgeOptions,
  type ToolImpl,
} from '@shared/engine';
import type { GitAuth } from '@shared/engine/engine.types';
import {
  HOST_RETRY_BACKOFF_MS,
  HOST_TRANSPORT_TRANSIENT_RE,
  MAX_HOST_RETRIES,
  isTransientAuthError,
  INTERNAL_PROFILE_AWARENESS_TOOL,
} from '@shared/engine/engine.types';
import { ProfileAwarenessService } from '../workspace-profile';
import {
  defaultResumeAt,
  isCorroboratedSessionLimit,
  SESSION_LIMIT_TEXT_MISFIRE_MAX,
} from '@shared/engine/session-limit';
import { GithubPrService, LocalGitService, type FeatureSandbox } from '../git';
import {
  CHAT_SURFACE,
  type ChatSurface,
  BLOCK_SINK,
  type BlockSink,
  TurnHarnessFactory,
  TASK_EVENT_SINK,
  type TaskEventSink,
  makeTaskTools,
  laneFor,
  webShipReviewCard,
  type ShipThreadVerification,
} from '../surface';
import { LiveTurnStore, MAIN_LANE } from '../surface/live-turn-store';
import { CredentialResolver } from '../onboarding';
import { ClaudeCredentialStore } from '../onboarding/claude-credential.store';
import { OauthUsageService } from '../onboarding/oauth-usage.service';
import { WorkspaceConfigStore } from '../onboarding/workspace-config.store';
import { McpResolver, McpOAuthService } from '../mcp';
import {
  ConventionProfileResolver,
  type ResolvedConventions,
} from '../conventions';
import {
  SkillResolver,
  SKILL_NUDGE_SELECTOR,
  type SkillNudgeSelector,
} from '../skills';
import { LeaderElectionService } from '../cluster';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox';
import { CONTAINER_CONTEXT } from '../sandbox/container-paths';
// Direct path (not the '../sandbox' barrel, which doesn't re-export it) — mirrors the brain's import.
import { TurnRegistry } from '../sandbox/turn-registry.service';
import type { ReattachOutcome } from '../sandbox/turn-reattach.registry';
import type {
  ActiveTurnEntity,
  SessionAnchor,
  ThreadGroupEntity,
  TaskItem,
  ThreadTerminalRecord,
} from '../persistence/entities';
import type { JobDispatcher } from '../brain';
import { TurnRunnerService } from '../runner';
import {
  COMMIT_AND_PUSH_NOTE,
  renderAgentPrompt,
  renderBatchTask,
  renderMasterReviewTask,
  renderOpenLegTasks,
  renderOpenTasksAdvisory,
  renderRunningServicesNote,
  composeLegSeed,
  foldLegTurn,
  stripContextPressureTag,
  ROTATION_SOFT_NUDGE,
  ROTATION_REMINDER_NUDGE,
  RECORD_LEG_HANDOFF_STOP,
  renderCommitTurnTask,
  renderWakeOnStopReminder,
} from '../prompt-kit';
import { chunkKey, composeTurn } from '../prompt-kit/harness';
import { fromExternal, type AgentMessage } from '@shared/prompt-kit/message';
import {
  StimulusStoreService,
  userChunkFor,
  CHAT_DELIVERY_LEASE_MS,
} from '../stimulus';
import { JitHostExecutor } from '../brain/jit-host-executor';
import { SelfSufficiencyToolsService } from '../brain/self-sufficiency-tools.service';
import { ExposureService } from '../exposure/exposure.service';
import { readServiceMarkers, serviceStatus } from '../exposure/service-markers';
import {
  isDriverExecutableKind,
  threadKindSpec,
  coerceThreadType,
  type ThreadRole,
  type ThreadType,
} from '../thread-kind';
import { threadGroupKindSpec } from '../thread-group-kind';
import { BuildShipService } from './build-ship.service';
import {
  DriverStoreService,
  type DriverThread,
  type JobRoute,
  type ReviewChildThread,
} from './driver-store.service';
import { JobBootstrapService } from '../job-bootstrap';
import {
  renderPlan,
  type PlannedStep,
} from '../prompt-kit/messages/render-plan';
import {
  LegRotationWatch,
  resolveRotationThresholds,
  freshLegRotationState,
  type LegRotationRunState,
  type LegRotationThresholds,
} from './leg-rotation-watch';
import { legRotationRule } from '@shared/prompt-kit/jit';
import {
  DRIVER_REPO,
  type DriverRepoResolver,
  type ResolvedRepo,
} from './repo-resolver';
import { JobLifecycleService } from './job-lifecycle.service';
import { AutoMergeService } from './auto-merge.service';

/**
 * Head+TAIL clamp for one piece of self-reported `complete_thread` evidence output. A plain head-only
 * `slice(0, N)` silently drops the decisive line of a curated proof when it sits past the cut, so keep a
 * head (which command) AND a tail (its result) joined by a visible elision marker. The default cap sits
 * above the measured prod p99 evidence length, so essentially all real evidence passes through untouched.
 */
function clampEvidenceOutput(s: string, cap = 3000): string {
  if (s.length <= cap) return s;
  const head = Math.min(1200, Math.floor(cap / 3));
  const tail = cap - head;
  const elided = s.length - head - tail;
  return `${s.slice(0, head)}\n…[${elided} chars elided]…\n${s.slice(s.length - tail)}`;
}

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
 * A thread's resolved terminal outcome. `done` (a `complete_thread` done-report present) is the only outcome
 * that advances the build to the next thread + ship. `incomplete` is the SINGLE "not done — needs the
 * operator" state: the turn ended without asserting completion, for any reason (no judge, no reason
 * taxonomy). `rotated` = the builder self-authored a leg handoff, so this leg is done and the freshly-
 * inserted builder is driven next.
 */
type ThreadOutcome = 'done' | 'incomplete' | 'rotated';

/** A batch turn's result: the engine report plus the terminal outcome the driver resolved for it. A
 *  `rotated` outcome means the builder self-authored a leg handoff (`record_leg_handoff`): the store
 *  ABANDONED this session and inserted the NEXT builder thread row, so this leg is done and the drive loop
 *  picks up the freshly-inserted builder as its own `runThread` call (no in-process re-kick). */
interface BatchResult {
  outcome: ThreadOutcome;
  report: string;
}

/** A thread's result: its outcome plus the handoff note for the next thread (null unless `done`;
 *  `rotated` also carries null — the rotation handoff was persisted onto the new builder row's
 *  `handoff_in` by `completeLegRotation`, not threaded through here). */
interface ThreadResult {
  outcome: ThreadOutcome;
  handoff: string | null;
}

/**
 * The outcome of driving ONE thread group (a build/direct_build thread group's whole builder chain +
 * review, or a master_review thread group): `advanced` carries the handoff forward to the next thread
 * group; `yield` means leadership was lost mid-drive (runJob returns, leaving the job `running`); `halt`
 * surfaces an unfinished thread for `haltJob` (ADR 0004 — no PR on an unfinished build).
 */
type ThreadGroupDriveResult =
  | { kind: 'advanced'; handoff: string | null }
  | { kind: 'yield' }
  | {
      kind: 'halt';
      thread: DriverThread;
      outcome: ThreadOutcome;
    };

/**
 * Whether a thrown drive-loop error is a TRANSIENT infra blip (sandbox/network/engine hiccup) that a bounded
 * silent retry should paper over — NOT a real failure to surface to the operator (ADR 0004, failure #1: a
 * plain retry fixed the last two "errors"). A build FAILURE never throws here — the orchestrator reports it
 * via its `terminal_record`/report — so a raw exception at the driver level is almost always infra. The few
 * exceptions that are genuinely terminal (auth → paused; detached → boot re-attach; unresumable session; a
 * runaway PHASE_TIMEOUT that must not re-run for another full timeout) are excluded so drive() handles them.
 * Classification-consistency check (post-#231): the build lane's own `turn-runner.service.ts` still throws a
 * typed `EngineSessionLimitError` directly (unlike the brain's engine-core, which now latches a mid-turn
 * limit into a clean `result.sessionLimit`), and `drive()`'s catch classifies `isSessionLimitError(err)`
 * BEFORE this predicate is ever consulted — so the `EngineSessionLimitError` exclusion below is real
 * defense-in-depth, not dead code, and no session-limit error can fall through to a `retryable`/`failed` box.
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
  return HOST_TRANSPORT_TRANSIENT_RE.test(msg);
}

/**
 * Whether a drive-loop error, encountered while `master_review` is the in-flight thread, is a genuine
 * Codex-outage shape (network/transport unreachable, or a Codex auth failure) rather than a real defect —
 * the scope guard for {@link isCodexReviewOutageError}'s callers, which additionally confirm the in-flight
 * thread is `master_review` before treating this as a hold-worthy outage (see d1: never for real findings).
 */
function isCodexReviewOutageError(err: unknown): boolean {
  if (err instanceof EngineAuthError) return err.engine === 'codex';
  return isTransientDriveError(err); // network/transport shapes, retries already exhausted upstream
}

/**
 * Total in-flight review-lens turns run concurrently in a builder's post-build review fan-out — the size of
 * the `async-sema` semaphore that `runReviewChildren` bounds ALL lens turns with. A fixed configuration
 * constant, identical in every environment (no thread composition produces more lenses than this, so it
 * comfortably covers every real fan-out and the semaphore never serialises them).
 */
const REVIEW_LENS_CONCURRENCY = 8;

/** The model the read-only review-lens FINDER turns run on — Sonnet, not the default Opus worker. The
 *  finding task is well within Sonnet's capability and moving the N per-thread finder turns off Opus is the
 *  dominant token win for the review fan-out. The post_review FIX turn keeps the default worker model. */
const REVIEW_LENS_MODEL = 'claude-sonnet-5';

@Injectable()
export class ThreadDriver implements JobDispatcher {
  private readonly logger = new Logger(ThreadDriver.name);
  /** Jobs being driven right now — guards against a double dispatch / a resume racing a live drive. */
  private readonly active = new Set<string>();
  private readonly driveAfterActiveTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

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
    // Host-side Haiku skill-relevance selector — picks the skill(s) directly relevant to a build thread so the
    // build turn can nudge the model to load it. Fail-soft: any failure resolves to no nudge (see below).
    @Inject(SKILL_NUDGE_SELECTOR)
    private readonly skillNudge: SkillNudgeSelector,
    private readonly threadLifecycle: JobLifecycleService,
    private readonly ship: BuildShipService,
    // The ONE merge resolution path — the manual "Merge PR" click lands here (resolveMergeApprovalDurably)
    // exactly like the auto path.
    private readonly autoMerge: AutoMergeService,
    // Lets the terminal-error catch tell a shutdown-induced abort (leave the job resumable) apart from a
    // real failure — so a graceful restart mid-build no longer self-marks the job `failed`.
    private readonly election: LeaderElectionService,
    // The shared transcript spine — a build turn rides it on a `phase:<stepId>` lane so the step sub-page
    // renders a full transcript (thinking/prose/tool calls), exactly like a subagent run.
    private readonly turnHarness: TurnHarnessFactory,
    @Inject(BLOCK_SINK) private readonly blockSink: BlockSink,
    // The live in-memory transcript fan (@Global via SurfaceModule) — fans the best-effort `turn_retry`
    // indicator frame alongside the durable quiet notice on a host auto-retry (never the source of truth).
    private readonly liveTurns: LiveTurnStore,
    // The durable registry of in-flight Redis-transport turns — lets a build batch RE-ATTACH its still-live
    // engine stream after a restart (like the brain) instead of re-running. @Global via SandboxModule.
    private readonly turnRegistry: TurnRegistry,
    // The neutral driver→brain gateway (Phase-3 halt + `done` completion wakes; the brain binds itself
    // into it on bootstrap). Injecting it forms no construction cycle — unlike a
    // `useExisting: AgentSessionManager` port, which would deadlock DI (the brain constructs this service).
    private readonly brainGateway: BrainGateway,
    // Folds a Codex master-review thread's `task_create`/`task_update` bridge calls into its `tasks` column
    // (the SAME sink the Claude lanes' SDK TaskCreate/TaskUpdate use), so the web renders its checklist
    // identically. Claude builders keep using their native SDK task tools via the transcript harness.
    @Inject(TASK_EVENT_SINK) private readonly taskSink: TaskEventSink,
    // @Global ExposureModule — inert unless PREVIEW_BASE_DOMAIN is set. @Optional so the driver still
    // constructs when previews are off; used to render each running service's public preview URL.
    @Optional() private readonly exposure?: ExposureService,
    // The repo's opt-in house-style profile — injected into every build-facing prompt (WORKER /
    // commit) and forwarded on the run args so the in-container FAN_OUT writer subagents get it too.
    // @Optional so unit tests construct the driver without it (undefined → no house style injected); DI
    // (@Global ConventionsModule) supplies it live.
    @Optional() private readonly conventions?: ConventionProfileResolver,
    // @Global OnboardingModule. @Optional so unit tests construct the driver without it (undefined → the
    // auth-halt classifier skips the transient-race branch and always surfaces the halt). Used to resolve
    // the org's selected credential + mark it `needs_reauth` when a refresh is unrecoverable.
    @Optional() private readonly claudeCreds?: ClaudeCredentialStore,
    // @Global OnboardingModule. @Optional so unit tests construct the driver without it (undefined → the
    // preview recipe reader always returns null, so nothing is injected). Used to read the repo's saved
    // preview recipe for the WORKER + `validate` prompts.
    @Optional() private readonly configStore?: WorkspaceConfigStore,
    // The durable inbound ledger — stamps a build-lane host seed `delivered_at` at the engine `input_ack`
    // (live steer) and at the Leg-kick hand-off (fresh-turn drain). StimulusModule is plain-imported into
    // DriverModule.imports (not @Global). @Optional so the direct-construction unit test constructs without
    // it (undefined → no host-seed drain, byte-identical).
    @Optional() private readonly stimulusStore?: StimulusStoreService,
    // The host-side JIT turn-prefix rail — a build-lane fresh-turn drain composes host seeds through the SAME
    // `composeTurn` + `collectOperatorPrepends` rail the brain uses (d4). @Global BrainModule. @Optional so the
    // unit test constructs without it (undefined → the inert empty memory rail, byte-identical framing).
    @Optional() private readonly jit?: JitHostExecutor,
    // Resolves the job's planning thread group thread id — the anchor job-level operator notices (pause/fail/ship/
    // merge boxes) are stamped onto (`messages.thread_id` is NOT NULL). @Optional so the direct-construction
    // unit tests keep compiling; the @Global JobBootstrapModule supplies it live.
    @Optional() private readonly jobBootstrap?: JobBootstrapService,
    // @Optional so the direct-construction unit test constructs without it (undefined → the
    // `__profile_awareness` tool is a silent no-op); DI (the @Global WorkspaceProfileModule) supplies it live.
    @Optional() private readonly profileAwareness?: ProfileAwarenessService,
    // The shared self-sufficiency toolset (request_secret/request_file/recall/remember) — wired onto every
    // build turn's tool set in `buildTurnBridge`, dispatched through the SAME handler bodies the brain uses
    // (@Global BrainModule). @Optional so unit tests construct the driver without it (undefined → those four
    // tools are simply absent from the bridge, matching this constructor's `jit` convention).
    @Optional() private readonly selfSufficiency?: SelfSufficiencyToolsService,
  ) {}

  /** The job's planning thread group thread id — the anchor a job-level operator notice (no build-lane thread of
   *  its own) is stamped onto. Wired in prod via DI; throws loudly if the @Optional dependency is absent. */
  private async planningThreadId(jobId: string): Promise<string> {
    if (!this.jobBootstrap)
      throw new Error('thread-driver: JobBootstrapService not wired');
    try {
      return await this.jobBootstrap.planningThreadId(jobId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('has no planning thread group thread')) throw err;
      const job = await this.store.loadJob(jobId);
      await this.jobBootstrap.ensurePlanningThreadGroup(jobId, job.orgId);
      return this.jobBootstrap.planningThreadId(jobId);
    }
  }

  /** In-process 10s re-drive timers for host auth/transport retries (per job). The durable session_resume
   *  clock (kind:'retry') is the restart backstop; whichever fires first clears the clock. */
  private readonly hostRetryTimers = new Map<string, NodeJS.Timeout>();

  /** The repo's attached house-style, or null when none. Best-effort: a resolver hiccup never sinks a build. */
  private async repoConventionsFor(
    job: Job,
  ): Promise<ResolvedConventions | null> {
    if (!this.conventions) return null;
    return this.conventions
      .resolveForRepo(job.orgId, job.repoId)
      .catch(() => null);
  }

  /** The repo's saved preview recipe, or null when none/unavailable. Best-effort: a lookup hiccup never sinks
   *  a build — it just means the recipe is omitted this turn. */
  private async previewRecipeFor(job: Job): Promise<string | null> {
    try {
      const recipe = await this.configStore?.getPreviewInstructions(
        job.orgId,
        job.repoId,
      );
      return recipe?.trim() ? recipe : null;
    } catch {
      return null;
    }
  }

  /**
   * Re-resolve the authenticated-git for a SINGLE turn: the token (and, for app-mode orgs, the App bot
   * commit identity) are fetched fresh every turn through the resolver — an installation token expires
   * hourly and a >1h job would otherwise push with a dead token. The resolver memoizes (a Map hit unless
   * near expiry), so this is cheap. `gitUrl` is stable and comes from the run-scoped resolved repo.
   */
  private async resolveTurnGitAuth(
    orgId: string,
    gitUrl: string,
  ): Promise<GitAuth> {
    const token = await this.creds.githubToken(orgId);
    // Optional-call: test fakes/older CredentialResolver stand-ins may predate this method — default 'pat'
    // (today's behavior) rather than throwing mid-drive.
    const mode = (await this.creds.githubAuthMode?.(orgId)) ?? 'pat';
    const { identity, apiToken } = await this.creds.githubWriteIdentity(orgId);
    return {
      gitUrl,
      mode,
      ...(token ? { token } : {}),
      ...(apiToken ? { apiToken } : {}),
      ...(identity ? { identity } : {}),
    };
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
    // Resumes a credential/401 halt, a session-limit park, OR a master_review Codex-outage hold (the
    // auto-resume sweep + the operator ping both route here). Any other halt kind (or none) is ignored.
    if (
      !job ||
      ![
        'blocked_credentials',
        'session_limit',
        'codex_review_unavailable',
      ].includes(job.halt?.kind ?? '')
    ) {
      this.logger.warn(
        `resumePaused job=${jobId}: not a resumable halt (${job?.halt?.kind ?? 'gone'}) — ignoring`,
      );
      return;
    }
    this.logger.log(
      `resumePaused job=${jobId} — re-driving the halted session`,
    );
    // OPERATOR RE-ARM (driver-transient lane): an explicit resume always starts a fresh transient-drive
    // retry budget too — mirrors the old function-local `attempt` counter, which reset on every drive()
    // re-entry. Boot `resume()` never calls `resumePaused()`, so it still keeps the accumulated, restart-safe count.
    await this.store.clearDriverRetryCounters(jobId);
    // Clear the durable auto-resume clock too, so the leader sweep never re-fires this resume (no-op for a
    // credential resume that was never parked on the clock).
    await this.store.setSessionResume(jobId, null, null);
    await this.store.setJobStatus(jobId, 'building');
    void this.drive(jobId).catch((err) => {
      this.logger.error(
        `resumePaused job=${jobId} crashed: ${err instanceof Error ? err.stack : err}`,
      );
    });
  }

  /**
   * WATCHDOG RE-ATTACH (build kind: step). The leader watchdog calls this for one
   * orphaned-but-alive `active_turns` row whose engine is still streaming but whose host relay was severed by
   * a restart / leader flap. We don't re-tail the row directly — that would only re-persist the transcript and
   * SKIP the driver's deterministic continuation (completion checks, commit/`commit_sha`, step `done`, branch
   * backstop). Instead we WAKE THE FULL DRIVE: `drive()`→`runJob` fast-forwards completed work, re-reaches the
   * interrupted batch/commit nudge, and re-attaches it via the existing `findReattachableTurn` path — exactly what boot
   * `resume()` does, just triggered continuously instead of once. Idempotent + safe:
   *   - only a `running`, un-halted job is drivable (`runJob`'s chokepoint) — otherwise 'deferred', so a
   *     halted/parked/terminal job keeps its existing recovery (`resumePaused`/`retry`) and the watchdog keeps
   *     the live turn alive rather than finalizing it;
   *   - the per-job `active` single-flight guard (shared with boot `resume()`) means a re-kick can never
   *     double-drive a job whose drive is already in flight.
   */
  async reattachTurnRow(row: ActiveTurnEntity): Promise<ReattachOutcome> {
    const job = await this.store.loadJob(row.job_id).catch(() => null);
    if (!job || job.status !== 'building' || job.halt != null) {
      // Not drivable: `runJob` would no-op on a non-running / halted job anyway. Leave it for its existing
      // recovery path; the watchdog keeps the (live) turn alive.
      return 'deferred';
    }
    if (this.active.has(row.job_id)) {
      // A drive is already in flight for this job (boot resume / a prior wake) — it owns re-reaching and
      // re-attaching every thread's turn. Report attached so the watchdog just keeps it alive meanwhile.
      return 'attached';
    }
    void this.drive(row.job_id).catch((err) =>
      this.logger.error(
        `reattach drive job=${row.job_id} crashed: ${err instanceof Error ? err.stack : err}`,
      ),
    );
    return 'attached';
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
    // OPERATOR RE-ARM (driver-transient lane): an explicit human retry always starts a fresh transient-drive
    // retry budget too — mirrors the old function-local `attempt` counter, which reset on every drive()
    // re-entry. Boot `resume()` never calls `retry()`, so it still keeps the accumulated, restart-safe count.
    await this.store.clearDriverRetryCounters(jobId);
    // Self-heal any drifted/backfilled phase so `runJob`'s `building` gate lets the re-drive through.
    // A Force-resume of a session-limit park routes through here — clear the durable auto-resume clock so the
    // leader sweep never re-fires (harmless no-op for a non-parked retry).
    await this.store.setSessionResume(jobId, null, null);
    await this.store.setJobStatus(jobId, 'building');
    void this.drive(jobId).catch((err) => {
      this.logger.error(
        `retry job=${jobId} crashed: ${err instanceof Error ? err.stack : err}`,
      );
    });
  }

  /**
   * OPERATOR/BRAIN re-drive of a NOT-DONE thread (the `retry_thread` tool + the operator-chat redrive path).
   * A not-done thread landed in the single `incomplete` "needs the operator" state; a re-drive just clears
   * its stale terminal record + condition and re-enters the resumable drive. Operator-initiated only — there
   * is no autonomous loop to bound, so no cap/budget. Precondition chain (so a re-drive never resurrects a
   * finished thread): active guard, job exists, the thread BELONGS to this job, and it is not already `done`.
   */
  async redriveThread(
    jobId: string,
    threadId: string,
    guidance?: string,
  ): Promise<{ ok: boolean; attempt?: number; reason?: string }> {
    if (this.active.has(jobId)) {
      return {
        ok: false,
        reason: 'the build is running right now — retry momentarily',
      };
    }
    const job = await this.store.loadJob(jobId).catch(() => null);
    if (!job) return { ok: false, reason: 'job not found' };
    const ownerJobId = await this.store.threadJobId(threadId).catch(() => null);
    if (ownerJobId !== jobId) {
      this.logger.warn(
        `redriveThread job=${jobId}: thread ${threadId} belongs to ${ownerJobId ?? '(gone)'} — refusing`,
      );
      return {
        ok: false,
        reason: `thread ${threadId} is not part of this job`,
      };
    }
    // Refuse to redrive a thread that already finished. A stale `retry_thread` (the brain acting on an old
    // view) must not clear the terminal record + flip the thread back to `executing` — that would erase the
    // very `done` evidence the drive short-circuits on and re-run a completed thread.
    const current = await this.store.getThread(threadId).catch(() => null);
    if (current?.status === 'done') {
      this.logger.warn(
        `redriveThread job=${jobId}: thread ${threadId} already done — refusing (won't resurrect a completed thread)`,
      );
      return { ok: false, reason: `thread ${threadId} is already complete` };
    }
    await this.store.clearTerminalRecord(threadId).catch(() => undefined);
    // RE-ARM the #254 transient-drive retry lane (this re-drive re-enters `drive()`), mirroring
    // `retry`/`resumePaused` — a fresh drive gets a fresh transient budget.
    await this.store.clearDriverRetryCounters(jobId).catch(() => undefined);
    await this.store.setThreadStatus(threadId, 'idle').catch(() => undefined);
    await this.store
      .setThreadCondition(threadId, 'none')
      .catch(() => undefined);
    if (guidance) {
      await this.store
        .setThreadOrientation(threadId, guidance)
        .catch(() => undefined);
    }
    if (job.status !== 'building') {
      await this.store.setJobStatus(jobId, 'building').catch(() => undefined);
    }
    this.logger.log(
      `redriveThread job=${jobId} thread=${threadId} — re-driving`,
    );
    void this.drive(jobId).catch((err) =>
      this.logger.error(
        `redriveThread drive job=${jobId} crashed: ${err instanceof Error ? err.stack : err}`,
      ),
    );
    return { ok: true };
  }

  /**
   * "Retry now" operator lever for a NOT-DONE thread — a thin operator-initiated re-drive. The
   * verification-judge outage hold it once guarded is gone (no host verification gate), so this just
   * re-enters {@link redriveThread}, which owns the active/exists/belongs/not-done precondition chain.
   */
  async operatorRetryStuckThread(
    jobId: string,
    threadId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const r = await this.redriveThread(jobId, threadId);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }

  /**
   * DEPRECATED operator entry point. The "skip & accept" hold existed only for the deleted
   * verification-judge outage; with `complete_thread` the sole done-signal there is nothing to skip &
   * accept. Retained (returns a refusal) only to satisfy the `JobDispatcher` interface + web route until a
   * coordinated slice removes the endpoint; a not-done thread is re-driven via {@link operatorRetryStuckThread}.
   */
  async operatorAcceptStuckThread(
    jobId: string,
    threadId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    void jobId;
    void threadId;
    return {
      ok: false,
      reason:
        'skip & accept is no longer available (the verification gate was removed) — use retry',
    };
  }

  /**
   * "Ship without review" — the operator escape hatch on a `codex_review_unavailable` hold (d1: shipping
   * without the automated Codex whole-diff pass is always an explicit operator choice, never automatic).
   * Marks `master_review` skipped/done (so the drive loop's `status !== 'done'` scan passes over it) and
   * re-drives, landing the job at the normal `awaiting_ship_review` gate — the human diff review still runs.
   */
  async operatorShipWithoutReview(
    jobId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (this.active.has(jobId)) {
      return {
        ok: false,
        reason: 'the build is running right now — retry momentarily',
      };
    }
    const job = await this.store.loadJob(jobId).catch(() => null);
    if (!job) return { ok: false, reason: 'job not found' };
    if (job.halt?.kind !== 'codex_review_unavailable') {
      return { ok: false, reason: 'not a Codex-outage hold' };
    }
    const threads = await this.store.threadsForJob(jobId).catch(() => []);
    const mr = threads.find((t) => t.kind === 'master_review');
    if (!mr) return { ok: false, reason: 'no master review thread' };
    await this.store
      .recordThreadTermination(mr.id, {
        status: 'done',
        summary:
          'Master review skipped — shipped without the automated Codex review (operator, Codex outage).',
      })
      .catch(() => undefined);
    for (const p of await this.store.stepsForThread(mr.id)) {
      await this.store
        .setStepState(p.id, 'done', 'done')
        .catch(() => undefined);
    }
    await this.store.setThreadStatus(mr.id, 'done').catch(() => undefined);
    await this.store.setSessionResume(jobId, null, null).catch(() => undefined);
    await this.store.setJobStatus(jobId, 'building').catch(() => undefined);
    void this.drive(jobId).catch((err) =>
      this.logger.error(
        `operatorShipWithoutReview job=${jobId} crashed: ${err}`,
      ),
    );
    return { ok: true };
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
    // A fresh drive supersedes any parked host-retry timer for this job (e.g. an operator retry/resumePaused
    // re-entering while a 10s backstop wait was still pending).
    const pendingTimer = this.hostRetryTimers.get(jobId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.hostRetryTimers.delete(jobId);
    }
    await this.store
      .clearRetrySessionResume(jobId, 'build')
      .catch((err) =>
        this.logger.warn(`clearRetrySessionResume(${jobId}) failed: ${err}`),
      );
    try {
      await this.runJobWithTransientRetry(jobId);
      // A clean drive clears the lost-rotation-race auto-retry budget so a future, unrelated auth halt on
      // this job starts fresh. Resets BOTH driver retry lanes (auth + transient-drive).
      await this.store.clearDriverRetryCounters(jobId);
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
        // fixed. Re-driving blindly would just 401 again — but a Claude personal cred whose token was
        // rotated by a CONCURRENT turn/keep-alive an instant ago means this turn merely lost the rotation
        // race and the DB already holds a fresh token; a bounded auto-retry recovers it (the pre-turn
        // `ensureFresh` will pick up the fresh token). Otherwise it's a genuinely dead login → `needs_reauth`.
        this.logger.warn(
          `job=${jobId} halted on credential error: ${err.message}`,
        );
        // NOTE: no `setJobHalt` here — a job the classifier decides to RETRY must show no paused banner (d1:
        // quiet-only retry, no human action pending). The halt is set ONLY in the classifier's SURFACE branch.
        await this.classifyAndSurfaceAuthHalt(jobId, err);
      } else if (isSessionLimitError(err)) {
        // A Claude subscription SESSION/USAGE limit — PARK (don't fail): the phase is preserved and the
        // unfinished step's session_id was persisted at the throw, so the lane resumes the SAME session. It
        // auto-resumes once the reset passes (the leader `SessionResumeSweep` → `resumePaused`) or on an
        // operator Force-resume (`POST …/retry`). Do NOT consume `halt_fix_attempts` — this isn't a build failure.
        const limit = err as EngineSessionLimitError;
        const job = await this.store.loadJob(jobId).catch(() => null);
        const orgId = job?.orgId;
        const util =
          limit.source === 'text' && orgId
            ? await this.usage
                .getUtilization(orgId, limit.rateLimitType)
                .catch(() => undefined)
            : undefined;

        const durablePark = async (): Promise<void> => {
          this.logger.warn(
            `job=${jobId} parked on session limit: ${limit.message}`,
          );
          // Resume-clock precedence (d5): the engine's precise reset instant → the org's harvested usage window.
          const resumeAt =
            limit.resetAt ??
            (orgId
              ? await this.usage.getResetAt(orgId, limit.rateLimitType)
              : undefined);
          // When neither yields a precise instant, park on a BOUNDED default clock (now + shortest window) so the
          // leader sweep still auto-resumes — a null clock would only ever be Force-resumed by hand.
          const resumeClock = resumeAt ?? defaultResumeAt();
          // Reflect the limit in the org's usage snapshot so the composer ring reads the session as FULL until
          // reset — this also covers the text-fallback path, which carries no `rate_limit_event` frame to harvest.
          if (orgId)
            void this.usage
              .applyHarvest(orgId, {
                status: 'rejected',
                rateLimitType: limit.rateLimitType,
                resetsAt: new Date(resumeClock).getTime(),
                utilization: 100,
                credentialId: limit.credentialId,
              })
              .catch(() => undefined);
          // A structured `rateLimitType` means the reset came from the usage frame/API; its absence means the
          // engine fell back to parsing the CLI's printed "resets …" string.
          const resetSource: 'usage_api' | 'parsed_string' = limit.rateLimitType
            ? 'usage_api'
            : 'parsed_string';
          await this.store
            .setSessionResume(jobId, resumeClock, {
              lane: 'build',
              reason: limit.message,
              resetSource,
            })
            .catch(() => undefined);
          await this.store
            .clearDriverRetryCounters(jobId)
            .catch(() => undefined);
        };

        if (isCorroboratedSessionLimit(limit.source, util)) {
          await durablePark();
        } else {
          const { ok, used } = await this.store.claimSessionLimitTextMisfire(
            jobId,
            SESSION_LIMIT_TEXT_MISFIRE_MAX,
          );
          if (!ok || used >= SESSION_LIMIT_TEXT_MISFIRE_MAX) {
            this.logger.warn(
              `job=${jobId} text-only session limit unconfirmed x${SESSION_LIMIT_TEXT_MISFIRE_MAX} — parking`,
            );
            await durablePark(); // backstop escalation
          } else {
            this.logger.warn(
              `job=${jobId} unconfirmed text-only session limit (util=${util ?? 'unknown'}) — quiet host-retry`,
            );
            await this.scheduleBuildHostRetry(
              jobId,
              'unconfirmed session limit (text fallback) — re-checking',
            );
          }
        }
      } else if (
        isCodexReviewOutageError(err) &&
        (await this.inFlightThreadIsMasterReview(jobId))
      ) {
        // A network/transport blip that exhausted `runJobWithTransientRetry`'s budget, or a Codex auth
        // failure, while master_review is in flight — a genuine Codex outage, not a build defect (d1): hold
        // on a re-waking clock instead of flipping the job to `failed`.
        this.logger.warn(
          `job=${jobId} master_review Codex outage — holding (not failing): ${err instanceof Error ? err.message : err}`,
        );
        await this.holdForCodexReviewOutage(jobId, err);
      } else {
        this.logger.error(
          `job=${jobId} failed: ${err instanceof Error ? err.stack : err}`,
        );
      }
    } finally {
      this.active.delete(jobId);
    }
  }

  /**
   * Run the job, retrying a bounded number of times on TRANSIENT infra errors (ADR 0004, failure #1; d1-B
   * host backstop). `runJob` is resumable — a re-entry fast-forwards completed threads/batches and resumes
   * the interrupted turn — so a retry is safe. Non-transient errors and an exhausted budget propagate to
   * `drive()`'s classification (paused / detached / failed). Skipped entirely while draining (a shutdown is
   * not a retryable error — drive() leaves the job running for boot-resume). Quiet: each retry fans a
   * best-effort live indicator (`liveTurns.retry`).
   */
  private async runJobWithTransientRetry(jobId: string): Promise<void> {
    const maxRetries = MAX_HOST_RETRIES;
    // Restart-safe re-entry: a retry may already have been in flight when the process died mid-backoff
    // (the durable claim below stamps `retry_last_attempt_at` the instant it's granted). Honor whatever's
    // left of that cooldown window before driving again, so a boot resume can't fire off immediately after
    // a claim it never got to sleep out. A fresh entry (no prior claim, or one aged past the window) waits
    // zero.
    const { count, lastAttemptAt } =
      await this.store.driverTransientRetryState(jobId);
    if (count > 0 && lastAttemptAt) {
      const remaining =
        HOST_RETRY_BACKOFF_MS - (Date.now() - lastAttemptAt.getTime());
      if (remaining > 0) {
        await new Promise((r) => setTimeout(r, remaining));
      }
    }
    for (;;) {
      try {
        await this.runJob(jobId);
        return;
      } catch (err) {
        if (this.election.isDraining() || !isTransientDriveError(err)) {
          throw err;
        }
        const { ok, used: n } = await this.store.claimDriverTransientRetry(
          jobId,
          maxRetries,
        );
        if (!ok) {
          throw err;
        }
        this.logger.warn(
          `job=${jobId} transient drive error (attempt ${n}/${maxRetries}) — retrying in ${HOST_RETRY_BACKOFF_MS}ms: ${
            err instanceof Error ? err.message : err
          }`,
        );
        const job = await this.store.loadJob(jobId).catch(() => null);
        const lane = await this.retryLaneForJob(jobId);
        try {
          this.liveTurns.retry(job?.repoId ?? jobId, jobId, lane, {
            attempt: n,
            max: maxRetries,
            nextAttemptAt: Date.now() + HOST_RETRY_BACKOFF_MS,
          });
        } catch {
          // live-only fan — never let a UI-indicator hiccup break the retry loop.
        }
        await new Promise((r) => setTimeout(r, HOST_RETRY_BACKOFF_MS));
      }
    }
  }

  /**
   * Classify a Claude/Codex auth halt and either AUTO-RETRY it (any transient auth error — a lost token
   * rotation race, a blip the SDK's own `ensureFresh` may clear on the next attempt — up to the unified
   * `MAX_HOST_RETRIES` budget at a flat `HOST_RETRY_BACKOFF_MS`) or SURFACE it as a genuine `needs_reauth`
   * failure (deterministic-fatal, or the retry budget is spent). The halt is set ONLY on the surface path —
   * a retrying job shows no paused banner (d1: quiet-only retry, no human action pending).
   */
  private async classifyAndSurfaceAuthHalt(
    jobId: string,
    err: EngineAuthError,
  ): Promise<void> {
    const job = await this.store.loadJob(jobId).catch(() => null);
    const orgId = job?.orgId;
    const isClaudeAuthHalt = err.engine !== 'codex';
    const selected =
      isClaudeAuthHalt && orgId && this.claudeCreds
        ? await this.claudeCreds.getSelectedRefreshMeta(orgId).catch(() => null)
        : null;
    if (isTransientAuthError(err)) {
      const { ok, used: n } = await this.store.claimAuthRetryAttempt(
        jobId,
        MAX_HOST_RETRIES,
      );
      if (ok) {
        // RETRY: no halt set (no paused banner) — a best-effort live indicator, then a precise 10s re-drive of
        // the SAME engine session via the durable resume clock + in-process timer.
        const lane = await this.retryLaneForJob(jobId);
        try {
          this.liveTurns.retry(job?.repoId ?? jobId, jobId, lane, {
            attempt: n,
            max: MAX_HOST_RETRIES,
            nextAttemptAt: Date.now() + HOST_RETRY_BACKOFF_MS,
          });
        } catch {
          // live-only fan — never let a UI-indicator hiccup break the retry.
        }
        await this.scheduleBuildHostRetry(jobId, err.message);
        this.logger.warn(
          `job=${jobId} transient auth halt — auto-retry ${n}/${MAX_HOST_RETRIES} in ${HOST_RETRY_BACKOFF_MS}ms`,
        );
        return;
      }
    }

    // SURFACE (deterministic-fatal, or the retry budget is spent): set the halt HERE (renders the paused
    // banner), flip the selected cred to `needs_reauth` so Settings shows a reconnect affordance, then post a
    // pause notice and wait for the human. Only claim the login is dead (the actionable reconnect copy) when
    // we actually marked it; otherwise fall back to the generic credential-pause notice. Resets BOTH driver
    // retry lanes (auth + transient-drive) — this is a genuine terminal auth-halt surface for this job.
    await this.store.clearDriverRetryCounters(jobId);
    if (
      err.engine === 'codex' &&
      (await this.inFlightThreadIsMasterReview(jobId))
    ) {
      // A Codex auth failure while master_review is in flight is a Codex OUTAGE, not a dead login (d1: never
      // a blocked_credentials needs-you state here) — hold on a re-waking clock instead.
      await this.holdForCodexReviewOutage(jobId, err);
      return;
    }
    if (orgId && selected && this.claudeCreds) {
      await this.claudeCreds
        .markNeedsReauth(orgId, selected.id, err.message)
        .catch(() => undefined);
    }
  }

  /** Best-effort live lane for a build host retry: current/next executable thread, else the Main fallback. */
  private async retryLaneForJob(jobId: string): Promise<string> {
    const threads = await this.store.threadsForJob(jobId).catch(() => []);
    const thread = threads.find(
      (t) => isDriverExecutableKind(t.kind) && t.status !== 'done',
    );
    return thread ? laneFor('builder', thread.id) : MAIN_LANE;
  }

  /** Whether the job's current in-flight thread (the first non-`done` executable thread) is `master_review`
   *  — master_review runs LAST, only once every builder is `done`, so this reliably scopes a Codex-outage
   *  hold to the ship-time review pass rather than a builder's own Codex/Claude use. */
  private async inFlightThreadIsMasterReview(jobId: string): Promise<boolean> {
    const threads = await this.store.threadsForJob(jobId).catch(() => []);
    const thread = threads.find(
      (t) => isDriverExecutableKind(t.kind) && t.status !== 'done',
    );
    return thread?.kind === 'master_review';
  }

  /**
   * PARK (don't fail) a job on a genuine Codex outage hit while `master_review` is in flight (d1): the phase
   * is preserved, master_review is left non-`done` so a re-drive re-runs it, and the leader
   * `SessionResumeSweep` auto-resumes it once `resumeAt` passes (mirrors the `session_limit` park). The
   * operator can also jump straight to `operatorShipWithoutReview` instead of waiting out the clock.
   */
  private async holdForCodexReviewOutage(
    jobId: string,
    err: unknown,
  ): Promise<void> {
    const reason = 'Master review is paused — Codex is unreachable.';
    const resumeAt = new Date(
      Date.now() + CODEX_REVIEW_OUTAGE_RETRY_MS,
    ).toISOString();
    await this.store
      // `resetSource` is required by the column type but not used for routing — 'usage_api' mirrors the
      // host-retry park's fixed-clock convention (`scheduleBuildHostRetry`), since this clock isn't a
      // harvested usage window either.
      .setSessionResume(jobId, resumeAt, {
        lane: 'build',
        reason,
        resetSource: 'usage_api',
      })
      .catch(() => undefined);
  }

  /**
   * Arm the precise 10s host-retry re-drive for the build lane (d1-B). Writes the durable `kind:'retry'`
   * resume clock FIRST (awaited — the restart-only backstop: if the process dies before the in-process timer
   * fires, the leader `SessionResumeSweep` still re-drives once this clock is due), then arms an in-process
   * `setTimeout` that at 10s clears the clock and re-drives via `resumeRetry`. Per-job, so a superseding drive
   * cancels a stale timer.
   */
  private async scheduleBuildHostRetry(
    jobId: string,
    reason: string,
  ): Promise<void> {
    const resumeAt = new Date(Date.now() + HOST_RETRY_BACKOFF_MS).toISOString();
    await this.store
      .setSessionResume(jobId, resumeAt, {
        lane: 'build',
        reason,
        resetSource: 'usage_api',
        kind: 'retry',
      })
      .catch(() => undefined);
    const existing = this.hostRetryTimers.get(jobId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.hostRetryTimers.delete(jobId);
      void this.resumeRetry(jobId).catch((e) =>
        this.logger.error(
          `host-retry re-drive job=${jobId} crashed: ${e instanceof Error ? e.stack : e}`,
        ),
      );
    }, HOST_RETRY_BACKOFF_MS);
    if (typeof t.unref === 'function') t.unref();
    this.hostRetryTimers.set(jobId, t);
  }

  /**
   * Re-drive a job parked on a host-retry clock (NO halt to clear — a retry park sets none). Clears the
   * resume clock (so the leader sweep never double-fires), ensures `running`, and re-enters the SAME drive
   * (fast-forwards completed work, resumes the interrupted step's engine session). Used by BOTH the
   * in-process timer above and the resume sweep's `kind:'retry'` branch.
   */
  async resumeRetry(jobId: string): Promise<void> {
    if (this.active.has(jobId)) {
      this.logger.warn(`resumeRetry job=${jobId}: already driving — ignoring`);
      return;
    }
    const t = this.hostRetryTimers.get(jobId);
    if (t) {
      clearTimeout(t);
      this.hostRetryTimers.delete(jobId);
    }
    await this.store.setSessionResume(jobId, null, null).catch(() => undefined);
    await this.store.setJobStatus(jobId, 'building').catch(() => undefined);
    void this.drive(jobId).catch((err) =>
      this.logger.error(
        `resumeRetry job=${jobId} crashed: ${err instanceof Error ? err.stack : err}`,
      ),
    );
  }

  /**
   * Walk a job's threads in order. The whole build flow lives here, readable top-to-bottom:
   *   load the job + record + route → ensure the feature sandbox → for each thread: runThread (which
   *   carries the prior handoff forward) → after all threads: finalizeBuild (ship — Atlas opens the PR in-sandbox).
   * Fast-forwards `done` threads (resume): a finished thread just yields its persisted handoff_out.
   */
  private async runJob(jobId: string): Promise<void> {
    const job = await this.store.loadJob(jobId);
    if (job.status !== 'building') {
      this.logger.warn(
        `job=${jobId} not running (status=${job.status}) — not driving`,
      );
      return;
    }
    // HALT INVARIANT: a halted job is NEVER driven — the single chokepoint. `halt` is cleared only by an
    // operator re-engagement (retry/resumePaused) or a brain re-drive (redriveThread), which re-enter here.
    if (job.halt != null) {
      this.logger.warn(`job=${jobId} halted (${job.halt.kind}) — not driving`);
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

    // THREAD-GROUP-DRIVEN DISPATCH (d7): the pipeline is the ordinal-ordered sequence of THREAD GROUPS,
    // not a flat job-wide thread list. Drive each executable thread group in ordinal order, routing its
    // behavior off the thread-group-kind registry rather than branching on kind inline.
    const threadGroups = await this.store.threadGroupsForJob(jobId);
    // CURRENT-REVISION ONLY: a thread group on an OLDER decision record is superseded history and must
    // never re-drive (plan-revision scoping moved off the thread onto `threadGroup.decision_record_id`,
    // d7 — mirrors `threadsForJob`'s revision gate). A thread group with a null record is
    // revision-agnostic → always current.
    const activeRecordId = job.decisionRecordId ?? null;
    const currentThreadGroups = threadGroups.filter(
      (s) =>
        s.decision_record_id == null || s.decision_record_id === activeRecordId,
    );
    // EXECUTABLE THREAD GROUPS: a thread group is driven here only if its kind contains a
    // driver-executable role (build/direct_build → `builder`; master_review → `master_review`).
    // planning/plan_review are render-only (their runtime lives in the brain), and post_build/ci don't
    // exist yet. Route off the registry, never a hardcoded kind list.
    const executableThreadGroups = currentThreadGroups.filter((s) =>
      threadGroupKindSpec(s.kind).roles.some((r) => isDriverExecutableKind(r.role)),
    );
    // NON-DRIVER GUARD: a job with NO executable thread groups is brain-owned — a pure planning/chat job
    // (only render-only thread groups). The driver must not fall through to the ship gate and spuriously
    // PARK it at `awaiting_ship_review` (or re-ship it past the gate). A driver build carries >=1 builder
    // Section; a PLANNED build also appends a master_review group, a DIRECT build (d6) just the one Section.
    if (executableThreadGroups.length === 0) {
      this.logger.log(
        `job=${jobId} has no driver-executable thread groups (brain-owned/direct build) — driver yielding, nothing to build or ship`,
      );
      return;
    }
    await this.store.recomputeBuildStageProgress(jobId).catch(() => undefined);
    // CAP (MAX_SECTIONS): bound the number of BUILD thread groups driven per run, but NEVER drop a
    // master_review thread group (it rides last). I cap BUILD THREAD GROUPS rather than builder threads —
    // a build thread group's rotated legs are its own budget (MAX_LEGS_PER_THREAD_GROUP), so the pipeline
    // ceiling is naturally the count of build slices. Partition, cap the build thread groups, keep every
    // master_review, then re-sort into pipeline order.
    const buildThreadGroups = executableThreadGroups.filter((s) =>
      threadGroupKindSpec(s.kind).roles.some((r) => r.role === 'builder'),
    );
    const reviewThreadGroups = executableThreadGroups.filter(
      (s) => s.kind === 'master_review',
    );
    const cappedBuildThreadGroups = buildThreadGroups.slice(0, this.maxThreads);
    if (buildThreadGroups.length > cappedBuildThreadGroups.length) {
      this.logger.warn(
        `job=${jobId} has ${buildThreadGroups.length} build thread groups > MAX_SECTIONS (${this.maxThreads}) — capping`,
      );
    }
    const threadGroupsToRun = [
      ...cappedBuildThreadGroups,
      ...reviewThreadGroups,
    ].sort((a, b) => a.ordinal - b.ordinal);

    // The :rocket: liveness post — count the active-revision executable threads still pending (accurate
    // across a resume, so a fully-done build on re-drive doesn't re-announce "Starting the build").
    const activeThreads = await this.store.threadsForJob(jobId);
    const pending = activeThreads.filter(
      (t) => isDriverExecutableKind(t.kind) && t.status !== 'done',
    ).length;
    if (pending > 0) {
      await this.post(
        route,
        `:rocket: Starting the build — ${pending} thread(s) on \`${sandbox.branch}\`.`,
      );
    }

    let handoff: string | null = null;
    for (const threadGroup of threadGroupsToRun) {
      // LEADERSHIP FENCE: drives are fire-and-forget and NOT gated on leadership mid-flight (see
      // LeaderElectionService), so a leader demoted mid-build (connection blip → a standby promotes and
      // re-drives this same `running` job) would keep driving it — two processes on one worktree/branch.
      // Re-check the ONE shared master lease at each THREAD-GROUP boundary (and, for a build thread group,
      // each builder boundary inside `driveBuildThreadGroup`) and yield if we're no longer leader: a bare
      // `return` leaves the job `running` (NO status write), and the current leader re-drives it
      // (promote-time `resume()` + the reap-tick backstop). Yielding is a cooperative stop, NOT an error —
      // never throw here.
      if (!this.election.isLeader()) {
        this.logger.warn(
          `job=${job.id} lost leadership mid-drive — yielding (a leader will re-drive; job left running)`,
        );
        return;
      }
      const spec = threadGroupKindSpec(threadGroup.kind);
      const isMasterReviewThreadGroup = spec.roles.some(
        (r) => r.role === 'master_review',
      );
      const res: ThreadGroupDriveResult = isMasterReviewThreadGroup
        ? await this.driveMasterReviewThreadGroup(
            job,
            record,
            route,
            repo,
            sandbox,
            threadGroup,
            handoff,
          )
        : await this.driveBuildThreadGroup(
            job,
            record,
            route,
            repo,
            sandbox,
            threadGroup,
            handoff,
          );
      if (res.kind === 'yield') return;
      if (res.kind === 'halt') {
        // NOT DONE: a thread that ended without `complete_thread` must not ship. Relay a durable "needs the
        // operator" card, flip the job to the single `incomplete` halt, write the trail, and SKIP
        // finalizeBuild — no PR on an unfinished build. The operator re-drives it from chat.
        await this.haltJob(job, route, res.thread, res.outcome);
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
    //
    // AUTO-APPROVE (per-job opt-in): parkForShipReview posts the card for audit, then stamps the approval
    // marker INLINE and returns true — we fall through to finalizeBuild WITHIN this same drive rather than
    // re-driving (a re-entrant drive() would be dropped by the single-flight `active` guard, stalling the
    // ship until the next process boot). false → the job is parked awaiting the operator's click.
    if (shipGateApplies(job)) {
      const gateJob =
        job.shipReviewApprovedAt == null
          ? await this.store.loadJob(job.id).catch(() => job)
          : job;
      if (gateJob.shipReviewApprovedAt == null) {
        const autoApproved = await this.parkForShipReview(job, route);
        if (!autoApproved) return;
      }
    }
    await this.finalizeBuild(job, record, route, repo, sandbox);
  }

  /**
   * Drive ONE `build`/`direct_build` thread group: run its `builder`-role threads SEQUENTIALLY in ordinal
   * order, RE-QUERYING the thread group between iterations because a leg rotation
   * (`record_leg_handoff`) appends a fresh builder row mid-drive (`runThread` returns `rotated` for the
   * leg it rotated away from, and the next loop picks up the newly-inserted `pending` builder). Loops
   * until no non-done builder remains, then runs the thread group's review ONCE over its cumulative diff
   * if the thread-group kind reviews (registry `hasReview` — `direct_build` skips it). The
   * cross-thread-group handoff carries into the FIRST leg; a rotated leg instead uses its OWN persisted
   * `handoff_in` (written by `completeLegRotation`).
   */
  private async driveBuildThreadGroup(
    job: Job,
    record: DecisionRecord | null,
    route: JobRoute,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
    threadGroup: ThreadGroupEntity,
    incomingHandoff: string | null,
  ): Promise<ThreadGroupDriveResult> {
    let handoff = incomingHandoff;
    for (;;) {
      // LEADERSHIP FENCE at each builder boundary (see runJob) — a rotation can append rows mid-drive, so
      // the fence lives inside this loop, not only at the thread-group boundary.
      if (!this.election.isLeader()) {
        this.logger.warn(
          `job=${job.id} lost leadership mid-drive — yielding (a leader will re-drive; job left running)`,
        );
        return { kind: 'yield' };
      }
      const builders = (
        await this.store.driverThreadsForThreadGroup(threadGroup.id)
      ).filter((t) => t.kind === 'builder');
      const builderFinished = (t: DriverThread) => t.status === 'done';
      // Carry the newest finished builder's handoff forward — covers both a resume and the post-run state
      // (the leg we just finished). A rotated leg overrides this with its own `handoff_in` below.
      const lastFinished = [...builders].reverse().find(builderFinished);
      if (lastFinished?.handoffOut) handoff = lastFinished.handoffOut;
      const next = builders.find((t) => !builderFinished(t));
      if (!next) break; // builder chain genuinely finished
      const res = await this.runThread(
        job,
        record,
        route,
        repo,
        sandbox,
        next,
        next.handoffIn ?? handoff,
      );
      // A rotated leg finished its work cleanly and inserted the next builder row — keep going within the
      // thread group: re-query and drive the freshly-inserted `pending` builder next. Do NOT run review or
      // treat the thread group as finished.
      if (res.outcome === 'rotated') continue;
      if (res.outcome !== 'done') {
        return { kind: 'halt', thread: next, outcome: res.outcome };
      }
      handoff = res.handoff;
    }

    // Builder chain genuinely finished — advance the sidebar's build-stage count now (before review), so a
    // just-finished builder counts immediately and the 'auto_fixing' review window doesn't hold it back.
    await this.store.recomputeBuildStageProgress(job.id).catch(() => undefined);

    // REVIEW ONCE PER THREAD GROUP (d13): after the LAST builder leg is genuinely done, run the review
    // over the thread group's CUMULATIVE diff (the FIRST leg's `start_sha`..HEAD — HEAD already carries
    // every leg's commits on the shared feature branch). Tree-parent the review children off the LAST
    // builder (materialize stamps the thread_group_id regardless), and route agent selection off the THREAD
    // GROUP's `type` (d7). A DIRECT build (d6) runs a real builder Section but with reviews OFF: it uses the
    // same `section` kind (`hasReview:true`), so the review skip is gated on the JOB's `build_path`, not the
    // kind — direct builds have no review children and no `master_review` group.
    if (job.buildPath !== 'direct' && threadGroupKindSpec(threadGroup.kind).hasReview) {
      const builders = (
        await this.store.driverThreadsForThreadGroup(threadGroup.id)
      ).filter((t) => t.kind === 'builder');
      const firstBuilder = builders[0];
      const lastBuilder = builders[builders.length - 1];
      if (firstBuilder && lastBuilder) {
        const existingReview = await this.store
          .reviewChildren(lastBuilder.id)
          .catch(() => []);
        const reviewAlreadyTerminal =
          existingReview.length > 0 &&
          existingReview.every(
            (c) => c.status === 'done' || c.condition === 'failed',
          );
        if (!reviewAlreadyTerminal) {
          const threadGroupStartSha = await this.resolveThreadStartSha(
            firstBuilder,
            sandbox,
          );
          await this.runReviewChildren(
            job,
            route,
            sandbox,
            lastBuilder,
            record,
            threadGroupStartSha,
            repo,
            coerceThreadType(threadGroup.type),
          );
          // `runReviewChildren` flips the parent builder to `auto_fixing` (the review-window affordance) but,
          // now that review runs AFTER the builder is already done, nothing restores it — so flip the last
          // builder back to `done` here (in the old per-thread flow `runThread` did this right after review).
          await this.store
            .setThreadStatus(lastBuilder.id, 'done')
            .catch(() => undefined);
        }
      }
    }
    return { kind: 'advanced', handoff };
  }

  /**
   * Drive ONE `master_review` thread group — its single `master_review` thread (a whole-diff Codex
   * review-&-fix), reached via thread-group iteration.
   * NON-GATING (d3): master_review is advisory. A not-done master_review does NOT halt the ship — it surfaces
   * on the ship card like any build thread, and the pipeline still reaches `parkForShipReview` regardless.
   * Master review keeps its full review+fix+verify capability; it just no longer blocks the ship. Never
   * rotates (Codex has no `record_leg_handoff`).
   */
  private async driveMasterReviewThreadGroup(
    job: Job,
    record: DecisionRecord | null,
    route: JobRoute,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
    threadGroup: ThreadGroupEntity,
    incomingHandoff: string | null,
  ): Promise<ThreadGroupDriveResult> {
    const threads = await this.store.driverThreadsForThreadGroup(threadGroup.id);
    const mr = threads.find((t) => t.kind === 'master_review');
    if (!mr) return { kind: 'advanced', handoff: incomingHandoff };
    if (mr.status === 'done') {
      return { kind: 'advanced', handoff: mr.handoffOut ?? incomingHandoff };
    }
    const res = await this.runThread(
      job,
      record,
      route,
      repo,
      sandbox,
      mr,
      incomingHandoff,
    );
    // ADVISORY: whatever master_review's outcome, ADVANCE to the ship gate. A not-done master_review leaves
    // its `incomplete` condition on the thread, which `parkForShipReview` surfaces on the ship card for the
    // operator — it never blocks the ship (the human ship-review + CI are the real gates).
    if (res.outcome !== 'done') {
      this.logger.log(
        `master_review "${mr.brief}" not done (${res.outcome}) — advisory, advancing to the ship gate`,
      );
    }
    return { kind: 'advanced', handoff: res.handoff ?? incomingHandoff };
  }

  private async resolveAutoApprover(job: Job): Promise<string> {
    if (job.autoApproveBy) return job.autoApproveBy;
    const owner = await this.store.ownerUserId(job.orgId);
    if (!owner)
      throw new Error(
        `no auto-approve approver for job ${job.id} (no auto_approve_by and no org owner)`,
      );
    return owner;
  }

  /**
   * Park the job at the ship-review gate: flip `running → awaiting_ship_review` + post the durable "Ship it"
   * card (one txn, single-park-guarded in the store), then a live notice + a passive brain milestone. A
   * concurrent drive that already parked it makes this a no-op (store returns false).
   *
   * AUTO-APPROVE (per-job opt-in): returns `true` when the gate was auto-resolved INLINE and the caller must
   * fall through to `finalizeBuild` within the SAME drive; `false` when the job is left parked awaiting an
   * operator "Ship it" click. We stamp the approval marker here rather than re-driving because this runs
   * inside the still-active drive — a re-entrant `drive()` would be swallowed by the single-flight guard.
   */
  /**
   * The honest ship-card verification summary (d5): each top-level build thread's title → its SELF-REPORTED
   * `verification[]` evidence (verbatim from the done-report), plus an `unverified` advisory flag when a
   * thread finished with no evidence at all. No judge grades it — Thread 2 renders it so the operator sees
   * the real signal before shipping. A not-done master_review (advisory) surfaces here with no evidence too.
   */
  private async buildShipVerifications(
    jobId: string,
  ): Promise<ShipThreadVerification[]> {
    const threads = await this.store.threadsForJob(jobId).catch(() => []);
    const buildThreads = threads.filter((t) => isDriverExecutableKind(t.kind));
    const summaries: ShipThreadVerification[] = [];
    for (const t of buildThreads) {
      const term = await this.store.getTerminalRecord(t.id).catch(() => null);
      const verification = term?.verification ?? [];
      const status =
        t.status === 'done' && term?.status === 'done' ? 'done' : 'not_done';
      summaries.push({
        title: t.brief,
        status,
        verification,
        unverified: status === 'done' && verification.length === 0,
      });
    }
    return summaries;
  }

  private async parkForShipReview(job: Job, route: JobRoute): Promise<boolean> {
    const title = job.title ?? 'this build';
    const summary =
      'All threads built. Review each thread’s self-reported verification below and the diff, then click **Ship it** to open the PR.';
    const verifications = await this.buildShipVerifications(job.id);
    const card = webShipReviewCard({
      jobId: job.id,
      title,
      summary,
      verifications,
    });
    const parked = await this.store.parkForShipReview(
      job.id,
      card as unknown as Record<string, unknown>,
      summary,
      job.orgId,
      job.decisionRecordId ?? null,
    );
    if (!parked) return false;
    this.logger.log(
      `job=${job.id} parked at ship-review gate — awaiting operator "Ship it"`,
    );
    // The DB-layer park above already ensured the post_build thread exists (DriverStoreService.
    // parkForShipReview → ensurePostBuildThread); deliver its opening gate turn now. Best-effort: a seed
    // failure must not fail the (already-committed) park itself.
    const postBuildThreadId = await this.store.postBuildThreadId(job.id);
    if (postBuildThreadId) {
      await this.brainGateway
        .seedPostBuildGate({
          jobId: job.id,
          orgId: job.orgId,
          repoId: job.repoId,
          threadId: postBuildThreadId,
        })
        .catch((err) =>
          this.logger.warn(`post_build gate seed failed (continuing): ${err}`),
        );
    }
    await this.post(
      route,
      `:mag: Build reviewed — ready to ship *${title}*. Review the diff, then click *Ship it* to open the PR.`,
    ).catch(() => undefined);
    // AUTO-APPROVE (per-job opt-in): the Ship card is posted above for audit; now immediately apply the SAME
    // resolution the operator's "Ship it" click would. Re-read the flag FRESH here — the `job` argument was
    // loaded at runJob start and a build can run for minutes; an operator may enable auto-approve mid-build
    // (setAutoApprove on a `running` job only writes the row, since no gate is parked yet), so trusting the
    // stale in-memory flag would wrongly wait for a manual click. `approveShip` flips awaiting_ship_review →
    // running (the just-parked status makes its CAS succeed) + stamps the marker; we return true so runJob
    // falls through to finalizeBuild in THIS drive (a re-entrant drive() would hit the single-flight guard).
    const fresh = await this.store.loadJob(job.id).catch(() => job);
    if (fresh.shipReviewApprovedAt != null) {
      this.logger.log(
        `job=${job.id} ship approval landed while gate was parking — shipping inline`,
      );
      return true;
    }
    if (!modeApprovesShip(fresh.autoApproveMode)) return false;
    const approver = await this.resolveAutoApprover(fresh);
    const acted = await this.store.approveShip(job.id);
    if (!acted) return false;
    this.logger.log(
      `job=${job.id} auto-approving ship gate (auto_approve on) by ${approver} — shipping inline`,
    );
    await this.blockSink
      .appendBlock(job.id, {
        kind: 'chat',
        threadId: await this.planningThreadId(job.id),
        text: ':rocket: Shipping — opening the pull request.',
        meta: { source: 'system_operator' },
      })
      .catch(() => undefined);
    return true;
  }

  /**
   * SHIP-REVIEW APPROVAL (the "Ship it" click, routed here by the web surface bridge). Stamp the approval
   * marker + flip `awaiting_ship_review → running` (idempotent in the store — acts only while parked, so a
   * stale/double click is a no-op), then re-drive: `runJob` fast-forwards the `done` threads, re-reaches the
   * gate with the marker now set, and ships. Returns whether it acted.
   */
  async resolveShipApprovalDurably(
    jobId: string,
    ruledBy: string,
  ): Promise<boolean> {
    const acted = await this.store.approveShip(jobId);
    if (!acted) {
      this.logger.warn(
        `ship approval for job=${jobId} by ${ruledBy}: not awaiting ship review — no-op`,
      );
      return false;
    }
    this.logger.log(
      `ship approval for job=${jobId} by ${ruledBy} — re-driving to ship`,
    );
    await this.blockSink
      .appendBlock(jobId, {
        kind: 'chat',
        threadId: await this.planningThreadId(jobId),
        text: ':rocket: Shipping — opening the pull request.',
        meta: { source: 'system_operator' },
      })
      .catch(() => undefined);
    this.driveAfterActive(jobId, 'ship-approve');
    return true;
  }

  private driveAfterActive(jobId: string, reason: string): void {
    if (!this.active.has(jobId)) {
      void this.drive(jobId).catch((err) =>
        this.logger.error(
          `${reason} drive job=${jobId} crashed: ${err instanceof Error ? err.stack : err}`,
        ),
      );
      return;
    }
    if (this.driveAfterActiveTimers.has(jobId)) return;
    const poll = (): void => {
      if (this.active.has(jobId)) {
        const next = setTimeout(poll, 25);
        if (typeof next.unref === 'function') next.unref();
        this.driveAfterActiveTimers.set(jobId, next);
        return;
      }
      this.driveAfterActiveTimers.delete(jobId);
      void this.drive(jobId).catch((err) =>
        this.logger.error(
          `${reason} deferred drive job=${jobId} crashed: ${
            err instanceof Error ? err.stack : err
          }`,
        ),
      );
    };
    const timer = setTimeout(poll, 25);
    if (typeof timer.unref === 'function') timer.unref();
    this.driveAfterActiveTimers.set(jobId, timer);
  }

  /**
   * MERGE-GATE APPROVAL (the "Merge PR" click, routed here by the web surface bridge). Posts a durable
   * note then merges through the ONE host merge path (`AutoMergeService.mergeNow`) — unlike
   * {@link resolveShipApprovalDurably} this does NOT re-drive: a merge is terminal, there is nothing left
   * to build. Returns whether the PR was actually merged, so the synchronous HTTP merge path can surface
   * a non-2xx when the merge did not complete.
   */
  async resolveMergeApprovalDurably(
    jobId: string,
    ruledBy: string,
  ): Promise<boolean> {
    await this.blockSink
      .appendBlock(jobId, {
        kind: 'chat',
        threadId: await this.planningThreadId(jobId),
        text: ':twisted_rightwards_arrows: Merging the pull request.',
        meta: { source: 'system_operator' },
      })
      .catch(() => undefined);
    return await this.autoMerge.mergeNow(jobId, ruledBy);
  }

  /**
   * SHIP-REVIEW RETRACT (the Atlas `withdraw_ship` tool OR the manual "Amend build" click). Flip
   * `awaiting_ship_review → amending` (idempotent in the store — acts only while parked, so a stale/double
   * retract is a no-op) and post a durable note. Unlike {@link resolveShipApprovalDurably}, this does NOT
   * re-drive — the job sits in `amending` for the operator/Atlas to do the follow-up work. Once the amend
   * is done it is re-parked at the ship-review gate (`amending → awaiting_ship_review`, no rebuild);
   * `parkForShipReview` accepts `amending`.
   *
   * Returns whether it actually acted (the store CAS affected a row) — the amend-proposal Approve path
   * uses this to wake the brain ONLY when the retract really fired (a stale/double click returns false).
   */
  async retractShipDurably(jobId: string, ruledBy: string): Promise<boolean> {
    const acted = await this.store.retractShip(jobId);
    if (!acted) {
      this.logger.warn(
        `ship retract for job=${jobId} by ${ruledBy}: not awaiting ship review — no-op`,
      );
      return false;
    }
    this.logger.log(`ship retract for job=${jobId} by ${ruledBy} → amending`);
    await this.blockSink
      .appendBlock(jobId, {
        kind: 'chat',
        threadId: await this.planningThreadId(jobId),
        text: '↩︎ Ship-review retracted — amending the build.',
        meta: { source: 'system_operator' },
      })
      .catch(() => undefined);
    return true;
  }

  /**
   * HALT the build on a NOT-DONE thread: flip the job to the single "needs the operator" state and relay a
   * DURABLE card so the halt never dead-ends silently (durable-first via the block sink — a bare `post()` is
   * invisible to reconnecting clients, since the `/messages` REST history reads the DB, not the SSE outbox).
   * A thread that ended
   * without `complete_thread` collapses to ONE advisory outcome (`incomplete`) — no reason taxonomy, no judge,
   * no autonomous retry loop, no owed brain wake. The operator re-drives it via chat ({@link redriveThread}).
   */
  private async haltJob(
    job: Job,
    route: JobRoute,
    thread: DriverThread,
    outcome: ThreadOutcome,
  ): Promise<void> {
    void outcome; // the only non-done/non-rotated outcome is `incomplete`
    const term = await this.store
      .getTerminalRecord(thread.id)
      .catch(() => null);
    const text = `:warning: Build halted — *${thread.brief}* ended without asserting completion (no \`complete_thread\`), so nothing shipped. Ping to retry, or open the thread to see what it did.`;
    await this.blockSink
      .appendBlock(job.id, {
        kind: 'chat',
        threadId: await this.planningThreadId(job.id),
        text,
        meta: { source: 'system_operator', severity: 'warning' },
      })
      .catch((e) =>
        this.logger.error(
          `could not durably record halt for job=${job.id}: ${e}`,
        ),
      );
    await this.post(route, text).catch(() => undefined);
    await this.writeCompletionMd(job, thread, term).catch((e) =>
      this.logger.warn(
        `could not write completion.md for thread=${thread.id}: ${e}`,
      ),
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
    term: ThreadTerminalRecord | null,
  ): Promise<void> {
    const dir = join(
      this.threadLifecycle.contextDirHost(job.id, job.orgId),
      'generated',
      'threads',
      threadDirName(thread),
    );
    await mkdir(dir, { recursive: true });
    // Resolve the anchor DIRECTLY (not off `term`) so the Transcript line renders even for an `incomplete`
    // halt whose terminal record is null.
    const anchor = await this.store
      .resolveSessionAnchor(thread.id)
      .catch(() => undefined);
    await writeFile(
      join(dir, 'completion.md'),
      renderCompletionMd(thread, term, new Date().toISOString(), anchor),
      'utf8',
    );
  }

  /** Resolve this thread leg's evidence subfolder and return the CONTAINER path emitted as
   *  ATLAS_EVIDENCE_DIR so the turn's writers (worker + validate/prototype subagents) land their live-run
   *  proof in evidence/<leg>/. Pre-creating the host dir is BEST-EFFORT (mirrors writeCompletionMd) — the
   *  /context/evidence bind already exists and the in-sandbox writer creates the leg subfolder itself, so a
   *  host mkdir failure (e.g. an unwritable path) must NEVER block the build turn. */
  private async evidenceDirForThread(
    job: Job,
    thread: DriverThread,
  ): Promise<string> {
    const leg = threadDirName(thread);
    try {
      const hostDir = join(
        this.threadLifecycle.contextDirHost(job.id, job.orgId),
        'evidence',
        leg,
      );
      await mkdir(hostDir, { recursive: true });
    } catch (err) {
      this.logger.debug(
        `evidence dir pre-create for thread ${thread.ordinal} failed (continuing): ${String(err)}`,
      );
    }
    return `${CONTAINER_CONTEXT}/evidence/${leg}`;
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
    await this.store.setThreadStatus(thread.id, 'idle');
    // Clear any stale halt overlay from a prior run — this (re)start of the turn puts the step back on the
    // linear ladder, so a resumed/retried thread must not keep a persisted 'incomplete'|'failed'|'paused'.
    await this.store
      .setThreadCondition(thread.id, 'none')
      .catch(() => undefined);
    // Clear the DISPLAY-ONLY halt_reason at the START of the turn (d8) — a resumed/retried thread must not
    // keep a stale "ended abnormally" label while it is live again. Re-set below only if THIS turn halts.
    await this.markHaltReason(thread.id, null);
    let { outcome, reports } = await this.runExecuteTurn(
      job,
      route,
      sandbox,
      thread,
      record,
      repo,
      sectionStartSha,
    );

    // WAKE-ON-STOP (d8): a MACHINE-role thread (registry `operatorInput:false` — codex_review, review_agent,
    // review_fix, master_review) that ended WITHOUT `complete_thread` gets ONE synthetic reminder turn,
    // immediately, resuming its own session so it can finish or call `complete_thread`. Event-driven, never
    // timed. A CHATTABLE role (planner/builder/post_build/ship) is left dormant instead (§8.3). Straight-line
    // (not a loop), so it fires exactly once: if the nudged turn ALSO ends incomplete we do NOT re-nudge —
    // the thread falls through to the dormant `incomplete` path below with its halt_reason set.
    if (
      outcome === 'incomplete' &&
      !threadKindSpec(thread.kind).operatorInput
    ) {
      const woke = await this.wakeMachineThreadOnStop(
        job,
        route,
        sandbox,
        thread,
        record,
        repo,
        sectionStartSha,
      ).catch((err) => {
        this.logger.warn(
          `wake-on-stop nudge for thread ${thread.ordinal} "${thread.brief}" crashed (leaving dormant): ${shortReason(err)}`,
        );
        return null;
      });
      if (woke) {
        reports = [...reports, ...woke.reports];
        // If the nudged turn asserted `complete_thread`, FINALIZE it through the normal path: re-entering
        // `executeSteps` now hits the restart-safe short-circuit (a persisted `done` terminal record ⇒ no
        // re-kick) and runs the commit + step-done marking a first-pass completion would have. A still-
        // incomplete nudge is NOT re-run (that would re-kick the batch) — the thread falls through to the
        // dormant path below. Either way the nudge fired exactly once.
        if (woke.outcome === 'done') {
          const finalized = await this.runExecuteTurn(
            job,
            route,
            sandbox,
            thread,
            record,
            repo,
            sectionStartSha,
          );
          outcome = finalized.outcome;
          reports = [...reports, ...finalized.reports];
        }
      }
    }

    // ROTATED (d1): the builder self-authored a leg handoff (`record_leg_handoff`), so the store abandoned
    // this session and inserted the NEXT builder thread row (carrying the handoff on its own `handoff_in`).
    // This leg finished its Leg's work CLEANLY — it is NOT a halt: mark it `done` with no condition overlay,
    // but do NOT run review, drop tasks, or write a `handoff_out` (the handoff already lives on the new
    // row). runJob's per-thread-group loop re-queries the thread group and drives the freshly-inserted
    // builder next.
    if (outcome === 'rotated') {
      await this.store
        .setThreadStatus(thread.id, 'done')
        .catch(() => undefined);
      await this.store
        .setThreadCondition(thread.id, 'none')
        .catch(() => undefined);
      this.logger.log(
        `thread ${thread.ordinal} "${thread.brief}" — rotated to a fresh builder leg; this leg marked done`,
      );
      return { outcome: 'rotated', handoff: null };
    }

    // The thread did NOT assert `done` (no `complete_thread`) — it lands in the single "not done" state.
    // Skip auto-fix + handoff, record `incomplete` on the orthogonal condition overlay (leaving the STEP at
    // `executing`), and let runJob relay + skip finalize. NEVER fall through to the done path (a clean turn is
    // not evidence of completion).
    if (outcome !== 'done') {
      const condition: ThreadCondition = 'incomplete';
      await this.store
        .setThreadCondition(thread.id, condition)
        .catch(() => undefined);
      // DISPLAY-ONLY (d8): label the dormant thread so the UI explains why it stopped. A thrown session-limit/
      // error end never reaches here (it propagates from `runExecuteTurn` already labelled); this is the clean
      // "turn ended without asserting completion" case — for a machine role, after its one wake-on-stop nudge.
      await this.markHaltReason(thread.id, 'incomplete');
      this.logger.warn(
        `thread ${thread.ordinal} "${thread.brief}" not done — ${outcome}`,
      );
      return { outcome, handoff: null };
    }

    // Post-build REVIEW no longer runs here — it runs ONCE per build thread group (over the thread
    // group's cumulative diff) from `driveBuildThreadGroup` after the thread group's last builder leg is
    // done (d13).

    // e. HANDOFF — summarize what this thread produced for the next.
    const handoffOut = this.summarizeHandoff(thread, steps, reports);
    await this.store.setThreadHandoffOut(thread.id, handoffOut);
    // Host backstop: the model already got its one in-gate reminder to reconcile its checklist, so flip any
    // task it STILL left open to `dropped` — a finished thread must never render with a task frozen
    // in-progress. Only on the clean `done` path; a blocked/halted thread's open tasks stay legitimately open.
    const droppedTasks = await this.store
      .dropOpenThreadTasks(thread.id)
      .catch(() => 0);
    if (droppedTasks > 0) {
      this.logger.log(
        `thread ${thread.ordinal} — dropped ${droppedTasks} unreconciled open task(s) on done`,
      );
    }
    await this.store.setThreadStatus(thread.id, 'done');
    await this.store
      .setThreadCondition(thread.id, 'none')
      .catch(() => undefined);
    this.logger.log(`thread ${thread.ordinal} done`);
    await this.post(
      route,
      `:white_check_mark: Thread done — *${thread.brief}*`,
    );
    // Free the RAM: this thread (a builder or the master review — the only kinds `runThread` executes) may
    // have booted services under the supervisor for testing. Threads run sequentially in one per-job
    // sandbox and this thread's review-lens/post-review children already finished above, so nothing else is
    // live here — tear the fleet down so it doesn't sit resident through the rest of the build on a shared
    // host. Best-effort: a teardown hiccup never affects the build (the next thread / ship re-derives).
    const stopped = await this.sandboxes
      .stopAllServices?.(job.id)
      .catch(() => undefined);
    if (stopped && !stopped.ok) {
      this.logger.warn(
        `thread ${thread.ordinal} — service teardown skipped: ${stopped.reason}`,
      );
    }
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
    const head = await this.git
      .headSha(sandbox.worktreePath)
      .catch(() => undefined);
    if (!head) return undefined;
    const persisted = await this.store
      .ensureThreadStartSha(thread.id, head)
      .catch(() => head);
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
    // The owning THREAD GROUP's review-selection type (d7 — routing moved off `threads.type` onto
    // `threadGroup.type`). Drives lens selection + framework-skill resolution for the whole thread
    // group's cumulative diff.
    threadGroupType: ThreadType,
  ): Promise<void> {
    const spec = threadKindSpec(thread.kind);
    if (!spec.children) return;
    // The review window: show the builder `auto_fixing` (the unchanged web affordance) while children run.
    await this.store
      .setThreadStatus(thread.id, 'idle')
      .catch(() => undefined);

    const channel = route.channel ?? job.repoId;

    // The shared review context — derive the diff ONCE, BEFORE selection/materialization, so a future
    // file-glob axis (Thread 4's framework lens) has `ctx.changedFiles` to route on, and so an empty diff
    // is caught before anything new is materialized.
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
      // they resolve `repos.convention_profile_slug` themselves (the thread group has no driver context
      // otherwise).
      orgId: job.orgId,
      repoId: job.repoId,
      autofixId: thread.id,
      scope: 'thread',
      // The fix turn commits + pushes its own work now — give it the authenticated remote (same as the
      // builder/gate/master-review turns carry).
      gitAuth: await this.resolveTurnGitAuth(
        job.orgId,
        repo.projectRepo.gitUrl,
      ),
      ...(sandbox.containerId
        ? {
            containerId: sandbox.containerId,
            ...(sandbox.execUser ? { execUser: sandbox.execUser } : {}),
          }
        : {}),
    };
    const ctx = await this.autofix
      .ensureContextDiff(baseCtx)
      .catch(() => baseCtx);

    // Empty diff → nothing to review: nothing is materialized (resume-safe — a re-entry on the same empty
    // diff must not synthesize new rows). If children were ALREADY materialized by a prior, non-empty run
    // of this thread, mark every non-done one `done` (idempotent) and skip the turns; a short notice posts
    // to each child's lane FIRST, so a skipped review reads as an explicit "nothing to review" line rather
    // than a silent blank (the symptom that hid a stale-`start_sha` empty range).
    if (!ctx.changedFiles?.length) {
      const already = await this.store.reviewChildren(thread.id);
      const notice = `No changes to review in this section (empty diff for "${thread.brief}") — this review was skipped.`;
      for (const c of already) {
        if (c.status === 'done') continue;
        const sub =
          c.kind === 'review_agent'
            ? {
                lensId: String(
                  (c.config as { lensId?: string }).lensId ?? c.id,
                ),
              }
            : { fix: true as const };
        await this.autofix
          .emitReviewNotice(ctx, sub, notice)
          .catch(() => undefined);
        if (c.kind === 'review_agent') {
          await this.store
            .setThreadReviewFindings(c.id, [])
            .catch(() => undefined);
        }
        // The review lifecycle genuinely completed (there was nothing to review), so the STEP is `done` —
        // this keeps the `=== 'done'` resume-idempotency guards intact — while `skipped` carries the
        // "nothing to do" overlay that used to live in the status value.
        await this.store.setThreadStatus(c.id, 'done').catch(() => undefined);
        await this.store
          .setThreadCondition(c.id, 'skipped')
          .catch(() => undefined);
      }
      return;
    }

    // Framework-conformance lens (d4): resolve the `review`-surface skills whose applicability matches this
    // thread group (by type OR a changed-file glob), force-inject their SKILL.md bodies. Best-effort — a
    // resolver failure must never sink the review pass, so fall back to no framework skills.
    const frameworkSkills = await this.skills
      .resolveReviewSkillsForThread(
        job.orgId,
        job.repoId,
        threadGroupType,
        ctx.changedFiles ?? [],
      )
      .catch((err) => {
        this.logger.warn(
          `framework-skill resolution failed (no framework lens): ${err}`,
        );
        return [] as { name: string; body: string }[];
      });
    const frameworkSkillNames = frameworkSkills.map((s) => s.name);

    // THE selection — reviewAgentsForThread is the single source of truth for WHICH lenses run, routed on
    // the THREAD GROUP's (closed-vocabulary) type (d7). Composed with the registry's post_review child
    // spec.
    const lenses = reviewAgentsForThread(threadGroupType, frameworkSkillNames);
    const childSpecs = [
      ...lenses.map((l) => ({
        kind: 'review_agent',
        brief: l.label,
        config:
          l.id === 'framework'
            ? { lensId: l.id, skills: frameworkSkillNames }
            : { lensId: l.id },
      })),
      ...spec.children({ id: thread.id, config: {} }),
    ];
    const children = await this.store
      .materializeReviewChildren(
        { id: thread.id, jobId: job.id, orgId: thread.orgId },
        childSpecs,
      )
      .catch((err) => {
        this.logger.warn(
          `review-children materialize failed (skipping review): ${err}`,
        );
        return [] as ReviewChildThread[];
      });
    if (children.length === 0) return;

    const lensChildren = children.filter((c) => c.kind === 'review_agent');
    const postReview = children.find((c) => c.kind === 'review_fix');

    // ANCHOR — same web contract as before: the `autofix_anchor` row + change-signal post (the review card
    // latches `meta.autofixAnchor`; each lens/fix turn streams on `autofix:*` lanes).
    await this.postAutofixAnchor(job, route, {
      autofixId: thread.id,
      scope: 'thread',
      label: thread.brief,
      lensIds: lensChildren.map((c) =>
        String((c.config as { lensId?: string }).lensId ?? c.id),
      ),
    });

    // Drive the LENSES concurrently through a semaphore capped at `REVIEW_LENS_CONCURRENCY` (d5) — each an
    // independent row (a `done` lens fast-forwards). Unlike a fixed batch loop, the next lens starts the
    // instant a slot frees rather than waiting on a batch barrier.
    const sema = new Sema(REVIEW_LENS_CONCURRENCY);
    await Promise.all(
      lensChildren.map(async (c) => {
        await sema.acquire();
        try {
          await this.runOneReviewLens(ctx, c, frameworkSkills);
        } finally {
          sema.release();
        }
      }),
    );

    // Then the POST-REVIEW fix pass over the deduped, severity-filtered union of the lenses' findings.
    if (postReview && postReview.status !== 'done') {
      await this.runPostReview(ctx, thread, postReview);
    }
  }

  /**
   * Run ONE `review_lens` child: mark it running, run the lens's read-only review turn, and persist its full
   * findings + terminal status on its OWN row. Never throws — a lens failure is isolated to its row (marked
   * `failed`), never blocking its siblings or the build. A lens already `done` (resume) fast-forwards.
   */
  private async runOneReviewLens(
    ctx: AutoFixContext,
    child: ReviewChildThread,
    frameworkBodies: { name: string; body: string }[] = [],
  ): Promise<void> {
    if (child.status === 'done') return;
    const lensId = String((child.config as { lensId?: string }).lensId ?? '');
    const lens = lensById(lensId);
    if (!lens) {
      this.logger.warn(
        `review-lens child ${child.id} has unknown lensId "${lensId}" — skipping`,
      );
      // Terminal `done` (matching the empty-diff skip) — nothing to review, so the step genuinely completed;
      // this keeps the `=== 'done'` resume-idempotency guard intact while `skipped` carries the overlay.
      await this.store.setThreadStatus(child.id, 'done').catch(() => undefined);
      await this.store
        .setThreadCondition(child.id, 'skipped')
        .catch(() => undefined);
      return;
    }
    await this.store
      .setThreadStatus(child.id, 'idle')
      .catch(() => undefined);
    // Clear any stale halt overlay from a prior run before (re)running the lens's turn.
    await this.store
      .setThreadCondition(child.id, 'none')
      .catch(() => undefined);
    try {
      const lensCtx = {
        ...(lens.scope === 'framework' ? { ...ctx, frameworkBodies } : ctx),
        threadId: child.id,
      };
      // Read-only lens finders run on Sonnet, not the default Opus worker: the finding task is well within
      // Sonnet's capability and this is the dominant token win (N finder turns per thread move off Opus).
      const findings = await this.autofix.runReviewLens(lensCtx, lens, {
        model: REVIEW_LENS_MODEL,
      });
      await this.store.setThreadReviewFindings(child.id, findings);
      await this.store.setThreadStatus(child.id, 'done');
      await this.store
        .setThreadCondition(child.id, 'none')
        .catch(() => undefined);
    } catch (err) {
      this.logger.warn(`review lens "${lensId}" failed (continuing): ${err}`);
      // Persist the reason on the lens's OWN lane so its pane explains itself instead of showing a
      // blank (the turn died before streaming, so `abort()` persisted only the prompt snapshot).
      await this.autofix
        .emitReviewNotice(
          ctx,
          { lensId },
          `This review lens failed to run: ${shortReason(err)}`,
        )
        .catch(() => undefined);
      await this.store
        .setThreadReviewFindings(child.id, [])
        .catch(() => undefined);
      await this.store
        .setThreadCondition(child.id, 'failed')
        .catch(() => undefined);
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
    await this.store
      .setThreadStatus(child.id, 'idle')
      .catch(() => undefined);
    try {
      const siblings = await this.store.reviewChildren(thread.id);
      const all = siblings
        .filter((c) => c.kind === 'review_agent')
        .flatMap((c) => c.reviewFindings ?? []);
      const minSeverity =
        (child.config as { minSeverity?: FindingSeverity }).minSeverity ??
        'medium';
      const deduped = dedupeFindings(all);
      const actionable = deduped.filter((f) =>
        meetsSeverity(f.severity, minSeverity),
      );
      if (actionable.length === 0) {
        // No fix turn runs — post an explicit line so the Post-review fixes pane reads as "nothing to
        // fix" rather than a silent blank (mirrors the empty-diff notice in reviewThreadChildren).
        await this.autofix
          .emitReviewNotice(
            ctx,
            { fix: true },
            'No findings met the fix threshold — nothing to fix.',
          )
          .catch(() => undefined);
        await this.store
          .setThreadStatus(child.id, 'done')
          .catch(() => undefined);
        await this.store
          .setThreadCondition(child.id, 'none')
          .catch(() => undefined);
        return;
      }
      await this.autofix.applyReviewFindings(
        { ...ctx, threadId: child.id },
        actionable,
      );
      await this.store.setThreadStatus(child.id, 'done');
      await this.store
        .setThreadCondition(child.id, 'none')
        .catch(() => undefined);
    } catch (err) {
      this.logger.warn(`post-review fix failed (continuing): ${err}`);
      // Persist the reason on the fix lane so a failed post-review explains itself, not a blank pane.
      await this.autofix
        .emitReviewNotice(
          ctx,
          { fix: true },
          `Post-review fix failed to run: ${shortReason(err)}`,
        )
        .catch(() => undefined);
      await this.store
        .setThreadCondition(child.id, 'failed')
        .catch(() => undefined);
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

    await this.store.setThreadStatus(thread.id, 'idle');
    const planned: PlannedStep[] = [
      { title: thread.brief, brief: thread.brief },
    ];
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
   * Build the host tool bridge for the orchestrate build turn:
   *  - `request_operator_input` — the mid-build "pause and ask" escape hatch (open a durable card → poll →
   *    pause the deadline across the human wait → return the answer so the SAME turn resumes).
   *  - `complete_thread` — the SOLE done-signal: the orchestrator MUST call this to declare the thread
   *    finished, passing what it did + the verification it actually ran. The driver reads the persisted
   *    done-report after the turn instead of inferring done-ness from "the turn didn't throw." A turn that
   *    ends without it is `incomplete` ("not done — needs the operator"), never `done`. No host verification
   *    gate runs — the self-reported verification is surfaced honestly on the ship card, ungraded.
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
    // TERMINAL LATCH: the bridge has no engine-turn-termination primitive, so the model could call
    // `complete_thread` twice and overwrite the first record. First assertion wins — a second call never
    // touches the record.
    //
    // ANTI-SPIN: once latched, the model SHOULD stop — but a model that doesn't will keep calling the terminal
    // tool, and a bare `{ok:false, error}` reads to it as "that failed, try again" → it spins until
    // PHASE_TIMEOUT. The bridge can't force the turn to end (aborting the deadline would mark the job `failed`
    // and discard the recorded outcome). So `afterTerminal` answers a repeat IDEMPOTENTLY and always with an
    // explicit STOP directive.
    let terminated: null | 'done' = null;
    const afterTerminal = () => ({
      ok: true,
      alreadyRecorded: true,
      message:
        `This thread already asserted \`done\` this turn — it is recorded and final. ` +
        `Do NOT call complete_thread again; stop here and end your turn now.`,
    });
    const tools: Record<string, ToolImpl> = {
      [INTERNAL_PROFILE_AWARENESS_TOOL]: (args) =>
        this.profileAwareness
          ? this.profileAwareness.handle({
              orgId: job.orgId,
              repoId: job.repoId,
              jobId: job.id,
              sessionType: 'build',
              command: String(args['command'] ?? ''),
            })
          : Promise.resolve(null),
      complete_thread: async (args) => {
        if (terminated) {
          return afterTerminal();
        }
        const summary = String(args['summary'] ?? '').trim();
        if (!summary) {
          return {
            ok: false,
            error: 'summary is required (one line: what this thread built)',
          };
        }
        // Task list is ADVISORY at completion (decision d1) — it NEVER blocks `complete_thread`. A prior
        // version bounced the FIRST `done` claim while the durable checklist held open items; because the
        // one-shot lived on this per-turn closure, every re-delivery re-bounced and wedged the thread into a
        // permanent `incomplete` loop. Now we only READ the still-open items to surface a non-blocking note;
        // the assertion latches (there is no host verification gate) and the done transition force-closes any
        // leftovers via `dropOpenThreadTasks` (see runThread). The native task-fold id reconciliation is
        // unreliable and being retired for durable task_* tools, so completion must not hinge on it.
        const openTasks = (
          await this.store.getThreadTasks(thread.id).catch(() => [] as TaskItem[])
        ).filter((t) => t.status === 'pending' || t.status === 'in_progress');
        const taskAdvisory = openTasks.length
          ? renderOpenTasksAdvisory(openTasks)
          : undefined;
        const asStrings = (v: unknown): string[] | undefined =>
          Array.isArray(v) && v.length
            ? v.map((x) => String(x).trim()).filter(Boolean)
            : undefined;
        // Tolerate a free-text `verification` (the model sometimes collapses its evidence into one
        // narrative string instead of discrete entries) — never silently drop reported evidence; the ship
        // card surfaces it verbatim, so a wrong-shaped entry would otherwise read as "nothing was checked."
        const verification = Array.isArray(args['verification'])
          ? (args['verification'] as unknown[])
              .map((e) => {
                const o = (e ?? {}) as Record<string, unknown>;
                return {
                  kind: String(o['kind'] ?? '').trim(),
                  command: String(o['command'] ?? '').trim(),
                  exitCode: Number.isFinite(Number(o['exitCode']))
                    ? Number(o['exitCode'])
                    : -1,
                  outputTail: clampEvidenceOutput(
                    String(o['outputTail'] ?? ''),
                  ),
                };
              })
              .filter((v) => v.command)
          : typeof args['verification'] === 'string' &&
              args['verification'].trim()
            ? [
                {
                  kind: 'reported',
                  command: '(see outputTail)',
                  exitCode: 0,
                  outputTail: clampEvidenceOutput(args['verification'].trim()),
                },
              ]
            : undefined;
        const candidate: ThreadTerminalRecord = {
          status: 'done',
          summary,
          ...(asStrings(args['changes'])
            ? { changes: asStrings(args['changes']) }
            : {}),
          ...(verification && verification.length ? { verification } : {}),
          ...(asStrings(args['deviations'])
            ? { deviations: asStrings(args['deviations']) }
            : {}),
          ...(asStrings(args['gaps']) ? { gaps: asStrings(args['gaps']) } : {}),
        };
        // `complete_thread` is the SOLE done-signal — no host verification gate. Persist the done-report and
        // latch; the self-reported `verification[]` is surfaced honestly on the ship card (ungraded). CI + the
        // human ship-review are the real backstops. The done transition force-closes any still-open tasks
        // (`dropOpenThreadTasks`); surface the advisory note about them, but never let it block the latch.
        terminated = 'done';
        await this.store.recordThreadTermination(thread.id, candidate);
        return taskAdvisory ? { ok: true, warning: taskAdvisory } : { ok: true };
      },
      request_operator_input: async (args) => {
        const question = String(args['question'] ?? '').trim();
        if (!question) {
          return {
            ok: false,
            error: 'question is required (what you need decided, specifically)',
          };
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
        }
        // Suspend the wall-clock budget across the (human-paced) wait, then poll the durable card.
        deadline.pause();
        try {
          const answer = await this.pollOperatorAnswer(
            job.id,
            questionId,
            deadline.signal,
          );
          await this.store
            .markOperatorInputDelivered(job.id, questionId)
            .catch(() => undefined);
          await this.store
            .setThreadStatus(thread.id, 'idle')
            .catch(() => undefined);
          await this.store
            .setThreadCondition(thread.id, 'none')
            .catch(() => undefined);
          return { answer };
        } finally {
          deadline.resume();
        }
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
            error:
              'handoff is required (a structured markdown handoff — see the tool description)',
          };
        }
        rotationHolder.handoff = handoff;
        return { ok: true, message: RECORD_LEG_HANDOFF_STOP };
      };
    }

    // OUT-OF-SCOPE routing (real builder lanes only, NOT the Codex master_review). A builder that trips over
    // something outside its assignment makes a CHEAP, clearly-correct fix inline and logs it via
    // `record_deviation`.
    if (thread.kind !== 'master_review') {
      // record_deviation — the builder made a small out-of-scope fix INLINE. Persist it to the durable
      // per-thread store, then re-project `/context/generated/deviations.md` (host-owned; the sandbox mount
      // is read-only). Idempotent on note text (store-level), so a re-driven turn never double-logs.
      tools.record_deviation = async (args) => {
        const note = String(args['note'] ?? '').trim();
        if (!note) {
          return {
            ok: false,
            error:
              'note is required (one line: what you changed off-spec and why)',
          };
        }
        await this.store.recordDeviation(thread.id, {
          note,
          ts: new Date().toISOString(),
        });
        await this.writeDeviationsMd(job);
        return { ok: true };
      };
    }

    // STRUCTURED REVIEW FINDINGS (review_agent only). The reviewer calls this as it finds issues — findings
    // ACCUMULATE incrementally onto its own `threads.review_findings` row (each item shaped exactly like
    // `ReviewFinding`, so review_fix's dedupe/fix plumbing consumes them unchanged). It never grades; the
    // reviewer signals it is finished with `complete_thread`.
    if (thread.kind === 'review_agent') {
      const severities: FindingSeverity[] = ['low', 'medium', 'high'];
      tools.report_findings = async (args) => {
        const raw = Array.isArray(args['findings'])
          ? (args['findings'] as unknown[])
          : [];
        const findings: ReviewFinding[] = raw
          .map((e) => {
            const o = (e ?? {}) as Record<string, unknown>;
            const title = String(o['title'] ?? '').trim();
            const detail = String(o['detail'] ?? '').trim();
            if (!title || !detail) return null;
            const sev = String(o['severity'] ?? '').trim() as FindingSeverity;
            const fileRaw = o['file'];
            return {
              lens: String(o['lens'] ?? 'review').trim() || 'review',
              severity: severities.includes(sev) ? sev : 'medium',
              file:
                typeof fileRaw === 'string' && fileRaw.trim()
                  ? fileRaw.trim()
                  : null,
              title,
              detail,
            } satisfies ReviewFinding;
          })
          .filter((f): f is ReviewFinding => f !== null);
        if (findings.length === 0) {
          return {
            ok: false,
            error:
              'each finding needs a non-empty title and detail (severity low|medium|high, file repo-relative or null)',
          };
        }
        const total = await this.store.appendThreadReviewFindings(
          thread.id,
          findings,
        );
        return { ok: true, recorded: findings.length, total };
      };
    }

    // LIVE TASK LIST for every build/master-review thread. Claude's native task tools are disabled
    // (engine-core), so both engines drive the operator-visible checklist through this ONE canonical
    // `task_create`/`task_update`/`task_list`/`task_get` set — direct CRUD on the stage-owned `tasks` rows
    // in a single durable uuid id space. Registered unconditionally: a fresh leg reads the durable rows, so
    // the list survives rotation.
    Object.assign(
      tools,
      makeTaskTools(this.taskSink, { kind: 'thread', id: thread.id }),
    );

    // Self-sufficiency toolset (request_secret/request_file/recall/remember) — every build thread (including
    // master_review) gets these, dispatched through the SAME handler bodies the brain uses. `authorId` is a
    // synthetic thread-scoped id (build threads carry no human author); `defaultQuery` seeds `recall`'s
    // fallback query when the model omits one, mirroring the brain's `stimulus.body` fallback.
    if (this.selfSufficiency) {
      Object.assign(
        tools,
        this.selfSufficiency.buildTools({
          jobId: job.id,
          orgId: job.orgId,
          repoId: job.repoId,
          authorId: `thread:${thread.id}`,
          defaultQuery: thread.brief,
        }),
      );
    }

    return { jobId: job.id, tools };
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
      if (signal.aborted)
        throw new Error('turn aborted while awaiting operator input');
      const answer = await this.store.readOperatorInputAnswer(
        jobId,
        questionId,
      );
      if (answer != null) return answer;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return '(No response from the operator within the time limit. Proceed using your best judgment, keep the change minimal and reversible, and clearly note the assumption you made in your report.)';
  }

  /** Update the thread's DISPLAY-ONLY `halt_reason` (d8), swallowing any error — it never blocks a turn and
   *  tolerates a store mock that predates the column (a stale label only mis-explains a dormant thread until
   *  its next turn clears it). */
  private async markHaltReason(
    threadId: string,
    reason: string | null,
  ): Promise<void> {
    try {
      await this.store.setThreadHaltReason(threadId, reason);
    } catch (err) {
      this.logger.debug(
        `setThreadHaltReason(${reason ?? 'clear'}) failed (display-only): ${shortReason(err)}`,
      );
    }
  }

  /** Run the thread's execute turn, labelling an ABNORMAL (thrown) ending onto the thread's DISPLAY-ONLY
   *  `halt_reason` before the exception propagates to the drive loop's park/fail handling (d8). A detached/
   *  drain end is the engine still living (boot re-attaches), not a halt, so it is never labelled. A clean
   *  stop without `complete_thread` does NOT throw — it returns `incomplete` and is labelled by `runThread`. */
  private async runExecuteTurn(
    job: Job,
    route: JobRoute,
    sandbox: FeatureSandbox,
    thread: DriverThread,
    record: DecisionRecord | null,
    repo: ResolvedRepo,
    sectionStartSha: string | undefined,
  ): Promise<{ outcome: ThreadOutcome; reports: string[] }> {
    try {
      return await this.executeSteps(
        job,
        route,
        sandbox,
        thread,
        record,
        repo,
        sectionStartSha,
      );
    } catch (err) {
      if (!isEngineDetachedError(err) && !this.election.isDraining()) {
        await this.markHaltReason(
          thread.id,
          isSessionLimitError(err) ? 'session_limit' : 'error',
        );
      }
      throw err;
    }
  }

  /**
   * WAKE-ON-STOP nudge (d8): resume a MACHINE-role thread's OWN session with a single synthetic reminder so a
   * turn that ended without `complete_thread` gets exactly one immediate chance to finish or assert done. The
   * turn carries the full build tool bridge (so `complete_thread` is reachable), then we re-read the terminal
   * record to resolve the outcome. Best-effort + self-contained: any error is labelled onto `halt_reason` and
   * absorbed to an `incomplete` result — the bonus reminder must NEVER itself park/fail the job (the original
   * turn already ended cleanly-incomplete). Invoked once, straight-line, so it can never become a retry loop.
   */
  private async wakeMachineThreadOnStop(
    job: Job,
    route: JobRoute,
    sandbox: FeatureSandbox,
    thread: DriverThread,
    record: DecisionRecord | null,
    repo: ResolvedRepo,
    sectionStartSha: string | undefined,
  ): Promise<{ outcome: ThreadOutcome; reports: string[] } | null> {
    const steps = await this.store.stepsForThread(thread.id);
    const anchor = steps[0];
    if (!anchor?.sessionId) return null; // no live session to resume — nothing to wake

    const spec = threadKindSpec(thread.kind);
    const lane = laneFor('builder', thread.id);
    const channel = route.channel ?? job.repoId;
    const metaTag = { phaseId: anchor.id, wakeOnStop: true };
    const harness = this.turnHarness.create({
      jobId: job.id,
      orgId: job.orgId,
      threadId: thread.id,
      channel,
      lane,
      metaTag,
    });
    const task = renderWakeOnStopReminder();
    await harness.emitPrompt(task, `wake:${anchor.id}`);
    const deadline = new PausableDeadline(
      this.phaseTimeoutMs,
      `wake-on-stop "${thread.brief}"`,
    );
    const toolBridge = this.buildTurnBridge(
      job,
      thread,
      route,
      deadline,
      sandbox,
      record,
      sectionStartSha,
      null,
    );
    const repoConventions = await this.repoConventionsFor(job);
    const evidenceDir = await this.evidenceDirForThread(job, thread);
    this.logger.log(
      `thread ${thread.ordinal} "${thread.brief}" (${thread.kind}) ended without complete_thread — waking once`,
    );
    try {
      const result = await this.runTurnBounded(
        {
          orgId: job.orgId,
          jobId: job.id,
          stepId: anchor.id, // resumes the machine thread's persisted session — same conversation
          sandbox,
          engine: spec.engine,
          mode: 'execute',
          systemPrompt: renderAgentPrompt(spec.agent, {
            jobKind: job.kind,
            settings: { repoConventions },
            turnPhase: 'batch',
          }),
          evidenceDir,
          ...(spec.reasoningEffort
            ? { modelReasoningEffort: spec.reasoningEffort }
            : {}),
          task,
          auth: await this.creds.engineAuth(job.orgId, spec.engine),
          userMcpServers: await this.mcp.resolveForTurn(
            job.orgId,
            job.repoId,
            'build',
          ),
          skills: await this.skills.resolveForTurn(
            job.orgId,
            job.repoId,
            'build',
          ),
          ...(repoConventions ? { repoConventions } : {}),
          gitAuth: await this.resolveTurnGitAuth(
            job.orgId,
            repo.projectRepo.gitUrl,
          ),
          toolBridge,
          richStream: true,
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
              wakeOnStop: true,
            },
          },
          liveRoute: { channel, jobId: job.id, lane },
          onEvent: (e) => harness.onEvent(e),
        },
        `wake-on-stop "${thread.brief}"`,
        deadline,
      );
      await harness.finish(
        result.report,
        result.usage
          ? { usage: result.usage, credentialId: result.credentialId ?? null }
          : undefined,
      );
      const term = await this.store
        .getTerminalRecord(thread.id)
        .catch(() => null);
      return {
        outcome: term?.status === 'done' ? 'done' : 'incomplete',
        reports: [result.report],
      };
    } catch (err) {
      await harness.abort().catch(() => undefined);
      // The bonus wake turn hit a session limit / infra error. Label it for DISPLAY, but do NOT re-throw:
      // the original turn already ended cleanly-incomplete, so the job must not park/fail on the nudge.
      if (!this.election.isDraining()) {
        await this.markHaltReason(
          thread.id,
          isSessionLimitError(err) ? 'session_limit' : 'error',
        );
      }
      return { outcome: 'incomplete', reports: [] };
    }
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
        job,
        route,
        sandbox,
        thread,
        record,
        batch,
        repo,
        key === lastKey,
        sectionStartSha,
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
    const currentLeg = anchor.legOrdinal;
    const metaTag: Record<string, unknown> = {
      phaseId: anchor.id,
      legOrdinal: currentLeg,
      ...(batchOrdinal != null ? { batchOrdinal } : {}),
    };
    // The instruction the engine receives — the build turn's "first message". Computed once here so it
    // can both kick off the turn AND be persisted on the anchor row (the web renders it like a subagent's
    // Task prompt, so the step transcript shows what was asked, not just the engine's reply).
    const nudge =
      thread.kind === 'builder'
        ? await this.resolveSkillNudge(job, thread, record)
        : [];
    const baseTask =
      thread.kind === 'master_review'
        ? renderMasterReviewTask(record, repo)
        : renderBatchTask(record, thread, steps, nudge);
    // LEG-ROTATION SEED FOLD: if a prior Leg rotated, its structured handoff is stashed on the anchor step.
    // Prepend it so the FRESH Leg session continues mid-flight (its WIP is already on disk in the worktree)
    // instead of restarting the batch. The seed is cleared the instant the fresh session is born (turn-runner
    // clear-on-birth). Mirrors the brain's `pending_compaction_seed` fold in `runChatTurnInner`.
    const legSeed = await this.store.getPendingLegSeed(anchor.id);
    // Live running-services context — builder turns only (a Codex master_review runs no services). Probed
    // fresh here and at every Leg re-kick below so each turn sees CURRENT state, not a batch-start snapshot.
    const servicesBlock =
      thread.kind === 'builder'
        ? await this.renderLiveServicesBlock(job.id)
        : '';

    // RESTART-SAFE SHORT-CIRCUIT (ADR 0004 rider 3): the orchestrator may have ALREADY asserted `done` on a
    // prior attempt (its `complete_thread` call persisted a terminal record) before a crash/restart hit
    // during the completion gate or commit that follows. Re-kicking the orchestrator here would re-send its
    // ORIGINAL batch task into an already-finished conversation. So: if a `done` terminal record already
    // exists for the terminal batch, skip the batch kick entirely and fall through to the completion gate /
    // commit path with the EXISTING assertion. An in-flight commit nudge is reattached later by
    // `ensureCommitted`.
    const priorTerm = isLastBatch
      ? await this.store.getTerminalRecord(thread.id)
      : null;

    let report: string;
    let outcome: ThreadOutcome = 'done';

    if (priorTerm?.status === 'done') {
      this.logger.log(
        `thread ${thread.ordinal} batch [${steps.map((p) => p.ordinal).join(',')}] — terminal record already 'done' from a prior attempt; resuming completion checks without re-kicking the orchestrator`,
      );
      report = priorTerm.summary;
    } else {
      // The orchestrator turn's PAUSABLE wall-clock deadline + the host tool bridge that exposes
      // `request_operator_input` (open a durable question card → poll it → pause the deadline across the
      // human wait). One deadline shared by the bounded kick AND the tool so a pause suspends the clock; the
      // same bridge is re-supplied on re-attach (the host tool closure is in-memory, lost on restart).
      const deadline = new PausableDeadline(
        this.phaseTimeoutMs,
        `batch "${label}"`,
      );
      // LEG-ROTATION arming: only the builder's OWN Claude execute session rotates (context-rot mitigation).
      // Codex master-review emits no per-call occupancy (never latches) and has no `record_leg_handoff`; review
      // children run elsewhere. The per-Leg run state is filled DURING the turn (by the watch + the handoff tool)
      // and read AFTER it to decide whether to rotate; `record_leg_handoff` is exposed only when armed.
      const rotationArmed =
        legRotationRule.enabled &&
        thread.kind === 'builder' &&
        threadKindSpec(thread.kind).engine === 'claude' &&
        (thread as DriverThread & { config?: { rotationCapped?: unknown } })
          .config?.rotationCapped !== true;
      const rotationThresholds = resolveRotationThresholds();
      const rotationState = freshLegRotationState();
      const toolBridge = this.buildTurnBridge(
        job,
        thread,
        route,
        deadline,
        sandbox,
        record,
        sectionStartSha,
        rotationArmed ? rotationState : null,
      );

      // RE-ATTACH or KICK. After a backend restart the engine kept running detached (Redis transport) and is
      // still writing to its streams — re-tail its live stream instead of re-running the batch, exactly like
      // the brain. A reattach row exists only for a still-live batch, so look it up only on a RESUME (the
      // anchor already has a persisted session) and only when the bound runner supports reattach (else the
      // pipe transport falls through to a kick that resumes the persisted session — today's recovery).
      const reattachRow =
        this.turn.canReattach() && anchor.sessionId
          ? await this.findReattachableTurn(
              job.id,
              lane,
              anchor.id,
              (ctx) => ctx.commitNudge == null,
            )
          : null;
      // Compose the fresh-turn task — and DRAIN + LEASE the build lane's pending host seeds into it — ONLY when
      // we're about to kick a fresh turn. `foldLegTaskWithSeeds` stamps `attempted_at` on the drained rows, but a
      // live reattach reuses the already-running turn (this composed `task`/`seedIds` is discarded and never wired
      // to a delivery stamp), so folding here would strand those seeds for a full CHAT_DELIVERY_LEASE_MS window —
      // long enough for a halt/done to skip them and lose them. A null container means we fall through to a kick.
      let task: AgentMessage = baseTask;
      let initialSeedIds: string[] = [];
      if (!reattachRow?.container_id) {
        ({ task, seedIds: initialSeedIds } = await this.foldLegTaskWithSeeds(
          job,
          thread,
          anchor.id,
          legSeed,
          baseTask,
          servicesBlock,
        ));
      }
      // A batch that has never started (no persisted session, no live turn) is a FRESH start — emit its START
      // markers (the :gear: milestone + the synthetic build_anchor the in-conversation BuildStepCard latches
      // onto) exactly ONCE. On a resume/reattach they already exist (durable), so re-emitting would duplicate.
      if (!reattachRow && !anchor.sessionId) {
        // Fresh start of the TERMINAL batch: clear any stale terminal record from a prior failed attempt so
        // the assertion we read after this turn can only be THIS turn's (staleness guard — ADR 0004). A
        // resume/reattach deliberately does NOT clear, preserving a pre-crash assertion.
        if (isLastBatch) {
          await this.store
            .clearTerminalRecord(thread.id)
            .catch(() => undefined);
        }
        await this.post(route, `:gear: ${thread.brief} — building: ${label}`);
        await this.blockSink
          .appendBlock(job.id, {
            kind: 'build_anchor',
            threadId: thread.id,
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
            this.logger.warn(
              `build_anchor append failed for thread=${job.id}: ${err}`,
            ),
          );
      }

      // Re-attach the in-flight turn if one is live; else (fresh batch, or a re-attach that could no longer be
      // tailed — engine finished + streams reaped, or the container is gone) KICK a fresh turn that resumes the
      // persisted session. Both paths own their harness lifecycle and yield the same RunTurnResult.
      let result: Awaited<ReturnType<TurnRunnerService['runTurn']>> | null =
        null;
      if (reattachRow?.container_id) {
        result = await this.reattachBatchTurn(
          job,
          thread,
          lane,
          metaTag,
          reattachRow,
          anchor.id,
          toolBridge,
        );
      }
      // LEG-ROTATION (single-shot): kick the Leg's turn (or reattach a live one), then check for rotation
      // ONCE. If the builder self-authored a handoff via `record_leg_handoff`, `completeLegRotation` has
      // ALREADY abandoned this session and inserted the NEXT builder thread row (carrying the handoff on its
      // own `handoff_in` + the continuation seed on its `config`) — so this batch is done: record the
      // closing Leg's read-model row and return `rotated`. runJob's per-thread-group loop re-queries the
      // thread group and drives the freshly-inserted `pending` builder as its OWN `runThread` call — no
      // in-process re-kick, because the seed now lives on the NEW row, not this one. The rotate-forever
      // guard is the per-thread-group leg cap enforced in `maybeRotateLeg` (MAX_LEGS_PER_THREAD_GROUP),
      // not an in-loop counter.
      if (!result) {
        result = await this.kickBatchTurn(
          job,
          sandbox,
          thread,
          steps,
          task,
          lane,
          channel,
          metaTag,
          label,
          repo,
          deadline,
          toolBridge,
          rotationArmed
            ? { state: rotationState, thresholds: rotationThresholds }
            : null,
          initialSeedIds,
        );
      }
      // Rotate ONLY if the builder self-authored a handoff (no forced rotation: a fat turn that never handed
      // off just ends). Not armed / asserted done / no handoff / over the per-thread-group cap ⇒ false.
      const rotated =
        rotationArmed &&
        (await this.maybeRotateLeg(job, route, thread, anchor, rotationState));
      if (rotated) {
        // Record the CLOSING Leg's read-model row (its session id + peak occupancy) before yielding — the
        // abandoned session stays on this (now-done) row as its transcript anchor. Display-only.
        await this.store
          .recordActiveLeg(
            anchor.id,
            result.session?.id ?? null,
            rotationState.peakTokens,
          )
          .catch((err) =>
            this.logger.debug(
              `recordActiveLeg failed (display-only): ${shortReason(err)}`,
            ),
          );
        return { outcome: 'rotated', report: result.report };
      }
      report = result.report;

      // Record/refresh the (non-rotated) Leg's read-model row (Stage 7 UI): its live session id + peak
      // occupancy — the implicit Leg-1 row for a thread that never rotated. Display-only.
      if (rotationArmed) {
        await this.store
          .recordActiveLeg(
            anchor.id,
            result.session?.id ?? null,
            rotationState.peakTokens,
          )
          .catch((err) =>
            this.logger.debug(
              `recordActiveLeg failed (display-only): ${shortReason(err)}`,
            ),
          );
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

    // The WRITER committed + pushed its own work (its batch prompt requires a clean tree). The host no longer
    // creates commits — it only READS what the writer produced. If the tree is still dirty (the model forgot),
    // nudge the SAME session to commit + push, bounded. This commit-fact observation is ADVISORY: if the tree
    // stays dirty the thread STILL advances as `done` (no downgrade) — the host records a "committed nothing"
    // note on the done-report so it surfaces on the ship card, and CI + the human ship-review are the backstops.
    const committed = await this.ensureCommitted(
      job,
      thread,
      sandbox,
      anchor,
      lane,
      channel,
      repo,
    );
    if (!committed.ok) {
      this.logger.warn(
        `thread ${thread.ordinal} — ${committed.detail} (advisory; advancing done)`,
      );
      const prior = await this.store
        .getTerminalRecord(thread.id)
        .catch(() => null);
      const advisory = `Committed nothing: ${committed.detail.slice(0, 500)}`;
      await this.store
        .recordThreadTermination(thread.id, {
          status: 'done',
          summary: prior?.summary ?? 'writer left uncommitted changes',
          ...(prior?.changes ? { changes: prior.changes } : {}),
          ...(prior?.verification ? { verification: prior.verification } : {}),
          ...(prior?.deviations ? { deviations: prior.deviations } : {}),
          gaps: [...(prior?.gaps ?? []), advisory],
        })
        .catch(() => undefined);
    }

    // Atomic-resume marker (#6): the sha the WRITER committed (READ via `headSha`, never created here). HEAD
    // unchanged from the thread's base ⇒ nothing was committed (a clean review) ⇒ the `NOTHING` sentinel.
    // Stamp on the ANCHOR step FIRST, then flip steps to done — a crash between the two fast-forwards on
    // resume (executeSteps) instead of re-running against an already-committed tree.
    const head = await this.git.headSha(sandbox.worktreePath).catch(() => null);
    const sha = head && head !== sectionStartSha ? head : NOTHING_COMMITTED;
    this.logger.log(
      `batch commit (writer-authored) ${sha === NOTHING_COMMITTED ? '(nothing)' : sha.slice(0, 8)}`,
    );
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
      .catch((err) =>
        this.logger.warn(`live-branch build backstop failed: ${err}`),
      );
    return { outcome: 'done', report };
  }

  /**
   * Ensure the WRITER left a clean tree (its own commit + push). Writers own their commits now (prompt);
   * this only handles the forgot-to-commit case. Re-checks the tree and, if dirty, resumes the SAME session
   * (via `stepId`) with a commit + push directive. Returns `ok:false` if the tree stays dirty (the driver
   * then blocks the thread).
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
      if (!(await this.git.hasChanges(sandbox.worktreePath)))
        return { ok: true };
      const reattachRow = this.turn.canReattach()
        ? await this.findReattachableTurn(
            job.id,
            lane,
            anchor.id,
            (ctx) => ctx.commitNudge != null,
          )
        : null;
      if (reattachRow?.container_id) {
        const result = await this.reattachBatchTurn(
          job,
          thread,
          lane,
          {
            phaseId: anchor.id,
            commitNudge:
              (reattachRow.ctx as { commitNudge?: unknown } | null)
                ?.commitNudge ?? 'reattach',
          },
          reattachRow,
          anchor.id,
        );
        if (result) continue;
      }
      if (attempt === COMMIT_NUDGE_MAX) break;
      const deadline = new PausableDeadline(
        this.phaseTimeoutMs,
        `commit nudge "${thread.brief}"`,
      );
      try {
        await this.kickCommitTurn(
          job,
          sandbox,
          thread,
          anchor,
          lane,
          channel,
          repo,
          attempt + 1,
          deadline,
        );
      } catch (err) {
        if (isEngineDetachedError(err)) throw err; // leave running for the next boot to re-attach
        this.logger.warn(
          `commit nudge ${attempt + 1} for thread ${thread.ordinal} errored: ${shortReason(err)}`,
        );
      }
    }
    return {
      ok: false,
      detail:
        'working tree still dirty after commit nudges — the writer did not commit its changes',
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
    const harness = this.turnHarness.create({
      jobId: job.id,
      orgId: job.orgId,
      threadId: thread.id,
      channel,
      lane,
      metaTag,
    });
    const task = renderCommitTurnTask();
    await harness.emitPrompt(task, `commit:${anchor.id}:${attempt}`);
    const repoConventions = await this.repoConventionsFor(job);
    // The repo's saved preview recipe — threaded the same way as the batch turn (see kickBatchTurn) so a
    // `validate` subagent spawned during a commit-nudge turn (Agent.WORKER, execute mode) also gets it.
    const previewInstructions =
      thread.kind === 'builder' ? await this.previewRecipeFor(job) : null;
    const evidenceDir = await this.evidenceDirForThread(job, thread);
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
            turnPhase: 'commit',
            ...(previewInstructions ? { previewInstructions } : {}),
          }),
          evidenceDir,
          ...(spec.reasoningEffort
            ? { modelReasoningEffort: spec.reasoningEffort }
            : {}),
          task,
          auth: await this.creds.engineAuth(job.orgId, spec.engine),
          userMcpServers: await this.mcp.resolveForTurn(
            job.orgId,
            job.repoId,
            'build',
          ),
          skills: await this.skills.resolveForTurn(
            job.orgId,
            job.repoId,
            'build',
          ),
          ...(repoConventions ? { repoConventions } : {}),
          ...(previewInstructions ? { previewInstructions } : {}),
          gitAuth: await this.resolveTurnGitAuth(
            job.orgId,
            repo.projectRepo.gitUrl,
          ),
          richStream: true,
          turnMeta: {
            jobId: job.id,
            orgId: job.orgId,
            channel,
            lane,
            kind: 'step', // reuse the batch reattach path (short resumed turn keyed on the anchor)
            ctx: {
              repoId: job.repoId,
              threadId: thread.id,
              anchorStepId: anchor.id,
              commitNudge: attempt,
            },
          },
          liveRoute: { channel, jobId: job.id, lane },
          onEvent: (e) => harness.onEvent(e),
        },
        `commit nudge "${thread.brief}" #${attempt}`,
        deadline,
      );
    } catch (err) {
      await harness.abort();
      throw err;
    }
    await harness.finish(
      result.report,
      result.usage
        ? { usage: result.usage, credentialId: result.credentialId ?? null }
        : undefined,
    );
    return result;
  }

  /**
   * Find the still-running registry row for THIS batch or commit-nudge engine turn (restart re-attach), or
   * null. Matches on (job_id, lane, ctx.anchorStepId) among running `'step'`-kind turns — the lane is
   * thread-scoped and a thread runs one batch/commit nudge at a time, so the match is unique; the anchor id
   * disambiguates across a thread's batches.
   */
  private async findReattachableTurn(
    jobId: string,
    lane: string,
    anchorStepId: string,
    matchCtx: (ctx: Record<string, unknown>) => boolean = () => true,
  ): Promise<ActiveTurnEntity | null> {
    const rows = await this.turnRegistry.listRunning().catch((err) => {
      this.logger.warn(
        `reattach lookup failed (will kick a fresh turn): ${err}`,
      );
      return [] as ActiveTurnEntity[];
    });
    return (
      rows.find((r) => {
        const ctx = r.ctx ?? {};
        return (
          r.kind === 'step' &&
          r.job_id === jobId &&
          r.lane === lane &&
          ctx.anchorStepId === anchorStepId &&
          matchCtx(ctx)
        );
      }) ?? null
    );
  }

  /**
   * RE-ATTACH a batch/commit-nudge in-flight engine turn after a restart: re-tail its live stream (no
   * re-kick) on the thread lane and persist the result — parity with the brain's boot re-attach. Returns null
   * when the turn can no longer be tailed (finished + streams reaped, or the container is gone) so the caller
   * re-runs it. Uses the ORIGINAL turn's channel so replayed frames land on the same SSE key.
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
      `thread ${thread.ordinal} — re-attaching in-flight engine turn ${row.turn_id} (container ${row.container_id})`,
    );
    const harness = this.turnHarness.create({
      jobId: job.id,
      orgId: job.orgId,
      threadId: thread.id,
      channel: row.channel,
      lane,
      metaTag,
    });
    try {
      const reattachCredentialId = (row.ctx as { credentialId?: string } | null)
        ?.credentialId;
      const spec = threadKindSpec(thread.kind);
      const result = await this.turn.reattach({
        turnId: row.turn_id,
        containerId: row.container_id!,
        jobId: job.id,
        orgId: row.org_id,
        stepId: anchorStepId,
        lane: row.lane,
        kind: row.kind,
        engine: spec.engine,
        liveRoute: { channel: row.channel, jobId: job.id, lane: row.lane },
        onEvent: (e) => harness.onEvent(e),
        // Re-supply the host tool closure — the in-sandbox session may have an in-flight
        // `request_operator_input` request whose response the re-attached host must still serve.
        ...(toolBridge ? { toolBridge } : {}),
        // Re-stamp rate_limit events with the dispatch-time credential (parity with a fresh dispatch).
        ...(reattachCredentialId ? { credentialId: reattachCredentialId } : {}),
      });
      await harness.finish(
        result.report,
        result.usage
          ? { usage: result.usage, credentialId: result.credentialId ?? null }
          : undefined,
      );
      return result;
    } catch (err) {
      if (isEngineDetachedError(err)) {
        // We lost our OWN tail mid-turn (shutdown during a watch respawn) — the engine is still running.
        // Persist nothing, finalize nothing (the row + streams are the next boot's re-attach anchor), and
        // crucially do NOT return null: that would re-kick a live engine's session. Propagate instead.
        this.logger.warn(
          `re-attach turn ${row.turn_id} detached — leaving it for the next boot`,
        );
        throw err;
      }
      if (isSessionLimitError(err)) {
        // The re-attached turn ended cleanly on a Claude session limit. End the live lane without a text
        // fallback and propagate so the top-level drive parks the build on the durable resume clock.
        await harness.abort();
        throw err;
      }
      // The engine turn already finished (streams reaped) or its container is gone — persist partials, end
      // the lane once, finalize the stale registry row (so the watchdog/reaper don't race it), and signal
      // the caller to re-run the batch (resuming the persisted session).
      await harness.abort();
      await this.turnRegistry
        .finalize(row.turn_id, 'failed')
        .catch(() => undefined);
      this.logger.warn(
        `re-attach turn ${row.turn_id} failed; re-running the batch: ${err}`,
      );
      return null;
    }
  }

  /**
   * Fold the next Leg's task, DRAINING the build lane's eligible pending HOST SEEDS into it (spec step 4/4a).
   * A build lane rides the SAME `composeTurn` + turn-prefix rail the brain uses (d4): the pending rows compose
   * as chronological `<user>` chunks behind the (inert) `collectOperatorPrepends` memory rail, and that
   * composed block is combined with the rotation `legSeed` into one fold seed. Only a STEERABLE Claude builder
   * drains (Codex master_review is non-steerable — skipped). The drained rows are LEASED so a crash between
   * here and the durable Leg-turn registration re-drives them (never double-runs); the caller stamps each
   * `delivered_at` via `onTurnRegistered` on the kick.
   *
   * PARITY: with nothing pending (the common case, and every existing golden test) the returned task is
   * byte-identical to `foldLegTurn(legSeed, baseTask, servicesBlock)` and `seedIds` is empty.
   */
  private async foldLegTaskWithSeeds(
    job: Job,
    thread: DriverThread,
    _anchorId: string,
    legSeed: string | null,
    baseTask: AgentMessage,
    servicesBlock: string,
  ): Promise<{ task: AgentMessage; seedIds: string[] }> {
    const drainable =
      thread.kind === 'builder' &&
      threadKindSpec(thread.kind).engine === 'claude';
    if (!drainable || !this.stimulusStore) {
      return {
        task: foldLegTurn(legSeed, baseTask, servicesBlock),
        seedIds: [],
      };
    }
    const lane = laneFor('builder', thread.id);
    const pending = await this.stimulusStore
      .eligiblePendingChat(job.id, CHAT_DELIVERY_LEASE_MS, lane)
      .catch(() => []);
    if (pending.length === 0) {
      return {
        task: foldLegTurn(legSeed, baseTask, servicesBlock),
        seedIds: [],
      };
    }
    const seedIds = pending.map((p) => p.id);
    await this.stimulusStore.leaseChatStimuli(seedIds).catch(() => undefined);
    const composed = composeTurn({
      prefixChunks: this.jit?.collectOperatorPrepends({ jobId: job.id }) ?? [],
      userChunks: pending.map((p) => userChunkFor(p)),
    });
    const combinedSeed = [legSeed, String(composed)]
      .filter(Boolean)
      .join('\n\n---\n\n');
    return {
      task: foldLegTurn(combinedSeed, baseTask, servicesBlock),
      seedIds,
    };
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
    task: AgentMessage,
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
    rotation: {
      state: LegRotationRunState;
      thresholds: LegRotationThresholds;
    } | null,
    // The build-lane host seeds folded into this Leg's `task` — each stamped `delivered_at` the instant the
    // turn is durably registered (the restart-survivable hand-off, mirroring the brain). Empty ⇒ no drain.
    seedIds: string[] = [],
  ): Promise<Awaited<ReturnType<TurnRunnerService['runTurn']>>> {
    const anchor = steps[0];
    const harness = this.turnHarness.create({
      jobId: job.id,
      orgId: job.orgId,
      threadId: thread.id,
      channel,
      lane,
      metaTag,
    });
    // Engine / persona / reasoning effort come from the thread-kind spec (the prompt-kit `Agent` binding).
    // The master-review kind runs CODEX in execute mode over the whole diff (review + fix + verify) with a
    // dedicated persona + high reasoning effort; a builder runs Claude with the WORKER persona. `jobKind` is
    // ignored by MASTER_REVIEW's fragments, so passing it uniformly is byte-identical for both.
    const spec = threadKindSpec(thread.kind);
    const engine: SessionEngine = spec.engine;
    // Mid-turn steering is armed for EVERY Claude builder Leg — INCLUDING the capped final Leg (where
    // `rotation` is null: a capped Leg is still a live steerable Claude session, it just won't rotate again).
    // Decoupled from `rotation` so a host seed can steer any live builder Leg; `rotationNudge` stays gated on
    // `rotation`. Codex builder / master-review turns stay non-steerable (no streaming-input steer).
    const steerable = engine === 'claude' && thread.kind === 'builder';
    // The repo's house-style, folded into the builder's system prompt AND forwarded on the run args so the
    // FAN_OUT writer subagents this turn spawns in-container render the same envelope (Layer B).
    const repoConventions = await this.repoConventionsFor(job);
    // The repo's saved preview recipe, folded into the WORKER's system prompt READ-ONLY AND forwarded on the
    // run args so the in-container `validate` subagent this turn spawns gets the same recipe.
    const previewInstructions =
      thread.kind === 'builder' ? await this.previewRecipeFor(job) : null;
    const systemPrompt = renderAgentPrompt(spec.agent, {
      jobKind: job.kind,
      settings: { repoConventions },
      turnPhase: 'batch',
      ...(previewInstructions ? { previewInstructions } : {}),
    });
    // Leg-rotation occupancy watch: fires SOFT once, then a REMINDER on each further +delta as this builder
    // session's main-agent context fills. Codex/master-review turns emit no per-call occupancy, so the watch
    // never latches for them (positive-signal only). When ARMED (Claude builder) each crossing (a) records that
    // the session went fat and (b) persists a VISIBLE harness row into this Leg's transcript, so the operator
    // sees the exact pressure ask; when disarmed it stays observe-only (logs the crossing). See the plan.
    const legOrdinal = (metaTag['legOrdinal'] as number | undefined) ?? 1;
    const rotationWatch = new LegRotationWatch(
      rotation?.thresholds ?? resolveRotationThresholds(),
      (sig) => {
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
        const nudgeText = stripContextPressureTag(
          sig.phase === 'soft' ? ROTATION_SOFT_NUDGE : ROTATION_REMINDER_NUDGE,
        );
        void this.store
          .recordBuildSystemChunk({
            jobId: job.id,
            phaseId: anchor.id,
            legOrdinal,
            kind: 'system_reminder',
            text: nudgeText,
            chunkKey: chunkKey.rotNudge(
              anchor.id,
              legOrdinal,
              sig.phase,
              sig.reminderIndex,
            ),
            reminderKind: 'context_pressure',
          })
          .catch((err) =>
            this.logger.debug(
              `rotation nudge row failed (display-only): ${shortReason(err)}`,
            ),
          );
      },
    );
    // Circuit breaker (#3): bound the engine turn with the shared PAUSABLE deadline (paused across a
    // `request_operator_input` human wait). On breach it both signals the SDK to abort AND hard-rejects so
    // the DRIVER gives up even if the SDK can't interrupt a stuck subprocess. Events attribute to the anchor
    // step (a batch is one turn; minor observability coarsening for the step transcript).
    const evidenceDir = await this.evidenceDirForThread(job, thread);
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
          evidenceDir,
          // High reasoning effort for the whole-diff review pass (parity with plan-review), from the spec.
          // Undefined for Claude builder turns. The `toolBridge` below now reaches Codex too — `runCodex`
          // renders its tool names into a config.toml `[mcp_servers.atlasbridge]` block (the MCP bridge).
          ...(spec.reasoningEffort
            ? { modelReasoningEffort: spec.reasoningEffort }
            : {}),
          task,
          auth: await this.creds.engineAuth(job.orgId, engine),
          userMcpServers: await this.mcp.resolveForTurn(
            job.orgId,
            job.repoId,
            'build',
          ),
          skills: await this.skills.resolveForTurn(
            job.orgId,
            job.repoId,
            'build',
          ),
          ...(repoConventions ? { repoConventions } : {}),
          ...(previewInstructions ? { previewInstructions } : {}),
          // Authenticated git IN the sandbox: the execute turn (orchestrator) can fetch/merge origin,
          // resolve conflicts, and push its own branch. Sourced from the RESOLVED repo (not `sandbox`).
          gitAuth: await this.resolveTurnGitAuth(
            job.orgId,
            repo.projectRepo.gitUrl,
          ),
          richStream: true, // full transcript (thinking + tool calls/results + subagent forwarding)
          // Mid-turn steering — armed for every Claude builder Leg (including the capped final Leg) so
          // operator steers AND the engine-local Leg-rotation SOFT/REMINDER nudges land in the LIVE turn
          // (`priority:'now'`). Never for Codex (no streaming-input steering there). `rotationNudge` gives
          // the engine the threshold + seed prompts so it injects the nudge itself the instant its own
          // occupancy crosses — race-free vs the input close; it stays gated on `rotation` (disarmed on the
          // capped final Leg, which won't rotate again).
          ...(steerable ? { steerable: true } : {}),
          ...(rotation
            ? {
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
          liveRoute: { channel, jobId: job.id, lane },
          // Stamp each folded host seed delivered the instant the Leg turn is durably registered (the
          // restart-survivable hand-off — a later crash resumes THIS turn rather than re-draining the seeds).
          ...(seedIds.length
            ? {
                onTurnRegistered: () => {
                  for (const id of seedIds) {
                    void this.stimulusStore
                      ?.markChatDelivered(id)
                      .catch((err) =>
                        this.logger.debug(
                          `markChatDelivered ${id} failed (sweep will retry): ${err}`,
                        ),
                      );
                  }
                },
              }
            : {}),
          onEvent: (e) => {
            // Rotation + peak track ONLY the main orchestrator's window. Subagent round-trips emit their
            // own `usage` frame (parentToolUseId set) carrying the SUBAGENT's occupancy — a separate
            // context that can't be rotated — so they must never trip the pressure nudge or inflate the
            // leg's peak. Mirrors the engine-local nudge's `if (!parent)` guard in engine-core.
            if (e.kind === 'usage' && e.parentToolUseId == null) {
              rotationWatch.observe(e);
              // Track the peak main-agent occupancy for the closing Leg's `build_legs` row (armed turns only).
              if (rotation && e.contextTokens != null) {
                rotation.state.peakTokens = Math.max(
                  rotation.state.peakTokens ?? 0,
                  e.contextTokens,
                );
              }
            }
            // A `now` host seed steered mid-turn into this live Leg is consumed at the engine `input_ack` — the
            // shared `steerPending` only LEASES, so stamp delivered HERE (idempotent) or it re-drains at lease
            // expiry. A rotation-nudge steer carries a throwaway id (no matching row) → a harmless no-op stamp.
            if (e.kind === 'input_ack' && e.id) {
              void this.stimulusStore
                ?.markChatDelivered(e.id)
                .catch((err) =>
                  this.logger.debug(
                    `input_ack stamp for ${e.id} failed (sweep will retry): ${err}`,
                  ),
                );
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
    await harness.finish(
      result.report,
      result.usage
        ? { usage: result.usage, credentialId: result.credentialId ?? null }
        : undefined,
    );
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
    const term = await this.store
      .getTerminalRecord(thread.id)
      .catch(() => null);
    if (term?.status === 'done') return false;

    // No forced rotation: a fat turn that never called `record_leg_handoff` simply ends (it was reminded, not
    // seized). Only a self-authored handoff rotates.
    const handoff = state.handoff;
    if (!handoff) return false;

    // PER-THREAD-GROUP LEG CAP (d1): once the thread group already holds MAX_LEGS_PER_THREAD_GROUP builder
    // rows, append exactly one final capped builder row and disarm rotation for it. A runaway
    // rotate-every-turn thread still gets one fresh, steerable session to finish from the handoff, but it
    // cannot grow the thread group forever.
    const legCount = await this.store
      .builderLegCountForThreadGroup(thread.id)
      .catch(() => 0);
    const rotationCapped = legCount >= MAX_LEGS_PER_THREAD_GROUP;
    if (rotationCapped) {
      this.logger.warn(
        `leg-rotation: thread ${thread.ordinal} hit MAX_LEGS_PER_THREAD_GROUP (${MAX_LEGS_PER_THREAD_GROUP}) builder legs — ` +
          `rotating once more to a capped final leg with rotation disabled`,
      );
    }

    // The seed carries the preamble + handoff + the OPEN task list (the SDK's in-memory todo dies with the
    // session; the thread-group-owned `tasks` table (d6) is folded back in so the fresh Leg continues its
    // checklist).
    const seed = await this.buildLegSeed(thread.id, handoff);
    const res = await this.store
      .completeLegRotation({
        anchorStepId: anchor.id,
        handoff,
        seed,
        ...(rotationCapped ? { rotationCapped: true } : {}),
        ...(state.peakTokens != null
          ? { contextTokensPeak: state.peakTokens }
          : {}),
      })
      .catch((err) => {
        this.logger.error(
          `leg-rotation: completeLegRotation failed for thread ${thread.ordinal}: ${err}`,
        );
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
        text: fromExternal(handoff),
        chunkKey: chunkKey.rotHandoff(anchor.id, res.fromLeg),
        reminderKind: 'leg_handoff',
      })
      .catch((err) =>
        this.logger.debug(
          `rotation handoff row failed (display-only): ${shortReason(err)}`,
        ),
      );
    await this.store
      .recordBuildSystemChunk({
        jobId: job.id,
        phaseId: anchor.id,
        legOrdinal: res.toLeg,
        kind: 'system_notice',
        text: seed,
        chunkKey: chunkKey.rotSeed(anchor.id, res.toLeg),
        reminderKind: 'leg_seed',
      })
      .catch((err) =>
        this.logger.debug(
          `rotation seed row failed (display-only): ${shortReason(err)}`,
        ),
      );
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
   * task list (cross-Leg task carry). The SDK's in-memory to-do dies with the abandoned session, but the list
   * is durable in the thread-group-owned `tasks` table (d6 — folded from the builder's own
   * TaskCreate/TaskUpdate calls), so we read it back and render the still-open items into the seed — the
   * fresh Leg continues the checklist instead of restarting it. The web checklist stays authoritative
   * across Legs regardless (it reads the same thread-group-scoped rows).
   */
  private async buildLegSeed(
    threadId: string,
    handoff: string,
  ): Promise<AgentMessage> {
    const tasks = await this.store
      .getThreadTasks(threadId)
      .catch(() => [] as TaskItem[]);
    // Compose through the hub factory (byte-identical to the former inline join) — the mint and the
    // `fromExternal` seam for the self-authored handoff both live inside prompt-kit, not at this call site.
    return composeLegSeed(handoff, renderOpenLegTasks(tasks));
  }

  /**
   * Probe THIS sandbox's live `atlas-svc` services and render the "still online — reuse them" block folded
   * into each builder turn-kick (and every rotated Leg). Recomputed per kick — never baked into the
   * once-per-batch base task — so a service an earlier session/Leg left running shows up. Best-effort: any
   * failure yields '' so a probe hiccup never blocks a kick, and the shared `serviceStatus` generation gate
   * means a reused pgid from a dead container generation reads `stopped`, not `running`.
   */
  private async renderLiveServicesBlock(jobId: string): Promise<string> {
    try {
      const dir = this.threadLifecycle.supervisorDirHost(jobId);
      if (!dir) return '';
      const markers = readServiceMarkers(dir);
      if (markers.length === 0) return '';
      const pgids = markers
        .map((m) => m.pgid)
        .filter((p): p is number => p != null);
      const probe = await this.threadLifecycle.probeLiveness(jobId, pgids);
      const running = markers.filter(
        (m) => serviceStatus(m, probe) === 'running',
      );
      if (running.length === 0) return '';
      return renderRunningServicesNote(
        running.map((m) => ({
          name: m.name,
          port: m.port,
          url:
            m.port != null && m.expose
              ? (this.exposure?.urlFor(jobId, m.name) ?? null)
              : null,
        })),
      );
    } catch (err) {
      this.logger.debug(
        `renderLiveServicesBlock(${jobId.slice(0, 8)}) failed: ${err}`,
      );
      return '';
    }
  }

  /**
   * Pick the skill(s) directly relevant to a build thread so the build turn can nudge the model to load them.
   * GROUP-GRAINED: the selection is persisted on the build thread GROUP (all rotation legs of one build share
   * one group), so the Haiku selector runs at most ONCE per build — a later leg reuses the persisted pick. A
   * PRESENT persisted key (even `{skills:[]}`) means "already decided": reuse it and skip selection. FAIL-SOFT
   * end to end — the whole body is wrapped in try/catch (belt-and-suspenders over the selector's own fail-soft)
   * so no key / any error / an empty pick all resolve to `[]` and never throw into the build path.
   */
  private async resolveSkillNudge(
    job: Job,
    thread: DriverThread,
    record: DecisionRecord | null,
  ): Promise<{ name: string; reason: string }[]> {
    try {
      const groupId = thread.threadGroupId;
      const prior = await this.store.readGroupSkillNudge(groupId);
      if (prior) return prior.skills;

      const resolved = await this.skills.resolveForTurn(
        job.orgId,
        job.repoId,
        'build',
      );
      if (!resolved.length) {
        await this.store.persistGroupSkillNudge(groupId, {
          skills: [],
          at: new Date().toISOString(),
        });
        return [];
      }

      const decisions = record?.decisions.length
        ? record.decisions
            .map((d) => `- [${d.decisionClass}] ${d.title}: ${d.ruling}`)
            .join('\n')
        : '(none)';
      const context = [
        record?.overview ?? '',
        `Thread: ${thread.brief}`,
        `Locked decisions:\n${decisions}`,
      ].join('\n');

      const picked = await this.skillNudge.select({
        context,
        skills: resolved.map(({ name, description }) => ({ name, description })),
        orgId: job.orgId,
      });
      await this.store.persistGroupSkillNudge(groupId, {
        skills: picked,
        at: new Date().toISOString(),
      });
      return picked;
    } catch (err) {
      this.logger.debug(
        `resolveSkillNudge(${thread.id.slice(0, 8)}) failed: ${err}`,
      );
      return [];
    }
  }

  /**
   * Persist the closing Leg's handoff as a DURABLE FILE at `/context/generated/handoffs/leg-<N>.md` — a
   * legible, inspectable artifact that lives OUTSIDE the git worktree (so it never becomes a dirty commit or
   * a PR file). `/context/generated` is the host-written bucket (mounted READ-ONLY into the container), so the
   * fresh Leg can re-read its own handoff, and it surfaces in the web's GENERATED panel. Best-effort: a write
   * failure is logged and swallowed — it must never block the rotation (the seed still carries the handoff text).
   */
  private async writeLegHandoffArtifact(
    job: Job,
    leg: number,
    handoff: string,
  ): Promise<void> {
    try {
      const generated = join(
        this.threadLifecycle.contextDirHost(job.id, job.orgId),
        'generated',
      );
      await mkdir(join(generated, 'handoffs'), { recursive: true });
      await writeFile(
        join(generated, 'handoffs', `leg-${leg}.md`),
        `${handoff}\n`,
        'utf8',
      );
    } catch (err) {
      this.logger.debug(
        `leg handoff artifact write failed (display-only): ${shortReason(err)}`,
      );
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
      const generated = join(
        this.threadLifecycle.contextDirHost(job.id, job.orgId),
        'generated',
      );
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
      this.logger.debug(
        `deviations projection write failed (display-only): ${shortReason(err)}`,
      );
    }
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
      const { rotated } = await this.mcpOAuth.refreshForSandbox(
        job.orgId,
        job.repoId,
      );
      if (!rotated) return;
      const servers = await this.mcp
        .resolveForSandbox(job.orgId, job.repoId)
        .catch(() => []);
      await this.sandboxes.kickMcpHubRefresh({ jobId: job.id, servers });
      this.logger.log(
        `job=${job.id} re-kicked mcp hub after oauth token rotation`,
      );
    } catch (err) {
      this.logger.debug(
        `oauth hub refresh skipped (continuing): ${String(err)}`,
      );
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
    a: {
      autofixId: string;
      scope: 'thread' | 'pr';
      label: string;
      lensIds: string[];
    },
  ): Promise<void> {
    await this.post(route, `:mag: Reviewing the diff — *${a.label}*`);
    await this.blockSink
      .appendBlock(job.id, {
        kind: 'autofix_anchor',
        threadId: await this.planningThreadId(job.id),
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
        this.logger.warn(
          `autofix_anchor append failed for job=${job.id}: ${err}`,
        ),
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
        new Error(
          `${this.label} exceeded PHASE_TIMEOUT_MS (${this.totalMs}ms)`,
        ),
      );
    }, this.remaining);
  }

  /** Suspend the countdown, banking the elapsed time. No-op if not armed / already paused / finished. */
  pause(): void {
    if (!this.armed || this.paused || this.done) return;
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.remaining = Math.max(
      0,
      this.remaining - (Date.now() - this.startedAt),
    );
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

/** Backstop on Leg rotations within a single build THREAD GROUP: a runaway thread that re-crosses the HARD
 *  threshold every Leg can't append builder rows forever. Once the thread group already holds this many
 *  `builder` threads, `maybeRotateLeg` refuses to rotate again — the current builder then ends without
 *  asserting `done`, so it halts as `incomplete` (surfaced to the operator) rather than spinning. */
const MAX_LEGS_PER_THREAD_GROUP = 8;

/** A locked step row → the `PlannedStep` view visibility/render read (title null → brief). */
function asPlannedStep(step: Step): PlannedStep {
  return { title: step.title ?? step.brief, brief: step.brief };
}

/**
 * Render the durable halt trail for `/context/generated/threads/<ordinal>-<slug>/completion.md` (ADR 0004 Phase 3). Pure
 * — every section is guarded on presence and tails are already length-capped in the record. The brain reads
 * this on its wake turn (alongside the fenced record in the wake body) to triage the halt.
 */
export function renderCompletionMd(
  thread: DriverThread,
  term: ThreadTerminalRecord | null,
  at: string,
  anchor?: SessionAnchor,
): string {
  const lines: string[] = [
    `# Thread not done: ${thread.brief}`,
    ``,
    `- **Outcome:** incomplete (needs the operator)`,
    `- **Thread:** \`${thread.id}\` (ordinal ${thread.ordinal})`,
    `- **When:** ${at}`,
  ];
  if (anchor)
    lines.push(
      `- **Transcript:** session \`${anchor.sessionId}\`${
        anchor.legOrdinal ? ` (Leg ${anchor.legOrdinal})` : ''
      } — \`atlas-tx show ${anchor.sessionId}\``,
    );
  if (term?.summary) lines.push(``, `## Summary`, term.summary);
  if (!term) {
    lines.push(
      ``,
      `## Why not done`,
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
  return detail.length > 500
    ? `${detail.slice(0, 497)}...`
    : detail || 'unknown error';
}

/** Render a session-limit reset instant as a short human time (e.g. "3:20 PM"); falls back to the raw ISO
 *  string if it can't be parsed. Kept simple + STABLE so the park notice dedupes on exact text. */
export function fmtReset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
