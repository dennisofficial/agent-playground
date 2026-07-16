import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Subscription } from 'rxjs';
import { modeApprovesPlan } from '@workspace/shared';
import { LeaderElectionService } from '../cluster';
import type {
  EventMessage,
  Job,
  JobKind,
  JobStatus,
  Message,
  MessageType,
  SeedRow,
  TurnEnvelope,
  UnblockBlockerInfo,
} from '@shared/domain';
import { MemoryStore } from '../memory';
import {
  StimulusStoreService,
  renderTurn,
  type TurnChunk,
  type CollectedPending,
  type DeliveryLane,
  CHAT_DELIVERY_LEASE_MS as DELIVERY_LEASE_MS,
  steerPending,
  trySteerLive,
  isNowPriority,
  isWakeEligible,
  userChunkFor,
} from '../stimulus';
import {
  CHAT_SURFACE,
  type ChatSurface,
  type DecisionApprovalCard,
  TurnHarnessFactory,
  TASK_EVENT_SINK,
  type TaskEventSink,
  makeTaskTools,
  ThreadInputService,
  laneFor,
  SYSTEM_SEED_AUTHOR,
  webQuestionCard,
  wrapSystemNotification,
} from '../surface';
import { LiveTurnStore, MAIN_LANE } from '../surface/live-turn-store';
import { TurnUsageProjector } from '../analytics/turn-usage-projector.service';
import { EnvService } from '@core/config/env/env.service';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  ActiveTurnEntity,
  InboundMessageEntity,
  JobSandboxEntity,
  TranscriptMessageEntity,
  RepoEntity,
} from '../persistence/entities';
import { ProdDiagnosticsService } from '../prod-mcp/prod-diagnostics.service';
import { isAtlasRepo } from '../sandbox/atlas-repo';
import {
  ProvisioningNotReadyError,
  JobLifecycleService,
} from '../driver/job-lifecycle.service';
import { DriverStoreService } from '../driver/driver-store.service';
import { JobBootstrapService } from '../job-bootstrap/job-bootstrap.service';
import { BuildShipService } from '../driver/build-ship.service';
import { AutoMergeService } from '../driver/auto-merge.service';
import { BrainGateway } from '../brain-gateway';
import { Agent, PromptService } from '../prompt-kit';
import {
  shipOpenPrBody,
  composePreviewPrepSeed,
  postBuildGateSeed,
} from '../prompt-kit';
import type { AgentMessage } from '@shared/prompt-kit/message';
import { fromExternal } from '@shared/prompt-kit/message';
import { isSubstantiveQuery, renderMemoryRecall } from '@shared/prompt-kit/jit';
import {
  chunkKey,
  composeMessageBody,
  RESET_VERIFY_TEXT,
  COMPACTION_SYSTEM,
  COMPACTION_INSTRUCTION,
  renderEventDelivery,
  renderFollowUpJobSeed,
  renderBornBlockedUnblockPrefix,
  frameAnswer,
  composeTurn,
  composeSeedTurn,
  maskedSecretNotice,
  maskedFileNotice,
  wakeForAmendApprovedBody,
  retryResumeNudge,
} from '../prompt-kit/harness';
// Re-exported so `brain/index.ts` (`export *`) and specs that import these straight from this file
// (colocated golden-snapshot/doctrine specs — see continuation-preamble-snapshot.spec / halt-triage-guidance.spec /
// agent-session-manager.spec) keep resolving after the content catalog moved into the prompt-kit hub.
export { CONTINUATION_PREAMBLE } from '../prompt-kit/harness';
import { DRIVER_REPO, type DriverRepoResolver } from '../driver/repo-resolver';
import type { PlannedStep } from '../prompt-kit/messages/render-plan';
import { coerceThreadType, type ThreadType } from '@shared/thread-kind/thread-types';
import { DecisionClassifier } from '../decision-gate';
import {
  CredentialResolver,
  WorkspaceConfigStore,
  WorkspaceSecretFileStore,
} from '../onboarding';
import { OauthUsageService } from '../onboarding/oauth-usage.service';
import {
  defaultResumeAt,
  isCorroboratedSessionLimit,
  SESSION_LIMIT_TEXT_MISFIRE_MAX,
} from '@shared/engine/session-limit';
import { McpResolver, McpServerStore } from '../mcp';
import { ConventionProfileResolver } from '../conventions';
import {
  SkillFileWriter,
  SkillInstallerService,
  SkillResolver,
  WorkspaceSkillStore,
} from '../skills';
import {
  WorkspaceProfileService,
  detectRepoManifests,
  ProfileAwarenessService,
} from '../workspace-profile';
import { CONTAINER_CONTEXT } from '../sandbox/container-paths';
import { LocalGitService } from '../git';
import type { SandboxMilestoneStage } from '../sandbox/sandbox-provider.port';
import { JobDependencyService } from '../job-deps';
import type { Decision } from '@shared/domain';
import { nextDecisionId, DECISION_CLASS_IDS } from '@shared/domain';
import type { DecisionClass } from '@shared/domain/decision-record';
import { BRIDGE_SERVER_NAME } from '@shared/bridge-names/bridge-options';
import {
  BrainTurnAlreadyRunningError,
  TurnRegistry,
} from '../sandbox/turn-registry.service';
import {
  TurnReattachRegistry,
  type ReattachOutcome,
} from '../sandbox/turn-reattach.registry';
import {
  ENGINE_RUNNER,
  HOST_RETRY_BACKOFF_MS,
  isEngineDetachedError,
  isRetryableTransientError,
  isUnresumableSessionMessage,
  MAX_HOST_RETRIES,
  resolveContextLimit,
  SANDBOX_RESET_NOTICE,
  INTERNAL_PROFILE_AWARENESS_TOOL,
} from '@shared/engine/engine.types';
import type {
  EngineEvent,
  EngineRunnerPort,
  GitAuth,
  ToolImpl,
  RunEngineArgs,
  EngineRunResult,
} from '@shared/engine/engine.types';
import { summarizeTurnFailure } from '@shared/engine/turn-failure-summary';
import type { TurnFailureCategory } from '@shared/engine/turn-failure-summary';
import type { EngineHomeKey } from '@shared/engine/engine-home';
import { threadKindSpec } from '../thread-kind';
import type { ThreadRole } from '../thread-kind';
import { BrainStoreService } from './brain-store.service';
import { DecisionApprovalService } from './decision-approval.service';
import type {
  ApprovalResolution,
  ApprovalVerdict,
} from './decision-approval.service';
import { JOB_DISPATCHER, type JobDispatcher } from './job-dispatcher';
import {
  PlanReviewService,
  deserializeFindings,
  type PlanReviewRow,
} from './plan-review.service';
import { TurnRecoveryService } from './turn-recovery.service';
import { JitHostExecutor } from './jit-host-executor';
import { SelfSufficiencyToolsService } from './self-sufficiency-tools.service';
import { ChatToolProvider } from './chat-tool-provider.service';

type InjectedMemoryDedupState = {
  sessionId: string | null;
  factIds: Set<string>;
};

/**
 * R3 — the AGENT SESSION MANAGER (the chat brain).
 *
 * Replaces `ConversationalBrainService` + `ScopingInvestigatorService`. Each thread gets a per-thread
 * Claude Agent SDK session that runs INSIDE the thread's sandbox via the R1 tool bridge.
 *
 * Architecture:
 *   - On a chat stimulus: run an in-sandbox engine turn via the `ENGINE_RUNNER` (Docker by default;
 *     Redis-Streams transport when ENGINE_TRANSPORT=redis), resuming the persisted session_id for the thread.
 *   - The session runs with a custom system prompt (NOT the SDK's native ExitPlanMode) + 6 host-side
 *     tool impls dispatched through the tool bridge.
 *   - `review_plan` → a SYNCHRONOUS in-turn Codex review (advisory findings, resumable conversation);
 *     `propose_plan` → `persistPlan` (status `awaiting_approval`, gated on a review having run) → approval
 *     card via `DecisionApprovalService`.
 *   - On approve → `JOB_DISPATCHER.dispatch`; on deny/request_changes → keep talking.
 *   - session_id is persisted on the `thread_sandboxes` row so it survives host restarts.
 */
/** A no-op {@link TaskEventSink} — the constructor default for a test that builds this manager directly
 *  (bypassing Nest DI) without wiring a real sink. In prod the @Global LiveTurnModule always supplies the
 *  real {@link EntityTaskEventSink}; a call through this default degrades gracefully instead of throwing. */
const NOOP_TASK_EVENT_SINK: TaskEventSink = {
  createTask: async () => ({ id: 'noop' }),
  updateTask: async () => ({ ok: false, error: 'task sink not wired' }),
  readTasks: async () => [],
};

@Injectable()
export class AgentSessionManager
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(AgentSessionManager.name);

  /** Leader-only boot-sweep subscription (turn_active reset + answered-Q / plan-review re-delivery). */
  private leaderBootSub?: Subscription;
  /** The boot sweeps run ONCE per process — never on a mid-life re-promote (would clear active turns). */
  private bootSweepsDone = false;
  /** Leader-only periodic chat-delivery sweep (started on promote, stopped on demote/shutdown). The interval
   *  itself is owned by @nestjs/schedule's SchedulerRegistry under CHAT_SWEEP_INTERVAL. */
  private chatSweepPromoteSub?: Subscription;
  private chatSweepDemoteSub?: Subscription;

  /** Bounded in-memory dedup for the work-owed review backstop: last nudge time per jobId, so a job whose
   *  re-driven turn is still spinning up isn't re-nudged every sweep. Best-effort (per-process). */
  private readonly workOwedNudgedAt = new Map<string, number>();

  /**
   * Delivery LEASE window: once the pump takes a pending chat row (steers it / hands it to a fresh turn),
   * it can't be re-selected for this long. Longer than a cold-container provision so a live delivery isn't
   * raced by the sweep; the per-thread turn queue is the real serializer, so this is a cross-pass guard.
   */
  private static readonly CHAT_DELIVERY_LEASE_MS = DELIVERY_LEASE_MS;

  /**
   * The thread brain's model — the conversational/planning session that grills, locks decisions, and
   * proposes plans. Pinned to Opus (the SDK accepts the `'opus'` alias → latest Opus). A code constant,
   * NOT an env var — model choice doesn't vary by environment. (Step workers default to Opus too, in
   * `engine-core`'s `DEFAULT_WORKER_MODEL`.)
   */
  private static readonly BRAIN_MODEL = 'opus';

  /**
   * Per-thread turn queue — serializes chat turns for ONE thread so a follow-up sent WHILE a turn is
   * still running waits for it instead of starting a second engine turn that resumes the SAME session id
   * concurrently (which corrupts the session). One thread = one in-flight turn at a time; the next turn
   * resumes the session with the queued message once the current one finishes. Keyed `orgId:jobId`.
   */
  private readonly turnQueues = new Map<string, Promise<void>>();

  /**
   * Bounded silent auto-resume cap for a BENIGN `aborted_streaming` (an SDK stream abort that
   * self-recovers) — the durable `jobs.benign_abort_redrives` counter is CAS-claimed against this cap.
   * Past the cap we stop swallowing and surface the normal retryable box, so a PERSISTENT abort still
   * reaches the operator.
   */
  private static readonly MAX_BENIGN_ABORT_REDRIVES = 2;

  /** Per-job in-process re-drive timer for the 10s host-retry backoff (the durable clock is the restart-only
   *  backstop). Cleared/replaced when a superseding turn is scheduled. */
  private readonly hostRetryTimers = new Map<string, NodeJS.Timeout>();

  // ── reset_sandbox bookkeeping (all keyed `orgId:jobId`, in-memory, per-process) ─────────────────
  /** "Tear down before the verify turn": set by the `reset_sandbox` tool, consumed by the turn tail. `hard`
   *  ⇒ a from-scratch worktree + container re-provision (vs the default container-only reset). */
  private readonly resetRequests = new Map<
    string,
    { reason: string; hard?: boolean }
  >();
  /** After a teardown, the verify framing is owed to the FIRST cold-attached turn (operator or synthetic). */
  private readonly pendingResetVerify = new Set<string>();
  /** Consecutive autonomous resets — incremented by the tool, cleared ONLY on an operator turn (loop guard). */
  private readonly consecutiveResets = new Map<string, number>();
  /** Two-call confirm for `reset_sandbox({ hard:true })`: the FIRST hard call arms this (returns a notice of
   *  what happens / what's lost, does NOT reset); the SECOND actually queues the hard reset. Cleared on any
   *  operator turn, so a stale arm can't fire a later reset the operator didn't just ask for. */
  private readonly pendingHardReset = new Set<string>();
  /** Set by `finalize_build` when a direct-build ship is committed and about to open its PR inline; consumed
   *  by the turn-end latch in `runChatTurn` (records the PR + flips done promptly). */
  private readonly directBuildShipPending = new Map<string, boolean>();
  /** Per-job STABLE git target (repo url + org id) — the token/identity are re-resolved PER TURN (an app
   *  installation token expires hourly), so only the stable bits are cached here. See resolveBrainGitAuth. */
  private readonly gitTargetByJob = new Map<
    string,
    {
      gitUrl: string;
      orgId: string;
      owner: string;
      repo: string;
      defaultBranch: string;
    }
  >();
  /**
   * SESSION-scoped `Edit`/`Write` grants for skills (`request_skill_edit_access`), keyed by jobId — in-memory
   * on this manager, per `ARCHITECTURE.md`'s halt-and-resume model: the grant is recorded HOST-side when the
   * owner approves, then forwarded on every subsequent brain turn's `RunEngineArgs.grantedSkills` so the
   * in-container `canUseTool` (which has no DB/host-state access of its own) can honor it (see `engine-core.ts`
   * `makeCanUseTool`'s skill guard). Lives for the process's lifetime / this job's — like `gitTargetByJob`,
   * never explicitly cleared (a backend restart resets it; re-approval is cheap and the alternative, a durable
   * grant that survives a job's ENTIRE life, is more surface than a "for this session" grant should have).
   */
  private readonly skillEditGrantsByJob = new Map<string, Set<string>>();

  // Cache of repoId (UUID) → repo slug for the atlas-prod tool gate. A slug is stable for a repo, so it's
  // resolved once per repo and reused across turns; `null` caches a missing/failed lookup (fail-closed).
  private readonly repoSlugCache = new Map<string, string | null>();

  // Per-session dedup for memory auto-recall (d2): fact ids already injected into THIS job's current live
  // SDK session, so a re-recalled fact is surfaced once but a fresh session can see it again. The first turn
  // has no session id yet; the set is rebound when the engine emits the session event.
  private readonly injectedMemoryByJob = new Map<
    string,
    InjectedMemoryDedupState
  >();

  constructor(
    private readonly store: BrainStoreService,
    private readonly driverStore: DriverStoreService,
    // The ONE merge resolution path — re-evaluated at every turn end (a settled brain is a merge trigger).
    private readonly autoMerge: AutoMergeService,
    private readonly memory: MemoryStore,
    private readonly approvals: DecisionApprovalService,
    private readonly lifecycle: JobLifecycleService,
    // The engine runner is resolved through the ENGINE_RUNNER token (not the concrete DockerEngineRunner)
    // so the ENGINE_TRANSPORT=pipe|redis factory governs the brain's conversational turns too. See ADR 0001.
    @Inject(ENGINE_RUNNER) private readonly engineRunner: EngineRunnerPort,
    // The durable registry of in-flight Redis-transport turns — drives boot re-attach after a restart.
    private readonly turnRegistry: TurnRegistry,
    private readonly planReview: PlanReviewService,
    @Inject(JOB_DISPATCHER) private readonly dispatcher: JobDispatcher,
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    @InjectRepository(JobSandboxEntity, DB_CONNECTION)
    private readonly sandboxRows: Repository<JobSandboxEntity>,
    // Event stimuli — the at-least-once boot sweep re-delivers any seeded-but-undelivered event.
    @InjectRepository(InboundMessageEntity, DB_CONNECTION)
    private readonly stimulusRows: Repository<InboundMessageEntity>,
    // The chat-inbox delivery queries (eligible/lease/mark-delivered/undelivered/reset) — the pump
    // delegates to these so the query logic is testable without this manager's full constructor.
    private readonly stimulusStore: StimulusStoreService,
    // The shared transcript spine — builds the per-turn streamer (live frames + durable blocks).
    private readonly turnHarness: TurnHarnessFactory,
    // Fast (direct-build) path: classify always-ask decisions, resolve the repo, and ship the result.
    private readonly classifier: DecisionClassifier,
    private readonly ship: BuildShipService,
    @Inject(DRIVER_REPO) private readonly repos: DriverRepoResolver,
    // Job-to-job "blocked by" edges + the wake funnel (create_job dependsOn, link_job_dependency, manual UI).
    private readonly jobDeps: JobDependencyService,
    // Per-org engine subscription secret for the in-sandbox brain turn (the SDK harness).
    private readonly creds: CredentialResolver,
    // User-defined MCP servers resolved onto the brain turn (org/repo tiers, `brain` surface).
    private readonly mcp: McpResolver,
    // Singleton-leadership gate: boot crash-recovery sweeps + new-turn intake run only on the leader.
    private readonly election: LeaderElectionService,
    // Crash recovery: back-fill brain turns that completed in-container but never reached `finish()`.
    private readonly turnRecovery: TurnRecoveryService,
    // Repo onboarding: the encrypted per-org secret store + grants the secure `request_secret` flow writes.
    private readonly secretStore: WorkspaceSecretFileStore,
    // The org+repo-scoped mounts/seed config `write_workspace_config` writes — DB-backed (see docs/adr/0003).
    private readonly configStore: WorkspaceConfigStore,
    // Used by `finish_onboarding` to decide whether there's an actual repo diff worth shipping a PR for.
    private readonly git: LocalGitService,
    // The fragment-library assembler for the brain's system prompt (ATLAS_MAIN; onboarding is a jobKind).
    private readonly prompts: PromptService,
    // The shared send seam — the brain registers its `main`-lane transport (the durable steer/fresh-turn
    // pump) so a generic caller can `postToThread(laneFor('main', jobId), …)` without knowing it's the brain.
    private readonly threadInput: ThreadInputService,
    // Host-side subscription usage snapshot — the Main-lane session-limit park reads `getResetAt(orgId,
    // rateLimitType)` to seed the resume clock when the engine didn't surface a precise reset instant.
    // @Global OnboardingModule.
    private readonly usage: OauthUsageService,
    // The shared self-sufficiency toolset (request_secret/request_file/recall/remember) — the SAME handler
    // bodies headless build/master_review threads dispatch through (see ThreadDriverService.buildTurnBridge),
    // so there is one implementation, not two drifting copies. Plain (non-optional): the @Global BrainModule
    // always provides it.
    private readonly selfSufficiency: SelfSufficiencyToolsService,
    // Durable per-model usage/cost analytics (best-effort) for brain + compaction turns. @Optional so
    // unit tests can construct the manager without wiring analytics; DI (@Global) supplies it live.
    @Optional() private readonly usageProjector?: TurnUsageProjector,
    // Reads the `HARNESS_CHUNK_ROWS` kill-switch (default ON) — gates whether injected system_notice /
    // system_reminder chunks also persist as visible transcript rows. @Optional so unit tests can omit it
    // (undefined → default ON); DI (@Global EnvService) supplies it live.
    @Optional() private readonly env?: EnvService,
    // The repo's opt-in house-style profile — injected into the brain prompt + forwarded to build subagents.
    // @Optional so unit tests construct the manager without it (undefined → no house style injected); DI
    // (@Global ConventionsModule) supplies it live.
    @Optional() private readonly conventions?: ConventionProfileResolver,
    // The read-model over this repo's WORKSPACE PROFILE — rendered into the brain prompt each turn so the
    // brain sees what is already provisioned (mounts, setup, secrets, MCP, skills, house style) and can keep
    // it current. @Optional so unit tests construct the manager without it (undefined → snapshot omitted);
    // DI (@Global WorkspaceProfileModule) supplies it live.
    @Optional() private readonly workspaceProfile?: WorkspaceProfileService,
    // Resolves this repo's skills onto the turn (forwarded as `RunEngineArgs.skills`, rendered in-container
    // as SKILL.md). @Optional (undefined → no skills forwarded); DI (@Global SkillsModule) supplies it live.
    @Optional() private readonly skills?: SkillResolver,
    // Owner-approved `propose_skill` commits write through this. @Optional for unit tests; DI supplies live.
    @Optional() private readonly skillStore?: WorkspaceSkillStore,
    // Reads a skill's current SKILL.md body for `propose_skill`'s `priorBody` (the registry row carries no
    // content). @Optional for unit tests; DI (@Global SkillsModule) supplies it live.
    @Optional() private readonly skillFiles?: SkillFileWriter,
    // Dry-run PREVIEW of a `propose_skill_install` source (resolve the real name + overwrite conflict) — the
    // approval install path lives in the controller. @Optional for unit tests; DI (@Global SkillsModule) live.
    @Optional() private readonly skillInstaller?: SkillInstallerService,
    // Read-only for `list_mcp_servers` (the write path is the owner-gated approve endpoint). @Optional for
    // unit tests (undefined → the tool reports none); DI (@Global McpModule) supplies it live.
    @Optional() private readonly mcpStore?: McpServerStore,
    // @nestjs/schedule registry for the leader-gated chat-delivery sweep (registered on promote, deleted on
    // demote). @Optional matching this constructor's convention — always present in prod (global
    // ScheduleModule); unit tests never promote, so the sweep (and this registry) is never touched.
    @Optional() private readonly scheduler?: SchedulerRegistry,
    // The neutral driver→brain seam: this service registers itself into it on bootstrap so the driver can
    // reach these methods (openPrAtShip + the wakes) WITHOUT construct-depending on the brain (which would
    // deadlock DI — the brain constructs the driver). @Optional matching this constructor's convention —
    // the @Global BrainGatewayModule supplies it live; unit tests that never boot the seam omit it.
    @Optional() private readonly brainGateway?: BrainGateway,
    // The kind→owner reattach routing table (from @Global SandboxModule). This service claims the brain-owned
    // kinds on bootstrap so the leader watchdog can re-attach an orphaned-but-alive brain/compaction turn
    // continuously, not only at the once-per-boot sweep. @Optional matching this constructor's convention.
    @Optional() private readonly reattachRegistry?: TurnReattachRegistry,
    // Host-side JIT executor (Pillar 4) supplying the turn-prefix memory rail (d18). @Optional so unit
    // tests construct the manager without it (undefined → no rail, default render is empty anyway); the
    // @Global BrainModule supplies it live.
    @Optional() private readonly jit?: JitHostExecutor,
    // The relocated prod-diagnostics reader + gated prod-write proposer, exposed as the atlas-prod toolset —
    // ONLY on the Atlas repo itself. @Optional so unit tests construct the manager without it (undefined →
    // the tools are simply absent); DI (@Global ProdMcpModule) supplies it live.
    @Optional() private readonly prodDiagnostics?: ProdDiagnosticsService,
    // Repo rows — a light id→slug lookup for the atlas-prod tool gate (the toolset keys on the repo SLUG
    // === ATLAS_REPO_SLUG, never the repo UUID). RepoEntity is registered in brain.module's forFeature.
    // @Optional matching this constructor's convention — always present in prod; unit tests that construct
    // the manager positionally omit it (undefined → resolveRepoSlug returns null → the atlas-prod tools are
    // simply absent, fail-closed).
    @Optional()
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repoRows?: Repository<RepoEntity>,
    // Live-turn fan-out for the mid-turn "Reconnecting…" indicator during a host-backstop retry. @Optional
    // so unit tests construct the manager without it; DI (@Global LiveTurnModule) supplies it live.
    @Optional() private readonly liveTurns?: LiveTurnStore,
    // Resolves the job's planning thread group thread id — the anchor every brain-lane turn's durable blocks are
    // stamped onto (`messages.thread_id` is NOT NULL). @Optional matching this constructor's convention;
    // the @Global JobBootstrapModule supplies it live.
    @Optional() private readonly jobBootstrap?: JobBootstrapService,
    // @Optional so unit tests can construct the manager without it (undefined → the `__profile_awareness`
    // tool is a silent no-op); DI (the @Global WorkspaceProfileModule) supplies it live.
    @Optional() private readonly profileAwareness?: ProfileAwarenessService,
    // The durable task store behind `task_create`/`task_update`/`task_list`/`task_get`. A default (not
    // @Optional) lets the many positional `new AgentSessionManager(...)` test call sites keep compiling
    // without reaching this param; DI (@Global LiveTurnModule) supplies the real EntityTaskEventSink live.
    @Inject(TASK_EVENT_SINK)
    private readonly taskSink: TaskEventSink = NOOP_TASK_EVENT_SINK,
    // The extracted leaf tool-builder surface (intake/skills/MCP/conventions/finish_onboarding + the decision
    // record + answered-card helpers), delegated to from `buildTools`. @Optional so the many positional
    // `new AgentSessionManager(...)` test call sites keep compiling without reaching this param; the @Global
    // BrainModule supplies it live. When absent (tests), `buildTools` self-builds an equivalent from this
    // manager's own injected deps (same handler bodies, so behavior is identical).
    @Optional() private readonly chatTools?: ChatToolProvider,
  ) {}

  /** Test-only fallback for the extracted tool surface: the positional-construction unit/int tests never
   *  pass `chatTools`, so build one lazily from this manager's own deps (the exact deps the moved methods
   *  used before extraction). In prod DI always supplies `this.chatTools`, so this never runs. */
  private fallbackChatTools?: ChatToolProvider;
  private get chatToolProvider(): ChatToolProvider {
    if (this.chatTools) return this.chatTools;
    return (this.fallbackChatTools ??= new ChatToolProvider(
      this.store,
      this.lifecycle,
      this.ship,
      this.secretStore,
      this.configStore,
      this.git,
      this.selfSufficiency,
      this.repos,
      this.conventions,
      this.mcpStore,
      this.skillStore,
      this.skillFiles,
      this.skillInstaller,
    ));
  }

  /** The job's planning thread group thread id — the anchor every brain-lane turn's durable blocks are stamped
   *  onto. Wired in prod via DI; throws loudly if the @Optional dependency is somehow absent at use. */
  private async planningThreadId(jobId: string): Promise<string> {
    if (!this.jobBootstrap)
      throw new Error('agent-session-manager: JobBootstrapService not wired');
    return this.jobBootstrap.planningThreadId(jobId);
  }

  /**
   * Resolve the git auth the brain's turns use to fetch/push/merge against the remote from inside the
   * sandbox. The repo url + org id are STABLE for a job, so they're resolved once (via the RESOLVED repo —
   * never `sandbox`, whose row-sourced form carries an empty `gitUrl`/no token) and cached in
   * `gitTargetByJob`. The TOKEN (and, for app-mode orgs, the App bot commit identity) is re-resolved on
   * EVERY call instead: an installation token expires hourly, so pinning it per job would push with a dead
   * token on a long-running session. Re-resolution is cheap — the credential resolver memoizes the minted
   * token (a Map hit unless near expiry). Best-effort: on failure returns undefined (and does NOT cache the
   * target), so remote git ops fail closed via `GIT_TERMINAL_PROMPT=0` and a later turn retries.
   */
  private async resolveBrainGitAuth(
    jobId: string,
  ): Promise<GitAuth | undefined> {
    try {
      let target = this.gitTargetByJob.get(jobId);
      if (!target) {
        const job = await this.store.loadJob(jobId);
        const repo = await this.repos.resolve(job);
        const gitUrl = repo.projectRepo.gitUrl;
        if (!gitUrl) return undefined;
        target = {
          gitUrl,
          orgId: job.orgId,
          owner: repo.owner,
          repo: repo.repo,
          defaultBranch: repo.defaultBranch,
        };
        this.gitTargetByJob.set(jobId, target);
      }
      const token = await this.creds.githubToken(target.orgId);
      // Optional-call: test fakes/older CredentialResolver stand-ins may predate this method — default
      // 'pat' (today's behavior) rather than throwing mid-turn.
      const mode = (await this.creds.githubAuthMode?.(target.orgId)) ?? 'pat';
      const { identity, apiToken } = await this.creds.githubWriteIdentity(
        target.orgId,
      );
      return {
        gitUrl: target.gitUrl,
        mode,
        ...(token ? { token } : {}),
        ...(apiToken ? { apiToken } : {}),
        ...(identity ? { identity } : {}),
      };
    } catch (err) {
      this.logger.warn(
        `brain git auth resolve failed for job ${jobId} (remote git disabled this turn): ${err}`,
      );
      return undefined;
    }
  }

  /**
   * Register the leader-only boot crash-recovery sweeps. These are SINGLETON repair operations (they
   * reset `turn_active` flags and re-drive dropped deliveries), so they must run ONLY on the instance
   * that holds leadership — never on a standby that booted while another instance is still live. The
   * drain-then-release invariant guarantees promotion happens only after any predecessor has fully
   * drained, so the sweeps never collide with in-flight work. `onPromote` fires immediately if this
   * instance is already leader.
   */
  onApplicationBootstrap(): void {
    // Register THIS brain as the handler behind the neutral driver→brain gateway, so the driver's
    // openPrAtShip / thread-halt / thread-done / provisioning-failure calls forward here — without the
    // driver construct-depending on the brain (which would deadlock DI).
    this.brainGateway?.bind(this);

    // Register the two input-accepting thread transports on the shared send seam, so a generic caller can
    // `postToThread(lane, ctx, message)` without knowing the kind. Delivery is UNCHANGED — the seam just
    // routes to these existing paths (see `ThreadInputService`).
    //
    // `main` (a chat turn to the brain): persist the message as a durable chat stimulus, then hand it to the
    // same at-least-once pump the web composer uses (steer a live turn / coalesce into a fresh one). A real
    // operator post carries `author`; a programmatic post omits it and falls back to `System`.
    this.threadInput.register('main', {
      post: async ({ jobId, orgId, repoId, author }, message) => {
        const recorded = await this.stimulusStore.recordChatStimulus({
          orgId,
          repoId,
          jobId,
          author: author ?? { id: 'U-SYSTEM', displayName: 'System' },
          replyRoute: { surfaceId: 'web', jobRef: jobId },
          body: message,
        });
        await this.enqueueChat(recorded);
      },
    });
    // NOTE: the `codex-review` thread-input transport was removed — Codex review is now Atlas-driven only
    // (the synchronous `review_plan` tool), so there is no external "post a rebuttal to Codex" path.
    // Claim the brain-owned kinds on the reattach routing table so the leader watchdog can re-attach an
    // orphaned-but-alive brain/compaction turn continuously (see `reattachTurnRow`), not only at the
    // once-per-boot `reattachOwnedTurns` sweep. Unconditional + idempotent (the watchdog is leader-only).
    for (const kind of ['brain', 'compaction'] as const) {
      this.reattachRegistry?.register(kind, (row) => this.reattachTurnRow(row));
    }

    this.leaderBootSub = this.election.onPromote(() =>
      this.runLeaderBootSweeps(),
    );
    // Leader-only periodic chat-delivery sweep: re-drive any operator message still undelivered (an
    // unacked steer, a fresh turn that never registered). Started on promote, stopped on demote/shutdown.
    this.chatSweepPromoteSub = this.election.onPromote(() =>
      this.startChatDeliverySweep(),
    );
    this.chatSweepDemoteSub = this.election.onDemote(() =>
      this.stopChatDeliverySweep(),
    );
  }

  onApplicationShutdown(): void {
    this.leaderBootSub?.unsubscribe();
    this.chatSweepPromoteSub?.unsubscribe();
    this.chatSweepDemoteSub?.unsubscribe();
    this.stopChatDeliverySweep();
  }

  private startChatDeliverySweep(): void {
    // Prod always injects the scheduler (global ScheduleModule); unit tests omit it and never promote, so the
    // sweep is a no-op there. Guard so an absent registry can't throw.
    if (!this.scheduler) return;
    if (this.scheduler.doesExist('interval', CHAT_SWEEP_INTERVAL)) return;
    const iv = setInterval(() => {
      void this.sweepUndeliveredChat();
      // Same leader cadence re-drives any routed GitHub event whose brain delivery never landed (a steer
      // swallowed by a finishing turn, or a fresh turn that never registered). Events get the SAME periodic
      // at-least-once backstop as operator chat — not just the once-per-boot sweep. Leader-guarded.
      void this.sweepUndeliveredEvents();
      // Same leader cadence re-drives WORK-OWED Codex reviews (a `review_plan` stranded `running` after its
      // brain turn was finalized on the non-detached path — reattach can't recover it). Leader-guarded.
      void this.reconcileWorkOwedReviews();
    }, CHAT_SWEEP_INTERVAL_MS);
    iv.unref?.(); // never keep the process alive (SchedulerRegistry does not unref for us)
    this.scheduler.addInterval(CHAT_SWEEP_INTERVAL, iv);
  }

  private stopChatDeliverySweep(): void {
    // deleteInterval clears the interval AND removes it from the registry.
    if (this.scheduler?.doesExist('interval', CHAT_SWEEP_INTERVAL)) {
      this.scheduler.deleteInterval(CHAT_SWEEP_INTERVAL);
    }
  }

  /** The leader-only boot sweeps, run ONCE on first promotion. Each step is independently best-effort. */
  private async runLeaderBootSweeps(): Promise<void> {
    // Guard against a mid-life re-promote (lock lost+regained on a blip): re-running resetAllTurnActive
    // would clear `turn_active` for turns CURRENTLY executing on this process, making them look idle.
    if (this.bootSweepsDone) return;
    this.bootSweepsDone = true;

    // 1) Reset any non-idle `activity` left set by a crash mid-work — re-attach (below) re-sets it for any
    //    turn it resumes, so a leftover flag on a non-resumable thread is stale and would suppress its
    //    "needs you" dot.
    try {
      const reset = await this.store.resetAllActivity();
      if (reset > 0)
        this.logger.log(`Leader: reset stale activity on ${reset} thread(s)`);
    } catch (err) {
      this.logger.warn(`activity reconciliation failed: ${err}`);
    }

    // 2) RE-ATTACH every interrupted turn this service owns (brain + compaction — same discipline as the
    //    driver's build turns). Redis is the only transport: each engine kept running detached and is still
    //    writing its durable streams, so a fresh backend resumes tailing and completes it per kind (brain →
    //    persist transcript; compaction → reseed). Live, lossless restart-survival. See ADR 0001.
    try {
      await this.reattachOwnedTurns();
    } catch (err) {
      this.logger.warn(`redis turn re-attach failed: ${err}`);
    }

    // 2) Backfill any question the operator ANSWERED (durably stamped) but whose delivery turn a host crash
    //    dropped before it reached the brain — onto the DURABLE pump: create the `stimuli` row (unless one is
    //    already live) and let the 30 s chat sweep own recovery. One owner (the sweep) removes the old
    //    boot-vs-sweep double-delivery window; pre-deploy stuck cards get pulled onto the durable path.
    try {
      const pending = await this.store.findUndeliveredAnsweredQuestions();
      if (pending.length > 0) {
        this.logger.log(
          `Leader: backfilling ${pending.length} answered-but-undelivered question(s) onto the durable pump`,
        );
        for (const q of pending) {
          void this.backfillSeedDelivery({
            jobId: q.jobId,
            orgId: q.orgId,
            repoId: q.repoId,
            body: frameAnswer(q.question, q.answer),
            // Same content-stable key + label as the live `/answer-question` path ⇒ one visible pill.
            seedRow: {
              label: `The operator answered your question ${JSON.stringify(q.question)}: ${q.answer}`,
              chunkKey: chunkKey.qa(q.jobId, q.questionId),
            },
            type: 'answer_question',
            seedQuestionId: q.questionId,
          }).catch((err) =>
            this.logger.warn(
              `question backfill failed for thread=${q.jobId}: ${err}`,
            ),
          );
        }
      }
      // Heal the denormalized open-question counter from the actual unanswered cards, so a crash mid-
      // open/answer can't leave the needs-you signal wedged the way the old single slot could.
      await this.store.reconcileOpenQuestionCounts();
    } catch (err) {
      this.logger.warn(`question-delivery reconciliation failed: ${err}`);
    }

    // Heal the denormalized open-secret counter from the actual open durable/mcp secret cards, mirroring the
    // open-question heal above (ephemeral cards use the single-slot pointer, not this counter, and are excluded).
    try {
      await this.store.reconcileOpenSecretCounts();
    } catch (err) {
      this.logger.warn(`open-secret-count reconciliation failed: ${err}`);
    }

    // 2b) Backfill any secret the operator PROVIDED (value durably stored + granted) but whose masked
    //     confirmation turn a crash dropped before it reached the brain — onto the durable pump, same shape as
    //     the answered-question backfill. The value is NOT carried, only the masked name/path notice.
    //     `seedSecretId` ties the delivery to stamping THAT secret card delivered + clearing the gate.
    try {
      const pendingSecrets = await this.store.findUndeliveredProvidedSecrets();
      if (pendingSecrets.length > 0) {
        this.logger.log(
          `Leader: backfilling ${pendingSecrets.length} provided-but-undelivered secret(s) onto the durable pump`,
        );
        for (const s of pendingSecrets) {
          const notice = maskedSecretNotice(s.name, {
            ...(s.path ? { path: s.path } : {}),
            ...(s.ephemeral ? { ephemeral: true } : {}),
            ...(s.mcp ? { mcp: s.mcp } : {}),
          });
          void this.backfillSeedDelivery({
            jobId: s.jobId,
            orgId: s.orgId,
            repoId: s.repoId,
            body: wrapSystemNotification(notice),
            // Same content-stable key as the live provide-secret path ⇒ one visible pill.
            seedRow: {
              label: notice,
              chunkKey: chunkKey.secret(s.jobId, s.name),
            },
            type: 'secret_provided',
            seedSecretId: s.requestId,
          }).catch((err) =>
            this.logger.warn(
              `secret backfill failed for thread=${s.jobId}: ${err}`,
            ),
          );
        }
      }
    } catch (err) {
      this.logger.warn(`secret-delivery reconciliation failed: ${err}`);
    }

    // 2c) Backfill any FILE the operator uploaded (contents durably stored + granted) but whose masked
    //     confirmation turn a crash dropped — onto the durable pump. Per-card (no thread pointer), so the seed
    //     MUST carry the file card id (`seedFileId`) for the delivery tail to stamp exactly that card delivered.
    try {
      const pendingFiles = await this.store.findUndeliveredProvidedFiles();
      if (pendingFiles.length > 0) {
        this.logger.log(
          `Leader: backfilling ${pendingFiles.length} provided-but-undelivered file(s) onto the durable pump`,
        );
        for (const f of pendingFiles) {
          const notice = maskedFileNotice(f.path);
          void this.backfillSeedDelivery({
            jobId: f.jobId,
            orgId: f.orgId,
            repoId: f.repoId,
            body: wrapSystemNotification(notice),
            // Same content-stable key as the live provide-file path ⇒ one visible pill.
            seedRow: {
              label: notice,
              chunkKey: chunkKey.file(f.jobId, f.path),
            },
            type: 'file_answered',
            seedFileId: f.requestId,
          }).catch((err) =>
            this.logger.warn(
              `file backfill failed for thread=${f.jobId}: ${err}`,
            ),
          );
        }
      }
    } catch (err) {
      this.logger.warn(`file-delivery reconciliation failed: ${err}`);
    }

    // 3) Codex-review WORK-OWED reconciliation: a `review_plan` that was interrupted on the non-detached
    //    finalize path (alive-grace/watchdog `del()` wipes the tool-bridge streams, so reattach can't
    //    re-dispatch it) leaves a `codex_reviews` row stuck `running`. Re-drive those jobs' brains once so
    //    Atlas re-invokes review_plan (which resumes the Codex session from the row). Same leader/live-turn/
    //    pending-chat guards as the periodic pass — see reconcileWorkOwedReviews.
    await this.reconcileWorkOwedReviews();

    // Event-delivery reconciliation (same durable-inbox at-least-once shape as operator chat): a routed event
    // is a `stimuli` row (kind='event') persisted at intake; `delivered_at` is stamped only on a positive
    // brain hand-off (engine `input_ack` for a steer, or the fresh turn's registration). Clear leases first
    // (a row mid-attempt at crash never reached a stamping hand-off), then pump every undelivered event. The
    // pump steers a re-attached live turn or runs a fresh one; the periodic sweep keeps re-driving after boot.
    try {
      await this.stimulusStore.resetEventLeases();
      const events = await this.stimulusStore.eligiblePendingEvents(
        AgentSessionManager.CHAT_DELIVERY_LEASE_MS,
      );
      if (events.length > 0) {
        this.logger.log(
          `Leader: re-driving ${events.length} seeded-but-undelivered event(s)`,
        );
        for (const ev of events) {
          void this.pumpEvent(ev).catch((err) =>
            this.logger.warn(
              `boot event re-drive failed for stimulus=${ev.id}: ${err}`,
            ),
          );
        }
      }
    } catch (err) {
      this.logger.warn(`event-delivery reconciliation failed: ${err}`);
    }

    // Operator-chat delivery reconciliation (the durable-inbox at-least-once boot half): a plain operator
    // message is a `stimuli` row persisted at intake; `delivered_at` is stamped only on a positive brain
    // hand-off. Clear leases first (a row mid-attempt at crash never reached the registered hand-off — a
    // registered turn would have stamped it), then pump every thread with an undelivered message. The pump
    // steers a re-attached live turn or runs a fresh one; the periodic sweep keeps re-driving after boot.
    try {
      await this.stimulusStore.resetChatLeases();
      const lanes = await this.stimulusStore.undeliveredChatLanes();
      if (lanes.length > 0) {
        this.logger.log(
          `Leader: re-driving undelivered operator message(s) across ${lanes.length} lane(s)`,
        );
        for (const t of lanes) {
          void this.pumpThread(t.jobId, t.orgId, t.repoId, t.lane).catch(
            (err) =>
              this.logger.warn(
                `boot chat re-drive failed for thread=${t.jobId}: ${err}`,
              ),
          );
        }
      }
    } catch (err) {
      this.logger.warn(`chat-delivery reconciliation failed: ${err}`);
    }

    // GROUND-TRUTH JSONL backstop (LAST — runs after Redis re-attach so it only sweeps up turns the primary
    // path missed). Back-fills any brain turn present in a thread's SDK session JSONL but absent from
    // `messages` — e.g. a mid-turn interrupt the watchdog finalized before re-attach, or one superseded by a
    // new operator prompt. Skips threads with a live Redis turn (see `TurnRecoveryService.candidateThreadIds`)
    // so it can never race re-attach's own persist. Best-effort, fail-soft.
    try {
      const recovered = await this.turnRecovery.recoverInterruptedTurns();
      if (recovered > 0)
        this.logger.log(
          `Leader: JSONL backstop back-filled ${recovered} lost turn(s)`,
        );
    } catch (err) {
      this.logger.warn(`JSONL turn-recovery backstop failed: ${err}`);
    }
  }

  /**
   * SERVER-INITIATED open-PR seed (the ship step). ENQUEUES the ship turn-prompt (reconcile the branch
   * against its base → push → author the PR body → `gh pr create`) onto the job's `ci` stage-thread lane
   * via the durable pump — it does NOT run the turn inline, so it returns as soon as the seed is persisted
   * and serializes behind any live post_build turn on the per-job queue. The brain runs it in ITS OWN sandbox
   * on the feature branch with its already-resolved engine auth + git auth, and the HOST records the opened PR
   * afterward by branch discovery (`BuildShipService.latchPr` / the git-state reconciler), so this needs no
   * `report_pr_opened` tool. Idempotent: a re-seed on an already-open PR just `gh pr edit`s (dedup by chunkKey).
   */
  async openPrAtShip(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    branch: string;
    defaultBranch: string;
    title: string;
    threadId: string;
  }): Promise<void> {
    const recorded = await this.stimulusStore.recordChatStimulus({
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      author: {
        id: SYSTEM_SEED_AUTHOR.id,
        displayName: SYSTEM_SEED_AUTHOR.name,
      },
      replyRoute: { surfaceId: 'web', jobRef: input.jobId },
      body: shipOpenPrBody({
        branch: input.branch,
        defaultBranch: input.defaultBranch,
        title: input.title,
      }),
      lane: `thread:${input.threadId}`,
      systemChunk: {
        label: 'Opening the pull request.',
        chunkKey: `seed:ship:${input.jobId}`,
      },
    });
    await this.enqueueChat(recorded);
  }

  /**
   * ESCALATE any still-undelivered build-lane host seed at thread end (spec step 6, d2). When a thread
   * reaches its final Leg terminal its build lane (`thread:<threadId>`) may still hold pending host seeds —
   * `queue`/`later` rows that never drained, or a `now` seed whose steer was swallowed. Re-key each onto the
   * `main` lane (leaving `delivered_at` NULL, never stamped here) with its origin labeled, so the brain's
   * existing main pump/sweep (`sweepUndeliveredChat`) delivers them at-least-once. This intentionally ignores
   * the normal delivery lease: a recently-attempted seed is still undelivered at terminal teardown, and the
   * build lane may never run again. Deliberately does NOT touch the done/halt wake body: a wake is dropped
   * whenever `handleChatTurn` early-returns (draining / blocked job), and a body mutation would then be lost
   * right alongside a premature delivered-stamp — re-keying is durable on its own and needs no wake to succeed.
   */
  private async escalateBuildLaneLeftovers(
    jobId: string,
    threadId: string,
  ): Promise<void> {
    const leftovers = await this.stimulusStore
      .undeliveredChatForLane(jobId, laneFor('builder', threadId))
      .catch(() => [] as TurnEnvelope[]);
    for (const s of leftovers) {
      const labeled = `Undelivered host seed from build thread ${threadId}: ${s.body}`;
      await this.stimulusStore
        .rekeyLaneToMain(s.id, labeled)
        .catch((err) =>
          this.logger.warn(
            `build-lane escalation re-key for ${s.id} failed (thread=${threadId}): ${err}`,
          ),
        );
    }
  }

  /**
   * WAKE a job whose block just cleared (every blocker reached a terminal state). Born-blocked jobs
   * (a create_job dependsOn that never started) replay their stored seed as the first turn; a job that
   * was manually blocked while it already had a session resumes that session with a synthetic wake
   * stimulus. `blockers` names each job that was holding this one (and how it resolved), so each variant can
   * name them and reorient: the born-blocked seed gets a fresh-start prefix, the resumed session a
   * rebase/re-scope nudge. Fire-and-forget (the JobUnblockSweep is the retry); concurrency-safe via
   * handleChatTurn/startFollowUpJob.
   */
  async wakeUnblockedJob(
    jobId: string,
    orgId: string,
    repoId: string,
    input: { seed: string | null; blockers: UnblockBlockerInfo[] },
  ): Promise<void> {
    if (input.seed != null) {
      const firstMessage =
        input.blockers.length > 0
          ? `${renderBornBlockedUnblockPrefix(input.blockers)}\n\n${input.seed}`
          : input.seed;
      await this.startFollowUpJob(jobId, orgId, repoId, firstMessage);
      return;
    }
    const stimulus = seedEnvelope({
      ...seedBase({ jobId, orgId, repoId }),
      type: 'unblocked_job_wake',
      blockers: input.blockers,
    });
    await this.handleChatTurn(stimulus);
  }

  /**
   * WAKE the job brain because the operator APPROVED its "Amend build?" proposal (the `withdraw_ship`
   * tool's card). By this point the operator retract path has already run (`awaiting_ship_review →
   * amending`), so the brain just needs to do the follow-up work it proposed. Delivered durably onto the
   * job's `post_build` stage-thread session (resolved, or spawned as a fallback) via the pump — non-blocking
   * so the amend-approve HTTP path returns immediately. Once the amend is done the job is re-parked at the
   * ship-review gate (`amending → awaiting_ship_review`, no rebuild).
   */
  async wakeForAmendApproved(jobId: string): Promise<void> {
    const job = await this.store.loadJob(jobId).catch(() => null);
    if (!job) return;
    const threadId =
      (await this.driverStore.postBuildThreadId(jobId)) ??
      (
        await this.driverStore.ensurePostBuildThread({
          jobId,
          orgId: job.orgId,
          decisionRecordId: job.decisionRecordId ?? null,
        })
      ).threadId;
    const recorded = await this.stimulusStore.recordChatStimulus({
      orgId: job.orgId,
      repoId: job.repoId,
      jobId,
      author: {
        id: SYSTEM_SEED_AUTHOR.id,
        displayName: SYSTEM_SEED_AUTHOR.name,
      },
      replyRoute: { surfaceId: 'web', jobRef: jobId },
      body: wakeForAmendApprovedBody(),
      lane: `thread:${threadId}`,
      systemChunk: {
        label: 'Amend approved — resuming to make the changes.',
        chunkKey: `seed:amend-approved:${jobId}`,
      },
    });
    await this.enqueueChat(recorded);
  }

  /**
   * SEED the operator "Spin up preview" request onto the job's `post_build` stage-thread session (d14). Runs
   * the preview-prep prompt (author a preview recipe / spin the preview up) on the fresh post_build session,
   * NOT planning. Durable + non-blocking: the request is persisted then enqueued via the pump, so the HTTP
   * handler returns immediately and a crash re-drives the seed. Falls back to spawning the post_build thread
   * if the gate somehow skipped it. Idempotent per job via the `preview` chunkKey.
   */
  async seedPreviewOnPostBuild(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    previewInstructions: string | null;
  }): Promise<void> {
    const job = await this.store.loadJob(input.jobId).catch(() => null);
    const threadId =
      (await this.driverStore.postBuildThreadId(input.jobId)) ??
      (
        await this.driverStore.ensurePostBuildThread({
          jobId: input.jobId,
          orgId: input.orgId,
          decisionRecordId: job?.decisionRecordId ?? null,
        })
      ).threadId;
    const recorded = await this.stimulusStore.recordChatStimulus({
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      author: {
        id: SYSTEM_SEED_AUTHOR.id,
        displayName: SYSTEM_SEED_AUTHOR.name,
      },
      replyRoute: { surfaceId: 'web', jobRef: input.jobId },
      body: composePreviewPrepSeed(input.previewInstructions),
      lane: `thread:${threadId}`,
      systemChunk: {
        label: 'Spin up preview requested',
        chunkKey: chunkKey.preview(input.jobId),
      },
    });
    await this.enqueueChat(recorded);
  }

  /**
   * SEED the ship-review-gate initial message onto the job's `post_build` stage-thread session. Called once,
   * right after the driver's gate-park transition (`ThreadDriver.parkForShipReview`), which by then has
   * already ensured the post_build thread exists — this only delivers its opening turn. Durable + idempotent
   * per job via the `gate` chunkKey, so a re-drive of the park can't re-seed it twice.
   */
  async seedPostBuildGate(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    threadId: string;
  }): Promise<void> {
    const recorded = await this.stimulusStore.recordChatStimulus({
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      author: {
        id: SYSTEM_SEED_AUTHOR.id,
        displayName: SYSTEM_SEED_AUTHOR.name,
      },
      replyRoute: { surfaceId: 'web', jobRef: input.jobId },
      body: postBuildGateSeed(),
      lane: `thread:${input.threadId}`,
      systemChunk: {
        label: 'Build ready — review at the ship gate',
        chunkKey: chunkKey.gate(input.jobId),
      },
    });
    await this.enqueueChat(recorded);
  }

  // ── Public API ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Handle one chat stimulus in a scoping thread. SERIALIZED per thread: if a turn is already running for
   * this thread (the operator sent a follow-up while it was thinking), this one queues behind it and runs
   * after — never two concurrent engine turns resuming the same session id. Runs an in-sandbox engine
   * turn with the 6 host-side tools; the session is resumed across turns.
   */
  async handleChatTurn(stimulus: TurnEnvelope): Promise<void> {
    // Drain gate: once this instance is draining (SIGTERM), accept NO new turns. Operator turns are
    // already rejected with 503 at the surface; this catches internal/boot re-delivery callers so the
    // in-flight set can actually quiesce. A no-op (not a throw) — internal callers are fire-and-forget.
    if (this.election.getState() === 'draining') return;

    // A dependency-blocked job is fully parked: no system wake/re-drive should start its brain until the
    // dependency service first flips it back to `open`.
    if (await this.isJobBlocked(stimulus.jobId)) {
      this.logger.log(
        `job=${stimulus.jobId} is blocked; dropping system turn until it is unblocked`,
      );
      return;
    }

    // Render this harness seed as a visible transcript row (the console mirrors the agent's turns — every
    // seed the brain reads must be legible). Runs whether the seed steers into a live turn or spawns a
    // fresh one; dedup-protected, so live + boot re-delivery collapse to one row. See {@link persistSeedRow}.
    this.persistSeedRow(stimulus);

    // NOTE: plain operator chat no longer enters here — it rides the durable delivery pump (`enqueueChat`
    // → `pumpThread`), which owns the steer-vs-fresh-turn decision AND the delivered/sweep guarantee. This
    // method now serves only SYSTEM turns (seeds, event/harness deliveries).
    //
    // STEER-VS-FRESH-TURN for seeds too: if a brain turn is ALREADY live for this job, steer this stimulus
    // straight into it (a mid-turn user message) instead of spawning a SECOND turn on the same session — the
    // "answers don't steer, they spawn a parallel turn" bug. This is also how N queued answers all reach the
    // brain "in one go": each steers into the one live turn. A reset-verify no-op seed is EXEMPT — it must
    // run its own (guarded) turn so its fresh-container cold-attach semantics are unchanged. The DB-level
    // single-brain-turn guard (`register` → `BrainTurnAlreadyRunningError`) backstops the check→queue race.
    if (
      !isStandaloneSeed(stimulus.message.type) &&
      (await this.steerIntoLiveBrainTurn(stimulus).catch((err) => {
        this.logger.warn(
          `steer-into-live pre-check failed for job=${stimulus.jobId}: ${err}`,
        );
        return false;
      }))
    ) {
      return;
    }

    const key = `${stimulus.orgId}:${stimulus.jobId}`;
    const prev = this.turnQueues.get(key) ?? Promise.resolve();
    // Chain after any in-flight turn (swallow its error so a failed turn doesn't break the queue).
    const next = prev
      .catch(() => undefined)
      .then(() => this.runChatTurn(stimulus));
    // Thread this as the tail; clear the map entry once it settles IF nothing newer queued behind it.
    this.turnQueues.set(
      key,
      next.finally(() => {
        if (this.turnQueues.get(key) === next) this.turnQueues.delete(key);
      }),
    );
    return next;
  }

  /**
   * If a brain turn is ALREADY live for this stimulus's job, steer the stimulus straight into it — a queued
   * user message injected mid-turn (the engine's `priority:'now'`) — and report handled, so the caller does
   * NOT spawn a second turn on the same session. This is the single-running-turn guarantee at delivery time
   * (the DB unique index is the hard backstop for the check→register race) AND how several queued answers all
   * reach the brain "in one go": each steers into the one live turn. Returns false when there is no live turn
   * or the runner can't steer (the caller then runs its own turn). The steer id is the stimulus id, so a
   * card-answer seed also stamps its card `deliveredAt` on success (the XADD is durable → this IS delivery;
   * the answered card then stops re-surfacing in `<open-questions>` and the boot re-seed sweep skips it).
   */
  /**
   * The engine-facing string for a stimulus's BODY (no turn-level notice/reminder prefixes — those are
   * added once, in `runChatTurnInner`). A human (operator) message is wrapped in a `<user name at>` tag
   * reconstructed from the author fields AT TURN TIME (the persisted body stays clean, so a replayed
   * stimulus frames identically); a coalesced turn carries one `<user>` chunk per message via `chunks`.
   * Seeds / synthetic Atlas turns already carry framed bodies (`<system_notice>`, event/halt framing) —
   * pass through untouched.
   */
  private engineBody(stimulus: TurnEnvelope): string {
    if (!isOperatorAuthored(stimulus)) return stimulus.body;
    if (stimulus.chunks?.length) return renderTurn(stimulus.chunks);
    return renderTurn([userChunkFor(stimulus)]);
  }

  /**
   * Persist THIS turn's injected system_notice / system_reminder chunks as visible transcript rows (behind
   * the `HARNESS_CHUNK_ROWS` kill-switch, default ON). Each row is backdated to sort just BEFORE the message
   * it rode with (history orders by `created_at ASC`; the operator row is already committed at ≈ receivedAt),
   * notices before reminders. Best-effort + insert-once (by `chunkKey`, inside the store) — a failure or a
   * re-drive never affects the turn. Missing on unit-test store mocks → optional-chained no-op.
   */
  /**
   * Render a harness SEED as a visible transcript row — the Command handler for {@link SeedRow}. The console
   * mirrors the agent's turns, so every seed the brain receives must be legible now that the raw
   * `agent_prompt` snapshot is not shown on Main. Cases: a descriptor → a curated `system_notice`/`untrusted`
   * pill; `'skip'` → the content already has a durable row (an event body); ABSENT → a generic fallback pill,
   * so a newly-added seed can never be silently invisible. Gated to genuine harness seeds (SYSTEM_SEED_AUTHOR,
   * not the reset-verify no-op). Dedup-protected by the descriptor's content-stable `chunkKey` (the generic
   * fallback keys on a body hash), so live delivery + the boot re-delivery sweep collapse to ONE row.
   * Fail-soft — best-effort like {@link persistChunkRows}.
   */
  private persistSeedRow(stimulus: TurnEnvelope): void {
    if (stimulus.author.id !== SYSTEM_SEED_AUTHOR.id) return; // harness seeds only
    if (stimulus.message.type === 'reset_verify') return; // reset already rides a notice chunk row
    const desc = stimulus.seedRow;
    if (desc === 'skip') return; // content already has a durable row elsewhere
    const row: Exclude<SeedRow, 'skip'> = desc ?? {
      label: 'A harness system notification was delivered to Atlas.',
      chunkKey: `seed:generic:${stimulus.jobId}:${createHash('sha1').update(stimulus.body).digest('hex').slice(0, 16)}`,
    };
    // Carry the raw payload the engine actually received so the console can reveal it on row-expand — but
    // only when it differs from the short `label` (curated notices whose label already IS the full body
    // don't need a redundant copy). See decision d1/d2.
    const isUntrusted = (row.kind ?? 'system_notice') === 'untrusted';
    // Untrusted rows: `label` already IS the clean fenced report and the trusted framing rides in
    // `row.framing` (its own block) — so DON'T fold the whole engine body (framing+fence) into fullBody.
    const fullBody =
      !isUntrusted && stimulus.body !== row.label ? stimulus.body : undefined;
    void this.store
      .recordSystemChunk?.({
        jobId: stimulus.jobId,
        kind: row.kind ?? 'system_notice',
        text: fromExternal(row.label),
        chunkKey: row.chunkKey,
        ...(row.untrustedSource
          ? { untrustedSource: row.untrustedSource }
          : {}),
        ...(row.severity ? { severity: row.severity } : {}),
        ...(fullBody ? { fullBody: fromExternal(fullBody) } : {}),
        ...(row.framing ? { framing: row.framing } : {}),
        // Frontend per-seed-type pill discriminant (mirrors `meta.eventKind`); skip the type-less legacy
        // `'seed'`/operator `'user'` values, which carry no per-type presentation.
        ...(stimulus.message.type !== 'user'
          ? { seedType: stimulus.message.type }
          : {}),
      })
      ?.catch((err: unknown) =>
        this.logger.debug(`persistSeedRow failed (best-effort): ${err}`),
      );
  }

  private persistChunkRows(
    stimulus: TurnEnvelope,
    notices: TurnChunk[],
    reminders: TurnChunk[],
  ): void {
    if (this.env?.get('HARNESS_CHUNK_ROWS') === 'off') return;
    const ordered = [...notices, ...reminders];
    const anchorMs = stimulus.receivedAt.getTime();
    ordered.forEach((chunk, i) => {
      const createdAt = new Date(anchorMs - (ordered.length - i));
      void this.store
        .recordSystemChunk?.({
          jobId: stimulus.jobId,
          kind: chunk.kind as 'system_notice' | 'system_reminder',
          text: fromExternal(chunk.body),
          chunkKey: `brain:${stimulus.id}:${chunk.kind}:${i}`,
          ...(chunk.attrs?.reminderKind
            ? { reminderKind: chunk.attrs.reminderKind }
            : {}),
          createdAt,
        })
        ?.catch((err: unknown) =>
          this.logger.debug(`recordSystemChunk failed (best-effort): ${err}`),
        );
    });
  }

  private async steerIntoLiveBrainTurn(
    stimulus: TurnEnvelope,
  ): Promise<boolean> {
    if (typeof this.engineRunner.steer !== 'function') return false;
    const live = await this.turnRegistry
      .runningBrainTurn(stimulus.jobId)
      .catch(() => null);
    if (!live?.turn_id) return false;
    // `runningBrainTurn` returns the job's ONE live brain turn across all its lanes/sessions. Never cross-steer
    // a stimulus into a turn on a different lane (e.g. a `ci` seed into a live `post_build` turn) — leave the
    // durable row pending for that lane's own pump/sweep once this turn ends and the `active_turns` row clears.
    if (this.activeTurnLane(live) !== this.laneForStimulus(stimulus))
      return false;
    try {
      await this.engineRunner.steer(
        live.turn_id,
        stimulus.id,
        this.engineBody(stimulus),
      );
    } catch (err) {
      // A live turn exists but the steer XADD failed (transient). Report handled anyway — falling back to a
      // fresh turn would just hit the single-turn guard. A dropped card-answer self-heals: the boot re-seed
      // sweep re-drives an answered-but-undelivered card.
      this.logger.warn(
        `steer into live turn ${live.turn_id} failed for job=${stimulus.jobId}: ${err}`,
      );
      return true;
    }
    // Legacy IN-MEMORY seeds (no durable `stimuli` row) stamp their card here on XADD success. A DURABLE
    // seed-card row must NOT — the steer id equals its `stimuli.id`, so the engine `input_ack` → `stampInputAck`
    // → markCardDeliveredForStimulus + markChatDelivered stamps BOTH card and row on real consumption, and if
    // the turn dies before the ack both stay un-stamped so the sweep re-drives (this is the bfe355ae fix — never
    // stamp a durable card on the XADD).
    if (isSeedCardDelivery(stimulus)) {
      const durableRow = await this.stimulusStore
        .findChatStimulusById(stimulus.id)
        .catch((err) => {
          this.logger.warn(
            `seed-card durability lookup failed for ${stimulus.id}; deferring stamp to ack/sweep: ${err}`,
          );
          return undefined;
        });
      if (durableRow === null) {
        await this.stampLegacySeedCard(stimulus);
      }
    } else {
      await this.stampLegacySeedCard(stimulus);
    }
    return true;
  }

  /**
   * After a card-answer/confirmation seed is steered into a live turn, stamp its card `deliveredAt` (the
   * per-stimulus equivalent of the fresh-turn tail stamp in `runChatTurnInner`). Guarded + idempotent: only
   * an answered/provided, not-yet-delivered card is stamped. A plain chat message or bare nudge (no card id)
   * is a no-op.
   */
  private async stampLegacySeedCard(stimulus: TurnEnvelope): Promise<void> {
    // The delivered-id arrays hold one id (a solo card delivery) or many (a combined `answer-batch`). Loop
    // each with the same per-kind guarded logic — per-id best-effort (`.catch` + continue), so a transient
    // failure on one card leaves it owed for the sweep without stranding the rest of the batch.
    for (const questionId of stimulus.deliveredQuestionIds ?? []) {
      const card = await this.store
        .getQuestionCard(stimulus.jobId, questionId)
        .catch(() => null);
      if (card?.answer != null && card.deliveredAt == null) {
        await this.store
          .markQuestionDelivered(stimulus.jobId, questionId)
          .catch((err) =>
            this.logger.warn(`markQuestionDelivered (steer) failed: ${err}`),
          );
      }
    }
    for (const secretId of stimulus.deliveredSecretIds ?? []) {
      const card = await this.store
        .getSecretCard(stimulus.jobId, secretId)
        .catch(() => null);
      if (card?.provided_at != null) {
        if (card.delivered_at == null) {
          await this.store
            .markSecretDelivered(stimulus.jobId, secretId)
            .catch((err) =>
              this.logger.warn(
                `markSecretDelivered (legacy seed) failed: ${err}`,
              ),
            );
        }
        // Only the EPHEMERAL lane uses the single-slot `awaiting_secret_id` pointer; durable/mcp cards are
        // per-card (no pointer to clear — like the file lane). Called unconditionally anyway (not gated on
        // `card.ephemeral === true`): `clearAwaitingSecret` is compare-and-clear, so it's a no-op unless the
        // pointer still equals this requestId — which also heals a pre-deploy legacy durable/mcp request that
        // left the pointer set before per-card secrets existed.
        await this.store
          .clearAwaitingSecret(stimulus.jobId, secretId)
          .catch((err) =>
            this.logger.warn(
              `clearAwaitingSecret (legacy seed) failed: ${err}`,
            ),
          );
      }
    }
    for (const fileId of stimulus.deliveredFileIds ?? []) {
      const card = await this.store
        .getFileCard(stimulus.jobId, fileId)
        .catch(() => null);
      if (card?.provided_at != null && card.delivered_at == null) {
        await this.store
          .markFileDelivered(stimulus.jobId, fileId)
          .catch((err) =>
            this.logger.warn(`markFileDelivered (steer) failed: ${err}`),
          );
      }
    }
  }

  /**
   * Stamp the question/secret/file card a DURABLE stimulus row points at, resolving the target from the row's
   * `reply_route` (read via the store) — the restart-safe, per-stimulus equivalent of `runChatTurnInner`'s
   * fresh-turn success-tail card stamps. Keyed on the durable `stimuli.id`, so it works from both the STEER
   * ack path (`stampInputAck`) and the reattach tail. Best-effort + idempotent: each kind is guarded on the
   * card's own delivered state, so a redundant call (sweep re-drive, double ack) never re-stamps. A row with no
   * seed target (a plain operator message or pure notice) is a no-op.
   */
  private async markCardDeliveredForStimulus(id: string): Promise<boolean> {
    // A genuinely-missing row is a clean no-op (null); a TRANSIENT lookup error must PROPAGATE so the caller
    // (stampSeedCardSuccessTails / stampInputAck) skips the trailing stimulus-row stamp and the sweep re-drives
    // the whole idempotent sequence — never leaving the row delivered while its card stays stranded.
    const stimulus = await this.stimulusStore.findChatStimulusById(id);
    if (!stimulus) return false;
    const { jobId, deliveredQuestionIds, deliveredSecretIds, deliveredFileIds } =
      stimulus;

    // Loop the delivered-id arrays (one id for a solo card delivery, many for a combined `answer-batch`).
    // NO `.catch` here (unlike `stampLegacySeedCard`): this function's invariant is that a transient error
    // PROPAGATES so the caller skips the trailing `markChatDelivered` and the sweep re-drives the whole
    // idempotent sequence — a card is never left stranded behind a delivered row. `getQuestionCard` returns
    // null for a genuinely-absent card; only a THROWN (transient) error propagates.
    for (const questionId of deliveredQuestionIds ?? []) {
      const card = await this.store.getQuestionCard(jobId, questionId);
      if (card?.answer != null && card.deliveredAt == null) {
        await this.store.markQuestionDelivered(jobId, questionId);
      }
    }
    for (const secretId of deliveredSecretIds ?? []) {
      const card = await this.store.getSecretCard(jobId, secretId);
      if (card?.provided_at != null) {
        if (card.delivered_at == null) {
          await this.store.markSecretDelivered(jobId, secretId);
        }
        // Only the EPHEMERAL lane uses the single-slot `awaiting_secret_id` pointer (durable/mcp is per-card,
        // like the file lane) — but this is called unconditionally regardless of `card.ephemeral`:
        // `clearAwaitingSecret` is compare-and-clear, so it's a no-op unless the pointer still equals this
        // requestId, which also heals a pre-deploy legacy durable/mcp request that left the pointer set before
        // per-card secrets existed. Clear even if the card was already marked delivered by a prior partial
        // tail: the row must not be delivered until both stamps have succeeded.
        await this.store.clearAwaitingSecret(jobId, secretId);
      }
    }
    for (const fileId of deliveredFileIds ?? []) {
      const card = await this.store.getFileCard(jobId, fileId);
      if (card?.provided_at != null && card.delivered_at == null) {
        await this.store.markFileDelivered(jobId, fileId);
      }
    }
    return true;
  }

  /**
   * SUCCESS-TAIL seed stamp: mark the durable stimulus row delivered AND stamp its question/secret/file card,
   * together, so a seed's `stimuli.delivered_at` and its card `deliveredAt` commit as one on consumption (never
   * on steer-dispatch/registration). Keyed on the durable `stimuli.id` passed EXPLICITLY — on the reattach path
   * the reconstructed `TurnEnvelope.id` is the engine turn id, not the row. Best-effort: a failed stamp leaves
   * BOTH owed for the sweep (at-least-once).
   */
  private async stampSeedCardSuccessTails(
    stimulusRowId: string,
  ): Promise<SeedCardStampResult> {
    // CARD first, ROW last: the sweep re-drives on `stimuli.delivered_at IS NULL`, so the row (its key) MUST
    // be the final write — a crash mid-tail then leaves the row un-stamped and the whole idempotent sequence
    // re-runs. If the card stamp fails, the row stamp is skipped (the throw propagates from
    // markCardDeliveredForStimulus), so a card is never stranded behind a delivered row. Best-effort overall.
    try {
      const found = await this.markCardDeliveredForStimulus(stimulusRowId);
      if (!found) return 'missing';
      await this.stimulusStore.markChatDelivered(stimulusRowId);
      return 'stamped';
    } catch (err) {
      this.logger.warn(
        `stampSeedCardSuccessTails failed (sweep will re-drive): ${err}`,
      );
      return 'failed';
    }
  }

  /**
   * TERMINAL delivery stamp for a pending chat being permanently dropped this turn (thread closed / provisioning
   * permanently failed) after we posted the explanatory notice — marks it delivered so the at-least-once sweep
   * won't re-post the identical notice every lease cycle. A solo seed-card delivery deferred its stamp from
   * `onRegistered`, so stamp its durable row + card here (the answer can never reach the dead thread, and this
   * also stops the edit-6 boot backfill from recreating the row); operator chat keeps the `onRegistered` path.
   */
  private async markTerminallyDelivered(
    stimulus: TurnEnvelope,
    opts?: TurnDeliveryOpts,
  ): Promise<void> {
    if (isSeedCardDelivery(stimulus)) {
      const result = await this.stampSeedCardSuccessTails(stimulus.id);
      if (result === 'missing') await this.stampLegacySeedCard(stimulus);
      return;
    }
    opts?.onRegistered?.();
  }

  /**
   * BOOT one-time backfill: for an answered/provided-but-undelivered card with NO live undelivered `stimuli`
   * row, persist the durable row (+ its curated pill) and hand it to the pump — steady-state recovery is then
   * the 30 s chat sweep, not a boot-only re-drive through `handleChatTurn`. Skips when a matching undelivered
   * row already exists so boot and the sweep never double-deliver one card, and backfills pre-deploy stuck
   * cards onto the durable path. Idempotent (the pill dedups on `chunkKey`; the guard blocks a duplicate row).
   */
  private async backfillSeedDelivery(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    body: string;
    seedRow: SeedRow;
    /** The typed card-confirmation variant this re-delivery reproduces — persisted on the durable row's
     *  `type` + stamped as `meta.seedType` so the boot re-drive renders the SAME per-type pill as the live
     *  path. The body is already framed by the caller, so no re-render through `composeMessageBody`. */
    type: Extract<
      MessageType,
      'answer_question' | 'secret_provided' | 'file_answered'
    >;
    seedQuestionId?: string;
    seedSecretId?: string;
    seedFileId?: string;
  }): Promise<void> {
    const target = {
      ...(input.seedQuestionId ? { seedQuestionId: input.seedQuestionId } : {}),
      ...(input.seedSecretId ? { seedSecretId: input.seedSecretId } : {}),
      ...(input.seedFileId ? { seedFileId: input.seedFileId } : {}),
    };
    if (
      await this.stimulusStore.hasChatStimulusForSeedTarget(input.jobId, target)
    )
      return;
    const recorded = await this.stimulusStore.recordChatStimulus({
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      author: {
        id: SYSTEM_SEED_AUTHOR.id,
        displayName: SYSTEM_SEED_AUTHOR.name,
      },
      replyRoute: { surfaceId: 'web', jobRef: input.jobId },
      body: input.body,
      systemChunk: input.seedRow,
      type: input.type,
      ...target,
    });
    await this.enqueueChat(recorded);
  }

  // ── Durable operator-message delivery (the pump) ─────────────────────────────────────────────────
  //
  // Every plain operator chat message is a durable `stimuli` row (persisted at intake). The pump is the
  // single owner of "get it to the brain, exactly once": steer a live turn, or run a fresh one, and stamp
  // `delivered_at` only on a positive hand-off (an engine `input_ack`, or the runner's registration). A
  // leader sweep re-drives anything still undelivered — so a swallowed steer / crash / sandbox transition
  // self-heals instead of silently losing the message (see the durable-delivery redesign).

  /** BrainSink.enqueueChat — a persisted operator message is ready; ensure the brain takes it. */
  async enqueueChat(stimulus: TurnEnvelope): Promise<void> {
    await this.pumpThread(
      stimulus.jobId,
      stimulus.orgId,
      stimulus.repoId,
      this.laneForStimulus(stimulus),
    );
  }

  /** The durable routing coordinate a chat stimulus targets: its own `thread:<id>` lane, else `'main'`. */
  private laneForStimulus(stimulus: { resumeThreadId?: string }): string {
    return stimulus.resumeThreadId
      ? `thread:${stimulus.resumeThreadId}`
      : 'main';
  }

  /** Active turns created before lane metadata, or older test doubles, are the legacy main brain lane. */
  private activeTurnLane(turn: { lane?: string | null }): string {
    return turn.lane ?? 'main';
  }

  /**
   * Deliver a thread's pending operator messages. FAST PATH: a running brain turn is steered directly
   * (outside the per-thread queue — that queue is HELD by the very turn we want to steer), so the model
   * reacts mid-flight; the engine's `input_ack` stamps delivery. SLOW PATH (no running turn): a fresh turn
   * is queued (serialized with all other turns) that coalesces the pending batch and stamps delivery at its
   * registration hand-off. Idempotent + safe to call redundantly (intake poke, sweep) — the lease + the
   * in-container exactly-once steer id set prevent double-injection.
   */
  async pumpThread(
    jobId: string,
    orgId: string,
    repoId: string,
    lane = 'main',
  ): Promise<void> {
    if (this.election.getState() === 'draining') return;

    // Leave pending operator chat undelivered while the job is dependency-blocked. The unblock wake flips the
    // job open and the delivery sweep/poke will then carry the queued messages into the brain.
    if (await this.isJobBlocked(jobId)) {
      this.logger.log(`job=${jobId} is blocked; parking pending chat delivery`);
      return;
    }

    // FAST PATH: a live brain turn is steered directly (the pump core resolves + steers `now`-priority
    // pending; `queue`/`later` stay pending for turn-end / ride-along).
    const deliveryLane = this.deliveryLane(jobId, orgId, repoId, lane);
    if (
      await trySteerLive(
        this.stimulusStore,
        deliveryLane,
        AgentSessionManager.CHAT_DELIVERY_LEASE_MS,
        this.logger,
      )
    ) {
      return;
    }

    // SLOW PATH: no running turn → deliver via a fresh turn, serialized on the per-thread turn queue (the
    // queue keying is brain-specific, so the brain owns this serialization around the lane's fresh-turn drain).
    const key = `${orgId}:${jobId}`;
    const prev = this.turnQueues.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.deliverPendingViaFreshTurn(deliveryLane));
    this.turnQueues.set(
      key,
      next.finally(() => {
        if (this.turnQueues.get(key) === next) this.turnQueues.delete(key);
      }),
    );
    return next;
  }

  /**
   * The brain's delivery-pump descriptor for a given `lane` (`'main'` or `'thread:<id>'`): steering stays the
   * engine `steer`, body framing stays `engineBody`, and a fresh-turn drain coalesces the pending batch into
   * ONE brain turn. `resolveLiveTurn` is LANE-MATCHED — `runningBrainTurn` returns the job's single running
   * brain turn across ALL its lanes/sessions, so it only counts as this lane's live turn when its `.lane`
   * matches; otherwise the row stays queued (never cross-steered into a different session's turn).
   */
  private deliveryLane(
    jobId: string,
    orgId: string,
    repoId: string,
    lane: string,
  ): DeliveryLane {
    return {
      jobId,
      orgId,
      repoId,
      lane,
      resolveLiveTurn: async () => {
        const live = await this.turnRegistry.runningBrainTurn(jobId);
        return live && this.activeTurnLane(live) === lane ? live : null;
      },
      canSteer: () => typeof this.engineRunner.steer === 'function',
      steer: (turnId, id, body) => this.engineRunner.steer!(turnId, id, body),
      renderBody: (p) => this.engineBody(p),
      drainFreshTurn: async (collected) => {
        await this.stimulusStore.leaseChatStimuli(collected.ids);
        const ids = collected.ids;
        // Coalesce into one turn: the operator already sees each as its own bubble (a `messages` row per
        // message); the brain reads them together as this turn's task. Base fields come from the oldest.
        const combined: TurnEnvelope = {
          ...collected.pending[0],
          body: collected.pending.map((p) => p.body).join('\n\n'),
          // Per-message attribution: one `<user name at>` chunk each, so a batch coalesced from several
          // senders isn't misattributed to the oldest. `engineBody` renders these; the joined `body` above
          // is the clean fallback (used for logging + when `chunks` is absent on a replay).
          chunks: collected.userChunks,
        };
        // A solo seed-card delivery defers its stimulus stamp to the SUCCESS tail (stamped together with the
        // card via `stampSeedCardSuccessTails`) so a register-then-fail turn leaves BOTH unstamped and the
        // sweep re-drives it (at-least-once atomicity). Operator chat keeps the looser at-registration bar —
        // its input rides the prompt the instant it registers.
        const deferStimulusStamp = isSeedCardDelivery(combined);
        await this.runChatTurn(combined, {
          // Restart-survivable hand-off: stamp every coalesced message delivered the instant the turn is
          // registered + kicked (a later crash resumes THIS turn rather than re-running these messages).
          onRegistered: () => {
            if (deferStimulusStamp) return;
            for (const id of ids) {
              void this.stimulusStore
                .markChatDelivered(id)
                .catch((err) =>
                  this.logger.debug(
                    `markChatDelivered ${id} failed (sweep will retry): ${err}`,
                  ),
                );
            }
          },
        });
      },
    };
  }

  /**
   * Owned coalescing selection for a fresh operator turn (d18). Fetches the `main` lane's eligible pending
   * chat, then PARTITIONS on the head row's authorship so a system seed never coalesces with operator rows: a
   * seed batched as a `<user>` chunk would render named "System" and mis-decide the batch's awareness drain.
   * An operator head takes the leading run of operator rows (coalesced as one turn); a seed head takes ONLY
   * that one seed (each seed delivers solo, keeping its `<system_notice>` framing + awareness-drain
   * semantics). The remainder stays pending and drains via the turn-end re-pump. Builds the chronological
   * `<user>` chunks (one per batched message), the id set to stamp delivered, and the wake flag. Returns null
   * when nothing is pending.
   */
  private async collectPendingForTurn(
    jobId: string,
    lane: string,
  ): Promise<CollectedPending | null> {
    const pending = await this.stimulusStore
      .eligiblePendingChat(
        jobId,
        AgentSessionManager.CHAT_DELIVERY_LEASE_MS,
        lane,
      )
      .catch((err) => {
        this.logger.warn(
          `pump: eligiblePendingChat failed for thread=${jobId}: ${err}`,
        );
        return [] as TurnEnvelope[];
      });
    if (pending.length === 0) return null;
    const operatorHead = isOperatorAuthored(pending[0]);
    const batch: TurnEnvelope[] = [];
    for (const p of pending) {
      if (isOperatorAuthored(p) !== operatorHead) break;
      batch.push(p);
      if (!operatorHead) break; // seeds deliver one-at-a-time
    }
    return {
      pending: batch,
      userChunks: batch.map((p) => userChunkFor(p)),
      ids: batch.map((p) => p.id),
      // Wake is computed over the FULL eligible-pending set, not just `batch`: a wake-eligible row excluded by
      // the author partition (e.g. a `now` seed behind a `later` operator head) must still start a turn —
      // otherwise no turn runs, no turn-end re-pump reconsiders the remainder, and the thread stalls until an
      // unrelated wake.
      wake: pending.some(isWakeEligible),
    };
  }

  /** Run ONE fresh turn that consumes the lane's pending operator messages (coalesced, oldest first). */
  private async deliverPendingViaFreshTurn(lane: DeliveryLane): Promise<void> {
    const collected = await this.collectPendingForTurn(lane.jobId, lane.lane);
    if (!collected) return;
    // Only WAKE for a wake-eligible (now/queue) message. A thread whose only pending rows are `later`
    // composes them as ride-along into some OTHER turn — it must never start a turn on its own.
    if (!collected.wake) return;

    // A turn may have appeared since pumpThread's check (a boot re-attach resumed one). Steer the `now`
    // messages into it instead of starting a SECOND turn on the same session; queue/later stay pending for
    // the turn-end drain.
    const live = await lane.resolveLiveTurn().catch(() => null);
    if (live?.turn_id && lane.canSteer()) {
      const nowOnly = collected.pending.filter(isNowPriority);
      if (nowOnly.length)
        await steerPending(
          this.stimulusStore,
          lane,
          live.turn_id,
          nowOnly,
          this.logger,
        );
      return;
    }

    const otherLive = await this.turnRegistry
      .runningBrainTurn(lane.jobId)
      .catch(() => null);
    if (otherLive?.turn_id && this.activeTurnLane(otherLive) !== lane.lane) {
      return;
    }

    await lane.drainFreshTurn(collected);
  }

  /** Stamp `delivered_at` when the engine acks a steered message (from either onEvent path). */
  private stampInputAck(e: EngineEvent): void {
    if (e.kind !== 'input_ack' || !e.id) return;
    // A steered seed's card is stamped on the SAME ack that stamps its stimulus row — the ack is the real
    // consumption signal. Order matters: stamp the CARD first, the stimulus ROW last (the sweep re-drives on
    // `stimuli.delivered_at IS NULL`, so the row must be the final write). If the card stamp fails, the row is
    // left un-stamped so the sweep re-drives. For a plain operator/wake ack the card stamp is a harmless no-op.
    // Closes the secret-wedge: markCardDeliveredForStimulus also clears `awaiting_secret_id`.
    void (async () => {
      await this.markCardDeliveredForStimulus(e.id);
      await this.stimulusStore.markChatDelivered(e.id);
    })().catch((err) =>
      this.logger.debug(
        `input_ack stamp for ${e.id} failed (sweep will retry): ${err}`,
      ),
    );
  }

  /** LEADER periodic + boot re-drive of any operator message still undelivered (the at-least-once sweep). */
  private async sweepUndeliveredChat(): Promise<void> {
    if (this.election.getState() !== 'leader') return;
    let lanes: Array<{
      jobId: string;
      orgId: string;
      repoId: string;
      lane: string;
    }>;
    try {
      lanes = await this.stimulusStore.undeliveredChatLanes();
    } catch (err) {
      this.logger.debug(
        `chat delivery sweep query failed (will retry): ${err}`,
      );
      return;
    }
    for (const t of lanes) {
      void this.pumpThread(t.jobId, t.orgId, t.repoId, t.lane).catch((err) =>
        this.logger.debug(
          `chat sweep pump failed for thread=${t.jobId}: ${err}`,
        ),
      );
    }
  }

  /**
   * LEADER periodic + boot re-drive of WORK-OWED Codex reviews. `review_plan` runs a Codex review
   * SYNCHRONOUSLY inside the brain turn; a `codex_reviews` row sits `running` for its duration. Normally the
   * live brain turn owns it — but if that turn is finalized on the NON-DETACHED path (the 10-min alive-grace
   * ceiling / watchdog `del()`s the tool-bridge streams so reattach can't re-dispatch the tool), the row is
   * stranded `running` with no owner and the plan quietly stalls. This is the ONLY recovery for that path
   * (reattach covers the ordinary host-restart case). It is NOT job-status-driven: a job idling in
   * `planning` is the normal "waiting on the operator" state, not a wedge — only a stranded `running`
   * review row is the work-owed fingerprint. The re-driven brain re-invokes `review_plan`, which RESUMES the
   * Codex session from the row.
   */
  private async reconcileWorkOwedReviews(): Promise<void> {
    if (this.election.getState() !== 'leader') return;
    let running: PlanReviewRow[];
    try {
      running = await this.planReview.findRunningReviews();
    } catch (err) {
      this.logger.debug(
        `work-owed review sweep query failed (will retry): ${err}`,
      );
      return;
    }
    for (const review of running) {
      void this.nudgeWorkOwedReview(review).catch((err) =>
        this.logger.warn(
          `work-owed review re-drive failed for job=${review.job_id}: ${err}`,
        ),
      );
    }
  }

  /**
   * Re-drive ONE work-owed review job. Re-checks conditions the batch query can't: the row is genuinely
   * STRANDED (running past the grace window — not a review legitimately in flight or a reattach still
   * settling), NO brain turn is live (a live turn owns the review — the common case, skip it), and no
   * operator/system chat is pending (the chat sweep drives those). A bounded in-memory dedup keeps it from
   * re-nudging a job whose re-driven turn is still spinning up. Injects one server-initiated nudge via
   * `handleChatTurn` (steers into any turn that appeared since; backstopped by the DB single-brain-turn
   * guard). The nudged brain re-invokes `review_plan` → the row goes running-with-a-live-turn or terminal,
   * so it naturally stops matching.
   */
  private async nudgeWorkOwedReview(review: PlanReviewRow): Promise<void> {
    const ageMs = Date.now() - new Date(review.updated_at).getTime();
    if (ageMs < PLAN_REVIEW_WEDGE_GRACE_MS) return; // in flight / reattach settling — not stranded yet
    const last = this.workOwedNudgedAt.get(review.job_id) ?? 0;
    if (Date.now() - last < WORK_OWED_RENUDGE_MS) return; // recently nudged — let the turn spin up

    const job = await this.store.loadJob(review.job_id).catch(() => null);
    if (!job) return;
    // A terminal job no longer owes a review continuation (operator already saw the plan, or it's closed).
    if (job.status === 'awaiting_approval' || job.status === 'building') return;
    const live = await this.turnRegistry
      .runningBrainTurn(review.job_id)
      .catch(() => null);
    if (live?.turn_id) return; // a live turn owns the review
    const pendingChat = await this.stimulusStore
      .eligiblePendingChat(
        review.job_id,
        AgentSessionManager.CHAT_DELIVERY_LEASE_MS,
      )
      .catch(() => [] as TurnEnvelope[]);
    if (pendingChat.some(isWakeEligible)) return; // the chat sweep will re-drive this job (later-only never wakes on its own)

    this.workOwedNudgedAt.set(review.job_id, Date.now());
    this.logger.log(
      `work-owed review: re-driving job=${review.job_id} (review stranded 'running' for ${Math.round(ageMs / 1000)}s)`,
    );
    const stimulus = seedEnvelope({
      ...seedBase({
        jobId: review.job_id,
        orgId: review.org_id,
        repoId: job.repoId,
      }),
      type: 'work_owed_nudge',
      reviewId: review.id,
    });
    await this.handleChatTurn(stimulus);
  }

  /**
   * STOP the live brain turn for a thread (the operator hit Stop). Publishes a cooperative abort; the
   * in-container engine aborts the SDK query and writes a graceful `final`, so the normal completion path
   * persists the partial transcript, finalizes the registry row, reclaims the streams, and clears
   * `turn_active` (whose turn_end fans out to drop the "working" indicator). No-op if nothing is running.
   * Returns true when a live turn was found and signalled.
   */
  async stopTurn(jobId: string): Promise<boolean> {
    if (typeof this.engineRunner.stop !== 'function') return false;
    const live = await this.turnRegistry
      .runningBrainTurn(jobId)
      .catch(() => null);
    if (!live?.turn_id) return false;
    await this.engineRunner.stop(live.turn_id);
    this.logger.log(
      `stop requested for brain turn ${live.turn_id} (job ${jobId})`,
    );
    return true;
  }

  private async isJobBlocked(jobId: string): Promise<boolean> {
    const loadJob = this.store.loadJob?.bind(this.store);
    if (!loadJob) return false;
    const job = await loadJob(jobId).catch(() => null);
    return job?.status === 'blocked';
  }

  /**
   * Record a SESSION-scoped skill edit grant for a job — called by the OWNER-gated
   * `…/jobs/:jobId/skill-edit-access/:requestId/approve` endpoint after it resolves the fork-to-custom
   * name (if any). The next brain turn forwards this on `RunEngineArgs.grantedSkills`, unlocking
   * `Edit`/`Write` for exactly this skill name in-container (see `engine-core.ts`'s skill guard).
   */
  grantSkillEditAccess(jobId: string, skillName: string): void {
    const set = this.skillEditGrantsByJob.get(jobId) ?? new Set<string>();
    set.add(skillName);
    this.skillEditGrantsByJob.set(jobId, set);
  }

  /**
   * Await all in-flight turns to finish, bounded by `graceMs`. Returns `true` if everything drained
   * cleanly, `false` if the grace cap was hit (the caller then lets the process exit; over-cap turns die
   * with it and cold-resume on the next leader). New turns are already blocked (drain gate above), so the
   * current `turnQueues` snapshot is the complete in-flight set.
   */
  async drainInFlight(graceMs: number): Promise<boolean> {
    const tails = [...this.turnQueues.values()].map((p) =>
      p.catch(() => undefined),
    );
    if (tails.length === 0) return true;
    this.logger.log(
      `Drain: awaiting ${tails.length} in-flight turn(s) (grace ${graceMs}ms)`,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), graceMs);
    });
    const done = Promise.all(tails).then(() => 'done' as const);
    const result = await Promise.race([done, timeout]);
    if (timer) clearTimeout(timer);
    return result === 'done';
  }

  /**
   * The boot RE-ATTACH handlers for the turn kinds THIS service owns, keyed by `active_turns.kind`. Each
   * resumes an in-flight detached exec and COMPLETES it the way that kind requires. `awaitCompletion` gates
   * whether {@link reattachOwnedTurns} blocks on it: a `brain` turn can run for minutes so it's
   * fire-and-forget, while a `compaction` turn is short AND `reconcileStrandedCompactions` depends on its
   * reseed having landed, so it's awaited before the sweep returns. The driver owns 'step'/'gate'/'review'/
   * 'autofix' and re-attaches those itself — they are intentionally absent here. Add an owned kind by
   * registering one entry (no new sweep method / boot wiring).
   */
  private reattachHandlers(): Record<
    string,
    { run: (row: ActiveTurnEntity) => Promise<void>; awaitCompletion: boolean }
  > {
    return {
      brain: { run: (row) => this.reattachOne(row), awaitCompletion: false },
      compaction: {
        run: (row) => this.reattachCompactionOne(row),
        awaitCompletion: true,
      },
    };
  }

  /**
   * BOOT RE-ATTACH (redis transport) for every in-flight turn this service owns. Each detached engine kept
   * running across the restart and is still writing to its Redis streams; we list `active_turns` ONCE and
   * dispatch each row to its {@link reattachHandlers} entry — brain rebuilds the harness + tool closure and
   * persists the transcript on completion; compaction completes the reseed. Lossless restart-survival (the
   * durable Redis log is replayed from the start). Long-running kinds run fire-and-forget; only kinds whose
   * completion a later boot step depends on are awaited (see `awaitCompletion`). See ADR 0001.
   */
  private async reattachOwnedTurns(): Promise<void> {
    if (!this.engineRunner.reattach) {
      this.logger.warn(
        'redis re-attach: the bound ENGINE_RUNNER has no reattach() — skipping',
      );
      return;
    }
    let rows: ActiveTurnEntity[];
    try {
      rows = await this.turnRegistry.listRunning();
    } catch (err) {
      this.logger.warn(`redis re-attach: listRunning failed: ${err}`);
      return;
    }
    const handlers = this.reattachHandlers();
    const owned = rows.filter((r) => handlers[r.kind]);
    if (owned.length === 0) return;
    this.logger.log(
      `Leader: re-attaching ${owned.length} in-flight turn(s) over Redis`,
    );
    const blocking: Promise<void>[] = [];
    for (const row of owned) {
      const { run, awaitCompletion } = handlers[row.kind];
      const p = run(row).catch((err) =>
        this.logger.warn(
          `re-attach turn ${row.turn_id} (${row.kind}) failed: ${err}`,
        ),
      );
      if (awaitCompletion) blocking.push(p);
      else void p;
    }
    // Block ONLY on ordering-sensitive kinds (compaction → its reseed must land before
    // `reconcileStrandedCompactions` queries); long brain turns keep streaming in the background.
    await Promise.all(blocking);
  }

  /**
   * WATCHDOG RE-ATTACH (brain kinds: brain/compaction). The leader watchdog calls this for one
   * orphaned-but-alive `active_turns` row this service owns — the same recovery as the boot
   * {@link reattachOwnedTurns} sweep, but for ONE row and triggered continuously (so a turn a restart
   * orphaned resumes within a watchdog window, without waiting for the next process restart). Idempotent:
   *   - a kind we don't own → 'deferred';
   *   - the runner can't reattach, or we're already tailing this turn in-process → we don't double-attach;
   *   - otherwise dispatch the kind's handler (brain runs fire-and-forget; compaction is short and awaited),
   *     rebuilding the harness + tool closure and resuming the live engine.
   * The `reattachOne`/`reattachCompactionOne` handlers self-guard on insufficient registry ctx (they no-op,
   * leaving the engine live for a later attempt), so we never finalize a live turn here.
   */
  async reattachTurnRow(row: ActiveTurnEntity): Promise<ReattachOutcome> {
    const handler = this.reattachHandlers()[row.kind];
    if (!handler) return 'deferred';
    if (!this.engineRunner.reattach) return 'deferred';
    if (this.engineRunner.isAttached?.(row.turn_id)) {
      // Already tailing it in THIS process — the live relay is advancing the heartbeat; nothing to do.
      return 'attached';
    }
    if (handler.awaitCompletion) {
      // Short, ordering-sensitive kinds (compaction): await so the watchdog's heartbeat freshen lands after.
      await handler.run(row);
    } else {
      // Long-running kinds (brain) stream for minutes — fire-and-forget, mirroring the boot sweep.
      void handler
        .run(row)
        .catch((err) =>
          this.logger.warn(
            `watchdog re-attach turn ${row.turn_id} (${row.kind}) failed: ${err}`,
          ),
        );
    }
    return 'attached';
  }

  /** A finalize loser: another attacher already claimed this turn ⇒ this caller must persist NOTHING. */
  private lost(result?: { claimed?: boolean }): boolean {
    return result?.claimed === false;
  }

  /** Re-attach one in-flight brain turn: rebuild stimulus → tools → harness, resume the engine, persist. */
  private async reattachOne(row: ActiveTurnEntity): Promise<void> {
    // A mid-day promotion (leader flap between watch respawns) re-fires this sweep while THIS process
    // may already be tailing the turn it kicked — a second attach loop would double every live frame
    // and double-persist the transcript at finish. Atomically claim the in-process slot (check-and-add in
    // one synchronous step ⇒ no TOCTOU between two concurrent sweep entries); the outer `finally` releases
    // it on every bail before `reattach()` runs (runAttached's own finally releases once attached).
    const claimedAttach =
      this.engineRunner.tryClaimAttach?.(row.turn_id) ?? true;
    if (!claimedAttach) {
      this.logger.log(
        `re-attach turn ${row.turn_id}: already attached in this process — skipping`,
      );
      return;
    }
    try {
      const ctx = (row.ctx ?? {}) as {
        repoId?: string;
        author?: { id: string; displayName: string };
        body?: string;
        // The `Message` type this turn ran (supersedes the retired `seed*` booleans) — drives the guard
        // switches on the rebuilt envelope's `message.type`.
        type?: MessageType;
        deliveredQuestionIds?: string[];
        deliveredSecretIds?: string[];
        deliveredFileIds?: string[];
        // The durable `stimuli.id` for a seed-card delivery — carried so the reattach success tail can stamp
        // the RIGHT row (the reconstructed `TurnEnvelope.id` below is `row.turn_id`, the engine turn, not the row).
        deliveryStimulusId?: string;
        // SESSION RE-HOME: this turn persists its session onto `threads.session_id` for this thread, not the
        // job sandbox (see {@link TurnEnvelope.resumeThreadId}) — carried so a reattach persists the same target.
        resumeThreadId?: string;
        // Dispatch-time credential the turn ran on — re-stamped onto rate_limit events so the reattach path
        // feeds the credential-scoped usage snapshot exactly like a fresh dispatch (else it tags `undefined`).
        credentialId?: string;
      };
      if (
        !row.container_id ||
        !ctx.repoId ||
        !ctx.author ||
        ctx.body === undefined
      ) {
        // NOT a death sentence: the engine may be alive and running (its Redis stream heartbeats prove or
        // disprove it) — this process just can't rebuild the tool closure. Leave the row for the watchdog,
        // whose stream-liveness probe finalizes only genuinely dead turns.
        this.logger.warn(
          `re-attach turn ${row.turn_id}: insufficient registry ctx — skipping (watchdog owns cleanup)`,
        );
        return;
      }
      // Rebuild the TurnEnvelope buildTools closes over (orgId/repoId/jobId/author/body). `message` is a
      // documented partial (only `.type` + identity real — {@link syntheticMessage}): the already-rendered
      // `body` is carried on the envelope, so no re-render, and the variant args are never read post-render.
      const type: MessageType = ctx.type ?? 'user';
      const stimulus: TurnEnvelope = {
        message: syntheticMessage({
          id: row.turn_id,
          orgId: row.org_id,
          repoId: ctx.repoId,
          jobId: row.job_id,
          receivedAt: new Date(),
          type,
        }),
        id: row.turn_id,
        orgId: row.org_id,
        repoId: ctx.repoId,
        jobId: row.job_id,
        body: ctx.body,
        author: ctx.author,
        replyRoute: { surfaceId: 'web', jobRef: row.job_id },
        receivedAt: new Date(),
        ...(ctx.deliveredQuestionIds?.length
          ? { deliveredQuestionIds: ctx.deliveredQuestionIds }
          : {}),
        ...(ctx.deliveredSecretIds?.length
          ? { deliveredSecretIds: ctx.deliveredSecretIds }
          : {}),
        ...(ctx.deliveredFileIds?.length
          ? { deliveredFileIds: ctx.deliveredFileIds }
          : {}),
        // Preserve the session re-home target so a reattached open-PR turn persists onto the thread, not the
        // job sandbox (else the fresh session would leak back onto `job_sandboxes.session_id`).
        ...(ctx.resumeThreadId ? { resumeThreadId: ctx.resumeThreadId } : {}),
      };
      // Rebuild the dispatch map with the SAME shape the original kick used: an onboarding thread's
      // container declares the curated onboarding toolset, so a re-attach that registers the normal map
      // would reject those calls as "Unknown tool" (finish_onboarding at the end of a long run).
      const reattachKind =
        (await this.store.loadJob(row.job_id).catch(() => null))?.kind ?? null;
      const repoSlug = await this.resolveRepoSlug(stimulus.repoId);
      const stageRole = await this.resolveStageKind(stimulus);
      const tools = this.buildTools(
        stimulus,
        reattachKind,
        repoSlug,
        stageRole,
      );
      // Drop any live-turn state stranded by a prior subscription that died without finish/abort/discard, so
      // the '0-0' event replay below rebuilds a CLEAN buffer (a fresh turn_start) instead of appending onto a
      // stale open block — the root cause of persistent multiple-cursor state. Silent (no turn_end) to avoid
      // racing the client's async reconcile; guarded so the empty boot path is a no-op. Lane defaults to
      // 'main' — matches create() below (no lane arg).
      this.turnHarness.resetLane(row.channel, row.job_id);
      const threadId =
        stimulus.resumeThreadId ?? (await this.planningThreadId(row.job_id));
      const streamer = this.turnHarness.create({
        jobId: row.job_id,
        orgId: row.org_id,
        threadId,
        channel: row.channel,
        turnId: row.turn_id,
        livePush: !this.engineRunner.pushesLiveRouteEvents,
      });
      const sandboxRow = await this.sandboxRows.findOne({
        where: { job_id: row.job_id, org_id: row.org_id },
      });
      await this.store.setActivity(row.job_id, 'turn').catch(() => undefined);
      try {
        const result = await this.engineRunner.reattach!(
          row.turn_id,
          row.container_id,
          {
            // Same durable-delivery ack handling as a fresh run: an `input_ack` replayed on re-attach still
            // stamps its stimulus `delivered_at`, so a steer acked while the host was down can't redeliver.
            onEvent: (e) => {
              this.stampInputAck(e);
              streamer.onEvent(e);
            },
            toolBridge: { jobId: row.job_id, tools },
            ...(ctx.credentialId ? { credentialId: ctx.credentialId } : {}),
            // Realtime live push via the runner's independent `realtime` consumer group — same 'main' lane
            // the reattach replay streams the brain conversation on (mirrors this `onEvent`→streamer wiring).
            liveRoute: { channel: row.channel, jobId: row.job_id, lane: 'main' },
          },
        );
        if (result.sessionId && stimulus.resumeThreadId) {
          await this.driverStore
            .setThreadSessionId(stimulus.resumeThreadId, result.sessionId)
            .catch(() => undefined);
        } else if (result.sessionId && sandboxRow) {
          sandboxRow.session_id = result.sessionId;
          await this.sandboxRows.save(sandboxRow).catch(() => undefined);
        }
        if (this.lost(result)) {
          // Another attacher already claimed (deleted) this turn's row ⇒ it owns the persist. Write nothing
          // (the inner `finally` still runs endTurnActivity; the outer `finally` releases the attach slot).
          await streamer.discard();
          return;
        }
        await streamer.finish(
          result.result,
          result.usage
            ? {
                usage: result.usage,
                contextTokens: result.usage.contextTokens ?? null,
                contextLimit: resolveContextLimit(
                  result.usage.contextModel ?? result.usage.model,
                ),
                credentialId: result.credentialId ?? null,
              }
            : undefined,
        );
        // SUCCESS TAIL — a seed-card delivery that completed via reattach: stamp its durable stimulus
        // row + card together, keyed on the `stimuli.id` carried in ctx (the reconstructed `stimulus.id` is the
        // engine turn id here, not the row). Else the sweep re-delivers an already-consumed answer (exactly-once).
        if (ctx.deliveryStimulusId) {
          await this.stampSeedCardSuccessTails(ctx.deliveryStimulusId);
        }
        void this.usageProjector?.record(
          {
            jobId: row.job_id,
            orgId: row.org_id,
            lane: row.lane,
            kind: row.kind,
            engine: 'claude',
            turnId: row.turn_id,
            credentialId: result.credentialId ?? null,
          },
          result.usage,
        );
        this.logger.log(
          `re-attached turn ${row.turn_id} completed + persisted`,
        );
      } catch (err) {
        if (isEngineDetachedError(err)) {
          // We lost the tail again (another respawn mid-re-attach), the turn didn't fail — persist NOTHING
          // (the next boot's re-attach replays the whole stream; a partial flush here would double it).
          this.logger.warn(
            `re-attached turn ${row.turn_id} detached again — leaving it for the next boot re-attach`,
          );
          return;
        }
        this.logger.warn(
          `re-attached turn ${row.turn_id} ended in error: ${err}`,
        );
        if (this.engineRunner.consumeClaim?.(row.turn_id) === false) {
          // Errored AFTER another attacher already claimed the row — discard the partial rather than
          // double-finishing (row.turn_id IS the engine turnId on the reattach path, so the claim is exact).
          await streamer.discard();
        } else {
          await streamer.finish();
        }
      } finally {
        await this.store.endTurnActivity(row.job_id).catch(() => undefined);
      }
    } finally {
      if (this.engineRunner.tryClaimAttach)
        this.engineRunner.releaseAttach?.(row.turn_id);
    }
  }

  /**
   * One chat turn — marks the thread "actively working" for its WHOLE duration (including the ~30s first
   * provisioning), so the sidebar "needs you" dot clears while we work and returns the moment control
   * comes back to the operator (every early return below still hits the `finally`). Best-effort flag
   * writes never block the turn. Delegates the actual turn to `runChatTurnInner`.
   */
  private async runChatTurn(
    stimulus: TurnEnvelope,
    opts?: TurnDeliveryOpts,
  ): Promise<void> {
    await this.store.setActivity(stimulus.jobId, 'turn').catch(() => undefined);
    // A new turn is starting (a fresh operator message OR the Resume nudge) — clear any outstanding halted
    // flag so the thread reads as working again. Best-effort; never block the turn.
    await this.store.setHalted(stimulus.jobId, false).catch(() => undefined);
    try {
      await this.runChatTurnInner(stimulus, opts);
    } finally {
      await this.latchDirectBuildAtTurnEnd(stimulus);
      await this.store.endTurnActivity(stimulus.jobId).catch(() => undefined);
      // Turn-end re-pump (d18): drain any `queue` message that arrived mid-turn (it was intentionally NOT
      // steered) into a fresh turn now rather than waiting the 30s sweep. Best-effort + idempotent —
      // delivered rows are stamped, and a `later`-only thread won't wake (collectPendingForTurn's wake guard).
      void this.pumpThread(
        stimulus.jobId,
        stimulus.orgId,
        stimulus.repoId,
        this.laneForStimulus(stimulus),
      ).catch((err) =>
        this.logger.debug(`turn-end re-pump failed (sweep will retry): ${err}`),
      );
      // A turn just ended — the brain-settled half of auto-merge's guard may now hold. Fire-and-forget;
      // errors never affect turn completion.
      void this.autoMerge.maybeAutoMerge(stimulus.jobId).catch(() => undefined);
    }
  }

  /**
   * DIRECT-BUILD TURN-END LATCH (decision d3). A `finalize_build` in this turn committed the change and
   * handed the brain `shipOpenPrBody` — the brain then reconciled/pushed/`gh pr create`d inline, so the PR
   * now exists. Record it + flip `running → done` PROMPTLY here, instead of waiting on the 30-min
   * `GitStateReconciler` discovery. Runs only when the pending flag was set for this job (consumed here); a
   * latch MISS leaves the job `running` for that same reconciler backstop.
   */
  private async latchDirectBuildAtTurnEnd(
    stimulus: TurnEnvelope,
  ): Promise<void> {
    if (!this.directBuildShipPending.delete(stimulus.jobId)) return;
    const job = await this.store.loadJob(stimulus.jobId).catch(() => null);
    // Mirror the `finalize_build` refusal gate: only a `running` build with an owning feature branch latches.
    if (!job || job.status !== 'building' || !job.featureBranch) return;
    const sandbox = await this.lifecycle
      .findSandbox(job.id, job.orgId)
      .catch(() => null);
    const repo = sandbox
      ? await this.repos.resolve(job).catch(() => null)
      : null;
    if (!sandbox || !repo) return;
    // Follow the LIVE branch (the agent may have `git checkout -b …` mid-build) — `discoverOpenPr` matches
    // on `sandbox.branch`, so hand it the live branch, mirroring the full ship path.
    const liveSandbox = {
      ...sandbox,
      branch: job.currentBranch ?? sandbox.branch,
    };
    await this.ship.latchPr(job, repo, liveSandbox).catch(() => undefined);
  }

  /** Which thread-kind registry key this turn runs as: a re-homed turn (post_build/ci) uses its thread's
   *  role; a plain planning turn (no resumeThreadId) is 'planning'. onboarding/review remain 'planning' via
   *  jobKind conditions. A missing/unreadable thread row falls back to 'planning' rather than failing the
   *  turn. Single source for both the prompt persona (`resolvePromptAgent`) and any other per-stage lookup
   *  (e.g. `threadKindSpec(...).reasoningEffort`) so they never drift apart. */
  private async resolveStageKind(stimulus: TurnEnvelope): Promise<ThreadRole> {
    const stageRole = stimulus.resumeThreadId
      ? await this.driverStore
          .threadRole(stimulus.resumeThreadId)
          .catch(() => null)
      : null;
    return stageRole ?? 'planner';
  }

  /** Which stage persona this turn runs as (see `resolveStageKind`). */
  private async resolvePromptAgent(stimulus: TurnEnvelope): Promise<Agent> {
    return threadKindSpec(await this.resolveStageKind(stimulus)).agent;
  }

  /** The turn body (provision → attach → in-sandbox engine turn → stream + persist). Serialized by the
   *  `handleChatTurn` queue above — never invoked concurrently for the same thread. `opts.onRegistered`
   *  (the delivery pump's fresh-turn path) fires when the turn becomes restart-survivable, so the pump can
   *  stamp the operator message(s) `delivered_at` at hand-off rather than at completion. */
  private async runChatTurnInner(
    stimulus: TurnEnvelope,
    opts?: TurnDeliveryOpts,
  ): Promise<void> {
    const resetKey = `${stimulus.orgId}:${stimulus.jobId}`;
    // A fresh turn supersedes any parked host-retry backstop for this job (mirrors the build lane's
    // `ThreadDriver.drive()` guard): cancel the pending 10s timer + its durable retry clock so a stale timer
    // can't later seed a spurious 'Please continue' nudge into this now-live turn.
    await this.clearPendingHostRetry(stimulus.jobId);
    // A real operator turn breaks any autonomous reset→verify→reset spiral — clear the loop counter so
    // operator-driven resets never trip the guard (only unattended self-resets accumulate). Also disarm any
    // pending hard-reset confirm: the two `hard:true` calls must be consecutive within one autonomous stretch,
    // never split across an operator message that might have changed the intent.
    if (isOperatorAuthored(stimulus)) {
      this.consecutiveResets.delete(resetKey);
      this.pendingHardReset.delete(resetKey);
    }
    // Reset-verify continuation no-op: the verify instruction rides the reset-notice, consumed by whichever
    // turn cold-attaches FIRST. If an earlier turn (e.g. a queued operator message) already consumed it,
    // this synthetic wake has nothing to do — drop it rather than run a redundant turn on the warm box.
    if (
      stimulus.message.type === 'reset_verify' &&
      !this.pendingResetVerify.has(resetKey)
    )
      return;

    // The job may have become blocked after this turn was queued. Do not mark chat delivered here; it should
    // stay pending and run after the dependency wake reopens the job.
    if (await this.isJobBlocked(stimulus.jobId)) return;

    // A composer message NEVER answers an open `ask_question` card — answers come ONLY through the
    // question-card component (`/answer-question`, which stamps the card directly + includes its own
    // free-text "Other…" field). Anything typed in the composer while a card is showing — or queued
    // before the card was even asked — is just a normal operator message, delivered as this turn. (The
    // old prose-linkage that opportunistically stamped the latest unanswered card was the bug where a
    // queued chat message got consumed as the answer to a later question.)

    // Seed-card delivery stamps are resolved at the SUCCESS tail from the exact durable stimulus row
    // (`reply_route.seedQuestionId`/`seedSecretId`/`seedFileId`), with a legacy fallback for internal
    // in-memory seeds. Do not precompute from mutable thread pointers here: an unrelated operator turn must
    // never clear a provided secret gate or mark a card delivered.

    // Lazily provision the thread's sandbox on its FIRST turn — the live create/seed paths insert bare
    // thread rows (no sandbox/branch). Subsequent turns no-op (the row already exists). Tell the operator
    // we're setting up so the first turn isn't a silent ~30s wait while we clone + start a container.
    const alreadyProvisioned = await this.lifecycle.findSandbox(
      stimulus.jobId,
      stimulus.orgId,
    );
    // This is HARNESS narration, not an Atlas reply — appendSystemEvent renders it as a quiet pill (same
    // treatment as "Codex is reviewing the plan…"), never faking Atlas's voice for operational setup text.
    if (!alreadyProvisioned) {
      await this.store.appendSystemEvent(
        stimulus.jobId,
        'Setting up an isolated workspace for this thread — one moment…',
      );
    }
    const onMilestone = this.sandboxMilestoneNotifier(stimulus);
    try {
      const provisioned = await this.lifecycle.ensureProvisioned(
        stimulus.jobId,
        stimulus.orgId,
        onMilestone,
      );
      if (!provisioned) {
        await this.say(
          stimulus,
          'This thread is closed — start a new one to keep working.',
        );
        // Treat this pending chat as DELIVERED — else the 2-min at-least-once delivery sweep re-drives it and
        // re-posts this identical "closed" notice every lease cycle (the endless spam). A closed sandbox is a
        // terminal state for this message, not a transient un-delivery — mirror the ProvisioningNotReadyError
        // branch below. A solo seed-card delivery defers its stamp from `onRegistered`, so stamp it terminally
        // here (row + card) — the answer can never reach the closed thread, and this also stops the edit-6 boot
        // backfill from recreating the row forever.
        await this.markTerminallyDelivered(stimulus, opts);
        return;
      }
    } catch (err) {
      if (err instanceof ProvisioningNotReadyError) {
        await this.say(stimulus, err.message);
        // We RESPONDED with an actionable message, so treat this pending chat as DELIVERED — otherwise the
        // 2-min at-least-once delivery sweep re-drives provisioning and re-posts this identical "not
        // connected" message every lease cycle (the incident's 3× spam). A permanent precondition failure is
        // not a transient un-delivery. The operator re-messages once access is fixed (the auto-heal in
        // ensureProvisioned already handles the common stale-`access_ok` case before we ever get here).
        // Seed-card deliveries defer their stamp from `onRegistered`, so stamp terminally here (row + card).
        await this.markTerminallyDelivered(stimulus, opts);
      } else {
        this.logger.error(
          `provisioning failed for thread=${stimulus.jobId}: ${err}`,
        );
        await this.say(
          stimulus,
          `I couldn't set up a workspace for this thread. (${String(err).slice(0, 200)})`,
        );
        // Leave undelivered: a transient provisioning failure (e.g. a Docker hiccup) is worth a bounded re-drive.
      }
      return;
    }

    // (Re-)attach a live container against the thread's durable worktree. Returns null only if the
    // thread has no sandbox row (just provisioned above, so unexpected) or is closed. A container-CREATE
    // failure (e.g. a bad Docker mount spec) THROWS here — catch it and surface a visible error instead
    // of letting it escape to the chat bridge as a silent unhandled rejection (which looks like the brain
    // "hanging"); returning cleanly also lets the turn queue drain so the thread isn't wedged.
    let ensured: Awaited<ReturnType<JobLifecycleService['ensureContainer']>>;
    try {
      ensured = await this.lifecycle.ensureContainer(
        stimulus.jobId,
        stimulus.orgId,
        onMilestone,
      );
    } catch (err) {
      this.logger.error(
        `container attach failed for thread=${stimulus.jobId}: ${err}`,
      );
      await this.say(
        stimulus,
        `I couldn't start the workspace container for this thread. (${String(err).slice(0, 200)})`,
      );
      return;
    }
    if (!ensured) {
      this.logger.warn(
        `No sandbox for thread=${stimulus.jobId} team=${stimulus.orgId} — cannot run in-sandbox turn`,
      );
      await this.say(
        stimulus,
        'Please create a thread via the web app to start a scoping session.',
      );
      return;
    }
    const sandbox = ensured.sandbox;

    // Resolve the current session_id to resume across turns. A SESSION RE-HOME turn (open-PR / post_build)
    // resumes THIS thread's own session; every other turn resumes the job sandbox's. `sandboxRow` is still
    // fetched either way — later code (setup_error reporting, compaction) reads its job-level fields.
    const sandboxRow = await this.sandboxRows.findOne({
      where: { job_id: stimulus.jobId, org_id: stimulus.orgId },
    });
    const sessionId = stimulus.resumeThreadId
      ? ((await this.driverStore.threadSessionId(stimulus.resumeThreadId)) ??
        undefined)
      : (sandboxRow?.session_id ?? undefined);

    // COMPACTION turn: summarize the fat session into a lean handoff, null the session id (abandon the heavy
    // transcript), and stash the summary as the next turn's seed. Runs a summarization engine turn and
    // returns early — NOT a normal conversational turn. Serialized on this per-job queue, so it never races
    // the turn it compacts, and the build (separate driver sessions) is unaffected.
    if (stimulus.message.type === 'compaction') {
      await this.runCompaction(
        stimulus,
        sandbox,
        sandboxRow ?? null,
        sessionId,
      );
      return;
    }

    // Assemble THIS turn as an ordered envelope of framed chunks (chunk-vocabulary): system notices and
    // reminders wrap the body; `renderTurn` orders them canonically (notices → reminders → `<user>` last).
    // The body is a `<user>` chunk for a human message (reconstructed from author fields at engine time —
    // the persisted body stays clean) or an already-framed seed passthrough. `notice`/`reminder` chunks
    // are ALSO the units Phase 2 persists as visible transcript rows.
    const noticeChunks: TurnChunk[] = [];
    const reminderChunks: TurnChunk[] = [];

    // Cold re-attach while resuming a session → the session remembers in-container state that's gone. Add
    // the reset notice so it re-establishes its runtime instead of trusting stale beliefs. When this cold
    // attach follows a `reset_sandbox` teardown, we owe a VERIFY instruction — fold it into the notice so
    // it lands on THIS (the first cold) turn, whether that's the synthetic wake or a queued operator turn.
    if (ensured.wasReset && sessionId) {
      const owedVerify = this.pendingResetVerify.delete(resetKey);
      const notice = owedVerify
        ? `${SANDBOX_RESET_NOTICE}\n\n${RESET_VERIFY_TEXT}`
        : SANDBOX_RESET_NOTICE;
      noticeChunks.push({ kind: 'system_notice', body: notice });
      if (owedVerify) {
        this.logger.log(
          `reset_sandbox: fresh container up for thread=${stimulus.jobId} — this turn verifies the environment`,
        );
        // Operator-visible bookend to the reset pill: makes the reset→recreate→verify cycle legible in the
        // transcript (the fresh container was just attached; this turn re-establishes + checks the stack).
        await this.store
          .appendSystemEvent(
            stimulus.jobId,
            '🟢 Sandbox is back up on a fresh container — verifying the environment cold-booted from durable config.',
          )
          .catch((err) =>
            this.logger.debug(`appendSystemEvent failed: ${err}`),
          );
      }
    }

    // DRAIN a cold-boot setup-script failure into THIS turn (stamped on the row by JobLifecycleService after
    // the last attach). Folded here — regardless of warm/cold — so it reaches the very next brain turn: the
    // proactive wake for a fresh job, the reset→verify retest turn, the first operator turn after a warm
    // re-attach a cold-only notice would miss, or a restart. Cleared once folded so it fires exactly once.
    if (sandboxRow?.setup_error) {
      noticeChunks.push({
        kind: 'system_notice',
        body:
          `[setup script] Your repo setup script failed on the last cold sandbox bring-up:\n${sandboxRow.setup_error}\n` +
          'Fix the cause (a dependency, the script itself via `write_setup_script`, or a missing secret/mount), ' +
          'then `reset_sandbox` to re-run it cold and confirm.',
      });
      await this.sandboxRows
        .update({ id: sandboxRow.id }, { setup_error: null })
        .catch((err) => this.logger.debug(`clear setup_error failed: ${err}`));
    }

    // Which stage this turn runs as — gates the host-side prefixes below (d8: post_build/ci don't grill;
    // the amend return-path lives on post_build now). Resolved once here and reused at the tool-surface call
    // below so both never drift apart.
    const stageRole = await this.resolveStageKind(stimulus);

    // Surface the brain's OWN still-open questions back into THIS turn. Question cards live outside the
    // engine session — a fresh turn (a new operator message, an event delivery, or a restart-rebuilt session
    // whose context was compacted) has no in-context memory of what it already asked, so without this the
    // brain re-asks the same question over and over. Advisory reminder listing each open card's id + gist, so
    // it waits (or `withdraw_question`s) instead of re-posting. PLANNING-only: post_build/ci have no
    // `ask_question` tool (Thread 2), so there is nothing to remind them about.
    if (stageRole === 'planner') {
      const openQuestionsPrefix = await this.buildOpenQuestionsPrefix(
        stimulus.jobId,
      );
      if (openQuestionsPrefix) {
        reminderChunks.push({
          kind: 'system_reminder',
          body: openQuestionsPrefix,
          attrs: { reminderKind: 'open_questions' },
        });
      }
    }

    // Same idea for still-open file-upload requests (posted, not yet uploaded/withdrawn): a compacted or
    // restart-rebuilt session has no memory of what it requested, so without this it re-posts a duplicate
    // request_file. Advisory reminder listing each open card's id + destination path, so it waits (or
    // `withdraw_file_request`s a stale one) instead of re-requesting. Applies to every turn; best-effort.
    const openFilesPrefix = await this.buildOpenFileRequestsPrefix(
      stimulus.jobId,
    );
    if (openFilesPrefix) {
      reminderChunks.push({
        kind: 'system_reminder',
        body: openFilesPrefix,
        attrs: { reminderKind: 'open_file_requests' },
      });
    }

    // Same idea for still-open durable/mcp secret requests (posted, not yet provided/withdrawn): a compacted
    // or restart-rebuilt session has no memory of what it requested, so without this it re-posts a duplicate
    // request_secret. Advisory reminder listing each open card's id + target, so it waits (or
    // `withdraw_secret_request`s a stale one) instead of re-requesting. Applies to every turn; best-effort.
    const openSecretsPrefix = await this.buildOpenSecretRequestsPrefix(
      stimulus.jobId,
    );
    if (openSecretsPrefix) {
      reminderChunks.push({
        kind: 'system_reminder',
        body: openSecretsPrefix,
        attrs: { reminderKind: 'open_secret_requests' },
      });
    }

    // AMENDING guidance — persistent while the ship gate is retracted for a follow-up fix. BOTH entry paths
    // land in `amending`: the brain's own `withdraw_ship` proposal (which wakes the brain) AND the operator's
    // manual "Amend build" click (which does NOT wake the brain at all). A one-time wake can also be compacted
    // mid-amend. So re-state the return path EVERY turn while amending, so the brain always knows how to get
    // back to ready-to-ship. Best-effort; null unless the job is `amending`. POST_BUILD-only: the amend loop
    // now runs on the post_build session (d3), not planning — stop rendering it there.
    const amendingPrefix =
      stageRole === 'post_build'
        ? await this.buildAmendingPrefix(stimulus.jobId)
        : null;
    if (amendingPrefix) {
      reminderChunks.push({
        kind: 'system_reminder',
        body: amendingPrefix,
        attrs: { reminderKind: 'amending' },
      });
    }

    // JIT turn-prefix rail (d18): `operator-message` rules may prepend a `system_reminder`. The reserved
    // `memory` slot now carries auto-recalled facts (d1/d2) via `prependText`; empty → no chunk → byte-identical.
    if (
      isOperatorAuthored(stimulus) &&
      this.jit?.hasEnabledOperatorPrepends()
    ) {
      const prependText =
        (await this.buildMemoryRecallPrefix(stimulus, sessionId)) ?? undefined;
      reminderChunks.push(
        ...(this.jit?.collectOperatorPrepends({
          jobId: stimulus.jobId,
          ...(prependText ? { prependText } : {}),
        }) ?? []),
      );
    }

    // Compose the turn through the hub (d18): the operator path frames prefix chunks + chronological `<user>`
    // chunks via composeTurn (byte-identical to the old inline `framedPrefix ? `${framedPrefix}\n${body}` :
    // body`). A non-operator seed body is RAW/already-framed XML (engineBody returns it verbatim) — it can't
    // be a `<user>` chunk, so that path keeps the inline prefix+body concat.
    let task: AgentMessage;
    if (isOperatorAuthored(stimulus)) {
      const userChunks = stimulus.chunks?.length
        ? stimulus.chunks
        : [userChunkFor(stimulus)];
      task = composeTurn({
        prefixChunks: [...noticeChunks, ...reminderChunks],
        userChunks,
      });
    } else {
      // Non-operator seed body is RAW/already-framed passthrough (`engineBody` returns it verbatim) — it can't
      // be a `<user>` chunk, so frame it through the hub's seed-turn factory; `fromExternal` marks the non-hub
      // body at the seam rather than minting it locally.
      task = composeSeedTurn(
        [...noticeChunks, ...reminderChunks],
        fromExternal(this.engineBody(stimulus)),
      );
    }

    // Onboarding threads (`kind='onboarding'`) run a different mission prompt + a curated, build-free
    // toolset (the gating is enforced here, not just in prose — omitted tool names aren't registered).
    const brainJob = await this.store.loadJob(stimulus.jobId).catch(() => null);
    if (brainJob?.status === 'blocked') return;

    // Build the host-side tool dispatch table, scoped to this thread. Curated by kind (onboarding/review
    // get build-free subsets — see buildTools). The repo SLUG (not the UUID) gates the atlas-prod toolset,
    // resolved once here and reused for the jobContext.isAtlasRepo prompt flag below.
    const repoSlug = await this.resolveRepoSlug(stimulus.repoId);
    const tools = this.buildTools(
      stimulus,
      brainJob?.kind ?? null,
      repoSlug,
      stageRole,
    );

    // All turns run inside the Docker sandbox container.
    const runner: EngineRunnerPort = this.engineRunner;

    // The thread is a live web wrapper over this in-sandbox session: stream every engine event to the web
    // AND persist the authoritative blocks (text/thinking/tool) as the durable transcript.
    const route = await this.store.route({
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      jobId: stimulus.jobId,
    });
    const channel = route.channel ?? stimulus.replyRoute.jobRef;
    // The brain streams on the default `main` lane (no metaTag) — its blocks ARE the conversation.
    const threadId =
      stimulus.resumeThreadId ?? (await this.planningThreadId(stimulus.jobId));
    const streamer = this.turnHarness.create({
      jobId: stimulus.jobId,
      orgId: stimulus.orgId,
      threadId,
      channel,
      livePush: !this.engineRunner.pushesLiveRouteEvents,
    });
    // One-shot guard so THIS turn's fully-assembled prompt (the operator body PLUS the invisible folded
    // prefixes: compaction seed / reset notice / awareness / open-questions) is surfaced exactly once, on
    // the engine's turn-START `session` event — which fires ONLY for a turn that actually kicked, so the
    // single-brain-turn steer-away (BrainTurnAlreadyRunningError) and the detached-mid-flight early-return
    // never record a prompt for a turn that didn't run. Idempotent by stimulus id across re-drive/reattach.
    let promptEmitted = false;

    // Live-branch observation: the agent may `git checkout -b …` freely inside the sandbox. We watch its
    // git activity on the normalized engine event stream (works for BOTH Claude `Bash` and Codex
    // `command_execution` — they map to the same `tool_use`/`tool_result` pair) and re-read HEAD whenever a
    // BRANCH-AFFECTING git command settles. `branchCommandById` buffers each git command by its tool id so
    // we can match it on the paired `tool_result` (post-settle); `lastObservedBranch` de-dupes writes so a
    // no-op `git checkout <file>` doesn't churn the row (and its realtime WAL delta). Observe only — Atlas
    // never asserts the branch here; `feature_branch` stays the host-named canonical.
    const branchCommandById = new Map<string, string>();
    let lastObservedBranch: string | null = null;

    const sandboxKey: EngineHomeKey = {
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      jobId: stimulus.jobId,
      type: 'brain',
    };
    // Per-org Claude subscription secret (deployed); undefined locally → the in-container engine falls
    // back to CLAUDE_OAUTH_TOKEN, and throws if neither is set (never an API-key fallback).
    const auth = await this.creds.engineAuth(stimulus.orgId, 'claude');
    // User-defined MCP servers active on the brain surface for this org/repo (secrets inlined host-side).
    const userMcpServers = await this.mcp.resolveForTurn(
      stimulus.orgId,
      stimulus.repoId,
      'brain',
    );
    // The repo's opt-in house-style profile (null when none attached → nothing injected). Fed into the
    // ATLAS_MAIN prompt below AND forwarded on the run args so any FAN_OUT/REVIEW_AGENT subagent the turn
    // spawns in-container gets the same envelope (Layer B).
    const repoConventions =
      (await this.conventions?.resolveForRepo(
        stimulus.orgId,
        stimulus.repoId,
      )) ?? null;
    // The CURRENT state of this repo's Workspace Profile + any host-derived GAPS (an approved MCP server
    // with an unfilled secret slot, or a new dependency manifest the profile hasn't acknowledged) the
    // brain can't otherwise see. Gaps render ONLY when present, so a healthy profile adds nothing — upkeep
    // is a concrete conditional signal, not standing prompt prose. Null when the service is absent (unit
    // tests) or the render is empty → the group prints "nothing recorded yet".
    let workspaceProfile: string | null = null;
    if (this.workspaceProfile) {
      const rendered = this.workspaceProfile.render(
        await this.workspaceProfile.describe(stimulus.orgId, stimulus.repoId),
      );
      const gaps = this.workspaceProfile.renderGaps(
        await this.workspaceProfile.computeGaps(
          stimulus.orgId,
          stimulus.repoId,
          detectRepoManifests(sandbox.worktreePath),
        ),
      );
      workspaceProfile = gaps ? `${rendered}\n\n${gaps}` : rendered;
    }
    // This repo's skills, resolved for the brain surface — forwarded on the run args so the in-container
    // engine symlinks each into `<CLAUDE_CONFIG_DIR>/skills/`, natively discovered by the SDK (Layer B,
    // like `userMcpServers`/`repoConventions`).
    const skills =
      (await this.skills?.resolveForTurn(
        stimulus.orgId,
        stimulus.repoId,
        'brain',
      )) ?? [];
    // This job's currently-approved skill edit-access grants (`request_skill_edit_access`), if any — see
    // `skillEditGrantsByJob` / `grantSkillEditAccess`.
    const grantedSkills = this.skillEditGrantsByJob.get(stimulus.jobId);
    // Authenticated git for the operator-facing brain turn: resolve the repo url + org PAT (cached per
    // job) so the brain can fetch/merge/rebase/resolve-conflicts/push directly from inside the sandbox —
    // it OWNS git, not the host. Sourced from the resolved repo, never `sandbox` (a row-sourced sandbox
    // has an empty gitUrl/no token). Undefined → remote git ops fail closed (GIT_TERMINAL_PROMPT=0).
    const gitAuth = await this.resolveBrainGitAuth(stimulus.jobId);
    // Per-job orientation facts for the CURRENT JOB prompt block (identity.group). The STABLE repo bits
    // ride the cache resolveBrainGitAuth just populated (no second `repos.resolve` — that does a network
    // GET /user). Every field is optional: a missing target (git disabled) drops the repo/base lines, and
    // an uncut feature branch drops the branch line — the fragment guards each.
    const gitTarget = this.gitTargetByJob.get(stimulus.jobId);
    const branch =
      brainJob?.featureBranch ?? brainJob?.currentBranch ?? undefined;
    const baseBranch =
      brainJob?.baseBranch ?? gitTarget?.defaultBranch ?? undefined;
    const jobContext = {
      ...(gitTarget
        ? { repoName: `${gitTarget.owner}/${gitTarget.repo}` }
        : {}),
      // The current sidebar label — so the brain can judge whether a propose_plan should re-title the job.
      ...(brainJob?.title ? { title: brainJob.title } : {}),
      ...(branch ? { branch } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      ...(this.env && isAtlasRepo(repoSlug ?? '', this.env)
        ? { isAtlasRepo: true }
        : {}),
    };
    const promptAgent = threadKindSpec(stageRole).agent;

    const runArgs: RunEngineArgs = {
      engine: 'claude',
      task,
      cwd: sandbox.worktreePath,
      // Assembled from fragments: which stage persona (PLANNING/POST_BUILD/CI) resolved just above from the
      // thread's role — the onboarding vs normal-brain split is a jobKind condition, not a separate prompt id
      // (`isOnboarding` still gates the toolset above). PLANNING stays byte-identical to the legacy ATLAS_MAIN
      // (see prompt-service.spec — the brain is assembled purely from `@Fragment`s).
      systemPrompt: this.prompts.generate(promptAgent, {
        jobKind: brainJob?.kind ?? null,
        job: jobContext,
        settings: {
          repoConventions,
          workspaceProfile,
          autoApproveMode: brainJob?.autoApproveMode ?? 'off',
          autoMerge: brainJob?.autoMerge ?? false,
        },
      }),
      sandboxKey,
      ...(auth ? { auth } : {}),
      ...(userMcpServers.length > 0 ? { userMcpServers } : {}),
      ...(repoConventions ? { repoConventions } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(grantedSkills && grantedSkills.size > 0
        ? { grantedSkills: Array.from(grantedSkills) }
        : {}),
      mode: 'execute', // the session manages its own read-only posture via custom plan mode
      model: AgentSessionManager.BRAIN_MODEL, // the thread brain reasons/plans — pin it to Opus
      ...(threadKindSpec(stageRole).reasoningEffort
        ? { modelReasoningEffort: threadKindSpec(stageRole).reasoningEffort }
        : {}),
      richStream: true, // token-level deltas + thinking + tool calls/results (the brain conversation)
      steerable: true, // streaming-input mode: operator messages steer this turn mid-flight (priority:'now')
      ...(sessionId ? { sessionId } : {}),
      ...(sandbox.containerId
        ? {
            target: {
              containerId: sandbox.containerId,
              worktreeHost: sandbox.worktreePath,
              ...(gitAuth ? { gitAuth } : {}),
              evidenceDir: `${CONTAINER_CONTEXT}/evidence`,
            },
          }
        : {}),
      toolBridge: {
        jobId: stimulus.jobId,
        tools,
      },
      // Registry context for restart-survival (only acted on by the Redis runner): records an
      // `active_turns` row so a fresh backend can re-attach to this turn after a restart. See ADR 0001.
      turnMeta: {
        jobId: stimulus.jobId,
        orgId: stimulus.orgId,
        channel,
        lane: this.laneForStimulus(stimulus),
        kind: 'brain',
        // Enough to rebuild the TurnEnvelope + buildTools closure on a boot re-attach (see reattachOne).
        // `type` + the delivered-id arrays are persisted so a re-attached DELIVERY turn can still stamp its
        // card `deliveredAt` on success — otherwise the boot sweep would re-seed that card on every restart.
        ctx: {
          repoId: stimulus.repoId,
          sandboxKey,
          author: stimulus.author,
          body: stimulus.body,
          type: stimulus.message.type,
          // The delivered-card ids (one per solo card, many per combined batch) — persisted so a re-attached
          // delivery turn stamps every card on success (else the boot sweep re-seeds each card on every restart).
          ...(stimulus.deliveredQuestionIds?.length
            ? { deliveredQuestionIds: stimulus.deliveredQuestionIds }
            : {}),
          ...(stimulus.deliveredFileIds?.length
            ? { deliveredFileIds: stimulus.deliveredFileIds }
            : {}),
          ...(stimulus.deliveredSecretIds?.length
            ? { deliveredSecretIds: stimulus.deliveredSecretIds }
            : {}),
          // Durable stimulus id for a seed-CARD delivery — carried so a reattach-completed turn stamps the RIGHT
          // `stimuli` row + its card together (here `stimulus.id` is the fresh-turn `combined.id` = `stimuli.id`).
          // Scoped to card seeds so event/wake seeds (no card, no owned row) don't drag their id through the tail.
          ...(isSeedCardDelivery(stimulus)
            ? { deliveryStimulusId: stimulus.id }
            : {}),
          // Session re-home target: a reattach must persist onto the same thread, not the job sandbox.
          ...(stimulus.resumeThreadId
            ? { resumeThreadId: stimulus.resumeThreadId }
            : {}),
        },
      },
      ...(opts?.onRegistered ? { onTurnRegistered: opts.onRegistered } : {}),
      // Realtime live push to the operator UI via RedisEngineRunner's independent `realtime` consumer group
      // (mirrors this `onEvent`→streamer wiring). Same lane the brain conversation streams on.
      liveRoute: { channel, jobId: stimulus.jobId, lane: 'main' },
      onEvent: (e) => {
        if (e.kind === 'session' && e.sessionId) {
          this.bindInjectedMemorySession(stimulus.jobId, e.sessionId);
        }
        // Surface THIS turn's fully-assembled prompt on the `main` lane, once, on the turn-START `session`
        // event (see `promptEmitted` above for why this is the right hook). Fire-and-forget; insert-once by
        // stimulus id, so a re-drive/reattach of the same message never duplicates it.
        if (e.kind === 'session' && !promptEmitted) {
          promptEmitted = true;
          void streamer.emitPrompt(task, `brain:${stimulus.id}`);
          // Persist the injected system_notice / system_reminder chunks as visible transcript rows (behind
          // HARNESS_CHUNK_ROWS). Co-located with emitPrompt's one-shot so it fires exactly once per real
          // turn kick — insert-once by chunkKey inside the store makes re-drive/reattach idempotent too.
          this.persistChunkRows(stimulus, noticeChunks, reminderChunks);
        }
        // EAGER session-id persist: the engine emits `{kind:'session'}` at turn START (before any work), so
        // a turn interrupted on its FIRST exchange — which never reaches the post-run persist below — still
        // leaves a resolvable session id on the row (helps resume AND crash recovery locate the transcript).
        // Fully defensive: a persistence hiccup here must NEVER break the live event stream.
        // SESSION RE-HOME turn (open-PR / post_build): persist the fresh session onto THIS thread's row, never
        // the job sandbox — and skip the compaction-seed bookkeeping entirely (a re-home turn never compacts).
        if (e.kind === 'session' && e.sessionId && stimulus.resumeThreadId) {
          const sid = e.sessionId;
          const threadId = stimulus.resumeThreadId;
          try {
            void this.driverStore
              .setThreadSessionId(threadId, sid)
              .catch((err) =>
                this.logger.warn(
                  `eager thread session_id persist failed for thread=${threadId}: ${err}`,
                ),
              );
          } catch (err) {
            this.logger.warn(
              `eager thread session_id persist threw for thread=${threadId}: ${err}`,
            );
          }
        } else if (
          e.kind === 'session' &&
          e.sessionId &&
          sandboxRow &&
          sandboxRow.session_id !== e.sessionId
        ) {
          const sid = e.sessionId;
          sandboxRow.session_id = sid;
          try {
            void Promise.resolve(
              this.sandboxRows.update(
                { job_id: stimulus.jobId, org_id: stimulus.orgId },
                { session_id: sid },
              ),
            ).catch((err) =>
              this.logger.warn(
                `eager session_id persist failed for thread=${stimulus.jobId}: ${err}`,
              ),
            );
          } catch (err) {
            this.logger.warn(
              `eager session_id persist threw for thread=${stimulus.jobId}: ${err}`,
            );
          }
        }
        // Live-branch observation (see `branchCommandById` above). Buffer a branch-affecting git command on
        // its `tool_use`, then re-read HEAD when the paired `tool_result` settles — so a `git checkout -b …`
        // is reflected in `current_branch` the instant it lands, before the turn even ends. Fully defensive:
        // a git/DB hiccup must never break the live stream (the per-turn backstop below is the floor).
        if (e.kind === 'tool_use') {
          const cmd = (e.input as { command?: unknown } | undefined)?.command;
          if (
            typeof cmd === 'string' &&
            /\bgit\b/.test(cmd) &&
            /(checkout|switch|\bbranch\b|worktree)/.test(cmd)
          ) {
            branchCommandById.set(e.id, cmd);
          }
        } else if (e.kind === 'tool_result' && branchCommandById.has(e.id)) {
          branchCommandById.delete(e.id);
          void this.git
            .currentBranch(sandbox.worktreePath)
            .then((live) => {
              if (live && live !== lastObservedBranch) {
                lastObservedBranch = live;
                return this.driverStore.setCurrentBranch(stimulus.jobId, live);
              }
              return undefined;
            })
            .catch((err) =>
              this.logger.warn(
                `live-branch sample failed for thread=${stimulus.jobId}: ${err}`,
              ),
            );
        }
        // Durable chat delivery: an `input_ack` means the engine PUSHED a steered operator message into the
        // session — stamp that stimulus `delivered_at` (the only place a steer is marked delivered).
        this.stampInputAck(e);
        streamer.onEvent(e);
      },
    };

    let result;
    try {
      result = await runner.run(runArgs);
      if (result.turnId) streamer.bindTurnId(result.turnId);
    } catch (err) {
      if (err instanceof BrainTurnAlreadyRunningError) {
        // Lost the check→register race: a concurrent/reattached brain turn is already live for this job, so
        // the runner refused to kick a second engine. Steer this stimulus into the live turn instead of
        // surfacing a scary error box. Do NOT `streamer.finish()` here — this aborted turn shares the `main`
        // lane with the live turn, and ending it would clobber the live turn's stream (no turn_start was
        // fanned yet — the first engine event fans it — so there is nothing to clean up). If the live turn
        // vanished in the meantime there is nothing to steer into; the pump sweep / boot re-seed re-drives.
        if (!(await this.steerIntoLiveBrainTurn(stimulus))) {
          this.logger.warn(
            `single-brain-turn guard hit but no live turn to steer for job=${stimulus.jobId} — leaving for re-drive`,
          );
        }
        return;
      }
      if (isEngineDetachedError(err)) {
        // NOT a turn failure — this process lost its tail mid-turn (its own shutdown during a watch
        // respawn). The detached engine keeps running; the registry row + streams were left in place, and
        // the next boot's re-attach resumes streaming + persists the turn. Flush NOTHING here (a partial
        // persist would double against the re-attach's full replay) and post no error box.
        this.logger.warn(
          `turn detached mid-flight for thread=${stimulus.jobId} — awaiting boot re-attach: ${err}`,
        );
        return;
      }
      this.logger.error(
        `in-sandbox turn failed for thread=${stimulus.jobId}: ${err}`,
      );
      // A normal turn's benign abort finishes (keeps its partial) and gets the continue-nudge below; a real
      // failure always keeps its partial.
      const benignAbort = this.isBenignStreamAbort(err);
      if (this.engineRunner.consumeClaim?.(stimulus.id) === false) {
        // Best-effort claim check: on the fresh-run path the engine turnId is generated INSIDE runner.run
        // (randomUUID) and never surfaced here, so `stimulus.id` won't match it — consumeClaim returns
        // undefined and we fall through to finish() (the safe back-compat default). The confirmed dup is the
        // SUCCESS path, which IS gated above via `result.claimed`.
        await streamer.discard();
      } else {
        await streamer.finish();
      }
      // A turn failure is a HARNESS error, never Atlas talking — both branches post a system→operator
      // notice (its own red box, not an Atlas bubble). Show the TRUE error verbatim, no narrative wrapper
      // ("I ran into an error — please try again") and no truncation — the box is a full panel, not a
      // card field with a length limit. An unresumable session gets one extra line of guidance and NO
      // resume option (retrying truly can't help — the transcript is gone, see `isUnresumableSessionMessage`);
      // any other failure is just the raw error, marked `retryable` so the web offers a "Resume" button
      // that re-pokes the SAME engine session (`POST …/retry-turn`) without a new operator message.
      // Classification-consistency check (post-#231): a Claude session limit that hit mid-turn is latched
      // into a clean `result.sessionLimit` by engine-core's outer catch BEFORE this `catch (err)` block ever
      // runs — a thrown `err` reaching here can never be the session-limit shape, so none of the branches
      // below (nor `isRetryableTransientError`) needs its own session-limit exclusion beyond the defensive
      // one `isRetryableTransientError` already carries.
      if (isUnresumableSessionMessage(String(err))) {
        const { category, summary } = summarizeTurnFailure(err);
        await this.saySystemOperator(
          stimulus,
          `${String(err)}\n\nThis thread can't continue — its engine session state is gone. Please start a new thread to pick this back up.`,
          { category, summary },
        );
      } else if (benignAbort) {
        // A self-recovering SDK stream abort (`aborted_streaming`) — NOT a real failure the operator must
        // act on. The engine-side hold makes the startup-race variant impossible; this is the net for any
        // residual/other abort. Instead of a scary red box, silently resume the SAME session once (the same
        // nudge the operator's Resume button seeds), bounded so a PERSISTENT abort still surfaces a box.
        const { ok, used: n } = await this.store.claimBenignAbortRedrive(
          stimulus.jobId,
          AgentSessionManager.MAX_BENIGN_ABORT_REDRIVES,
        );
        if (ok) {
          this.logger.warn(
            `benign aborted_streaming for thread=${stimulus.jobId} — auto-resuming (attempt ${n}/${AgentSessionManager.MAX_BENIGN_ABORT_REDRIVES}), no operator box: ${err}`,
          );
          // Name the task in the nudge — a bare "Please continue." on a cold re-attach is exactly what left
          // the brain disoriented (posting a needless "what should I continue?" question). The title orients it.
          const title = await this.store
            .jobTitle(stimulus.jobId)
            .catch(() => null);
          const nudge = retryResumeNudge(title ?? undefined);
          // `seedRow: 'skip'` keeps this re-drive SILENT: the durable stimulus row is still written (the
          // brain turn is driven), but no operator-facing transcript pill is rendered. This auto-resume was
          // always meant to have "no operator box" — a bare seed with no seedRow falls through to the generic
          // "A harness system notification was delivered to Atlas." pill, which is the leak we're closing.
          this.surface.seedSystemNotification?.(
            stimulus.repoId,
            stimulus.jobId,
            nudge,
            {
              orgId: stimulus.orgId,
              seedRow: 'skip',
            },
          );
        } else {
          this.logger.warn(
            `benign aborted_streaming recurred ${n}× for thread=${stimulus.jobId} — surfacing retryable box`,
          );
          const { category, summary } = summarizeTurnFailure(err);
          await this.saySystemOperator(stimulus, String(err), {
            retryable: true,
            category,
            summary,
          });
        }
      } else if (isRetryableTransientError(err)) {
        // Host-side backstop for an error the SDK did NOT retry (a transient auth hiccup or a host↔container
        // transport/infra blip): re-drive the SAME session up to MAX_HOST_RETRIES with a fixed backoff,
        // posting a quiet durable notice + driving the live "Reconnecting…" indicator each attempt. Only an
        // exhausted budget surfaces the retryable box.
        const { ok, used: n } = await this.store.claimTransientRetryRedrive(
          stimulus.jobId,
          MAX_HOST_RETRIES,
        );
        if (ok) {
          this.logger.warn(
            `retryable transient error for thread=${stimulus.jobId} — auto-retry ${n}/${MAX_HOST_RETRIES} in ${HOST_RETRY_BACKOFF_MS}ms: ${err}`,
          );
          await this.store.appendSystemNotice(
            stimulus.jobId,
            `Reconnecting to Claude — auto-retry ${n}/${MAX_HOST_RETRIES}…`,
          );
          // Fan the live indicator AFTER the turn_end from the earlier finish() (retry() uses a fresh higher
          // seq). Best-effort: the durable notice above is the real deliverable.
          this.liveTurns?.retry(channel, stimulus.jobId, MAIN_LANE, {
            attempt: n,
            max: MAX_HOST_RETRIES,
            nextAttemptAt: Date.now() + HOST_RETRY_BACKOFF_MS,
          });
          await this.scheduleHostRetry(stimulus, String(err));
        } else {
          this.logger.warn(
            `retryable transient error recurred ${n}× for thread=${stimulus.jobId} — surfacing retryable box`,
          );
          const { category, summary } = summarizeTurnFailure(err);
          await this.saySystemOperator(stimulus, String(err), {
            retryable: true,
            category,
            summary,
          });
        }
      } else {
        const { category, summary } = summarizeTurnFailure(err);
        await this.saySystemOperator(stimulus, String(err), {
          retryable: true,
          category,
          summary,
        });
      }
      return;
    }
    // A turn completed without throwing — clear any benign-abort auto-resume budget for this thread. Gated on
    // `!result.sessionLimit`: a session-limit turn is handled by the dedicated branch below, which owns its
    // own `session_limit_text_misfires` bookkeeping (increment-on-quiet-retry, reset-on-park) — clearing it
    // here unconditionally would wipe the consecutive-misfire streak on EVERY text-fallback hit (this same
    // "clean turn" path runs for a session-limit result too, since it doesn't throw), so the N=3 backstop
    // could never accumulate past 1 across re-drives.
    if (!result.sessionLimit) {
      await this.store.clearBrainRetryCounters(stimulus.jobId);
    }
    // …and cancel any still-pending host-retry backstop (timer + durable retry clock): this clean turn IS the
    // recovery, so a stale 10s timer must not fire a spurious 'Please continue' nudge on the now-healthy job.
    await this.clearPendingHostRetry(stimulus.jobId);

    // Live-branch backstop (universal floor): re-read HEAD once at the turn boundary in case the per-tool
    // listener missed a switch (a branch change not made via a matched `git` command, or a dropped event).
    // Best-effort + null/unchanged-guarded so it never writes over a known branch or churns the row.
    void this.git
      .currentBranch(sandbox.worktreePath)
      .then((live) => {
        if (live && live !== lastObservedBranch) {
          lastObservedBranch = live;
          return this.driverStore.setCurrentBranch(stimulus.jobId, live);
        }
        return undefined;
      })
      .catch((err) =>
        this.logger.warn(
          `live-branch backstop failed for thread=${stimulus.jobId}: ${err}`,
        ),
      );

    // Persist the session_id for resume. A SESSION RE-HOME turn persists onto its thread; every other turn
    // onto the job sandbox.
    if (result.sessionId && stimulus.resumeThreadId) {
      this.bindInjectedMemorySession(stimulus.jobId, result.sessionId);
      await this.driverStore.setThreadSessionId(
        stimulus.resumeThreadId,
        result.sessionId,
      );
    } else if (result.sessionId && sandboxRow) {
      this.bindInjectedMemorySession(stimulus.jobId, result.sessionId);
      sandboxRow.session_id = result.sessionId;
      await this.sandboxRows.save(sandboxRow);
    }

    // SESSION/USAGE LIMIT PARK (Main lane): the engine ended the turn CLEANLY on a Claude subscription limit
    // (not a crash). Park the lane on the durable resume clock — the Main lane has no `halt`, so the clock IS
    // the park marker — finalize the live stream as a GRACEFUL end (the turn already ended; just flush, don't
    // run the triage success tails), post ONE stable notice, and stop. The leader sweep auto-resumes at the
    // reset (or the operator Force-resumes via `POST …/retry-turn`); every un-park path clears the clock.
    if (result.sessionLimit) {
      if (this.lost(result)) {
        await streamer.discard();
        return;
      }
      const rlType = result.sessionLimit.rateLimitType;
      const source = result.sessionLimit.source;
      const util =
        source === 'text'
          ? await this.usage
              .getUtilization(stimulus.orgId, rlType)
              .catch(() => undefined)
          : undefined;

      const durablePark = async (): Promise<void> => {
        const resumeAt =
          result.sessionLimit?.resetAt ??
          (await this.usage.getResetAt(stimulus.orgId, rlType));
        // The Main lane has no `halt`, so the durable clock IS the park marker: when no precise reset is known,
        // seed a BOUNDED default (now + shortest window) so the leader sweep auto-resumes and a process restart
        // still has something to resume — a null clock would strand the lane on manual Force-resume only.
        const resumeClock = resumeAt ?? defaultResumeAt();
        // Reflect the limit in the org's usage snapshot so the composer ring reads the session as FULL until
        // reset — covers the text-fallback path too (no `rate_limit_event` frame was harvested).
        void this.usage
          .applyHarvest(stimulus.orgId, {
            status: 'rejected',
            rateLimitType: rlType,
            resetsAt: new Date(resumeClock).getTime(),
            utilization: 100,
            credentialId: auth?.refreshBack?.credentialId,
          })
          .catch(() => undefined);
        const resetSource: 'usage_api' | 'parsed_string' = rlType
          ? 'usage_api'
          : 'parsed_string';
        const reason = `Claude session limit${rlType ? ` (${rlType})` : ''}${resumeAt ? `; resets ${resumeAt}` : ''}`;
        await this.store
          .setSessionResume(stimulus.jobId, resumeClock, {
            lane: 'main',
            reason,
            resetSource,
          })
          .catch((err) => this.logger.warn(`setSessionResume failed: ${err}`));
        // Graceful finish, mirroring the normal success finish below — so the lane doesn't hang and the
        // transcript flushes — WITHOUT the halt-wake / secret / file success-tail writes (no triage happened).
        // Do not pass `result.result`: on some SDK paths that final summary is the same printed limit line the
        // engine suppressed from text blocks, and `finish()` would persist it as a normal chat fallback.
        await streamer.finish(
          undefined,
          result.usage
            ? {
                usage: result.usage,
                contextTokens: result.usage.contextTokens ?? null,
                contextLimit: resolveContextLimit(
                  result.usage.contextModel ?? result.usage.model,
                ),
                credentialId: result.credentialId ?? null,
              }
            : undefined,
        );
        void this.usageProjector?.record(
          {
            jobId: stimulus.jobId,
            orgId: stimulus.orgId,
            lane: 'main',
            kind: 'brain',
            engine: 'claude',
            credentialId: result.credentialId ?? null,
          },
          result.usage,
        );
        await this.saySystemOperator(
          stimulus,
          `You've hit your session limit — resets ${resumeAt ? this.fmtReset(resumeAt) : 'soon'}. Auto-resumes then; use Force resume now to resume earlier.`,
          {
            retryable: false,
            sessionLimit: true,
            category: 'session_limit',
            summary:
              "You've hit your Claude session limit — it auto-resumes at reset.",
            ...(resumeAt ? { resumeAt } : {}),
          },
        );
        await this.store.clearBrainRetryCounters(stimulus.jobId);
      };

      if (isCorroboratedSessionLimit(source, util)) {
        await durablePark();
      } else {
        const { ok, used } = await this.store.claimSessionLimitTextMisfire(
          stimulus.jobId,
          SESSION_LIMIT_TEXT_MISFIRE_MAX,
        );
        if (!ok || used >= SESSION_LIMIT_TEXT_MISFIRE_MAX) {
          this.logger.warn(
            `job=${stimulus.jobId} text-only session limit unconfirmed x${SESSION_LIMIT_TEXT_MISFIRE_MAX} — parking`,
          );
          await durablePark(); // backstop escalation
        } else {
          this.logger.warn(
            `job=${stimulus.jobId} unconfirmed text-only session limit (util=${util ?? 'unknown'}) — quiet host-retry`,
          );
          await streamer.finish(
            undefined,
            result.usage
              ? {
                  usage: result.usage,
                  contextTokens: result.usage.contextTokens ?? null,
                  contextLimit: resolveContextLimit(
                    result.usage.contextModel ?? result.usage.model,
                  ),
                  credentialId: result.credentialId ?? null,
                }
              : undefined,
          );
          void this.usageProjector?.record(
            {
              jobId: stimulus.jobId,
              orgId: stimulus.orgId,
              lane: 'main',
              kind: 'brain',
              engine: 'claude',
              credentialId: result.credentialId ?? null,
            },
            result.usage,
          );
          await this.scheduleHostRetry(
            stimulus,
            'unconfirmed session limit (text fallback)',
          );
        }
      }
      return;
    }

    // Flush the durable transcript (persists any unpaired tool call + a text fallback if the turn emitted
    // no text block) + a `turn_meta` block (per-turn token usage + context-window occupancy, when the SDK
    // reported usage), then signal turn end so the client reconciles its live buffer against /messages.
    if (this.lost(result)) {
      await streamer.discard();
      return;
    }
    await streamer.finish(
      result.result,
      result.usage
        ? {
            usage: result.usage,
            // Occupancy = the per-call context size (NOT the cumulative billing `inputTokens`, which
            // sums every round-trip's cache re-reads and blows past the window). Null when the engine
            // didn't surface per-call usage — better a blank ring than a wrong ~94%.
            contextTokens: result.usage.contextTokens ?? null,
            // Resolve the window from the MAIN agent's model, not a helper picked up by billing usage.
            contextLimit: resolveContextLimit(
              result.usage.contextModel ?? result.usage.model,
            ),
            credentialId: result.credentialId ?? null,
          }
        : undefined,
    );
    void this.usageProjector?.record(
      {
        jobId: stimulus.jobId,
        orgId: stimulus.orgId,
        lane: 'main',
        kind: 'brain',
        engine: 'claude',
        credentialId: result.credentialId ?? null,
      },
      result.usage,
    );

    // SUCCESS TAIL — a solo seed-card fresh turn stamps its DURABLE stimulus row + exact card together here
    // (its `onRegistered` deferred the row stamp) so a register-then-fail turn leaves both unstamped and the
    // sweep re-drives it. On this path `stimulus.id === stimuli.id` (seeds deliver solo). Internal legacy
    // in-memory seeds have no row, so fall back to the old best-effort direct card stamp.
    if (isSeedCardDelivery(stimulus)) {
      const result = await this.stampSeedCardSuccessTails(stimulus.id);
      if (result === 'missing') await this.stampLegacySeedCard(stimulus);
    }

    // SUCCESS TAIL — honor a pending `reset_sandbox`: tear the container down NOW (safe here — the engine
    // exec for this turn has already returned) and kick a fresh-container verify turn. Only on the happy
    // path: an errored/detached turn returns earlier, leaving the request for a retry to honor.
    await this.maybeHonorSandboxReset(stimulus);
  }

  /**
   * If this turn's Atlas called `reset_sandbox`, recreate the sandbox: tear the container down (keeping the
   * durable worktree + session) and kick a synthetic continuation so Atlas verifies on the fresh box. The
   * verify instruction itself rides the reset-notice (see the notice fold in `runChatTurnInner`) so it lands
   * on whichever turn cold-attaches first; this continuation only guarantees a turn happens when nothing
   * else is queued. Fire-and-forget: awaiting `handleChatTurn` here would deadlock on the per-thread queue.
   */
  private async maybeHonorSandboxReset(stimulus: TurnEnvelope): Promise<void> {
    const key = `${stimulus.orgId}:${stimulus.jobId}`;
    const req = this.resetRequests.get(key);
    if (!req) return;
    this.resetRequests.delete(key);
    this.logger.log(
      `reset_sandbox: honoring ${req.hard ? 'HARD ' : ''}reset for thread=${stimulus.jobId} (reason: ${req.reason}) — tearing down`,
    );

    // HARD reset re-provisions the whole sandbox (worktree + container, session preserved); the default reset
    // recreates only the container. Both keep `session_id`, so the fresh box resumes the same brain session.
    const res = await (
      req.hard
        ? this.lifecycle.hardResetSandbox(stimulus.jobId, stimulus.orgId)
        : this.lifecycle.resetContainer(stimulus.jobId, stimulus.orgId)
    ).catch((err) => {
      this.logger.warn(
        `reset_sandbox ${req.hard ? 'hard-' : ''}teardown failed for thread=${stimulus.jobId}: ${err}`,
      );
      return { reset: false, reason: 'no-container' } as const;
    });

    if (!res.reset) {
      this.logger.log(
        `reset_sandbox: skipped for thread=${stimulus.jobId} — ${res.reason}`,
      );
      const pill =
        res.reason === 'busy'
          ? '🔄 Sandbox reset skipped — a build is currently running in this container. Try again once it finishes.'
          : '🔄 Sandbox reset skipped — no live container to recreate (it will start fresh on the next turn anyway).';
      await this.store
        .appendSystemEvent(stimulus.jobId, pill)
        .catch((err) => this.logger.debug(`appendSystemEvent failed: ${err}`));
      return;
    }
    this.logger.log(
      `reset_sandbox: container torn down for thread=${stimulus.jobId} — kicking verify continuation`,
    );

    // NOTE: the operator-visible "reset requested" pill is posted by the TOOL (mid-turn, so it lands on this
    // turn's reconcile); the "back up — verifying" bookend is posted by the verify turn's notice-fold. Nothing
    // is posted here — a tail-posted pill would miss this turn's reconcile (turn_end already fired).
    this.pendingResetVerify.add(key);

    void this.handleChatTurn(
      seedEnvelope({
        ...seedBase({
          jobId: stimulus.jobId,
          orgId: stimulus.orgId,
          repoId: stimulus.repoId,
        }),
        type: 'reset_verify',
      }),
    ).catch((err) =>
      this.logger.warn(
        `reset_sandbox verify continuation failed for thread=${stimulus.jobId}: ${err}`,
      ),
    );
  }

  /** Resolve a repo's SLUG from its id (cached). The atlas-prod toolset gates on the SLUG (=== ATLAS_REPO_SLUG),
   *  NEVER the repoId UUID. A light RepoEntity lookup — NOT `repos.resolve()` (which does a network git GET). */
  private async resolveRepoSlug(repoId: string): Promise<string | null> {
    if (!this.repoRows) return null;
    if (this.repoSlugCache.has(repoId))
      return this.repoSlugCache.get(repoId) ?? null;
    const row = await this.repoRows
      .findOne({ where: { id: repoId } })
      .catch(() => null);
    const slug = row?.slug ?? null;
    this.repoSlugCache.set(repoId, slug);
    return slug;
  }

  // ── Host-side tool impls ───────────────────────────────────────────────────────────────────────

  /**
   * Build the host tool impls for a chat turn, all scoped to the stimulus's thread/team/project. The
   * toolset is CURATED by job kind: an `onboarding` thread gets the build-free bring-up tools; a `review`
   * thread (reviews an existing PR, never builds) gets ask/memory/secret tools only — NO plan/build/PR
   * tools; every other kind gets the full set. The omission is enforced (the in-container SDK only
   * registers names present in the returned map), so a gated-out tool is un-callable, not just discouraged.
   */
  buildTools(
    stimulus: TurnEnvelope,
    kind: string | null = null,
    repoSlug: string | null = null,
    role: ThreadRole | null = null,
  ): Record<string, ToolImpl> {
    const onboarding = kind === 'onboarding';
    const review = kind === 'review';
    const postBuild = role === 'post_build';
    const ci = role === 'ship';
    // The brain's own live checklist — the SAME `task_*` host-bridge tools the build threads register,
    // scoped to the job's planning stage. Carried by all three branches (normal/review/onboarding) since
    // every persona prompt teaches the task-list discipline.
    const taskTools = makeTaskTools(this.taskSink, {
      kind: 'main',
      id: stimulus.jobId,
    });
    // CREATE a decision (the `create_decision` tool). Auto-attaches
    // the question the operator just answered — sourced AUTHORITATIVELY from the thread's human-input gate
    // pointer (no "latest answered card" race), persists with a fresh stable id, re-renders the generated
    // record, and returns the FULLY-RESOLVED decision (id + attached Q&A) — so the brain holds ground truth
    // in context and never needs a read-back before submit_plan.
    const createDecision: ToolImpl = async (args) => {
      const envelope = missingArgsEnvelope(args);
      if (envelope) return envelope;
      const decisionClass = asDecisionClass(args['decisionClass']);
      const ruling = String(args['ruling'] ?? '').trim();
      if (!decisionClass) {
        return {
          ok: false,
          reason:
            'decisionClass must be one of: data_model | api_contract | dependency | infrastructure | ' +
            'cross_cutting | one_way_door',
        };
      }
      if (!ruling) return { ok: false, reason: 'ruling is required' };

      // Attach the answered question: an explicit `questionId` (the brain named which question this
      // decision settles — important when several are open) wins, else the card THIS turn delivered, else
      // the most-recently-answered unlogged card. No single-slot pointer.
      const explicitQuestionId =
        typeof args['questionId'] === 'string'
          ? args['questionId'].trim() || undefined
          : undefined;
      const answered = await this.chatToolProvider.resolveAnsweredCard(
        stimulus,
        explicitQuestionId,
      );
      const answeredId = answered?.id;
      const answeredCard = answered?.card;
      const hasAnswer = answeredCard?.answer != null;
      // PROVENANCE: `confirmedByOperator` is true ONLY if the brain asserts it AND an operator answer is
      // actually attached (same `hasAnswer` the Q&A auto-attach uses — never a second pointer read, so the
      // two can't disagree). Default false: an unasked default lands as Atlas-authored, surfacing at the gate.
      const confirmedByOperator =
        args['confirmedByOperator'] === true && hasAnswer;
      const title =
        String(args['title'] ?? '').trim() ||
        deriveDecisionTitle(hasAnswer ? answeredCard.question : ruling);
      const { decision, all } = await this.store.createDecision(
        stimulus.jobId,
        {
          decisionClass,
          title,
          ruling,
          confirmedByOperator,
          ...(hasAnswer && answeredCard.question
            ? { question: answeredCard.question }
            : {}),
          ...(hasAnswer ? { answer: answeredCard.answer } : {}),
        },
      );
      if (answeredId && hasAnswer) {
        await this.store.updateCardMessage(stimulus.jobId, answeredId, {
          loggedDecision: true,
        });
      }
      await this.chatToolProvider.writeDecisionRecordMd(stimulus.jobId, stimulus.orgId, all);
      // Echo the running provenance balance so the brain sees how much it has actually CONFIRMED vs authored.
      const confirmedCount = all.filter((d) => d.confirmedByOperator).length;
      return {
        ok: true,
        decision,
        total: all.length,
        provenance: {
          confirmed: confirmedCount,
          authored: all.length - confirmedCount,
        },
      };
    };

    const tools: Record<string, ToolImpl> = {
      [INTERNAL_PROFILE_AWARENESS_TOOL]: (args) =>
        this.profileAwareness
          ? this.profileAwareness.handle({
              orgId: stimulus.orgId,
              repoId: stimulus.repoId,
              jobId: stimulus.jobId,
              sessionType: 'brain',
              command: String(args['command'] ?? ''),
            })
          : Promise.resolve(null),
      get_pipeline_state: async (_args) => {
        return this.driverStore.getPipelineState(
          stimulus.jobId,
          stimulus.orgId,
        );
      },

      get_decision_record: async (_args) => {
        const record = await this.driverStore.getDecisionRecord(stimulus.jobId);
        if (record) return record;
        // No proposal yet — surface the working set logged so far so the brain can see what it has locked.
        const pending = await this.store.pendingDecisions(stimulus.jobId);
        return { status: 'drafting', decisions: pending };
      },

      recall: this.chatToolProvider.selfSufficiencyTools(stimulus).recall,

      remember: this.chatToolProvider.selfSufficiencyTools(stimulus).remember,

      forget: this.chatToolProvider.selfSufficiencyTools(stimulus).forget,

      update_memory: this.chatToolProvider.selfSufficiencyTools(stimulus).update_memory,

      ask_question: async (args) => {
        const question = String(args['question'] ?? '').trim();
        if (!question) return { ok: false, reason: 'question is required' };
        const options = normalizeQuestionOptions(args['options']);
        const decisionClass = asDecisionClass(args['decisionClass']);
        const header = String(args['header'] ?? '').trim();
        const questionId = await this.store.nextQuestionId(stimulus.jobId);
        const card = webQuestionCard({
          jobId: stimulus.jobId,
          questionId,
          question,
          ...(header ? { header } : {}),
          ...(decisionClass ? { decisionClass } : {}),
          options,
          allowOther: args['allowOther'] !== false,
        });
        // Open a question card ATOMICALLY: persist the card row + bump the thread's open-question counter in
        // one transaction (the surface `post` path does NOT persist `messages.card`; the card renders on the
        // turn-end refetch). Multiple questions MAY be open at once — each is answered independently via its
        // own card; the asking turn ends cleanly (async gate) and each answer arrives on a later delivery turn.
        const opened = await this.store.openQuestion(stimulus.jobId, {
          ts: questionId,
          text: question,
          card: card as unknown as Record<string, unknown>,
        });
        if (!opened.ok) {
          return {
            ok: false,
            reason: 'Could not open the question (thread not found).',
          };
        }
        return {
          ok: true,
          questionId,
          message:
            'Question posted to the operator as a card. Keep this tool call focused on ONE question, but you ' +
            'MAY post more than one card when you have several distinct things to settle — they can be answered ' +
            'in any order. Each answer arrives on a later turn; when one settles an always-ask decision, call ' +
            'create_decision (pass `questionId` to attach that exact question).',
        };
      },

      // Retract a still-unanswered question card — the escape hatch for "I need to reword this" or "this is
      // no longer relevant". Idempotent + race-safe: if the operator already answered it, the withdraw is a
      // no-op and the brain should handle the answer rather than re-ask. Decrements the open-question gate.
      withdraw_question: async (args) => {
        const questionId = String(args['questionId'] ?? '').trim();
        if (!questionId) return { ok: false, reason: 'questionId is required' };
        const reason = String(args['reason'] ?? '').trim();
        const res = await this.store.withdrawQuestion(
          stimulus.jobId,
          questionId,
          reason || undefined,
        );
        if (!res.withdrawn) {
          return {
            ok: false,
            reason:
              'That question could not be withdrawn — it was already answered, already withdrawn, or not ' +
              'found. If the operator answered it, work from that answer instead of re-asking.',
          };
        }
        return {
          ok: true,
          questionId,
          message:
            'Question withdrawn — the operator no longer sees it as awaiting an answer. Re-ask a reworded ' +
            'version with ask_question if you still need the input.',
        };
      },

      withdraw_plan: async (args) => {
        const reason = String(args['reason'] ?? '').trim();
        const res = await this.store.withdrawPlan(
          stimulus.jobId,
          reason || undefined,
        );
        if (!res.withdrawn) {
          return {
            ok: false,
            message:
              'No plan is currently awaiting the operator’s approval — nothing to withdraw. ' +
              '(If it was already approved or denied, work from that instead.)',
          };
        }
        this.approvals.cancel(
          stimulus.jobId,
          reason || 'plan withdrawn by Atlas',
        );
        await this.store.appendAtlasMessage(
          stimulus.jobId,
          `Withdrew the plan from approval${reason ? `: ${reason}` : ''}. Still working — I’ll re-propose when ready.`,
        );
        return {
          ok: true,
          message:
            'Plan withdrawn — the approve button is cleared and the job is back in planning. ' +
            'Re-propose with propose_plan when the plan is ready.',
        };
      },

      // PROPOSE amending the ship-review build (READY TO SHIP). This does NOT retract the gate — the ship
      // gate is a human control, so only the operator can release it. The tool posts an "Amend build?"
      // proposal card carrying the brain's `reason`; the gate stays parked until the operator approves it
      // (which runs the operator retract path AND wakes the brain via `wakeForAmendApproved`). The brain
      // MUST stop and wait after proposing — do not keep building.
      withdraw_ship: async (args) => {
        const reason = String(args['reason'] ?? '').trim();
        const outcome = await this.driverStore.openAmendProposal(
          stimulus.jobId,
          reason,
        );
        if (outcome === 'not-parked') {
          return {
            ok: false,
            message:
              'The job is not currently parked at the ship-review gate — nothing to propose amending.',
          };
        }
        if (outcome === 'already-open') {
          return {
            ok: false,
            message:
              'An amend proposal is already awaiting the operator’s decision. Wait for it — do NOT keep building.',
          };
        }
        await this.store.appendAtlasMessage(
          stimulus.jobId,
          'Proposed amending the build — awaiting the operator’s decision…',
        );
        return {
          ok: true,
          message:
            'Amend proposal posted. It is PENDING the operator’s approval — do NOT keep building. The ship ' +
            'gate stays up until they approve; if approved you’ll be woken to do the follow-up work.',
        };
      },

      // Classify (or re-classify) THIS job's kind — e.g. this is a PR review, not a build. The next turn's
      // system prompt reflects the new kind automatically (it's read fresh each turn). Operator/system kinds
      // ('event'/'onboarding') are NOT settable here. Prefer letting propose_plan/start_direct_build carry
      // feature/bugfix during scoping; use this when the job isn't a build (e.g. 'review').
      set_job_kind: async (args) => {
        const raw = String(args['kind'] ?? '').trim();
        const settable: readonly JobKind[] = ['feature', 'bugfix', 'review'];
        if (!settable.includes(raw as JobKind)) {
          return {
            ok: false,
            reason: `kind must be one of: ${settable.join(', ')}.`,
          };
        }
        await this.store.setJobKind(stimulus.jobId, raw as JobKind);
        return {
          ok: true,
          kind: raw,
          message: `Job kind set to '${raw}'. Your orientation for this and the next turns reflects it.`,
        };
      },

      create_decision: createDecision,

      update_decision: async (args) => {
        const envelope = missingArgsEnvelope(args);
        if (envelope) return envelope;
        const id = String(args['id'] ?? '').trim();
        if (!id) return { ok: false, reason: 'id is required' };
        // Validate decisionClass when present — an unrecognized class would persist but then be silently
        // dropped by the record renderer's class grouping. ruling/title are free text.
        const patch: Partial<
          Pick<
            Decision,
            'ruling' | 'title' | 'decisionClass' | 'confirmedByOperator'
          >
        > = {};
        if (args['confirmedByOperator'] !== undefined) {
          // Promoting a default to operator-confirmed requires evidence: an operator answer must be attached
          // NOW (same rule as create_decision). A bare `true` with no answer on record coerces to false, so
          // confirmation is never asserted without a Q&A linkage. Demotion to false is always allowed.
          const wantsConfirm = args['confirmedByOperator'] === true;
          if (wantsConfirm) {
            // Justify confirmation by a real attached answer (explicit `questionId` wins, else the card this
            // turn delivered, else newest-answered). Attachment of the Q&A itself stays in `create_decision`.
            const explicitQuestionId =
              typeof args['questionId'] === 'string'
                ? args['questionId'].trim() || undefined
                : undefined;
            const answered = await this.chatToolProvider.resolveAnsweredCard(
              stimulus,
              explicitQuestionId,
            );
            patch.confirmedByOperator = answered?.card.answer != null;
          } else {
            patch.confirmedByOperator = false;
          }
        }
        if (args['decisionClass'] !== undefined) {
          const decisionClass = asDecisionClass(args['decisionClass']);
          if (!decisionClass) {
            return {
              ok: false,
              reason:
                'decisionClass must be one of: data_model | api_contract | dependency | infrastructure | ' +
                'cross_cutting | one_way_door',
            };
          }
          patch.decisionClass = decisionClass;
        }
        if (args['ruling'] !== undefined) {
          const ruling = String(args['ruling'] ?? '').trim();
          if (!ruling) return { ok: false, reason: 'ruling cannot be blank' };
          patch.ruling = ruling;
        }
        if (args['title'] !== undefined) {
          const title = String(args['title'] ?? '').trim();
          if (!title) return { ok: false, reason: 'title cannot be blank' };
          patch.title = title;
        }

        const result = await this.store.updateDecision(
          stimulus.jobId,
          id,
          patch,
        );
        if (!result) {
          const pending = await this.store.pendingDecisions(stimulus.jobId);
          return {
            ok: false,
            reason: `no decision with id "${id}"`,
            knownIds: pending.map((d) => d.id),
          };
        }
        await this.chatToolProvider.writeDecisionRecordMd(
          stimulus.jobId,
          stimulus.orgId,
          result.all,
        );
        return {
          ok: true,
          decision: result.decision,
          total: result.all.length,
        };
      },

      delete_decision: async (args) => {
        const envelope = missingArgsEnvelope(args);
        if (envelope) return envelope;
        const id = String(args['id'] ?? '').trim();
        if (!id) return { ok: false, reason: 'id is required' };
        const { removed, all } = await this.store.deleteDecision(
          stimulus.jobId,
          id,
        );
        if (!removed) {
          return {
            ok: false,
            reason: `no decision with id "${id}"`,
            knownIds: all.map((d) => d.id),
          };
        }
        await this.chatToolProvider.writeDecisionRecordMd(stimulus.jobId, stimulus.orgId, all);
        return { ok: true, removed: id, remainingIds: all.map((d) => d.id) };
      },

      review_plan: async (args) => {
        // SYNCHRONOUS, ATLAS-DRIVEN Codex review of the authored `/context/specs/`. Blocks this turn until
        // Codex returns (like a subagent), then hands its severity-tagged findings straight back. Atlas
        // re-calls it after revising to RESUME the same Codex conversation (adjudication, not blind
        // re-review). Mandatory to RUN before `propose_plan`, but ADVISORY — Atlas is the judge. No round
        // cap (only a high safety ceiling). The `note` arg carries what changed / a point-by-point pushback.
        const overview = String(args['overview'] ?? '').trim();
        const goal = String(args['goal'] ?? '').trim();
        const note = String(args['note'] ?? '').trim();
        const decisions =
          args['decisions'] != null
            ? normalizeDecisions(args['decisions'])
            : await this.store.pendingDecisions(stimulus.jobId);
        const threads = normalizeThreads(args['threads']);
        const hasSteps = threads.some((s) => s.steps.length > 0);

        // Ensure there's an open scoping job (+ sandbox) so the review has specs + a container to run in.
        // Do NOT invent a placeholder title here: in the normal full-path flow `goal`/`overview` go to
        // `propose_plan`, not to `review_plan` (it reviews from the spec files), so both are usually empty.
        // Passing an empty title lets `openJob` keep the thread's existing title — the authoritative rename
        // happens later in `persistPlan` from the plan `goal` — instead of clobbering it with a phase name.
        const jobId = await this.ensureJob(
          stimulus,
          overview || goal,
          'feature',
        );
        const outcome = await this.planReview.review({
          jobId,
          orgId: stimulus.orgId,
          goal,
          overview,
          decisions,
          threadTitles: threads.map((s) => s.title),
          ...(hasSteps ? { stepsByThread: threads.map((s) => s.steps) } : {}),
          ...(note ? { note } : {}),
        });

        // The review just finalized `activity` to `idle`, but this tool ran INSIDE the still-live brain
        // turn — re-assert `turn` so the brief idle window before the turn-end writer settles it can't
        // false-light the "needs you" dot.
        await this.store.setActivity(jobId, 'turn').catch(() => undefined);

        if (outcome.status === 'failed') {
          return {
            ok: true,
            jobId,
            reviewStatus: 'failed',
            message:
              `Codex review could not run: ${outcome.error}. This is an INFRASTRUCTURE failure, not a clean ` +
              `pass — the plan was not validated. You can retry review_plan, or call propose_plan anyway ` +
              `(a review that ran, even if it errored, satisfies the gate) — but if you propose, tell the ` +
              `operator plainly that the automated Codex review did not run (and why).`,
          };
        }

        const blocking = outcome.findings.filter(
          (f) => f.severity === 'BLOCKING',
        );
        const advisory = outcome.findings.filter(
          (f) => f.severity === 'ADVISORY',
        );
        const ceilingNote = outcome.ceilingHit
          ? '\n\n(Re-review ceiling reached — stop re-reviewing; address what matters and call propose_plan.)'
          : '';

        if (outcome.findings.length === 0) {
          return {
            ok: true,
            jobId,
            reviewStatus: 'clean',
            message:
              'Codex review — no findings; the plan looks solid. Call propose_plan to send it to the ' +
              `operator for approval, or revise and review_plan again first.${ceilingNote}`,
          };
        }

        const body = [
          ...blocking.map((f) => `• [BLOCKING] ${f.text}`),
          ...advisory.map((f) => `• [ADVISORY] ${f.text}`),
        ].join('\n');
        return {
          ok: true,
          jobId,
          reviewStatus: 'findings',
          blocking: blocking.length,
          advisory: advisory.length,
          message:
            `Codex review — ${blocking.length} blocking, ${advisory.length} advisory (these are ADVISORY — ` +
            `you are the judge, findings never block):\n\n${body}\n\nAddress the BLOCKING ones (APPLY the fix, ` +
            `or HOLD FIRM with reasoning), advisory as you see fit — then revise + review_plan again to ` +
            `re-check, or call propose_plan to send the plan to the operator.${ceilingNote}`,
        };
      },

      propose_plan: async (args) => {
        // The single "send to operator" action (absorbs the old submit_plan + finalize_plan). Persists the
        // plan straight to `awaiting_approval` and posts the approval card — the operator is the FINAL gate.
        // GATED on a review having RUN for THIS plan version (mandatory-run, advisory-to-pass).

        const overview = String(args['overview'] ?? '').trim();
        // The one-line goal — the SAME text Atlas writes as plan.md's `# <H1>`. Becomes the thread title
        // (durable + live `thread_meta` frame, repainted inside requestApprovalAndAct).
        const goal = String(args['goal'] ?? '').trim();
        // `kind` orients the whole job: `bugfix` lights up the reproduce-the-failure-first framing (job-kind
        // block + build orientation). Default `feature`; only `bugfix` is a meaningful override here. But an
        // operator-set kind (picked at job creation) WINS — don't clobber it back to feature/bugfix.
        const kind: JobKind =
          (await this.store.jobKind(stimulus.jobId)) ??
          (args['kind'] === 'bugfix' ? 'bugfix' : 'feature');
        // Whether to re-title the job from `goal`. Default FALSE (keep the current title) — the brain opts
        // IN only when the plan's subject drifted from, or is meaningfully crisper than, the current name.
        const rename = args['rename'] === true;
        // Decisions are LOCKED incrementally during grilling (create_decision → pending_decisions). Source
        // them from the working set; an explicit `decisions` arg, if given, is an authoritative override.
        const decisions =
          args['decisions'] != null
            ? normalizeDecisions(args['decisions'])
            : await this.store.pendingDecisions(stimulus.jobId);
        const threads = normalizeThreads(args['threads']);
        const threadTitles = threads.map((s) => s.title);
        const threadTypes = threads.map((s) => s.type);
        const hasSteps = threads.some((s) => s.steps.length > 0);
        const stepsByThread = hasSteps
          ? threads.map((s) => s.steps)
          : undefined;

        if (!overview || !goal || threads.length === 0) {
          return {
            ok: false,
            reason: 'overview, goal, and at least one thread are required',
          };
        }

        const jobId = await this.ensureJob(stimulus, overview, kind);

        // ── MANDATORY-RUN GATE (version-tied, failure-tolerant) ─────────────────────────────────
        // A Codex review must have RUN for the plan version being proposed. `reviewForCurrentSpecs`
        // returns a TERMINAL review row (complete OR failed — a review that ran satisfies the gate, so an
        // infra outage never permanently blocks approval) whose `spec_hash` matches the CURRENT specs. Null
        // ⇒ no review yet, or the specs changed since the last review. Findings are ADVISORY — they never
        // affect this gate.
        const reviewed = await this.planReview.reviewForCurrentSpecs(
          jobId,
          stimulus.orgId,
        );
        if (!reviewed) {
          return {
            ok: false,
            reason:
              'Run `review_plan` first — the operator only sees plans that have been through a Codex ' +
              'review. Its findings are advisory (you decide what to address), but the review must have run ' +
              'on the version you are proposing. If you revised the specs since your last review, review_plan ' +
              'again (the reviewed version no longer matches).',
          };
        }

        // REATTACH IDEMPOTENCY (durable) + clean re-propose: if a proposal is already pending, durably
        // retract it (flip → planning, supersede the draft) BEFORE persisting the new one — so a re-run
        // (host death mid-propose) or a deliberate revise-and-repropose always ends with exactly ONE
        // pending proposal, never a no-op and never an orphaned live handle. Run this ONLY after all
        // validation/gates above have passed, so a rejected re-propose never retracts an approvable card.
        const prep = await this.prepareRepropose(stimulus.jobId);
        if (prep.refuse) return { ok: false, reason: prep.refuse };

        // Persist STRAIGHT to `awaiting_approval` (no `plan_review`): persistPlan supersedes drafts + titles
        // in one transaction. `thread_meta` repaint happens inside requestApprovalAndAct (single source).
        const { thread: job, decisionRecordId } = await this.store.persistPlan({
          orgId: stimulus.orgId,
          repoId: stimulus.repoId,
          jobId,
          title: goal,
          kind,
          overview,
          decisions,
          threadTitles,
          threadTypes,
          stepsByThread,
          rename,
          status: 'awaiting_approval',
        });

        const rec = await this.store.loadDecisionRecord(decisionRecordId);
        if (!rec) {
          return {
            ok: false,
            reason: 'No decision record found for this plan.',
          };
        }

        // Surface the review disposition in the timeline so the operator sees a review ran (advisory).
        const findings = deserializeFindings(reviewed.row.findings);
        const blocking = findings.filter(
          (f) => f.severity === 'BLOCKING',
        ).length;
        const reviewNote =
          reviewed.row.status === 'failed'
            ? `⚠️ Codex review did not run (${reviewed.row.error ?? 'infrastructure error'}) — proposed without an automated pass.`
            : findings.length
              ? `🔍 Codex review: ${blocking} blocking, ${findings.length - blocking} advisory (advisory — Atlas addressed or held firm).`
              : '🔍 Codex review: no findings.';
        await this.store
          .appendSystemEvent(job.id, reviewNote)
          .catch((err) =>
            this.logger.debug(`appendSystemEvent failed: ${err}`),
          );

        // Post the card + await the verdict in the background.
        void this.requestApprovalAndAct(stimulus, job, decisionRecordId, {
          jobId: job.id,
          decisionRecordId,
          title: job.title ?? goal,
          summary: rec.overview,
          decisions: rec.decisions,
          threads: rec.threadTitles,
        });

        return {
          ok: true,
          jobId: job.id,
          decisionRecordId,
          message:
            'Plan sent to the operator for approval — the build will start automatically if approved. ' +
            'You can keep talking; if denied or changes are requested you will be told.',
        };
      },

      dispatch_build: async (_args) => {
        // GATED tool — only starts an already-approved (status=running) job, AFTER the base-check judged the
        // plan still valid. Resolve the job by id (NOT openJobOnThread, which is planning-only) and let the
        // running-status check gate it; idempotent (a re-fire lands on the same 'running' job harmlessly, and
        // the dispatcher/runDirectBuild it calls are themselves the SOLE start of the build).
        const job = await this.store.loadJob(stimulus.jobId).catch(() => null);
        if (!job) {
          return {
            ok: false,
            reason: 'No job on this thread — call submit_plan first',
          };
        }
        if (job.status !== 'building' || job.halt != null) {
          return {
            ok: false,
            reason: `Job ${job.id} is in status '${job.status}'${job.halt != null ? ` and halted (${job.halt.kind})` : ''} — only 'running' (approved), un-halted jobs can be dispatched`,
          };
        }
        // Branch on the committed build path (d16 — ONE tool, not a separate "proceed to implement" for
        // direct builds): 'direct' runs the in-session implement turn (fire-and-forget — it streams in this
        // same brain session, so it must not be awaited here); 'plan' dispatches the full build pipeline.
        if (job.buildPath === 'direct') {
          if (!(await this.store.buildNotStarted(job.id))) {
            return {
              ok: true,
              jobId: job.id,
              message: 'Build already started.',
            };
          }
          // Stamp the durable "direct build started" marker BEFORE firing the (fire-and-forget) implement
          // turn, so `buildNotStarted()` closes the pre-start base-check window the instant the build begins
          // — otherwise `hold_build` would stay callable throughout the whole implementation turn and could
          // reopen planning underneath it. Awaited so the marker is durable before the turn streams.
          await this.store.markDirectBuildStarted(job.id);
          void this.runDirectBuild(stimulus, job);
        } else {
          await this.dispatcher.dispatch(job);
        }
        // MILESTONE COMPACTION: the plan is now durable and the build runs on its own (either the driver's
        // own sessions, or this session's in-flight direct implement) — the heavy planning transcript is
        // redundant. Compact the brain session while the build proceeds so follow-ups start lean.
        // Fire-and-forget onto the serialized queue — it runs AFTER this turn drains (never awaited here,
        // which would deadlock on the queue).
        void this.enqueueCompaction(stimulus);
        return { ok: true, jobId: job.id, message: 'Build started.' };
      },

      hold_build: async (args) => {
        // GATED tool, the mirror of dispatch_build for the OTHER base-check outcome: the rebased base made
        // the plan redundant or requires revision. Gated on the DURABLE "build not started" predicate, never
        // on `activity` — the base-check seed runs on the normal turn path, which sets activity='turn' for
        // its duration, so by the time Atlas calls this the activity is already 'turn', never 'base_check'.
        const reason = String(args['reason'] ?? '').trim();
        const job = await this.store.loadJob(stimulus.jobId).catch(() => null);
        if (!job) return { ok: false, reason: 'No job on this thread.' };
        if (job.status !== 'building' || job.halt != null) {
          return {
            ok: false,
            reason: `Job ${job.id} is in status '${job.status}'${job.halt != null ? ' and halted' : ''} — hold_build only applies to a running, un-halted job in the pre-start base-check window.`,
          };
        }
        if (!(await this.store.buildNotStarted(job.id))) {
          return {
            ok: false,
            reason:
              'The build has already started — too late to hold. Use the normal build controls.',
          };
        }
        await this.store.reopenPlanning(job.id);
        return {
          ok: true,
          jobId: job.id,
          status: 'planning',
          message:
            'Build held — back to planning. Revise the plan against the new base and re-propose (propose_plan), or confirm with the operator.',
        };
      },

      start_direct_build: async (args) => {
        // FAST PATH — a small, localized change the brain implements ITSELF (no threads/steps). Still
        // gated by a lightweight approval; on approval an autonomous implementation turn runs.
        const summary = String(args['summary'] ?? '').trim();
        if (!summary) {
          return {
            ok: false,
            reason: 'summary is required (what you will change, directly)',
          };
        }

        const changeOutline = Array.isArray(args['changeOutline'])
          ? args['changeOutline'].map((c) => String(c).trim()).filter(Boolean)
          : [];
        // `bugfix` orients the direct build to reproduce the failure first; default `feature`. An
        // operator-set kind (picked at job creation) WINS — don't clobber it.
        const kind: JobKind =
          (await this.store.jobKind(stimulus.jobId)) ??
          (args['kind'] === 'bugfix' ? 'bugfix' : 'feature');
        // Honor decisions locked during grilling (create_decision → pending_decisions); an explicit arg overrides.
        const decisions =
          args['decisions'] != null
            ? normalizeDecisions(args['decisions'])
            : await this.store.pendingDecisions(stimulus.jobId);

        // SAFETY GATE: "small" must NOT mean skipping an always-ask decision. Classify the change against
        // the locked decisions; an UNCOVERED always-ask class → refuse the fast path.
        const classification = await this.classifier.classify(
          {
            description: summary,
            ...(changeOutline.length
              ? { context: changeOutline.join('\n') }
              : {}),
          },
          { decisions },
          stimulus.orgId,
        );
        if (classification.verdict === 'ask') {
          return {
            ok: false,
            reason:
              `Not fast-path-safe — this touches an always-ask decision ` +
              `(${classification.decisionClass}): ${classification.reason} ` +
              `Lock it with the operator first, or use submit_plan for the full ceremony.`,
          };
        }

        // Clean re-propose: durably retract any pending proposal (flip → planning, supersede the draft)
        // ONLY after the always-ask safety gate has passed — so an uncovered always-ask class refuses
        // WITHOUT first destroying an approvable card, always ending with exactly ONE pending proposal.
        const prep = await this.prepareRepropose(stimulus.jobId);
        if (prep.refuse) return { ok: false, reason: prep.refuse };

        // Persist a MINIMAL record (overview = summary, any locked decisions, NO threads) and post the
        // lightweight approval card. The build runs only after approval (kind: 'direct').
        const jobId = await this.ensureJob(stimulus, summary, kind);
        const { thread: job, decisionRecordId } = await this.store.persistPlan({
          orgId: stimulus.orgId,
          repoId: stimulus.repoId,
          jobId: jobId,
          title: jobTitle(summary),
          kind,
          overview: summary,
          decisions,
          threadTitles: [],
        });

        void this.requestApprovalAndAct(stimulus, job, decisionRecordId, {
          jobId: job.id,
          decisionRecordId,
          kind: 'direct',
          // The reloaded short title from persistPlan — keeps the card + its live `thread_meta` emit
          // consistent with the durable sidebar title.
          title: job.title ?? jobTitle(summary),
          summary,
          decisions,
          threads: changeOutline,
        });

        return {
          ok: true,
          jobId: job.id,
          decisionRecordId,
          message:
            'Direct-build approval sent to the operator. On approval I will implement the change ' +
            'directly, then open a PR. You can keep talking; if denied you will be told.',
        };
      },

      finalize_build: async (_args) => {
        // GATED — callable only inside the autonomous implementation turn of an APPROVED direct build
        // (status 'running'). Commits whatever was written, then runs the shared terminal ship. Resolve
        // the job by id (NOT openJobOnThread, which is planning-only — approval already flipped it to
        // 'running', so that lookup would always return null here) and let the status check gate it.
        const job = await this.store.loadJob(stimulus.jobId).catch(() => null);
        if (!job)
          return {
            ok: false,
            reason: 'No job on this thread — nothing to finalize',
          };
        const jobId = job.id;
        if (job.status !== 'building') {
          return {
            ok: false,
            reason: `Job ${jobId} is '${job.status}' — only an approved (running) build can be finalized`,
          };
        }
        const sandbox = await this.lifecycle.findSandbox(
          stimulus.jobId,
          stimulus.orgId,
        );
        if (!sandbox)
          return {
            ok: false,
            reason: 'No sandbox for this thread — cannot finalize',
          };

        const repo = await this.repos.resolve(job);

        // HOST PRE-SHIP GATE only (no-token + leak-scan — the host NEVER commits). We are ALREADY inside this
        // brain turn, so we cannot seed a nested open-PR turn (that is the driver/boot ship path). Hand
        // `shipOpenPrBody` back as the tool result so the brain — still in THIS turn — commits anything
        // uncommitted, reconciles, pushes, and opens the PR itself. The git-state reconciler then records
        // `pr_url` + flips the job `done` on discovery, and `latchDirectBuildAtTurnEnd` latches the PR the
        // moment the turn completes.
        const pre = await this.ship.preShip(job, repo, sandbox, (m) =>
          this.say(stimulus, m),
        );

        if (!pre.ok) {
          if (pre.reason === 'leak-scan') {
            // Hard security block — a hydrated secret/seed path is on the branch (committed OR staged in the
            // working tree). NOT ok: the brain must clean it before it can ship.
            return {
              ok: false,
              jobId,
              reason:
                `PR blocked by the pre-ship security scan — a managed secret/seed file is on ` +
                `this branch: ${pre.leaked.join(', ')}. Remove it from the branch history and retry.`,
            };
          }
          return {
            ok: true,
            jobId,
            message:
              'No GitHub token is configured — PR not opened. Commit your work; connect a token to ship.',
          };
        }

        // The brain opens the PR inline later in THIS turn; flag the job so the turn-end latch
        // (`latchDirectBuildAtTurnEnd`) records the PR + flips running→done the moment the turn completes,
        // rather than waiting on the reconciler. A latch miss leaves the job for the boot backstop.
        this.directBuildShipPending.set(jobId, true);
        return {
          ok: true,
          jobId,
          message: shipOpenPrBody({
            branch: sandbox.branch,
            defaultBranch: repo.defaultBranch,
            title: job.title?.trim() || sandbox.branch,
          }),
        };
      },

      create_job: async (args) => {
        const firstMessage = String(args['firstMessage'] ?? '').trim();
        const title =
          String(args['title'] ?? '').trim() || jobTitle(firstMessage);
        if (!firstMessage) {
          return {
            ok: false,
            reason:
              "firstMessage is required (the new thread's opening intent)",
          };
        }

        // Validate every dependsOn blocker (existence + same repo) BEFORE creating the job, so a bad or
        // cross-repo id rejects cleanly with no residue — otherwise an early edge could park a live
        // 'blocked' job that later wakes/replays even though this create_job reported failure.
        const dependsOn = strArray(args['dependsOn']) ?? [];
        if (dependsOn.length > 0) {
          try {
            await this.jobDeps.assertDependenciesValid({
              orgId: stimulus.orgId,
              repoId: stimulus.repoId,
              dependsOnJobIds: dependsOn,
            });
          } catch (err) {
            return { ok: false, reason: errText(err) };
          }
        }

        // Same org + repo as this thread — derived from the closure, never from tool args (no cross-tenant
        // escape). The follow-up inherits this thread's base branch and starts scoping immediately.
        const current = await this.store.loadJob(stimulus.jobId);
        const newJobId = await this.store.createFollowUpJob({
          orgId: stimulus.orgId,
          repoId: stimulus.repoId,
          title,
          baseBranch: current.baseBranch,
          createdByJobId: stimulus.jobId,
          createdByTitle: current.title,
        });

        let anyBlocked = false;
        if (dependsOn.length > 0) {
          try {
            for (const dependsOnJobId of dependsOn) {
              const { blocked } = await this.jobDeps.addDependency({
                orgId: stimulus.orgId,
                repoId: stimulus.repoId,
                jobId: newJobId,
                dependsOnJobId,
                seed: firstMessage,
              });
              anyBlocked ||= blocked;
            }
          } catch (err) {
            return { ok: false, jobId: newJobId, reason: errText(err) };
          }
        }

        if (anyBlocked) {
          this.logger.log(
            `thread ${stimulus.jobId} created follow-up ${newJobId}, blocked on ${dependsOn.length} job(s)`,
          );
          return {
            ok: true,
            jobId: newJobId,
            blocked: true,
            message: `Created follow-up "${title}" — blocked on ${dependsOn.length} job(s); it will start when they resolve.`,
          };
        }

        // Kick the new thread's brain with its opening intent. Fire-and-forget — the parent's turn doesn't
        // block on the child's provisioning (~30s); the intent is recorded so it's visible if the start fails.
        void this.startFollowUpJob(
          newJobId,
          stimulus.orgId,
          stimulus.repoId,
          firstMessage,
        ).catch((err) =>
          this.logger.warn(`create_job: start of ${newJobId} failed: ${err}`),
        );
        this.logger.log(
          `thread ${stimulus.jobId} created + started follow-up ${newJobId}`,
        );
        return {
          ok: true,
          jobId: newJobId,
          blocked: false,
          message: `Created follow-up "${title}" and started it.`,
        };
      },

      // List this repo's sibling jobs so the brain can discover real same-repo ids to wire peer
      // dependencies (create_job dependsOn / link_job_dependency). Repo-scoped from the CLOSURE, never
      // from tool args — the same tenant-safety invariant as create_job.
      list_jobs: async (args) => {
        try {
          const jobs = await this.jobDeps.listJobs({
            orgId: stimulus.orgId,
            repoId: stimulus.repoId,
            status: optStr(args['status']),
            query: optStr(args['query']),
            limit:
              typeof args['limit'] === 'number' ? args['limit'] : undefined,
          });
          return { ok: true, jobs };
        } catch (err) {
          return { ok: false, reason: errText(err) };
        }
      },

      link_job_dependency: async (args) => {
        const jobId = String(args['jobId'] ?? '').trim();
        const dependsOnJobId = String(args['dependsOnJobId'] ?? '').trim();
        if (!jobId || !dependsOnJobId)
          return { ok: false, reason: 'jobId and dependsOnJobId are required' };
        try {
          const { blocked } = await this.jobDeps.addDependency({
            orgId: stimulus.orgId,
            repoId: stimulus.repoId,
            jobId,
            dependsOnJobId,
          });
          return {
            ok: true,
            blocked,
            message: blocked
              ? 'Linked dependency — the job is now blocked until its blocker resolves.'
              : 'Linked dependency (blocker already resolved — no live block).',
          };
        } catch (err) {
          return { ok: false, reason: errText(err) };
        }
      },

      // House-style: propose an owner-approved CHANGE to a reusable convention profile when the build notices
      // the convention itself should evolve (attaching one is onboarding's `propose_convention_profile`).
      propose_convention_profile_change:
        this.chatToolProvider.buildProposeConventionProfileChangeTool(stimulus),
    };

    // The ceremony and an ordinary build thread share the SAME onboarding capabilities — the ceremony just
    // does it all up front in one pass; any other thread does it incrementally, on the fly, whenever it
    // hits the same kind of friction (a missing secret, a repo setup gap worth recording for next time).
    // Every thread can request a missing secret/file on the spot (the owner-gated provide endpoints accept
    // any job) AND amend the repo's DB-backed workspace config (mounts/seed) — writes land instantly for
    // every job on the repo, no PR/ship step needed outside the ceremony (see `write_workspace_config`).
    const intake = {
      request_secret: this.chatToolProvider.selfSufficiencyTools(stimulus).request_secret,
      request_file: this.chatToolProvider.selfSufficiencyTools(stimulus).request_file,
      withdraw_file_request: this.chatToolProvider.buildWithdrawFileRequestTool(stimulus),
      withdraw_secret_request: this.chatToolProvider.buildWithdrawSecretRequestTool(stimulus),
      write_workspace_config: this.chatToolProvider.buildWriteWorkspaceConfigTool(stimulus),
      write_setup_script: this.chatToolProvider.buildWriteSetupScriptTool(stimulus),
      read_setup_script: this.chatToolProvider.buildReadSetupScriptTool(stimulus),
      write_preview_instructions:
        this.chatToolProvider.buildWritePreviewInstructionsTool(stimulus),
      read_preview_instructions:
        this.chatToolProvider.buildReadPreviewInstructionsTool(stimulus),
      derive_secret: this.chatToolProvider.buildDeriveSecretTool(stimulus),
      reset_sandbox: this.buildResetSandboxTool(stimulus),
      // Skills + MCP servers are Workspace Profile dimensions like mounts/setup — maintainable INCREMENTALLY
      // by any job, not just onboarding: list what exists + propose new/edited ones (owner-approved).
      list_skills: this.chatToolProvider.buildListSkillsTool(stimulus),
      propose_skill: this.chatToolProvider.buildProposeSkillTool(stimulus),
      propose_skill_install: this.chatToolProvider.buildProposeSkillInstallTool(stimulus),
      request_skill_edit_access: this.chatToolProvider.buildRequestSkillEditAccessTool(stimulus),
      propose_skill_removal: this.chatToolProvider.buildProposeSkillRemovalTool(stimulus),
      list_mcp_servers: this.chatToolProvider.buildListMcpServersTool(stimulus),
      propose_mcp_servers: this.chatToolProvider.buildProposeMcpServersTool(stimulus),
      propose_mcp_removal: this.chatToolProvider.buildProposeMcpRemovalTool(stimulus),
    };

    // atlas-prod: relocated prod-diagnostics reads + the gated write. Registered ONLY when this repo is the
    // Atlas repo (by SLUG === ATLAS_REPO_SLUG) and the prod-diagnostics service is wired — fail-closed
    // everywhere else (the tools are simply absent). The structural approval gate lives in proposeWrite.
    const atlasProd: Record<string, ToolImpl> =
      this.env && this.prodDiagnostics && isAtlasRepo(repoSlug ?? '', this.env)
        ? {
            atlas_query: (a) => this.prodDiagnostics!.runRead('atlas_query', a),
            atlas_schema: (a) =>
              this.prodDiagnostics!.runRead('atlas_schema', a),
            atlas_job_overview: (a) =>
              this.prodDiagnostics!.runRead('atlas_job_overview', a),
            atlas_session_raw: (a) =>
              this.prodDiagnostics!.runRead('atlas_session_raw', a),
            atlas_context_read: (a) =>
              this.prodDiagnostics!.runRead('atlas_context_read', a),
            atlas_worktree_tree: (a) =>
              this.prodDiagnostics!.runRead('atlas_worktree_tree', a),
            atlas_worktree_file: (a) =>
              this.prodDiagnostics!.runRead('atlas_worktree_file', a),
            propose_prod_write: (a) =>
              this.prodDiagnostics!.proposeWrite(
                stimulus,
                String(a['sql'] ?? ''),
              ),
          }
        : {};

    // Review threads get a curated, build-free subset (they review an EXISTING PR via `gh`/Read/subagents,
    // never plan/build/ship) — no propose_plan/start_direct_build/decisions. They DO get the job tools
    // (list_jobs/create_job/link_job_dependency): a review may legitimately spin up or relate sibling jobs
    // even though it does not build its own PR. Matches the `reviewTools` prompt fragment; the omission of
    // the build/plan/ship tools is enforced (un-callable, not just discouraged).
    if (review) {
      return {
        [INTERNAL_PROFILE_AWARENESS_TOOL]:
          tools[INTERNAL_PROFILE_AWARENESS_TOOL],
        ask_question: tools.ask_question,
        withdraw_question: tools.withdraw_question,
        set_job_kind: tools.set_job_kind,
        recall: tools.recall,
        remember: tools.remember,
        forget: tools.forget,
        update_memory: tools.update_memory,
        list_jobs: tools.list_jobs,
        create_job: tools.create_job,
        link_job_dependency: tools.link_job_dependency,
        ...intake,
        ...taskTools,
        ...atlasProd,
      };
    }
    // POST_BUILD/CI re-homed turns get a curated, engineering-focused subset (mirrors the prose in
    // host-tools.group.ts's postBuildTools/ciTools fragments — keep both in lockstep). Full engineering
    // (edit/git/gh/subagents) is native Bash/Edit/Task, not a host tool, so both stages keep it; they only
    // lose the planning apparatus (grill/decisions/plan/dispatch — post_build/ci never author or approve a
    // plan). Only post_build additionally gets `withdraw_ship` — it owns the amend loop, ci does not.
    if (postBuild || ci) {
      const base = {
        [INTERNAL_PROFILE_AWARENESS_TOOL]:
          tools[INTERNAL_PROFILE_AWARENESS_TOOL],
        get_pipeline_state: tools.get_pipeline_state,
        recall: tools.recall,
        remember: tools.remember,
        create_job: tools.create_job,
        list_jobs: tools.list_jobs,
        link_job_dependency: tools.link_job_dependency,
        ...intake,
        ...atlasProd,
      };
      return postBuild ? { ...base, withdraw_ship: tools.withdraw_ship } : base;
    }
    // Normal threads get the full toolset above + intake. Onboarding threads get a curated, build-free
    // subset (they don't build/PR; they explore, provision, and finish) — `finish_onboarding` stays
    // ceremony-only: it stamps `onboarded_at` and opens the ceremony's OWN dedicated config PR, which only
    // makes sense when there is no other in-flight build PR to fold the config change into.
    if (!onboarding) return { ...tools, ...intake, ...taskTools, ...atlasProd };
    return {
      [INTERNAL_PROFILE_AWARENESS_TOOL]: tools[INTERNAL_PROFILE_AWARENESS_TOOL],
      ask_question: tools.ask_question,
      withdraw_question: tools.withdraw_question,
      recall: tools.recall,
      remember: tools.remember,
      forget: tools.forget,
      update_memory: tools.update_memory,
      list_jobs: tools.list_jobs,
      create_job: tools.create_job,
      link_job_dependency: tools.link_job_dependency,
      ...intake,
      list_convention_profiles: this.chatToolProvider.buildListConventionProfilesTool(stimulus),
      propose_convention_profile:
        this.chatToolProvider.buildProposeConventionProfileTool(stimulus),
      propose_convention_profile_change:
        this.chatToolProvider.buildProposeConventionProfileChangeTool(stimulus),
      finish_onboarding: this.chatToolProvider.buildFinishOnboardingTool(stimulus),
      ...taskTools,
      ...atlasProd,
    };
  }

  /**
   * `reset_sandbox({ reason, hard? })` — recreate this thread's sandbox so Atlas can PROVE it cold-boots from
   * durable inputs (worktree + recorded mounts + granted secrets + the durable HOME + `/.atlas`) instead of
   * ephemeral container state it built by hand.
   *   • DEFAULT (soft): recreate just the CONTAINER; the durable worktree + session survive.
   *   • `hard:true`: recreate the WHOLE sandbox FROM SCRATCH — a fresh worktree AND container, as if the job
   *     were just created — while KEEPING the coding session (history resumes) and the `/context` +
   *     `/playground` mounts. TWO-CALL CONFIRM: the first `hard` call returns a notice of what happens / what
   *     is lost and does NOT reset; the second actually queues it. REFUSES on a dirty tree / unpushed commits
   *     (the host never commits, so it cannot rescue that work — commit + push first).
   * It does NOT tear down synchronously (that would kill the engine process running this very call); it flags
   * the reset, and the turn tail (`maybeHonorSandboxReset`) tears down + kicks a fresh verify turn once Atlas
   * stops. A soft loop guard refuses a 4th consecutive unattended reset so a broken setup can't spin forever.
   */
  private buildResetSandboxTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const key = `${stimulus.orgId}:${stimulus.jobId}`;
      const reason = String(args['reason'] ?? '').trim() || 'no reason given';
      const hard = args['hard'] === true;

      if (hard) {
        // Refusal gate — the host will NOT commit to rescue work, so a hard reset must not be armed over a
        // dirty tree or a full clone with unpushed commits. Checked on BOTH calls (state may have changed).
        const sandbox = await this.lifecycle
          .findSandbox(stimulus.jobId, stimulus.orgId)
          .catch(() => null);
        if (!sandbox) {
          this.pendingHardReset.delete(key);
          return {
            ok: false,
            reason: 'No sandbox for this job yet — nothing to hard-reset.',
          };
        }
        const dirty = await this.git
          .hasChanges(sandbox.worktreePath)
          .catch(() => true);
        const safe = dirty
          ? false
          : await this.git
              .worktreeSafeToRecut(sandbox.worktreePath, sandbox.branch)
              .catch(() => false);
        if (!safe) {
          this.pendingHardReset.delete(key);
          return {
            ok: false,
            reason:
              'Hard reset refused: this checkout has work that a from-scratch re-cut would DESTROY ' +
              `(${dirty ? 'uncommitted changes in the working tree' : 'commits not yet pushed to origin'}). ` +
              'The host never commits on your behalf — commit and `git push` everything you want to keep, then ' +
              'call `reset_sandbox({ hard:true })` again.',
          };
        }

        // FIRST hard call: arm + describe. No reset yet, no loop-counter tick (nothing was torn down).
        if (!this.pendingHardReset.has(key)) {
          this.pendingHardReset.add(key);
          return {
            ok: true,
            willReset: false,
            confirmRequired: true,
            message:
              'HARD RESET — this recreates your sandbox FROM SCRATCH on your next turn: the worktree is ' +
              'deleted and re-cut fresh from the branch, and the container is rebuilt. PRESERVED: your coding ' +
              'session (history resumes), and the `/context` + `/playground` mounts. LOST: anything only in ' +
              'the running container (installed packages, running services, scratch files outside those ' +
              'mounts) — it all re-derives from durable config on the fresh box. Your git work is safe (the ' +
              'tree is clean and pushed). To proceed, call `reset_sandbox({ hard:true })` ONCE MORE; otherwise ' +
              'do nothing and it will not reset.',
          };
        }
        // SECOND hard call: confirmed — fall through to arm the actual reset (marked `hard`).
        this.pendingHardReset.delete(key);
      }

      const priorResets = this.consecutiveResets.get(key) ?? 0;
      if (priorResets >= RESET_LOOP_CAP) {
        return {
          ok: false,
          reason: `You've reset the sandbox ${priorResets} times in a row without operator input — stop and investigate the failing piece (read logs, check what's actually missing) before resetting again.`,
        };
      }
      this.consecutiveResets.set(key, priorResets + 1);
      this.resetRequests.set(key, { reason, ...(hard ? { hard: true } : {}) });
      // Post the operator-visible cue HERE (mid-turn) rather than in the tail: `appendSystemEvent` only
      // surfaces on the next `/messages` reconcile (turn boundary), and the tail runs AFTER this turn's
      // `streamer.finish` already fired turn_end — so a tail-posted pill would miss this turn's reconcile
      // and only appear an entire turn later. Posted here, it lands on THIS turn's reconcile — visible the
      // moment Atlas stops. Best-effort (never fail the tool on a persistence hiccup).
      await this.store
        .appendSystemEvent(
          stimulus.jobId,
          hard
            ? `🔄 HARD reset requested (${reason}) — the worktree + container will be recreated from scratch on the next turn (session preserved), then Atlas verifies the environment cold-boots.`
            : `🔄 Sandbox reset requested (${reason}) — the container will be recreated from scratch on the next turn, then Atlas verifies the environment cold-boots from durable config.`,
        )
        .catch((err) => this.logger.debug(`appendSystemEvent failed: ${err}`));
      return {
        ok: true,
        willReset: true,
        message: hard
          ? 'Your sandbox will be recreated FROM SCRATCH (fresh worktree + container, session preserved) on your next turn — stop here now. Once it is back you will be prompted to verify the stack cold-boots and record anything that was lost.'
          : 'Your sandbox will be recreated fresh on your next turn — stop here now. Once it is back you will be prompted to verify the environment cold-boots and record anything that was lost.',
      };
    };
  }

  /**
   * Re-render `/context/generated/atlas-cleared-blocks.md` — the audit of build blocks Atlas CLEARED itself by
   * retrieving an existing answer. A pure PROJECTION of the durable `cleared:*` FYI
   * card rows (mirrors `writeDecisionRecordMd`): the card rows are the source of truth (they survive sandbox
   * teardown), the file is a re-render, so idempotency falls out of re-projecting a deduped store. This is a
   * job-scoped audit only — NOT ADR-promotable; Atlas never authors significant decisions on its own.
   */
  private async writeClearedBlocksMd(
    jobId: string,
    orgId: string,
  ): Promise<void> {
    const entries = await this.store.listClearedBlockCards(jobId);
    const generatedDir = join(
      this.lifecycle.contextDirHost(jobId, orgId),
      'generated',
    );
    await mkdir(generatedDir, { recursive: true });
    const body = entries.length
      ? entries
          .map(
            (e) =>
              `## thread ${e.threadId} — ${e.reason}\n\n${e.evidence}\n\n_(${e.at.toISOString()})_`,
          )
          .join('\n\n')
      : '_No blocks cleared autonomously._';
    await writeFile(
      join(generatedDir, 'atlas-cleared-blocks.md'),
      `# Cleared blocks — halts Atlas resolved by retrieving an existing answer\n\n${body}\n`,
      'utf8',
    );
  }

  // ── Approval flow ──────────────────────────────────────────────────────────────────────────────

  /**
   * Prepare a (re)proposal: refuse if the job already moved past the gate; if a proposal is pending,
   * durably retract it (flip → planning, supersede the draft) BEFORE returning, then drop the live handle.
   * Returns a refusal reason to bail with, or null to proceed. After this returns null the job is in
   * 'planning'/'open', so no in-flight click can approve the old plan.
   */
  private async prepareRepropose(jobId: string): Promise<{ refuse?: string }> {
    const existing = await this.store.loadJob(jobId).catch(() => null);
    if (!existing) return {};
    // Statuses past the approval gate (post-`awaiting_approval`) — never (re)propose over these. Covers the
    // whole build→review→ship→PR window (the former single `running`/`done` span, now split into distinct
    // phases). `amending` is deliberately NOT listed — like `planning`, it's a shaping state where a fresh
    // propose_plan is allowed.
    const pastGate: JobStatus[] = [
      'building',
      'master_review',
      'ready',
      'shipping',
      'pr_open',
      'merged',
      'cancelled',
      'deleting',
    ];
    if (pastGate.includes(existing.status)) {
      return {
        refuse: `This job is already '${existing.status}' — can’t (re)propose a plan for it.`,
      };
    }
    if (existing.status === 'awaiting_approval' && existing.decisionRecordId) {
      const res = await this.store.withdrawPlan(
        jobId,
        'superseded by a re-proposed plan',
      );
      if (!res.withdrawn) {
        const now = await this.store.loadJob(jobId).catch(() => null);
        return {
          refuse:
            `This job just moved to '${now?.status ?? 'a non-planning state'}' (an approval or cancel raced ` +
            `in) — nothing was changed. Re-check the state before proposing again.`,
        };
      }
      this.approvals.cancel(jobId, 'superseded by a re-proposed plan');
    }
    return {};
  }

  /** The user id to attribute an auto-approval to: the enabling user (jobs.auto_approve_by), falling back
   *  to the org owner if that user was deleted (auto_approve_by null). */
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
   * Post the approval card and act on the verdict — mirrors the old `ConversationalBrainService`
   * flow but without blocking the session turn on it.
   */
  async requestApprovalAndAct(
    stimulus: TurnEnvelope,
    job: Job,
    decisionRecordId: string,
    card: DecisionApprovalCard,
  ): Promise<void> {
    const route = await this.store.route({
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      jobId: stimulus.jobId,
    });
    const channel = route.channel ?? stimulus.replyRoute.jobRef;
    const threadTs = route.threadTs ?? stimulus.replyRoute.jobRef;

    const handle = await this.approvals.request(
      { channel, threadTs, orgId: stimulus.orgId },
      card,
    );

    // §H — the plan reached the operator (a card is now posted). The durable title was already written
    // to `goal` in persistPlan (full path) / jobTitle(summary) (direct); publish a live `thread_meta`
    // frame so the open UI repaints the title in place. Emitted on the CARD path only (never on the
    // pre-review draft return), AFTER the durable write, so live and durable never diverge. Best-effort.
    this.surface.emitThreadMeta?.(stimulus.repoId, stimulus.jobId, card.title);

    // AUTO-APPROVE (per-job opt-in): the card is posted above for audit/transcript; now immediately drive the
    // SAME resolution an operator's click would — the awaited handle.verdict below fires and actOnApprovalVerdict
    // runs identically (dispatch for a plan, direct build for a direct card). Re-read the flag at gate time:
    // a brain turn can spend minutes shaping a plan, and the operator may flip auto-approve while it runs.
    const autoApprovalJob =
      (await Promise.resolve()
        .then(() => this.store.loadJob(job.id))
        .catch(() => null)) ?? job;
    if (modeApprovesPlan(autoApprovalJob.autoApproveMode)) {
      const approver = await this.resolveAutoApprover(autoApprovalJob);
      await this.saySystemNotice(
        stimulus,
        'Auto-approve is on — approving this plan automatically.',
      );
      this.approvals.resolve(
        autoApprovalJob.id,
        'approve',
        approver,
        undefined,
        decisionRecordId,
      );
    }

    let resolution;
    try {
      resolution = await handle.verdict;
    } catch (err) {
      this.logger.warn(`approval wait abandoned for job ${job.id}: ${err}`);
      return;
    }

    await this.actOnApprovalVerdict(
      stimulus,
      job,
      decisionRecordId,
      card.kind === 'direct',
      resolution,
    );
  }

  /**
   * Apply a ruled approval verdict — the durable effect, shared by the live in-session await
   * ({@link requestApprovalAndAct}) and the restart-safe fallback ({@link resolveApprovalDurably}).
   * `approve` → flip the decision record + thread to `running`, commit the build path (`isDirect`), then
   * fire the `plan-approved` JIT rule to rebase-check the base branch BEFORE the build starts (the seed
   * itself calls `dispatch_build`/`hold_build` once Atlas judges the plan); `request_changes` → back to
   * planning; `deny` → cancel.
   */
  private async actOnApprovalVerdict(
    stimulus: TurnEnvelope,
    job: Job,
    decisionRecordId: string,
    isDirect: boolean,
    resolution: ApprovalResolution,
  ): Promise<void> {
    if (resolution.verdict === 'approve') {
      // Prefer the record the OPERATOR clicked (the version pin); fall back to the handle's closure
      // record when a caller didn't supply one (e.g. a test, or a client that omitted decisionRecordId).
      const recId = resolution.clickedDecisionRecordId ?? decisionRecordId;
      const running = await this.store.approve(
        job.id,
        recId,
        resolution.ruledBy,
        isDirect ? 'direct' : 'plan',
      );
      if (!running) {
        await this.say(
          stimulus,
          'That plan was withdrawn or updated since you clicked — nothing was approved. ' +
            'Re-propose the current version and approve that.',
        );
        return;
      }
      // Approval no longer dispatches/implements immediately (Thread 6): the plan-approved JIT rule seeds
      // Atlas to rebase-check the base branch (always auto-resolving git conflicts inline) and judge PLAN
      // VALIDITY before it calls `dispatch_build` (valid) or `hold_build` (redundant/needs-revision). This
      // is the SAME seed for both build paths — only `dispatch_build`'s internal branch differs.
      await this.store
        .setActivity(stimulus.jobId, 'base_check')
        .catch(() => undefined);
      await this.saySystemNotice(
        stimulus,
        'Approved — checking the base branch before starting…',
      );
      this.jit?.fireLifecycle('plan-approved', {
        repoId: running.repoId,
        jobId: running.id,
        orgId: running.orgId,
        buildPath: isDirect ? 'direct' : 'plan',
        baseBranch: running.baseBranch ?? undefined,
        decisionRecordId: recId,
      });
      return;
    }

    if (resolution.verdict === 'request_changes') {
      await this.store.reopenPlanning(job.id);
      // The note is the operator telling the brain WHAT to change — deliver it into the resumed engine
      // session (a real seeded turn), not just an operator-facing ack. Without this the note only lands in
      // the `messages` mirror and the brain never sees it. Build from `job.*` (reliable on both the live
      // and durable-fallback callers) rather than the possibly-stale/empty `stimulus`. No note → nothing
      // actionable to deliver, so keep the ack and wait for the operator's next turn.
      if (resolution.note) {
        await this.handleChatTurn(
          seedEnvelope({
            ...seedBase({
              jobId: job.id,
              orgId: job.orgId,
              repoId: job.repoId,
            }),
            type: 'request_changes',
            note: resolution.note,
            decisionRecordId,
          }),
        );
        return;
      }
      // No note: a calm System-notice ack (never in Atlas's voice), consistent with the other
      // approval-resolution acks. The brain's next turn resumes from the reopened planning state.
      await this.saySystemNotice(
        stimulus,
        'Got it — back to the drawing board. What should change?',
      );
      return;
    }

    // deny
    await this.store.cancel(job.id);
    await this.saySystemNotice(stimulus, "Understood — I'll drop this one.");
  }

  /**
   * RESTART-SAFE approval fallback. The web bridge calls this when {@link DecisionApprovalService.resolve}
   * finds no live in-memory handle for the clicked job — the canonical case being a backend restart AFTER
   * the plan was submitted, which drops the in-memory pending map (`DecisionApprovalService` keeps it in
   * RAM by design) while the thread stays durably `awaiting_approval`. Without this, the click POSTs 200
   * but nothing happens — the gate never resolves.
   *
   * Reconstructs the verdict effect from durable state alone: the job row + its decision record. Idempotent
   * — it only acts while the job is still `awaiting_approval`, so a stale/double click (or one that raced
   * the live path) is a no-op. `isDirect` is derived from the decision record (a direct build persists no
   * thread titles; the driver needs threads to dispatch). Returns whether it acted.
   */
  async resolveApprovalDurably(
    jobId: string,
    verdict: ApprovalVerdict,
    ruledBy: string,
    note?: string,
    clickedDecisionRecordId?: string,
  ): Promise<boolean> {
    const job = await this.store.loadJob(jobId).catch(() => null);
    if (!job || job.status !== 'awaiting_approval' || !job.decisionRecordId)
      return false;
    const rec = await this.store.loadDecisionRecord(job.decisionRecordId);
    if (!rec) return false;
    const stimulus = internalEnvelope({
      jobId: job.id,
      orgId: job.orgId,
      repoId: job.repoId,
      author: { id: SYSTEM_SEED_AUTHOR.id, displayName: SYSTEM_SEED_AUTHOR.name },
      // Empty body — a pure mechanism to drive `actOnApprovalVerdict`; the verdict itself is visible.
      type: 'user',
      body: '',
      seedRow: 'skip',
    });
    const isDirect = (rec.threadTitles?.length ?? 0) === 0;
    this.logger.log(
      `durable approval fallback for job ${jobId}: "${verdict}" by ${ruledBy} (direct=${isDirect})`,
    );
    await this.actOnApprovalVerdict(
      stimulus,
      job,
      job.decisionRecordId,
      isDirect,
      {
        jobId,
        verdict,
        ruledBy,
        ...(note ? { note } : {}),
        ...(clickedDecisionRecordId ? { clickedDecisionRecordId } : {}),
      },
    );
    return true;
  }

  // ── Compaction ───────────────────────────────────────────────────────────────────────────────────

  /**
   * COMPACT the brain session: run a summarization engine turn against the CURRENT (fat) session, then null
   * the session id (abandon the heavy transcript) and stash the lean summary as the next turn's seed. Invoked
   * from `runChatTurnInner` when `stimulus.compact` is set — so it is SERIALIZED on the per-job turn queue and
   * never races the turn it compacts. The container is already attached (ensured by the caller). The summary
   * turn is READ-ONLY (mode `review`, no tool bridge, no restart-survival registry) and is NOT streamed to the
   * operator — only a small system pill marks it. On any failure the fat session is left intact (we simply
   * don't compact this time). The build itself runs in SEPARATE driver sessions and is unaffected either way.
   */
  private async runCompaction(
    stimulus: TurnEnvelope,
    sandbox: { worktreePath: string; containerId?: string | null },
    sandboxRow: { session_id: string | null } | null,
    sessionId: string | undefined,
  ): Promise<void> {
    // Nothing to compact — the session was never created (or already compacted). No-op.
    if (!sessionId || !sandboxRow) {
      this.logger.log(
        `compaction: no live session for job=${stimulus.jobId} — nothing to compact`,
      );
      return;
    }

    const sandboxKey: EngineHomeKey = {
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      jobId: stimulus.jobId,
      type: 'brain',
    };
    const auth = await this.creds.engineAuth(stimulus.orgId, 'claude');

    const channel = stimulus.replyRoute?.jobRef ?? stimulus.jobId;
    let summary = '';
    try {
      const runArgs: RunEngineArgs = {
        engine: 'claude',
        task: COMPACTION_INSTRUCTION,
        cwd: sandbox.worktreePath,
        systemPrompt: COMPACTION_SYSTEM,
        sandboxKey,
        ...(auth ? { auth } : {}),
        // Read-only worker turn: no writes, default permission (no plan ceremony), no tool bridge, no
        // steering, no rich stream (internal — not surfaced in the operator transcript).
        mode: 'review',
        model: AgentSessionManager.BRAIN_MODEL,
        sessionId,
        // Track this detached exec like every other turn: an `active_turns` row (kind:'compaction') lets a
        // restart mid-summary RE-ATTACH the SAME exec (see `reattachOwnedTurns`) instead of orphaning it and
        // double-running. The compaction handler (`reattachCompactionOne`) reseeds — never persists as chat.
        turnMeta: {
          jobId: stimulus.jobId,
          orgId: stimulus.orgId,
          channel,
          lane: 'main',
          kind: 'compaction',
          ctx: { repoId: stimulus.repoId, sessionId },
        },
        ...(sandbox.containerId
          ? {
              target: {
                containerId: sandbox.containerId,
                worktreeHost: sandbox.worktreePath,
              },
            }
          : {}),
      };
      const result = await this.engineRunner.run(runArgs);
      void this.usageProjector?.record(
        {
          jobId: stimulus.jobId,
          orgId: stimulus.orgId,
          lane: 'main',
          kind: 'compaction',
          engine: 'claude',
          credentialId: result.credentialId ?? null,
        },
        result.usage,
      );
      summary = (result.result ?? '').trim();
    } catch (err) {
      // A non-clean summary turn never reaches `end_turn`, so recovery would not surface it — give up this
      // cycle (best-effort; no boot retry-loop) with the session left intact.
      this.logger.error(
        `compaction: summary turn failed for job=${stimulus.jobId} — leaving session intact: ${err}`,
      );
      return;
    }

    if (!summary) {
      this.logger.warn(
        `compaction: empty summary for job=${stimulus.jobId} — leaving session intact`,
      );
      return;
    }

    try {
      await this.completeCompaction(stimulus.jobId, stimulus.orgId, summary);
    } catch (err) {
      // The summary is durable in the SDK JSONL, so the reset is best-effort — keep the in-memory row
      // coherent (session NOT reset yet) and give up this cycle.
      this.logger.error(
        `compaction: completion failed for job=${stimulus.jobId} (will re-drive on boot): ${err}`,
      );
      return;
    }
    // Keep the in-memory row coherent for the rest of this call.
    sandboxRow.session_id = null;
    this.logger.log(
      `compaction: job=${stimulus.jobId} compacted (${summary.length} chars) — session reseeded`,
    );
  }

  /**
   * ATOMIC compaction completion — the session reset (null `session_id`) and the inspectable `build_event`
   * pill land in ONE transaction, so a crash can never leave the session reset without its audit pill (Codex
   * review). The summary is durable on the `build_event` message row. Bounded in-process retry rides out a
   * transient DB blip; on exhaustion it throws and the caller leaves the session intact. Shared by the fresh
   * run and {@link reattachCompactionOne}.
   */
  private async completeCompaction(
    jobId: string,
    orgId: string,
    summary: string,
  ): Promise<void> {
    const pillText =
      '🗜️ Compacted the planning conversation into a lean handoff — the build is running and future turns start fresh.';
    const threadId = await this.planningThreadId(jobId);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.sandboxRows.manager.transaction(async (mgr) => {
          await mgr.update(
            JobSandboxEntity,
            { job_id: jobId, org_id: orgId },
            { session_id: null },
          );
          await mgr.insert(TranscriptMessageEntity, {
            job_id: jobId,
            thread_id: threadId,
            author: 'Atlas',
            author_id: 'atlas',
            author_bot_id: 'atlas',
            text: pillText,
            kind: 'build_event',
            meta: { compactionSummary: summary },
          });
        });
        return;
      } catch (err) {
        lastErr = err;
        this.logger.warn(
          `compaction: completion txn attempt ${attempt}/3 failed for job=${jobId}: ${err}`,
        );
      }
    }
    throw lastErr;
  }

  /**
   * Re-attach ONE in-flight compaction turn → complete the reseed, or drop the marker if it yielded nothing.
   * The compaction handler for {@link reattachOwnedTurns} (registered with `awaitCompletion:true`, so its
   * reseed lands before `reconcileStrandedCompactions` runs — closing the "reattach finalized the turn row
   * but the reseed hasn't committed" race). The detached summary exec survives a restart; re-attaching the
   * SAME exec (replaying its durable Redis log to the final frame) and completing via {@link completeCompaction}
   * never kicks a second exec against the live session.
   */
  private async reattachCompactionOne(row: ActiveTurnEntity): Promise<void> {
    if (this.engineRunner.isAttached?.(row.turn_id)) return;
    if (!row.container_id) {
      // Can't re-tail without a container — leave the row for the watchdog to finalize; once it's gone and
      // the exec is confirmed dead, `reconcileStrandedCompactions` re-drives a fresh compaction.
      this.logger.warn(
        `compaction re-attach ${row.turn_id}: no container — deferring to reconciler`,
      );
      return;
    }
    let result: EngineRunResult;
    try {
      const ctx = (row.ctx ?? {}) as { credentialId?: string };
      result = await this.engineRunner.reattach!(
        row.turn_id,
        row.container_id,
        {
          onEvent: () => {
            /* internal turn — not surfaced in the operator transcript */
          },
          // Re-stamp rate_limit events with the dispatch-time credential (parity with a fresh dispatch).
          ...(ctx.credentialId ? { credentialId: ctx.credentialId } : {}),
        },
      );
    } catch (err) {
      // Lost the tail (detached again) — the row survives; the next boot re-attempts. Best-effort.
      this.logger.warn(
        `compaction re-attach ${row.turn_id}: reattach failed: ${err}`,
      );
      return;
    }
    const summary = (result.result ?? '').trim();
    if (!summary) {
      // The exec concluded with no usable summary — leave the session intact (a fresh compaction can be
      // re-driven later). The turn row was finalized by reattach's own path.
      return;
    }
    await this.completeCompaction(row.job_id, row.org_id, summary);
    this.logger.log(
      `Leader: completed re-attached compaction for job=${row.job_id}`,
    );
  }

  /**
   * True when the brain session is too LEAN to be worth compacting — below the {@link COMPACTION_MIN_OCCUPANCY_FRAC}
   * floor of the model window. Positive-signal only: returns false (⇒ compact) when occupancy is unknown, so a
   * fat-but-unreported session is never silently left uncompacted. Reads the brain's last recorded occupancy.
   */
  private async shouldSkipCompaction(jobId: string): Promise<boolean> {
    const occ = await this.store.latestBrainOccupancy(jobId).catch(() => null);
    return !!(
      occ &&
      occ.contextTokens != null &&
      occ.contextLimit != null &&
      occ.contextTokens < COMPACTION_MIN_OCCUPANCY_FRAC * occ.contextLimit
    );
  }

  /**
   * Enqueue a COMPACTION turn for this job (fire-and-forget onto the serialized turn queue). Called after a
   * milestone that makes the heavy planning transcript redundant with durable state (operator approval →
   * dispatch; the `dispatch_build` tool). Gated by {@link shouldSkipCompaction} — a quick plan leaves a lean
   * session not worth a summary turn. MUST NOT be awaited from inside a live turn (it would deadlock on the
   * queue); it runs after the current turn drains, while the build proceeds in its own sessions.
   */
  private async enqueueCompaction(stimulus: TurnEnvelope): Promise<void> {
    if (await this.shouldSkipCompaction(stimulus.jobId)) {
      this.logger.log(
        `compaction: job=${stimulus.jobId} skipped — session lean (below ${COMPACTION_MIN_OCCUPANCY_FRAC} of the window)`,
      );
      return;
    }
    // A summarization turn (message.type `compaction` drives `runChatTurnInner`'s early branch) — built clean
    // rather than spread from `stimulus`, so a source turn's delivered-card ids never ride onto it.
    const compaction = internalEnvelope({
      jobId: stimulus.jobId,
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      author: { id: 'atlas', displayName: 'Atlas' },
      type: 'compaction',
      body: '',
    });
    void this.handleChatTurn(compaction).catch((err) =>
      this.logger.error(
        `compaction turn failed to run for job=${stimulus.jobId}: ${err}`,
      ),
    );
  }

  // ── Direct-build (fast path) ─────────────────────────────────────────────────────────────────────

  /**
   * Run the AUTONOMOUS implementation turn for an approved direct build. The brain wrote the change's
   * spec to `/context` during the sitting; now (post-approval, no operator present) it implements it
   * ITSELF in the worktree and calls `finalize_build` to ship. Reuses the normal in-sandbox turn path
   * via a synthetic, Atlas-authored stimulus (the same pattern `startFollowUpJob` uses) so the work
   * streams to the thread and the session keeps full context. Fire-and-forget — errors are surfaced by
   * the turn itself.
   */
  private async runDirectBuild(
    stimulus: TurnEnvelope,
    job: Job,
  ): Promise<void> {
    const instruction =
      'The direct-build plan was APPROVED. Implement the change now, directly, in the repo ' +
      '(`/workspace`) — follow the spec/notes you wrote under `/context`. When the change is complete, ' +
      "run `mcp__atlas-lsp-ts__diagnostics` on the files you changed and the repo's own typecheck, and fix " +
      'anything they find. Then — if your change touched a runtime surface (an HTTP endpoint/route, a UI ' +
      'page/component, a CLI entry point, or a background job) — ACTUALLY EXERCISE IT LIVE: boot the process ' +
      'and curl the endpoint / drive the UI / run the CLI for real. If the change is internal plumbing whose ' +
      'effect is never echoed in an HTTP/UI/CLI surface (e.g. an option/value handed to an SDK), instead boot ' +
      'the process and capture a log line proving the changed value was passed at runtime. Typecheck, build, ' +
      'lint, and the test suite are NOT live verification on their own. ' +
      'Then call `finalize_build` to commit, review, and open the PR. Do NOT call submit_plan or ' +
      'start_direct_build again.';
    const synthetic = internalEnvelope({
      jobId: stimulus.jobId,
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      author: { id: 'atlas', displayName: 'Atlas' },
      type: 'user',
      body: instruction,
    });
    try {
      await this.handleChatTurn(synthetic);
    } catch (err) {
      this.logger.error(
        `direct build implementation turn failed for thread=${job.id}: ${err}`,
      );
      await this.say(
        stimulus,
        `The direct build hit an error — ${String(err).slice(0, 200)}`,
      );
    }
  }

  // ── create_job: start the follow-up's brain ──────────────────────────────────────────────────

  /**
   * Kick a freshly-created follow-up thread's brain with its opening intent. Records the intent into the
   * transcript first (the brain path doesn't persist the inbound message — intake normally does), then runs
   * one chat turn (which lazily provisions the new thread's sandbox).
   */
  async startFollowUpJob(
    jobId: string,
    orgId: string,
    repoId: string,
    firstMessage: string,
  ): Promise<void> {
    await this.store.appendAtlasMessage(
      jobId,
      `🔗 Follow-up started from a prior thread:\n\n${firstMessage}`,
    );
    // Frame the engine-facing seed with the spawning job's provenance (already snapshotted on the child at
    // create time) so the child brain knows this thread came from ANOTHER Atlas job, not from the operator.
    const job = await this.store.loadJob(jobId);
    const seed = renderFollowUpJobSeed({
      firstMessage,
      parent: job?.createdBy ?? null,
    });
    const stimulus = internalEnvelope({
      jobId,
      orgId,
      repoId,
      author: { id: 'atlas', displayName: 'Atlas' },
      type: 'user',
      body: seed,
    });
    await this.handleChatTurn(stimulus);
  }

  /**
   * Kick a repo-ONBOARDING thread's first turn (spawned by `OnboardingService` when a repo is connected on
   * a runnable org). The thread is born `kind='onboarding'`; this seeds a synthetic Atlas-authored stimulus
   * so the brain starts initialising the repo immediately (no human first message). The detailed mission +
   * tool list live in the onboarding fragments (ATLAS_MAIN, `jobKind==='onboarding'`); the seed body is just the opening nudge. The sandbox is
   * lazily provisioned on this first turn.
   */
  async startOnboardingThread(
    jobId: string,
    orgId: string,
    repoId: string,
  ): Promise<void> {
    // The seed stimulus below bypasses intake (which is what persists operator bubbles), so append a
    // visible opener — otherwise the transcript starts with the brain's first reply out of nowhere.
    await this.store.appendAtlasMessage(
      jobId,
      '🚀 Atlas is grounding on this repo — it will do a quick read-only pass to map the codebase, then check in with you before the full bring-up (which takes a while and a lot of tokens).',
    );
    const body =
      'Begin onboarding this repository, starting with the GROUNDING GATE. Do a quick, READ-ONLY grounding ' +
      'pass first (read the docs, map the stack, draft the fleet inventory) — do NOT install, boot, or ' +
      'request any secrets yet. Then present that summary to the operator, note plainly that the full ' +
      'bring-up will take a while and a lot of tokens, and ask for their go-ahead via ask_question before ' +
      'proceeding. STOP and wait for their response. Only after they green-light it: bring up and validate ' +
      'the fleet, make each user-facing surface browser-accessible through the preview proxy and prove it ' +
      'with atlas-probe, register required secrets via request_secret, record non-secret config with ' +
      'write_workspace_config, propose any stack-matched MCP servers for the owner to approve via ' +
      'propose_mcp_servers, match the repo against the org house-style profiles (list_convention_profiles → ' +
      'propose_convention_profile with the best-matching slug, or "none" if it follows none), then call ' +
      'finish_onboarding.';
    const stimulus = internalEnvelope({
      jobId,
      orgId,
      repoId,
      author: { id: 'atlas', displayName: 'Atlas' },
      type: 'user',
      body,
    });
    await this.handleChatTurn(stimulus);
  }

  // ── Durable EVENT delivery: the one-brain replacement for the deleted event-triage lane ─────────────
  //
  // Mirrors the operator-chat pump (steer-into-live OR fresh queued turn), with the SAME at-least-once
  // guarantee. The event's operator-visible `system_event` card is written at intake; the durable `stimuli`
  // row (kind='event', `delivered_at` null) is the queue this drives. CRITICAL: delivery is NEVER stamped on
  // a bare steer XADD — only the engine's `input_ack` (steer path) or the fresh turn's registration hand-off
  // marks `delivered_at`. So an event steered into a turn that ENDS before consuming it stays undelivered
  // (the engine leaves such a steer un-acked) and the sweep re-drives it — closing the swallowed-steer race.

  /** BrainSink.deliverEvent — a routed event is ready; ensure the owning job's brain consumes it. */
  async deliverEvent(stimulus: EventMessage): Promise<void> {
    await this.pumpEvent(stimulus);
  }

  /**
   * Deliver ONE event to its job's brain. FAST PATH: a running brain turn on the SAME lane is steered (the
   * event-row id is the steer id, so the engine's `input_ack` stamps THIS row). SLOW PATH (no running turn on
   * this lane): a fresh turn framed by `renderEventDelivery` is queued on the per-thread turn queue and stamps
   * delivery at its registration hand-off. Idempotent (skips an already-delivered row); lease-guarded so a
   * concurrent sweep can't double-drive. Deliberately does NOT go through `handleChatTurn` — that method's
   * seed steer fast-path (`steerIntoLiveBrainTurn`) reports "handled" on a bare XADD, which would re-open the
   * swallowed-steer race.
   */
  async pumpEvent(stimulus: EventMessage): Promise<void> {
    if (this.election.getState() === 'draining') return;

    // Already delivered (an intake / sweep / boot race) → no-op. Cheap guard before paying a turn.
    const row = await this.stimulusRows.findOne({ where: { id: stimulus.id } });
    if (row?.delivered_at) return;

    // The event is already an `EventMessage` (carrying its own `body`) — `renderEventDelivery` reads it directly.
    const body = renderEventDelivery(stimulus);
    const lane = this.laneForStimulus(stimulus);
    const live = await this.turnRegistry
      .runningBrainTurn(stimulus.jobId)
      .catch(() => null);
    if (
      live?.turn_id &&
      this.activeTurnLane(live) === lane &&
      typeof this.engineRunner.steer === 'function'
    ) {
      await this.steerEvent(live.turn_id, stimulus.id, body);
      return;
    }

    // No running turn → deliver via a fresh turn, serialized on the per-thread turn queue.
    const key = `${stimulus.orgId}:${stimulus.jobId}`;
    const prev = this.turnQueues.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.deliverEventViaFreshTurn(stimulus, body));
    this.turnQueues.set(
      key,
      next.finally(() => {
        if (this.turnQueues.get(key) === next) this.turnQueues.delete(key);
      }),
    );
    return next;
  }

  /** Steer an event into a live turn (lease first; the engine `input_ack` on the event-row id stamps delivered). */
  private async steerEvent(
    turnId: string,
    eventRowId: string,
    body: AgentMessage,
  ): Promise<void> {
    await this.stimulusStore
      .leaseChatStimuli([eventRowId]) // kind-agnostic (updates by id) — reused for the event row
      .catch((err) =>
        this.logger.debug(`pump: lease event failed (continuing): ${err}`),
      );
    await this.engineRunner.steer!(turnId, eventRowId, body).catch((err) =>
      this.logger.warn(
        `pump: steer event into turn ${turnId} failed (sweep will re-drive): ${err}`,
      ),
    );
  }

  /** Run ONE fresh turn that consumes a single event, stamping delivery at the registration hand-off. */
  private async deliverEventViaFreshTurn(
    stimulus: EventMessage,
    body: AgentMessage,
  ): Promise<void> {
    // A turn may have appeared since pumpEvent's check (a boot re-attach resumed one). Steer it instead of
    // starting a SECOND turn on the same session (never two concurrent turns resuming one session id). If the
    // one live brain turn is on a DIFFERENT lane, leave this event pending for its own lane's sweep/queue turn;
    // never lease it or cross-steer it into the wrong stage session.
    const lane = this.laneForStimulus(stimulus);
    const live = await this.turnRegistry
      .runningBrainTurn(stimulus.jobId)
      .catch(() => null);
    if (
      live?.turn_id &&
      this.activeTurnLane(live) === lane &&
      typeof this.engineRunner.steer === 'function'
    ) {
      await this.steerEvent(live.turn_id, stimulus.id, body);
      return;
    }
    if (live?.turn_id && this.activeTurnLane(live) !== lane) return;

    // Lease BEFORE dispatch (like the chat fresh path) so a concurrent sweep can't re-drive a duplicate
    // while this potentially-long turn runs.
    await this.stimulusStore.leaseChatStimuli([stimulus.id]);
    const delivery = seedEnvelope(stimulus, {
      id: stimulus.id, // the DURABLE event-row id — so `onRegistered` stamps THIS row (not a synthetic uuid)
      body, // already framed + fenced by renderEventDelivery — rides straight through, no re-render
      seedRow: 'skip', // the untrusted event body already has a durable `system_event` row from intake
      ...(stimulus.resumeThreadId
        ? { resumeThreadId: stimulus.resumeThreadId } // §CI-routing: routed to the `ci` thread when it exists
        : {}),
    });
    await this.runChatTurn(delivery, {
      // Restart-survivable hand-off: stamp delivered the instant the turn is registered + kicked (a later
      // crash resumes THIS turn rather than re-running the event).
      onRegistered: () => {
        void this.stimulusStore
          .markChatDelivered(stimulus.id)
          .catch((err) =>
            this.logger.debug(
              `event markDelivered ${stimulus.id} failed (sweep will retry): ${err}`,
            ),
          );
      },
    });
  }

  /** LEADER periodic + boot re-drive of any routed event still undelivered (the event at-least-once sweep). */
  private async sweepUndeliveredEvents(): Promise<void> {
    if (this.election.getState() !== 'leader') return;
    let events: EventMessage[];
    try {
      events = await this.stimulusStore.eligiblePendingEvents(
        AgentSessionManager.CHAT_DELIVERY_LEASE_MS,
      );
    } catch (err) {
      this.logger.debug(
        `event delivery sweep query failed (will retry): ${err}`,
      );
      return;
    }
    for (const ev of events) {
      void this.pumpEvent(ev).catch((err) =>
        this.logger.debug(
          `event sweep pump failed for stimulus=${ev.id}: ${err}`,
        ),
      );
    }
  }

  /**
   * An advisory prefix listing this thread's still-OPEN `ask_question` cards (asked, not yet answered or
   * withdrawn) so a fresh turn doesn't re-ask them — the fix for the "brain keeps asking the same question"
   * loop, whose root cause is that question cards live OUTSIDE the engine session and are never otherwise
   * re-surfaced once the session's in-context memory is lost (a new turn, an event, a restart/compaction).
   * Null when nothing is open. Best-effort — a failure here never blocks the turn. Gated by the call site to
   * PLANNING only — post_build/ci carry no `ask_question` tool, so they never have anything open to remind.
   */
  private async buildOpenQuestionsPrefix(
    jobId: string,
  ): Promise<string | null> {
    try {
      const open = await this.store.openQuestionCards(jobId);
      if (open.length === 0) return null;
      const lines = open.map((c) => {
        const gist = (c.header?.trim() || c.question || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160);
        return `  • [${c.questionId}] ${gist}`;
      });
      const n = open.length;
      // Clean text — the `<system_reminder source="open_questions">` chunk this becomes provides the
      // boundary (no self-wrapping tag, so the persisted transcript row reads cleanly in the web too).
      return (
        `You have ${n} question${n === 1 ? '' : 's'} already posted to the operator and still awaiting an ` +
        `answer. Do NOT re-ask ${n === 1 ? 'it' : 'them'} — wait for the answer to arrive on a later turn, or ` +
        `call withdraw_question({ questionId, reason }) to retract one (e.g. to reword it or if it's no longer ` +
        `needed).\n${lines.join('\n')}`
      );
    } catch (err) {
      this.logger.debug(`open-questions prefix failed (continuing): ${err}`);
      return null;
    }
  }

  /**
   * Persistent per-turn reminder while a job sits in `amending` (the ship-review gate retracted for a
   * follow-up fix). This is the durable teacher of the return path: unlike the one-time amend-approved wake,
   * it fires EVERY turn while amending, so it covers the manual "Amend build" click (which never wakes the
   * brain) and survives compaction. Returns null unless the job is `amending`. Best-effort. Gated by the call
   * site to the POST_BUILD session only (d3: the amend loop runs there now, not on planning).
   */
  private async buildAmendingPrefix(jobId: string): Promise<string | null> {
    try {
      const job = await this.store.loadJob(jobId).catch(() => null);
      if (job?.status !== 'amending') return null;
      return (
        'This build is AMENDING — the ship-review gate was retracted so you can make a follow-up fix. ' +
        'Make the change in the sandbox and verify it (typecheck/build/tests, plus a live run of any ' +
        'runtime surface you touched). When it is done and verified, the job is re-parked at the ' +
        'ship-review gate (amending → ready-to-ship, no rebuild) and the "Ship it" card is re-posted for ' +
        'the operator. Do not re-propose amending unless something material changed.'
      );
    } catch (err) {
      this.logger.debug(`amending prefix failed (continuing): ${err}`);
      return null;
    }
  }

  /**
   * Memory auto-retrieval turn-prefix (d1/d2/d5): on a substantive operator turn, recall project+team facts
   * and format them for the reserved `system_reminder source="memory"` slot. Best-effort — any recall/embed
   * failure yields null and never blocks the turn (mirrors the `recall` tool's catch). Two-layer kill-switch:
   * the runtime `MEMORY_AUTORECALL_DISABLED` env guard here + the declarative `memoryPrependRule.enabled`.
   * Per-session dedup suppresses a fact already injected earlier in the same live session.
   */
  private injectedMemoryFactIds(
    jobId: string,
    sessionId: string | null,
  ): Set<string> {
    let state = this.injectedMemoryByJob.get(jobId);
    if (!state || state.sessionId !== sessionId) {
      state = { sessionId, factIds: new Set<string>() };
      this.injectedMemoryByJob.set(jobId, state);
    }
    return state.factIds;
  }

  private bindInjectedMemorySession(jobId: string, sessionId: string): void {
    const state = this.injectedMemoryByJob.get(jobId);
    if (!state || state.sessionId === sessionId) return;
    if (state.sessionId === null) {
      state.sessionId = sessionId;
      return;
    }
    this.injectedMemoryByJob.set(jobId, {
      sessionId,
      factIds: new Set<string>(),
    });
  }

  private async buildMemoryRecallPrefix(
    stimulus: TurnEnvelope,
    sessionId?: string,
  ): Promise<string | null> {
    if (this.env?.get('MEMORY_AUTORECALL_DISABLED') === 'on') return null;
    if (!isSubstantiveQuery(stimulus.body)) return null;
    try {
      const facts = await this.memory.recall(stimulus.body, {
        scopes: [`project:${stimulus.repoId}`, `team:${stimulus.orgId}`],
        orgId: stimulus.orgId,
        limit: 3,
        floor: 0.45,
      });
      if (facts.length === 0) return null;
      const seen = this.injectedMemoryFactIds(
        stimulus.jobId,
        sessionId ?? null,
      );
      const fresh = facts.filter((f) => !seen.has(f.id));
      if (fresh.length === 0) return null;
      const body = renderMemoryRecall(
        fresh.map((f) => ({ id: f.id, fact: f.fact, scope: f.scope })),
      );
      if (!body) return null;
      for (const f of fresh) seen.add(f.id);
      return body;
    } catch (err) {
      this.logger.debug(
        `memory auto-recall prefix failed (continuing): ${err}`,
      );
      return null;
    }
  }

  /**
   * The file-request analog of {@link buildOpenQuestionsPrefix}: an advisory reminder of the file-upload
   * cards still awaiting an upload (posted, not yet provided/withdrawn), so a fresh/compacted brain session
   * doesn't re-post a duplicate `request_file`. Lists each open card's id + destination path. Best-effort.
   */
  private async buildOpenFileRequestsPrefix(
    jobId: string,
  ): Promise<string | null> {
    try {
      const open = await this.store.openFileCards(jobId);
      if (open.length === 0) return null;
      const lines = open.map((c) => `  • [${c.requestId}] ${c.path}`);
      const n = open.length;
      return (
        `You have ${n} file-upload request${n === 1 ? '' : 's'} already posted to the operator and still ` +
        `awaiting an upload. Do NOT re-post ${n === 1 ? 'it' : 'them'} — wait for the file to arrive on a ` +
        `later turn, or call withdraw_file_request({ requestId, reason }) to retract one (e.g. wrong path or ` +
        `no longer needed).\n${lines.join('\n')}`
      );
    } catch (err) {
      this.logger.debug(
        `open-file-requests prefix failed (continuing): ${err}`,
      );
      return null;
    }
  }

  /**
   * The secret-request analog of {@link buildOpenFileRequestsPrefix}: an advisory reminder of the durable/mcp
   * `request_secret` cards still awaiting a value (posted, not yet provided/withdrawn), so a fresh/compacted
   * brain session doesn't re-post a duplicate. Ephemeral (`deliver_to`) requests are single-slot/immediate and
   * excluded by {@link BrainStore.openSecretCards}. Lists each open card's id + target. Best-effort.
   */
  private async buildOpenSecretRequestsPrefix(
    jobId: string,
  ): Promise<string | null> {
    try {
      const open = await this.store.openSecretCards(jobId);
      if (open.length === 0) return null;
      const lines = open.map((c) => {
        const target = c.mcp
          ? `${c.mcp.server} (${c.mcp.slot}:${c.mcp.key})`
          : c.path
            ? `${c.name} → ${c.path}`
            : c.name;
        return `  • [${c.requestId}] ${target}`;
      });
      const n = open.length;
      return (
        `You have ${n} secret request${n === 1 ? '' : 's'} already posted to the operator and still awaiting ` +
        `a value. Do NOT re-post ${n === 1 ? 'it' : 'them'} — wait for the value to arrive on a later turn, or ` +
        `call withdraw_secret_request({ requestId, reason }) to retract one (e.g. wrong target or no longer ` +
        `needed).\n${lines.join('\n')}`
      );
    } catch (err) {
      this.logger.debug(
        `open-secret-requests prefix failed (continuing): ${err}`,
      );
      return null;
    }
  }

  /**
   * Build an `onMilestone` callback for the provisioning chain (`ensureProvisioned`/`ensureContainer`) —
   * narrates the genuinely slow attach sub-steps (a real image rebuild, a cold container create) as a
   * quiet operator-visible pill via `appendSystemEvent` (NOT a fake Atlas reply) — it needs to be seen by
   * the operator now. Fire-and-forget with a debug-logged catch, matching this file's other best-effort
   * append style.
   */
  private sandboxMilestoneNotifier(
    stimulus: TurnEnvelope,
  ): (stage: SandboxMilestoneStage) => void {
    return (stage) => {
      const text =
        stage === 'image_build'
          ? 'Building the sandbox image — this can take a few minutes on first run or after a workspace-setup change…'
          : "Preparing this thread's workspace container — one moment…";
      void this.store
        .appendSystemEvent(stimulus.jobId, text)
        .catch((err) =>
          this.logger.debug(`milestone event append failed: ${err}`),
        );
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────────────────────

  /** Post a reply in-thread AND append it to the durable transcript. */
  private async say(stimulus: TurnEnvelope, text: string): Promise<void> {
    let channel = stimulus.replyRoute.jobRef;
    let threadTs = stimulus.replyRoute.jobRef;
    try {
      const route = await this.store.route({
        orgId: stimulus.orgId,
        repoId: stimulus.repoId,
        jobId: stimulus.jobId,
      });
      channel = route.channel ?? channel;
      threadTs = route.threadTs ?? threadTs;
    } catch (err) {
      this.logger.warn(`failed to resolve brain reply route: ${err}`);
    }
    try {
      await this.surface.post(channel, text, {
        threadTs,
        orgId: stimulus.orgId,
      });
    } catch (err) {
      this.logger.warn(`failed to post brain reply: ${err}`);
    }
    await this.store
      .appendAtlasMessage(stimulus.jobId, text)
      .catch((err) =>
        this.logger.warn(`failed to persist brain reply: ${err}`),
      );
  }

  /** Post a calm SYSTEM→OPERATOR notice (meta.source='system_notice') in-thread AND append the durable
   *  row. Mirrors {@link say} but is NOT in Atlas's voice — a benign harness ack the resumed brain
   *  session never authored, with no error/Resume semantics (contrast {@link saySystemOperator}). */
  private async saySystemNotice(
    stimulus: TurnEnvelope,
    text: string,
  ): Promise<void> {
    const route = await this.store.route({
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      jobId: stimulus.jobId,
    });
    const channel = route.channel ?? stimulus.replyRoute.jobRef;
    const threadTs = route.threadTs ?? stimulus.replyRoute.jobRef;
    const meta = { source: 'system_notice' };
    try {
      await this.surface.post(channel, text, {
        threadTs,
        orgId: stimulus.orgId,
        meta,
      });
    } catch (err) {
      this.logger.warn(`failed to post system notice: ${err}`);
    }
    await this.store.appendSystemNotice(stimulus.jobId, text);
  }

  /**
   * Post a SYSTEM→OPERATOR notice — a runtime/harness message for the OPERATOR ONLY, NOT in Atlas's voice
   * and never seeded into the brain (e.g. an unresumable-thread error). Mirrors {@link say} (live SSE post
   * + durable row) but stamps `meta.source='system_operator'` so the web renders its own system-notice box.
   * `retryable: true` tells the web to render a "Resume" button (a turn-halting engine error the operator
   * can re-poke without retyping anything — see `POST …/retry-turn`); omit/false for terminal failures.
   */
  /**
   * A BENIGN, self-recovering SDK stream abort: the engine ended the turn with
   * `terminal_reason="aborted_streaming"` (a priority:'now' steer that raced the stream, an interrupt).
   * Distinct from a genuine engine failure — recovered by a silent single resume, not an operator box.
   */
  private isBenignStreamAbort(err: unknown): boolean {
    return /aborted_streaming/.test(String(err));
  }

  /** Render a session-limit reset instant as a short human time (e.g. "3:20 PM"); falls back to the raw ISO
   *  string if unparseable. Mirrors the build lane's `fmtReset`; kept STABLE so the park notice dedupes. */
  private fmtReset(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  private async saySystemOperator(
    stimulus: TurnEnvelope,
    text: string,
    opts: {
      retryable?: boolean;
      sessionLimit?: boolean;
      resumeAt?: string;
      category?: TurnFailureCategory;
      summary?: string;
    } = {},
  ): Promise<void> {
    const route = await this.store.route({
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      jobId: stimulus.jobId,
    });
    const channel = route.channel ?? stimulus.replyRoute.jobRef;
    const threadTs = route.threadTs ?? stimulus.replyRoute.jobRef;
    // Idempotency: a PERSISTENT engine failure (spend / session / rate limit) fails every queued sibling
    // turn, every event/seed delivery, and every durable-delivery sweep re-drive identically — stacking
    // byte-identical red boxes. If the same notice already landed on this thread moments ago, skip it (the
    // operator already has the box + its Resume). Per-thread turns are serialized, so this can't race.
    if (await this.store.hasRecentSystemOperatorNotice(stimulus.jobId, text)) {
      this.logger.debug(
        `suppressing duplicate system→operator notice for thread=${stimulus.jobId}`,
      );
      // The outstanding box already exists, but this turn still stopped. Re-assert `halted` because a
      // Resume/new turn clears it at turn start before the repeated failure gets deduped here.
      await this.store.setHalted(stimulus.jobId, true).catch(() => undefined);
      return;
    }
    const meta = {
      source: 'system_operator',
      ...(opts.retryable ? { retryable: true } : {}),
      ...(opts.sessionLimit ? { sessionLimit: true } : {}),
      ...(opts.resumeAt ? { resumeAt: opts.resumeAt } : {}),
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.summary ? { summary: opts.summary } : {}),
    };
    try {
      await this.surface.post(channel, text, {
        threadTs,
        orgId: stimulus.orgId,
        meta,
      });
    } catch (err) {
      this.logger.warn(`failed to post system→operator notice: ${err}`);
    }
    await this.store.appendSystemOperatorMessage(stimulus.jobId, text, meta);
    // A turn-failure operator box is now outstanding — mark the thread halted so the sidebar renders it as
    // errored (a ✕ + needs-you dot) even though `status` is untouched. Cleared when the next turn starts.
    await this.store.setHalted(stimulus.jobId, true).catch(() => undefined);
  }

  /**
   * Cancel any pending Main-lane host-retry backstop for this job (in-process 10s timer + its durable
   * `kind:'retry'` resume clock), mirroring the build lane's `ThreadDriver.drive()` guard ('a fresh drive
   * supersedes any parked host-retry timer'). Called at the top of a fresh `runChatTurnInner` and on the
   * successful-turn tail: if the thread recovered through an unrelated path (an operator message, a pump/wake)
   * the stale timer must not later seed a spurious 'Please continue' nudge into an already-healthy job, and the
   * leftover retry clock must not keep `endTurnActivity` reporting `activity:'retrying'` or let the leader
   * `SessionResumeSweep` re-fire the nudge. The durable clear is conditional on `kind:'retry'` + lane `main`,
   * so it cannot clobber a session-limit park on either lane.
   */
  private async clearPendingHostRetry(jobId: string): Promise<void> {
    const t = this.hostRetryTimers.get(jobId);
    if (t) {
      clearTimeout(t);
      this.hostRetryTimers.delete(jobId);
    }
    await this.store
      .clearRetrySessionResume(jobId, 'main')
      .catch((e) =>
        this.logger.warn(
          `clearPendingHostRetry(${jobId}) clock clear failed: ${e}`,
        ),
      );
  }

  private async scheduleHostRetry(
    stimulus: TurnEnvelope,
    reason: string,
  ): Promise<void> {
    const resumeAt = new Date(Date.now() + HOST_RETRY_BACKOFF_MS).toISOString();
    await this.store
      .setSessionResume(stimulus.jobId, resumeAt, {
        lane: 'main',
        reason,
        resetSource: 'usage_api',
        kind: 'retry',
      })
      .catch((e) => this.logger.warn(`setSessionResume(retry) failed: ${e}`));
    const existing = this.hostRetryTimers.get(stimulus.jobId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.hostRetryTimers.delete(stimulus.jobId);
      void (async () => {
        try {
          await this.store.setSessionResume(stimulus.jobId, null, null);
          const title = await this.store
            .jobTitle(stimulus.jobId)
            .catch(() => null);
          // `seedRow: 'skip'` keeps the re-drive SILENT (drives the turn, renders no pill). The operator
          // already saw the visible "Reconnecting to Claude — auto-retry n/N…" notice appended when the
          // retry was scheduled; a second "Please continue…" box here is redundant plumbing.
          this.surface.seedSystemNotification?.(
            stimulus.repoId,
            stimulus.jobId,
            retryResumeNudge(title ?? undefined),
            { orgId: stimulus.orgId, seedRow: 'skip' },
          );
        } catch (e) {
          this.logger.warn(
            `host-retry re-drive for thread=${stimulus.jobId} failed: ${e}`,
          );
        }
      })();
    }, HOST_RETRY_BACKOFF_MS);
    if (typeof t.unref === 'function') t.unref();
    this.hostRetryTimers.set(stimulus.jobId, t);
  }

  /** Find the open scoping job on this thread, or open a fresh one. */
  private async ensureJob(
    stimulus: TurnEnvelope,
    title: string,
    kind: JobKind,
  ): Promise<string> {
    const existing = await this.store.openJobOnThread(stimulus.jobId);
    if (existing) return existing;
    return this.store.openJob({
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      jobId: stimulus.jobId,
      title: jobTitle(title),
      kind,
    });
  }
}

/** The synthetic author id Atlas stamps on its own (non-operator) turns — runDirectBuild /
 *  startFollowUpJob. The passive-awareness flush is gated on this so a background turn never drains
 *  the buffer before the operator sees it. */
/** How often the leader re-drives any operator message still undelivered (the at-least-once chat sweep). */
const CHAT_SWEEP_INTERVAL_MS = 30_000;
/** SchedulerRegistry interval name (process-unique) for the leader-gated chat-delivery sweep. */
const CHAT_SWEEP_INTERVAL = 'brain:chat-delivery-sweep';

/**
 * How long a `codex_reviews` row must sit `running` before the work-owed backstop treats it as STRANDED
 * (not a review legitimately in flight, and not a reattach still settling right after boot). Comfortably
 * shorter than a human's reaction time so a genuinely stalled plan recovers within a sweep or two.
 */
const PLAN_REVIEW_WEDGE_GRACE_MS = 90_000;

/** After nudging a work-owed review, don't re-nudge the same job for this long (lets the re-driven turn
 *  register). The live-turn guard is the primary dedup; this bounds the spin-up window. */
const WORK_OWED_RENUDGE_MS = 5 * 60_000;

/** Options threaded from the delivery pump into a fresh turn (stamp delivery at the registration hand-off). */
interface TurnDeliveryOpts {
  /** Fired when the turn becomes restart-survivable (registered + kicked). */
  onRegistered?: () => void;
}

type SeedCardStampResult = 'stamped' | 'missing' | 'failed';

const ATLAS_AUTHOR_ID = 'atlas';

/** True when a turn was authored by the operator — NOT a synthetic Atlas turn and NOT a host-originated
 *  system seed. Both background kinds must skip the passive-awareness drain so a real operator turn still
 *  gets the buffered milestones. */
function isOperatorAuthored(stimulus: TurnEnvelope): boolean {
  return (
    stimulus.author.id !== ATLAS_AUTHOR_ID &&
    stimulus.author.id !== SYSTEM_SEED_AUTHOR.id
  );
}

/** A seed that must run its OWN (guarded) turn rather than steering into a live one: `reset_verify` (its
 *  fresh-container cold-attach semantics depend on a dedicated turn) and `compaction` (a summarization turn
 *  that branches early in `runChatTurnInner`). Everything else steers into a live turn when one exists. */
function isStandaloneSeed(type: MessageType): boolean {
  return type === 'reset_verify' || type === 'compaction';
}

/** A turn that stamps a card (question/secret/file). Its stimulus row + card must be stamped TOGETHER on the
 *  consumption tail (fresh-turn success / steer ack / reattach), never on steer-dispatch or registration — so
 *  a register-then-fail turn re-drives instead of stranding a card behind a delivered row. Two shapes qualify:
 *  a card-bearing internal-seed variant (`answer_question`/`file_answered`/`secret_provided`), or the composed
 *  multi-item operator send (`type:'user'`) that carries the union of answered-card ids it delivered. */
function isSeedCardDelivery(s: TurnEnvelope): boolean {
  const t = s.message.type;
  if (
    t === 'answer_question' ||
    t === 'file_answered' ||
    t === 'secret_provided'
  )
    return true;
  return (
    (s.deliveredQuestionIds?.length ?? 0) > 0 ||
    (s.deliveredFileIds?.length ?? 0) > 0 ||
    (s.deliveredSecretIds?.length ?? 0) > 0
  );
}

/** Max consecutive UNATTENDED `reset_sandbox` calls before the tool refuses (cleared by any operator turn). */
const RESET_LOOP_CAP = 3;

/**
 * Compaction FLOOR — skip compaction when the brain session's context occupancy is below this fraction of
 * the model's window. A quick plan leaves a lean session; compacting it would burn a full-context summary
 * turn AND reset the prompt cache for no benefit. Only compact when the transcript is heavy enough that
 * carrying it into follow-ups actually hurts. Tunable. (The brain is pinned to Opus, whose window is ~1M,
 * so 0.3 ≈ 300k tokens.) The gate is POSITIVE-signal only: an unknown occupancy compacts (never silently
 * leaves a fat-but-unreported session uncompacted).
 */
const COMPACTION_MIN_OCCUPANCY_FRAC = 0.3;

/**
 * Build the documented-partial `Message` a SYNTHETIC or reattached {@link TurnEnvelope} carries — only its
 * `.type` + `MessageBase` identity are real; the variant args were consumed by `composeMessageBody` at
 * construction and the rendered body rides `envelope.body`, so nothing downstream of render reads them
 * (mirrors the store's `reconstructMessage` + `pumpEvent`'s stopgap). Used for the internal Atlas-authored
 * turns (compaction/direct-build/onboarding) and the reattach ctx rebuild, which have no typed variant on
 * hand. `type` is any `MessageType` that must NOT be mistaken for a card/reset/compaction turn unless it IS
 * one (the four guards read `.type`).
 */
function syntheticMessage(input: {
  id: string;
  orgId: string;
  repoId: string;
  jobId: string;
  receivedAt: Date;
  type: MessageType;
}): Message {
  return {
    id: input.id,
    orgId: input.orgId,
    repoId: input.repoId,
    jobId: input.jobId,
    receivedAt: input.receivedAt.toISOString(),
    type: input.type,
  } as unknown as Message;
}

/** `MessageBase` scaffolding for a synthetic host-seed `Message` built at a brain call site. Its `id`/
 *  `receivedAt` are inert (the brain path never persists the inbound row and `seedEnvelope` mints the envelope
 *  id + `Date` itself) — only the variant's `type` + args carry meaning. */
function seedBase(input: { jobId: string; orgId: string; repoId: string }): {
  id: string;
  orgId: string;
  repoId: string;
  jobId: string;
  receivedAt: string;
  trust: 'system';
} {
  return {
    id: randomUUID(),
    orgId: input.orgId,
    repoId: input.repoId,
    jobId: input.jobId,
    receivedAt: new Date().toISOString(),
    trust: 'system',
  };
}

/**
 * Wrap a typed internal-seed `Message` into a host-seed {@link TurnEnvelope} (SYSTEM_SEED_AUTHOR, no operator
 * bubble), rendering its body + `SeedRow` through the ONE `composeMessageBody` switch. The single builder the
 * synthetic (non-durable, brain-path) seed factories share: `reset_verify`, the work-owed/unblock/
 * request-changes wakes, and event delivery all flow through here so a variant's body + chunkKey stay
 * byte-identical to the durable-intake path.
 */
function seedEnvelope(
  message: Exclude<Message, { type: 'user' }>,
  opts?: {
    /** Override the minted id — event delivery passes the DURABLE event-row id so bookkeeping stamps it. */
    id?: string;
    /** A pre-rendered body/seedRow the caller already framed (event delivery: `renderEventDelivery`'s output
     *  rides straight through — no re-render — since `composeMessageBody`'s `event` arm reads `message.body`). */
    body?: AgentMessage;
    seedRow?: SeedRow;
    /** SESSION RE-HOME: run this turn on the thread's own session (see {@link TurnEnvelope.resumeThreadId}). */
    resumeThreadId?: string;
    /** File-gate delivery: the `request_file` card id this seed confirms, so the tail stamps it delivered. */
    deliveredFileIds?: string[];
  },
): TurnEnvelope {
  // Skip the compose switch entirely when the caller already framed both body + seedRow (event delivery:
  // `renderEventDelivery`'s output rides straight through — no re-render, per the envelope's body-carry rule).
  const composed =
    opts?.body === undefined || opts?.seedRow === undefined
      ? composeMessageBody(message)
      : undefined;
  const body = opts?.body ?? composed!.body;
  const seedRow = opts?.seedRow ?? composed?.seedRow;
  return {
    message,
    id: opts?.id ?? randomUUID(), // synthetic — the brain path doesn't persist the inbound row
    orgId: message.orgId,
    repoId: message.repoId,
    jobId: message.jobId,
    receivedAt: new Date(),
    author: { id: SYSTEM_SEED_AUTHOR.id, displayName: SYSTEM_SEED_AUTHOR.name },
    replyRoute: { surfaceId: 'web', jobRef: message.jobId },
    body,
    ...(seedRow ? { seedRow } : {}),
    ...(opts?.resumeThreadId ? { resumeThreadId: opts.resumeThreadId } : {}),
    ...(opts?.deliveredFileIds ? { deliveredFileIds: opts.deliveredFileIds } : {}),
  };
}

/**
 * Build a {@link TurnEnvelope} for an INTERNAL Atlas-authored turn with no durable inbound row and no typed
 * seed variant — a compaction / direct-build / onboarding instruction, or the approval-mechanism carrier.
 * `message` is a documented partial (only `.type` + identity real — {@link syntheticMessage}); the brain
 * guards read `.type`, so pass the type reflecting what the turn IS: `compaction` for a summarization turn,
 * otherwise `'user'` (a plain instruction turn — its author, `atlas` or a seed scope, decides framing). The
 * body is supplied pre-formed (these turns don't render through `composeMessageBody`).
 */
function internalEnvelope(input: {
  jobId: string;
  orgId: string;
  repoId: string;
  body: string;
  author: { id: string; displayName: string };
  type: MessageType;
  seedRow?: SeedRow;
}): TurnEnvelope {
  const id = randomUUID();
  const receivedAt = new Date();
  return {
    message: syntheticMessage({
      id,
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      receivedAt,
      type: input.type,
    }),
    id,
    orgId: input.orgId,
    repoId: input.repoId,
    jobId: input.jobId,
    receivedAt,
    author: input.author,
    replyRoute: { surfaceId: 'web', jobRef: input.jobId },
    body: input.body,
    ...(input.seedRow ? { seedRow: input.seedRow } : {}),
  };
}

/** Normalize a raw `decisions` tool arg into typed locked decisions (drops malformed entries). */
function normalizeDecisions(raw: unknown): Decision[] {
  const arr = Array.isArray(raw) ? raw : [];
  const candidates = arr.filter(
    (d): d is Record<string, unknown> =>
      typeof d === 'object' &&
      d !== null &&
      'decisionClass' in d &&
      'title' in d &&
      'ruling' in d,
  );
  // Preserve id/question/answer (this override path otherwise regresses the "fully resolved decision"
  // contract); assign a fresh stable id to any entry missing one, unique across the produced set.
  const out: Decision[] = [];
  for (const d of candidates) {
    const id =
      typeof d['id'] === 'string' && d['id'] ? d['id'] : nextDecisionId(out);
    out.push({
      id,
      decisionClass: d['decisionClass'] as Decision['decisionClass'],
      title: String(d['title']),
      ruling: String(d['ruling']),
      ...(typeof d['question'] === 'string' ? { question: d['question'] } : {}),
      ...(typeof d['answer'] === 'string' ? { answer: d['answer'] } : {}),
      // Carry provenance through the override path; absent → undefined (renders as Atlas-authored).
      ...(d['confirmedByOperator'] === true
        ? { confirmedByOperator: true }
        : {}),
    });
  }
  return out;
}

/** A short job title from a summary line. */
function jobTitle(summary: string): string {
  const firstLine =
    summary
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? summary;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

// ── Question / decision tool arg coercion ──────────────────────────────────────────────────────────

// Derived from the SSOT (DECISION_CLASS_META → DECISION_CLASS_IDS) — do NOT re-list the classes here.
const DECISION_CLASSES: ReadonlySet<string> = new Set<string>(
  DECISION_CLASS_IDS,
);

/**
 * Coerce a raw `decisionClass` arg into a valid {@link DecisionClass}, or undefined. Tolerant: the SDK
 * exposes a generic tool schema (no enum), so the model often guesses the token format — it sent
 * `api-contract`/`data-model` (hyphens) before self-correcting. Normalize casing + hyphens/spaces to the
 * canonical underscore id so a natural guess just works instead of costing a rejected round-trip.
 */
function asDecisionClass(v: unknown): DecisionClass | undefined {
  if (typeof v !== 'string') return undefined;
  const norm = v
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return DECISION_CLASSES.has(norm) ? (norm as DecisionClass) : undefined;
}

/** Return a focused missing-arguments hint before field-specific validation picks a misleading first error. */
function missingArgsEnvelope(
  args: Record<string, unknown>,
): { ok: false; reason: string } | null {
  if (args && Object.keys(args).length > 0) return null;
  return {
    ok: false,
    reason:
      'No arguments received — pass the required fields directly in this tool call ' +
      '(e.g. { decisionClass, ruling, title }).',
  };
}

/**
 * Normalize the `ask_question` `options` arg into `{ id?, label, description? }[]`. Accepts plain strings
 * ("Yes") or objects ({ label, description }); drops empties. The card builder fills missing ids.
 */
function normalizeQuestionOptions(
  raw: unknown,
): { id?: string; label: string; description?: string }[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: { id?: string; label: string; description?: string }[] = [];
  for (const o of arr) {
    if (typeof o === 'string') {
      const label = o.trim();
      if (label) out.push({ label });
    } else if (o && typeof o === 'object' && 'label' in o) {
      const label = String((o as { label: unknown }).label ?? '').trim();
      if (!label) continue;
      const id = optStr((o as { id?: unknown }).id);
      const description = optStr((o as { description?: unknown }).description);
      out.push({
        label,
        ...(id ? { id } : {}),
        ...(description ? { description } : {}),
      });
    }
  }
  return out;
}

/** Derive a short decision title from the question (or ruling) when the brain doesn't supply one. */
function deriveDecisionTitle(source: string): string {
  const firstLine =
    source
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? source;
  const cleaned = firstLine.replace(/[?:.]+$/, '').trim();
  return cleaned.length > 72
    ? `${cleaned.slice(0, 69)}...`
    : cleaned || 'Decision';
}

// ── Tool arg coercion (args are Record<string, unknown> from the bridge) ────────────────────────────

/** A trimmed non-empty string, or undefined. */
function optStr(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : undefined;
}

/** Coerce an arg into an array of non-empty strings (the bridge may pass a single string or an array). */
function strArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim());
    return out.length > 0 ? out : undefined;
  }
  const single = optStr(v);
  return single ? [single] : undefined;
}

/** A safe, short error message for a tool's `{ ok:false, reason }` (surfaces validation/404 cleanly). */
function errText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err)
    return String(err.message).slice(0, 200);
  return String(err).slice(0, 200);
}

/**
 * Normalize the `submit_plan` `threads` arg into ordered threads: `{ title, type }`. Steps are NO LONGER
 * authored up front (the running thread's orchestrator decomposes into a live task list), so `steps` is
 * OPTIONAL — parsed if a caller still supplies `{ title, brief }` items (back-compat: those lock + skip the
 * driver's JIT plan), else `[]`. A thread with an empty/whitespace title is dropped; a supplied step missing
 * a title OR a brief is dropped.
 */
function normalizeThreads(
  raw: unknown,
): { title: string; type: ThreadType; steps: PlannedStep[] }[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: { title: string; type: ThreadType; steps: PlannedStep[] }[] = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const o = s as {
      title?: unknown;
      brief?: unknown;
      type?: unknown;
      steps?: unknown;
    };
    const title = String(o.title ?? o.brief ?? '').trim();
    if (!title) continue;
    // Scope type is the deterministic routing key for review-lens selection: coerced to the closed
    // THREAD_TYPES vocabulary, with any unrecognized/empty value falling back to 'general'.
    const type = coerceThreadType(o.type);
    const stepsRaw = Array.isArray(o.steps) ? o.steps : [];
    const steps: PlannedStep[] = [];
    for (const p of stepsRaw) {
      if (!p || typeof p !== 'object') continue;
      const po = p as { title?: unknown; brief?: unknown };
      const pTitle = String(po.title ?? '').trim();
      const pBrief = String(po.brief ?? '').trim();
      if (pTitle && pBrief) steps.push({ title: pTitle, brief: pBrief });
    }
    out.push({ title, type, steps });
  }
  return out;
}
