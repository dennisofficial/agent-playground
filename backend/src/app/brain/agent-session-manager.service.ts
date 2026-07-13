import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
  ChatStimulus,
  EventStimulus,
  Job,
  JobKind,
  JobStatus,
  SeedRow,
} from '../domain';
import { MemoryStore } from '../memory';
import {
  StimulusStoreService,
  renderTurn,
  type TurnChunk,
} from '../stimulus';
import {
  CHAT_SURFACE,
  type ChatSurface,
  type DecisionApprovalCard,
  TurnHarnessFactory,
  ThreadInputService,
  SYSTEM_SEED_AUTHOR,
  type McpProposalServer,
  type WebQuestionCard,
  webConventionProposalCard,
  webConventionEditProposalCard,
  webFileRequestCard,
  webMcpProposalCard,
  webQuestionCard,
  webSecretInputCard,
  webShipReviewCard,
  webSkillEditAccessCard,
  webSkillProposalCard,
  wrapSystemNotification,
} from '../surface';
import { TurnUsageProjector } from '../analytics/turn-usage-projector.service';
import { EnvService } from '@core/config/env/env.service';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  ActiveTurnEntity,
  StimulusEntity,
  JobSandboxEntity,
  CodexReviewEntity,
  MessageEntity,
  RepoEntity,
} from '../persistence/entities';
import { ProdDiagnosticsService } from '../prod-mcp/prod-diagnostics.service';
import { isAtlasRepo } from '../sandbox/atlas-repo';
import type {
  McpAuthKind,
  McpOAuthTokenAuthMethod,
  McpSurface,
  StoredMcpOAuthConfig,
} from '../persistence/entities';
import {
  ProvisioningNotReadyError,
  JobLifecycleService,
} from '../driver/job-lifecycle.service';
import { DriverStoreService } from '../driver/driver-store.service';
import { BuildShipService } from '../driver/build-ship.service';
import { BrainGateway } from '../brain-gateway';
import { Agent, PromptService } from '../prompt-kit';
import { shipOpenPrBody } from '../prompt-kit';
import type { AgentMessage } from '../prompt-kit/message';
import { agentMessage, fromExternal } from '../prompt-kit/message';
import { isSubstantiveQuery, renderMemoryRecall } from '../prompt-kit/jit';
import {
  chunkKey,
  RESET_VERIFY_TEXT,
  COMPACTION_SYSTEM,
  COMPACTION_INSTRUCTION,
  CONTINUATION_PREAMBLE,
  foldCompactionSeed,
  renderWorkOwedNudge,
  renderRequestChangesDelivery,
  renderEventDelivery,
  haltWakeFraming,
  renderHaltDelivery,
  haltRecordBody,
  doneWakeFraming,
  renderDoneDelivery,
  doneRecordBody,
  frameAnswer,
  composeTurn,
  composeSeedTurn,
  maskedSecretNotice,
  maskedFileNotice,
  wakeForProvisioningFailureBody,
  wakeUnblockedJobBody,
  wakeForAmendApprovedBody,
  retryResumeNudge,
  resetContinuationNotice,
} from '../prompt-kit/harness';
// Re-exported so `brain/index.ts` (`export *`) and specs that import these straight from this file
// (colocated golden-snapshot/doctrine specs — see continuation-preamble-snapshot.spec / halt-triage-guidance.spec /
// agent-session-manager.spec) keep resolving after the content catalog moved into the prompt-kit hub.
export {
  CONTINUATION_PREAMBLE,
  haltTriageGuidance,
  renderDoneDelivery,
  doneRecordBody,
} from '../prompt-kit/harness';
import { PipelineAwarenessStore } from '../driver/pipeline-awareness.store';
import {
  pipelineStateSignature,
  renderAwarenessPrefix,
  renderPipelineStateSummary,
} from '../driver/pipeline-awareness';
import { DRIVER_REPO, type DriverRepoResolver } from '../driver/repo-resolver';
import type { PlannedStep } from '../prompt-kit/messages/render-plan';
import { coerceThreadType, type ThreadType } from '../thread-kind/thread-types';
import {
  LIVE_VERIFICATION_JUDGE,
  type LiveVerificationJudge,
  type LiveVerificationVerdict,
} from '../driver/live-verification-judge';
import {
  clampEvidenceOutput,
  NON_RUNTIME_FILE_RE,
  renderLockedDecisionsSummary,
  renderTerminalRecordSummary,
  type VerificationEvidence,
} from '../driver/live-verification-support';
import { DecisionClassifier } from '../decision-gate';
import { CredentialResolver, WorkspaceConfigStore, WorkspaceSecretFileStore } from '../onboarding';
import { OauthUsageService } from '../onboarding/oauth-usage.service';
import { defaultResumeAt } from '../engine/session-limit';
import { McpResolver, McpServerStore } from '../mcp';
import { ConventionProfileResolver } from '../conventions';
import { SkillFileWriter, SkillInstallerService, SkillResolver, WorkspaceSkillStore } from '../skills';
import { WorkspaceProfileService, detectRepoManifests } from '../workspace-profile';
import {
  CONTAINER_CONTEXT,
  isExternalMountPath,
  isReservedContainerPath,
  isReservedMountPath,
  MAX_MOUNT_PATH_LEN,
  type MountMode,
} from '../sandbox/container-paths';
import { LocalGitService } from '../git';
import type { SandboxMilestoneStage } from '../sandbox/sandbox-provider.port';
import { JobDependencyService } from '../job-deps';
import type { Decision } from '../domain';
import { nextDecisionId, DECISION_CLASS_IDS, HALT_FIX_ATTEMPT_CAP } from '../domain';
import type { DecisionClass } from '../domain/decision-record';
import { renderDecisionRecordMd } from './decision-record-md';
import { BRIDGE_SERVER_NAME } from '../sandbox/image/bridge-options';
import { isReservedMcpName } from '../sandbox/image/reserved-mcp-names';
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
  isEngineDetachedError,
  isUnresumableSessionMessage,
  resolveContextLimit,
  SANDBOX_RESET_NOTICE,
} from '../engine/engine.types';
import type {
  EngineEvent,
  EngineRunnerPort,
  GitAuth,
  ToolImpl,
  RunEngineArgs,
  EngineRunResult,
} from '../engine/engine.types';
import type { EngineHomeKey } from '../engine/engine-home';
import { threadKindSpec } from '../thread-kind';
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
} from './plan-review.service';
import { TurnRecoveryService } from './turn-recovery.service';
import { JitHostExecutor } from './jit-host-executor';

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
  private static readonly CHAT_DELIVERY_LEASE_MS = 2 * 60 * 1000;

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
   * Bounded silent auto-resume for a BENIGN `aborted_streaming` (an SDK stream abort that self-recovers) —
   * keyed by jobId, count of consecutive auto-resumes. Reset on the next successful turn. Past the cap we
   * stop swallowing and surface the normal retryable box, so a PERSISTENT abort still reaches the operator.
   */
  private readonly benignAbortRedrives = new Map<string, number>();
  private static readonly MAX_BENIGN_ABORT_REDRIVES = 2;

  // ── reset_sandbox bookkeeping (all keyed `orgId:jobId`, in-memory, per-process) ─────────────────
  /** "Tear down before the verify turn": set by the `reset_sandbox` tool, consumed by the turn tail. `hard`
   *  ⇒ a from-scratch worktree + container re-provision (vs the default container-only reset). */
  private readonly resetRequests = new Map<string, { reason: string; hard?: boolean }>();
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
    { gitUrl: string; orgId: string; owner: string; repo: string; defaultBranch: string }
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
  private readonly injectedMemoryByJob = new Map<string, InjectedMemoryDedupState>();

  /**
   * Steer-id → build-completion/halt wake payload, awaiting the engine's `input_ack` (the real consumption
   * signal — the engine emits it only after it PUSHES the steer into the live SDK session, never on the Redis
   * write). Populated when a wake is steered into an already-live brain turn (`steerIntoLiveBrainTurn`) and
   * consumed in `stampInputAck`, which stamps `done_waked_at`/`halt_waked_at` there. Bounded + per-process — an
   * unacked entry (turn died before the steer was injected, or a leader failover) is harmless: the owed flag
   * stays set and the 30s owed-wake sweep re-fires. Mirrors the durable-operator-message ack path.
   */
  private readonly pendingWakeAcks = new Map<
    string,
    | { kind: 'done'; threadId: string; gen: number }
    | { kind: 'halt'; threadId: string; gen: number }
  >();
  private static readonly MAX_PENDING_WAKE_ACKS = 512;

  constructor(
    private readonly store: BrainStoreService,
    private readonly driverStore: DriverStoreService,
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
    @InjectRepository(StimulusEntity, DB_CONNECTION)
    private readonly stimulusRows: Repository<StimulusEntity>,
    // The chat-inbox delivery queries (eligible/lease/mark-delivered/undelivered/reset) — the pump
    // delegates to these so the query logic is testable without this manager's full constructor.
    private readonly stimulusStore: StimulusStoreService,
    // The shared transcript spine — builds the per-turn streamer (live frames + durable blocks).
    private readonly turnHarness: TurnHarnessFactory,
    // Fast (direct-build) path: classify always-ask decisions, resolve the repo, and ship the result.
    private readonly classifier: DecisionClassifier,
    private readonly ship: BuildShipService,
    @Inject(DRIVER_REPO) private readonly repos: DriverRepoResolver,
    // Passive pipeline-milestone awareness: the durable per-thread buffer drained into each operator turn.
    private readonly awareness: PipelineAwarenessStore,
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
    // ADR-0005 live-verification judge — the SAME port the driver's per-thread gate uses (shared @Global
    // LiveVerificationModule). Gates the direct-build `finalize_build` ship: a runtime diff must be exercised
    // live (curl / drive / run), not merely typechecked, before the PR opens.
    @Inject(LIVE_VERIFICATION_JUDGE) private readonly liveVerificationJudge: LiveVerificationJudge,
    // Host-side subscription usage snapshot — the Main-lane session-limit park reads `getResetAt(orgId,
    // rateLimitType)` to seed the resume clock when the engine didn't surface a precise reset instant.
    // @Global OnboardingModule.
    private readonly usage: OauthUsageService,
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
  ) {}

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
      const { identity, apiToken } = await this.creds.githubWriteIdentity(target.orgId);
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
    // same at-least-once pump the web composer uses (steer a live turn / coalesce into a fresh one). Authored
    // `System` because a programmatic post is not the human operator typing.
    this.threadInput.register('main', {
      post: async ({ jobId, orgId, repoId }, message) => {
        const recorded = await this.stimulusStore.recordChatStimulus({
          orgId,
          repoId,
          jobId,
          author: { id: 'U-SYSTEM', displayName: 'System' },
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
    this.chatSweepPromoteSub = this.election.onPromote(() => this.startChatDeliverySweep());
    this.chatSweepDemoteSub = this.election.onDemote(() => this.stopChatDeliverySweep());
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
      // ADR 0004 Phase 3: backstop the thread-halt brain wake. The driver fires it inline once a job leaves
      // the active window, but that inline fire can lose a race with the just-ending build turn (a wake turn
      // that throws never stamps `halt_waked_at`). This periodic pass re-delivers any owed-but-unwaked halt
      // within a sweep interval — steady-state at-least-once, without waiting for a restart's boot sweep.
      void this.dispatcher
        .deliverOwedHaltWakes()
        .catch((err) => this.logger.warn(`periodic halt-wake sweep failed: ${err}`));
      // Decision d1: same at-least-once backstop for the completion wake (`'final'`/`'notable'`).
      void this.dispatcher
        .deliverOwedDoneWakes()
        .catch((err) => this.logger.warn(`periodic done-wake sweep failed: ${err}`));
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

    // 2b) Re-drive any compaction STRANDED between its (now-finished) exec and the reseed commit — the
    //     post-conclusion window re-attach can't cover (no `active_turns` row left). Guarded on "no live
    //     turn" so the exec is provably dead and a fresh run cannot race it. Runs AFTER `reattachOwnedTurns`
    //     (which awaits compaction reseeds), so a just-reattached job is no longer stranded here.
    try {
      await this.reconcileStrandedCompactions();
    } catch (err) {
      this.logger.warn(`compaction reconcile failed: ${err}`);
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
            seedQuestionId: q.questionId,
          }).catch((err) =>
            this.logger.warn(`question backfill failed for thread=${q.jobId}: ${err}`),
          );
        }
      }
      // Heal the denormalized open-question counter from the actual unanswered cards, so a crash mid-
      // open/answer can't leave the needs-you signal wedged the way the old single slot could.
      await this.store.reconcileOpenQuestionCounts();
    } catch (err) {
      this.logger.warn(`question-delivery reconciliation failed: ${err}`);
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
            seedRow: { label: notice, chunkKey: chunkKey.secret(s.jobId, s.name) },
            seedSecretId: s.requestId,
          }).catch((err) =>
            this.logger.warn(`secret backfill failed for thread=${s.jobId}: ${err}`),
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
            seedRow: { label: notice, chunkKey: chunkKey.file(f.jobId, f.path) },
            seedFileId: f.requestId,
          }).catch((err) =>
            this.logger.warn(`file backfill failed for thread=${f.jobId}: ${err}`),
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
            this.logger.warn(`boot event re-drive failed for stimulus=${ev.id}: ${err}`),
          );
        }
      }
    } catch (err) {
      this.logger.warn(`event-delivery reconciliation failed: ${err}`);
    }

    // Thread-halt wake reconciliation (ADR 0004 Phase 3, same at-least-once shape): a thread that halted
    // (`blocked`/`incomplete`/`failed`) records an owed brain wake on its row (`halt_outcome` set,
    // `halt_waked_at` null). If the host died between the halt and the wake turn, re-fire it. The driver owns
    // the query + wake + generation-keyed stamp; this just kicks the all-jobs pass. Idempotent.
    try {
      await this.dispatcher.deliverOwedHaltWakes();
    } catch (err) {
      this.logger.warn(`halt-wake reconciliation failed: ${err}`);
    }

    // Same at-least-once reconciliation for the completion wake (decision d1).
    try {
      await this.dispatcher.deliverOwedDoneWakes();
    } catch (err) {
      this.logger.warn(`done-wake reconciliation failed: ${err}`);
    }

    // Operator-chat delivery reconciliation (the durable-inbox at-least-once boot half): a plain operator
    // message is a `stimuli` row persisted at intake; `delivered_at` is stamped only on a positive brain
    // hand-off. Clear leases first (a row mid-attempt at crash never reached the registered hand-off — a
    // registered turn would have stamped it), then pump every thread with an undelivered message. The pump
    // steers a re-attached live turn or runs a fresh one; the periodic sweep keeps re-driving after boot.
    try {
      await this.stimulusStore.resetChatLeases();
      const threads = await this.stimulusStore.undeliveredChatThreads();
      if (threads.length > 0) {
        this.logger.log(
          `Leader: re-driving undelivered operator message(s) across ${threads.length} thread(s)`,
        );
        for (const t of threads) {
          void this.pumpThread(t.jobId, t.orgId, t.repoId).catch((err) =>
            this.logger.warn(`boot chat re-drive failed for thread=${t.jobId}: ${err}`),
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
        this.logger.log(`Leader: JSONL backstop back-filled ${recovered} lost turn(s)`);
    } catch (err) {
      this.logger.warn(`JSONL turn-recovery backstop failed: ${err}`);
    }
  }

  /**
   * SERVER-INITIATED open-PR turn (the ship step). Seeds the job-brain session with the ship turn-prompt
   * (reconcile the branch against its base → push → author the PR body → `gh pr create`) as a harness turn.
   * The brain runs it in ITS OWN sandbox on the feature branch with
   * its already-resolved engine auth + git auth — no separate `engine.run` session — and the HOST records
   * the opened PR afterward by branch discovery (`BuildShipService.latchPr` / the git-state reconciler), so
   * this turn needs no `report_pr_opened` tool. Idempotent: a re-seed on an already-open PR just `gh pr edit`s.
   * MUST only be called when the brain is IDLE (the driver/boot ship paths); a caller already inside a brain
   * turn (the direct-build `finalize_build` tool) instead returns {@link shipOpenPrBody} as guidance so the
   * brain opens the PR inline in its current turn — it cannot nest a second brain turn.
   */
  async openPrAtShip(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    branch: string;
    defaultBranch: string;
    title: string;
  }): Promise<void> {
    const stimulus = harnessDeliveryStimulus({
      jobId: input.jobId,
      orgId: input.orgId,
      repoId: input.repoId,
      body: shipOpenPrBody({
        branch: input.branch,
        defaultBranch: input.defaultBranch,
        title: input.title,
      }),
      seedRow: {
        label: 'Opening the pull request.',
        chunkKey: `seed:ship:${input.jobId}`,
      },
    });
    await this.handleChatTurn(stimulus);
  }

  /**
   * Phase 3 (ADR 0004 rider 4) — WAKE the job brain to triage a halted build thread. Called by the driver
   * (via the lazy `BrainSurface`) once a thread halts `blocked`/`incomplete`/`failed`, and again by the boot
   * sweep on crash recovery. Runs a TRUSTED harness turn (not the untrusted event lane, whose framing tells
   * the brain to propose-a-plan-before-any-build and would suppress the autonomous fix): the brain reads
   * `/context/generated/threads/<ordinal>-<slug>/completion.md` + the fenced record in the body, then either re-drives with guidance
   * (`retry_thread`) or escalates. A no-op if the thread is no longer owed a wake (already re-driven / done).
   */
  async notifyThreadHalted(
    jobId: string,
    threadId: string,
    outcome: 'blocked' | 'incomplete' | 'failed',
    gen: number,
  ): Promise<void> {
    const job = await this.driverStore.loadJob(jobId).catch(() => null);
    if (!job) return;
    const thread = await this.driverStore.getThread(threadId).catch(() => null);
    if (!thread) return;
    const term = await this.driverStore
      .getTerminalRecord(threadId)
      .catch(() => null);
    // A `done` record means the thread was re-driven and shipped between the owed-wake read and here —
    // nothing to triage. (`incomplete` legitimately has no record; still wake for it.)
    if (term?.status === 'done') return;
    // Resolve the transcript anchor DIRECTLY from steps/legs (not the record) so a null `term` (an
    // `incomplete` halt) still carries the session id — the exact class that most needs raw-transcript forensics.
    const anchor = await this.driverStore
      .resolveSessionAnchor(threadId)
      .catch(() => undefined);
    const stimulus = haltDeliveryStimulus({
      jobId,
      orgId: job.orgId,
      repoId: job.repoId,
      body: renderHaltDelivery(thread, outcome, term, anchor),
      seedHaltWake: { threadId, gen },
      // The halted thread's own (untrusted) record → a visible `untrusted` pill; keyed by thread+gen.
      seedRow: {
        kind: 'untrusted',
        label: haltRecordBody(term, anchor),
        chunkKey: `seed:halt:${threadId}:${gen}`,
        untrustedSource: `thread-halt:${threadId}`,
        severity: outcome,
        framing: haltWakeFraming(thread, outcome, term),
      },
    });
    await this.handleChatTurn(stimulus);
  }

  /**
   * Decision d1 — WAKE the job brain for a CLEAN completion owed a wake: `'final'` (the whole build parked
   * at the ship gate) or `'notable'` (a thread finished `done` but carrying gaps/unverified items). Called
   * by the driver (via `BrainSurface`) and again by the periodic + boot sweeps. Runs a TRUSTED harness turn
   * (same convention as {@link notifyThreadHalted}) so the brain can investigate/report/retry within the d2
   * autonomy boundary. A no-op if the thread has vanished.
   */
  async notifyThreadDone(
    jobId: string,
    threadId: string,
    reason: 'final' | 'notable',
  ): Promise<void> {
    const job = await this.driverStore.loadJob(jobId).catch(() => null);
    if (!job) return;
    const thread = await this.driverStore.getThread(threadId).catch(() => null);
    if (!thread) return;
    const term = await this.driverStore.getTerminalRecord(threadId).catch(() => null);
    // Claim a fresh completion-wake generation for THIS delivery, then supersede any prior (dead) attempt's
    // truncated partial before we stream the fresh summary. `claimDoneWakeGen` returns null when the wake is
    // no longer owed (already delivered by a racing sweep) → no-op. The supersede is deliberately NOT wrapped
    // in `.catch()`: if the delete fails we must NOT go on to stamp `done_waked_at`, else the stale partial is
    // orphaned with no later sweep to clean it — let it throw so the sweep's per-thread catch retries the
    // whole delivery (owed stays true; the gen already bumped so the retry's higher-gen supersede still
    // sweeps the earlier partial).
    const gen = await this.driverStore.claimDoneWakeGen(threadId).catch(() => null);
    if (gen == null) return;
    await this.driverStore.supersedeDoneWakeMessages(jobId, threadId, gen);
    // Resolved DIRECTLY from steps/legs at delivery time (not stored) — mirrors `notifyThreadHalted`.
    const anchor = await this.driverStore.resolveSessionAnchor(threadId).catch(() => undefined);
    let perThreadGaps: { brief: string; gaps: string[] }[] | undefined;
    if (reason === 'final') {
      const allThreads = await this.driverStore.threadsForJob(jobId).catch(() => []);
      const withGaps = await Promise.all(
        allThreads.map(async (t) => {
          const r = await this.driverStore.getTerminalRecord(t.id).catch(() => null);
          return r?.gaps?.length ? { brief: t.brief, gaps: r.gaps } : null;
        }),
      );
      perThreadGaps = withGaps.filter((g): g is { brief: string; gaps: string[] } => g != null);
    }
    const stimulus = doneDeliveryStimulus({
      jobId,
      orgId: job.orgId,
      repoId: job.repoId,
      body: renderDoneDelivery(thread, reason, term, anchor, perThreadGaps),
      seedDoneWake: { threadId, reason, gen },
      // The completed thread's own (untrusted) record → a visible `untrusted` pill.
      seedRow: {
        kind: 'untrusted',
        label: doneRecordBody(term, anchor),
        chunkKey: `seed:done:${threadId}`,
        untrustedSource: `thread-done:${threadId}`,
        severity: reason,
        framing: doneWakeFraming(thread, reason, term, anchor, perThreadGaps),
      },
    });
    await this.handleChatTurn(stimulus);
  }

  /**
   * WAKE the job brain because the repo's cold-boot SETUP SCRIPT failed on a fresh sandbox bring-up. Called
   * by `JobLifecycleService` (via ModuleRef) at `createJob` provisioning — a brand-new job has no turn yet, so
   * without this the failure would sit until the operator happened to message. Runs a TRUSTED harness turn;
   * the SPECIFIC error is delivered as a system notice on this
   * turn (drained from `job_sandboxes.setup_error` in {@link handleChatTurn}), so this body stays generic to
   * avoid duplicating it. Concurrency-safe via `handleChatTurn` (steers into a live turn / queues behind one).
   */
  async wakeForProvisioningFailure(jobId: string, orgId: string, repoId: string): Promise<void> {
    const stimulus = harnessDeliveryStimulus({
      jobId,
      orgId,
      repoId,
      body: wakeForProvisioningFailureBody(),
      seedRow: {
        label: 'Repo setup script failed on cold bring-up — checking the environment.',
        chunkKey: `seed:setup-fail:${jobId}`,
      },
    });
    await this.handleChatTurn(stimulus);
  }

  /**
   * WAKE a job whose block just cleared (every blocker reached a terminal state). Born-blocked jobs
   * (a create_job dependsOn that never started) replay their stored seed as the first turn; a job that
   * was manually blocked while it already had a session resumes that session with a synthetic wake
   * stimulus. `note` (d1) names any blocker that did NOT merge so the brain re-checks its assumptions.
   * Fire-and-forget (the JobUnblockSweep is the retry); concurrency-safe via handleChatTurn/startFollowUpJob.
   */
  async wakeUnblockedJob(
    jobId: string,
    orgId: string,
    repoId: string,
    input: { seed: string | null; note: string | null },
  ): Promise<void> {
    if (input.seed != null) {
      const firstMessage = input.note ? `${input.note}\n\n${input.seed}` : input.seed;
      await this.startFollowUpJob(jobId, orgId, repoId, firstMessage);
      return;
    }
    const stimulus = harnessDeliveryStimulus({
      jobId,
      orgId,
      repoId,
      body: wakeUnblockedJobBody(input.note),
      seedRow: { label: 'Unblocked — a blocking job resolved.', chunkKey: `seed:unblock:${jobId}` },
    });
    await this.handleChatTurn(stimulus);
  }

  /**
   * WAKE the job brain because the operator APPROVED its "Amend build?" proposal (the `withdraw_ship`
   * tool's card). By this point the operator retract path has already run (`awaiting_ship_review →
   * amending`), so the brain just needs to do the follow-up work it proposed. The brain's session is
   * resumed, so it recalls WHAT it proposed — the delivery stays generic. The brain re-arms the gate by
   * calling `report_verification({ passed: true })` once the amend is verified (re-parks directly at
   * `awaiting_ship_review`, no rebuild). Concurrency-safe via `handleChatTurn`.
   */
  async wakeForAmendApproved(jobId: string): Promise<void> {
    const job = await this.store.loadJob(jobId).catch(() => null);
    if (!job) return;
    const stimulus = harnessDeliveryStimulus({
      jobId,
      orgId: job.orgId,
      repoId: job.repoId,
      body: wakeForAmendApprovedBody(),
      seedRow: {
        label: 'Amend approved — resuming to make the changes.',
        chunkKey: `seed:amend-approved:${jobId}`,
      },
    });
    await this.handleChatTurn(stimulus);
  }

  // ── Public API ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Handle one chat stimulus in a scoping thread. SERIALIZED per thread: if a turn is already running for
   * this thread (the operator sent a follow-up while it was thinking), this one queues behind it and runs
   * after — never two concurrent engine turns resuming the same session id. Runs an in-sandbox engine
   * turn with the 6 host-side tools; the session is resumed across turns.
   */
  async handleChatTurn(stimulus: ChatStimulus): Promise<void> {
    // Drain gate: once this instance is draining (SIGTERM), accept NO new turns. Operator turns are
    // already rejected with 503 at the surface; this catches internal/boot re-delivery callers so the
    // in-flight set can actually quiesce. A no-op (not a throw) — internal callers are fire-and-forget.
    if (this.election.getState() === 'draining') return;

    // A dependency-blocked job is fully parked: no system wake/re-drive should start its brain until the
    // dependency service first flips it back to `open`.
    if (await this.isJobBlocked(stimulus.jobId)) {
      this.logger.log(`job=${stimulus.jobId} is blocked; dropping system turn until it is unblocked`);
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
      !stimulus.seedResetVerify &&
      !stimulus.compact &&
      (await this.steerIntoLiveBrainTurn(stimulus).catch((err) => {
        this.logger.warn(`steer-into-live pre-check failed for job=${stimulus.jobId}: ${err}`);
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
  private engineBody(stimulus: ChatStimulus): string {
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
  private persistSeedRow(stimulus: ChatStimulus): void {
    if (stimulus.author.id !== SYSTEM_SEED_AUTHOR.id) return; // harness seeds only
    if (stimulus.seedResetVerify) return; // reset already rides a notice chunk row
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
    const fullBody = !isUntrusted && stimulus.body !== row.label ? stimulus.body : undefined;
    void this.store
      .recordSystemChunk?.({
        jobId: stimulus.jobId,
        kind: row.kind ?? 'system_notice',
        text: fromExternal(row.label),
        chunkKey: row.chunkKey,
        ...(row.untrustedSource ? { untrustedSource: row.untrustedSource } : {}),
        ...(row.severity ? { severity: row.severity } : {}),
        ...(fullBody ? { fullBody: fromExternal(fullBody) } : {}),
        ...(row.framing ? { framing: row.framing } : {}),
      })
      ?.catch((err: unknown) =>
        this.logger.debug(`persistSeedRow failed (best-effort): ${err}`),
      );
  }

  private persistChunkRows(
    stimulus: ChatStimulus,
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

  private async steerIntoLiveBrainTurn(stimulus: ChatStimulus): Promise<boolean> {
    if (typeof this.engineRunner.steer !== 'function') return false;
    const live = await this.turnRegistry
      .runningBrainTurn(stimulus.jobId)
      .catch(() => null);
    if (!live?.turn_id) return false;
    try {
      await this.engineRunner.steer(live.turn_id, stimulus.id, this.engineBody(stimulus));
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
    // A completion/halt wake steered into a live turn is only marked delivered when the engine ACKS it (see
    // `stampInputAck`) — stamping here on the XADD would drop the wake if the turn dies before injecting it,
    // and a synthetic wake seed has no `stimuli` row to recover from. Record the payload keyed by the steer id
    // so the ack can reach it; NOT recorded on the XADD-failure return above (that must stay owed for the sweep).
    if (stimulus.seedDoneWake) {
      this.rememberPendingWakeAck(stimulus.id, {
        kind: 'done',
        threadId: stimulus.seedDoneWake.threadId,
        gen: stimulus.seedDoneWake.gen,
      });
    } else if (stimulus.seedHaltWake) {
      this.rememberPendingWakeAck(stimulus.id, {
        kind: 'halt',
        threadId: stimulus.seedHaltWake.threadId,
        gen: stimulus.seedHaltWake.gen,
      });
    }
    return true;
  }

  /** Remember a steered wake awaiting its `input_ack`, evicting the oldest entry past the bound (safe — an
   *  evicted wake just degrades to sweep-driven re-fire). */
  private rememberPendingWakeAck(
    id: string,
    wake:
      | { kind: 'done'; threadId: string; gen: number }
      | { kind: 'halt'; threadId: string; gen: number },
  ): void {
    this.pendingWakeAcks.set(id, wake);
    while (this.pendingWakeAcks.size > AgentSessionManager.MAX_PENDING_WAKE_ACKS) {
      const oldest = this.pendingWakeAcks.keys().next().value;
      if (oldest === undefined) break;
      this.pendingWakeAcks.delete(oldest);
    }
  }

  /** SUCCESS-TAIL wake stamps (halt + completion), generation-keyed. Shared by `runChatTurnInner`'s tail and
   *  the `reattachOne` success path — a reattached wake turn runs outside `runChatTurnInner`, so without this
   *  it would never stamp and the sweeps would re-wake it forever. Best-effort; a failed stamp just leaves the
   *  wake owed for the next sweep (at-least-once). */
  private async stampWakeSuccessTails(stimulus: ChatStimulus): Promise<void> {
    if (stimulus.seedHaltWake) {
      await this.driverStore
        .markHaltWaked(stimulus.seedHaltWake.threadId, stimulus.seedHaltWake.gen)
        .catch((err) => this.logger.warn(`markHaltWaked failed: ${err}`));
    }
    if (stimulus.seedDoneWake) {
      await this.driverStore
        .markDoneWaked(stimulus.seedDoneWake.threadId, stimulus.seedDoneWake.gen)
        .catch((err) => this.logger.warn(`markDoneWaked failed: ${err}`));
    }
  }

  /**
   * After a card-answer/confirmation seed is steered into a live turn, stamp its card `deliveredAt` (the
   * per-stimulus equivalent of the fresh-turn tail stamp in `runChatTurnInner`). Guarded + idempotent: only
   * an answered/provided, not-yet-delivered card is stamped. A plain chat message or bare nudge (no card id)
   * is a no-op.
   */
  private async stampLegacySeedCard(stimulus: ChatStimulus): Promise<void> {
    if (stimulus.seedQuestionId) {
      const card = await this.store
        .getQuestionCard(stimulus.jobId, stimulus.seedQuestionId)
        .catch(() => null);
      if (card?.answer != null && card.deliveredAt == null) {
        await this.store
          .markQuestionDelivered(stimulus.jobId, stimulus.seedQuestionId)
          .catch((err) =>
            this.logger.warn(`markQuestionDelivered (steer) failed: ${err}`),
          );
      }
    }
    if (stimulus.seedSecretId) {
      const card = await this.store
        .getSecretCard(stimulus.jobId, stimulus.seedSecretId)
        .catch(() => null);
      if (card?.provided_at != null) {
        if (card.delivered_at == null) {
          await this.store
            .markSecretDelivered(stimulus.jobId, stimulus.seedSecretId)
            .catch((err) =>
              this.logger.warn(`markSecretDelivered (legacy seed) failed: ${err}`),
            );
        }
        await this.store
          .clearAwaitingSecret(stimulus.jobId, stimulus.seedSecretId)
          .catch((err) =>
            this.logger.warn(`clearAwaitingSecret (legacy seed) failed: ${err}`),
          );
      }
    }
    if (stimulus.seedFileId) {
      const card = await this.store
        .getFileCard(stimulus.jobId, stimulus.seedFileId)
        .catch(() => null);
      if (card?.provided_at != null && card.delivered_at == null) {
        await this.store
          .markFileDelivered(stimulus.jobId, stimulus.seedFileId)
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
    const { jobId, seedQuestionId, seedSecretId, seedFileId } = stimulus;

    if (seedQuestionId) {
      // No .catch here: getQuestionCard returns null for a genuinely-absent card, and a THROWN error is
      // transient — it must PROPAGATE so the caller skips the trailing markChatDelivered and the sweep re-drives
      // (never stamping the row delivered while its card stays stranded, per this function's stated invariant).
      const card = await this.store.getQuestionCard(jobId, seedQuestionId);
      if (card?.answer != null && card.deliveredAt == null) {
        await this.store.markQuestionDelivered(jobId, seedQuestionId);
      }
    }

    if (seedSecretId) {
      // No .catch: a null is a genuinely-absent card; a thrown error is transient and must propagate (see above).
      const card = await this.store.getSecretCard(jobId, seedSecretId);
      if (card?.provided_at != null) {
        if (card.delivered_at == null) {
          await this.store.markSecretDelivered(jobId, seedSecretId);
        }
        // Clear even if the card was already marked delivered by a prior partial tail: the row must not be
        // delivered until both the card stamp and the gate clear have succeeded.
        await this.store.clearAwaitingSecret(jobId, seedSecretId);
      }
    }

    if (seedFileId) {
      // No .catch: a null is a genuinely-absent card; a thrown error is transient and must propagate (see above).
      const card = await this.store.getFileCard(jobId, seedFileId);
      if (card?.provided_at != null && card.delivered_at == null) {
        await this.store.markFileDelivered(jobId, seedFileId);
      }
    }
    return true;
  }

  /**
   * SUCCESS-TAIL seed stamp: mark the durable stimulus row delivered AND stamp its question/secret/file card,
   * together, so a seed's `stimuli.delivered_at` and its card `deliveredAt` commit as one on consumption (never
   * on steer-dispatch/registration). Keyed on the durable `stimuli.id` passed EXPLICITLY — on the reattach path
   * the reconstructed `ChatStimulus.id` is the engine turn id, not the row. Best-effort: a failed stamp leaves
   * BOTH owed for the sweep (at-least-once).
   */
  private async stampSeedCardSuccessTails(stimulusRowId: string): Promise<SeedCardStampResult> {
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
      this.logger.warn(`stampSeedCardSuccessTails failed (sweep will re-drive): ${err}`);
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
    stimulus: ChatStimulus,
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
    seedQuestionId?: string;
    seedSecretId?: string;
    seedFileId?: string;
  }): Promise<void> {
    const target = {
      ...(input.seedQuestionId ? { seedQuestionId: input.seedQuestionId } : {}),
      ...(input.seedSecretId ? { seedSecretId: input.seedSecretId } : {}),
      ...(input.seedFileId ? { seedFileId: input.seedFileId } : {}),
    };
    if (await this.stimulusStore.hasChatStimulusForSeedTarget(input.jobId, target)) return;
    const recorded = await this.stimulusStore.recordChatStimulus({
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      author: { id: SYSTEM_SEED_AUTHOR.id, displayName: SYSTEM_SEED_AUTHOR.name },
      replyRoute: { surfaceId: 'web', jobRef: input.jobId },
      body: input.body,
      systemChunk: input.seedRow,
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
  async enqueueChat(stimulus: ChatStimulus): Promise<void> {
    await this.pumpThread(stimulus.jobId, stimulus.orgId, stimulus.repoId);
  }

  /**
   * Deliver a thread's pending operator messages. FAST PATH: a running brain turn is steered directly
   * (outside the per-thread queue — that queue is HELD by the very turn we want to steer), so the model
   * reacts mid-flight; the engine's `input_ack` stamps delivery. SLOW PATH (no running turn): a fresh turn
   * is queued (serialized with all other turns) that coalesces the pending batch and stamps delivery at its
   * registration hand-off. Idempotent + safe to call redundantly (intake poke, sweep) — the lease + the
   * in-container exactly-once steer id set prevent double-injection.
   */
  async pumpThread(jobId: string, orgId: string, repoId: string): Promise<void> {
    if (this.election.getState() === 'draining') return;

    // Leave pending operator chat undelivered while the job is dependency-blocked. The unblock wake flips the
    // job open and the delivery sweep/poke will then carry the queued messages into the brain.
    if (await this.isJobBlocked(jobId)) {
      this.logger.log(`job=${jobId} is blocked; parking pending chat delivery`);
      return;
    }

    const live = await this.turnRegistry.runningBrainTurn(jobId).catch(() => null);
    if (live?.turn_id && typeof this.engineRunner.steer === 'function') {
      const pending = await this.stimulusStore
        .eligiblePendingChat(jobId, AgentSessionManager.CHAT_DELIVERY_LEASE_MS)
        .catch((err) => {
          this.logger.warn(`pump: eligiblePendingChat failed for thread=${jobId}: ${err}`);
          return [] as ChatStimulus[];
        });
      // Only `now`-priority messages steer a live turn; `queue`/`later` stay pending — they drain at
      // turn-end (the turn-end re-pump) or ride along the next turn that runs for any other reason (d18).
      const nowOnly = pending.filter(isNowPriority);
      if (nowOnly.length) await this.steerPending(live.turn_id, nowOnly);
      return;
    }

    // No running turn → deliver via a fresh turn, serialized on the per-thread turn queue.
    const key = `${orgId}:${jobId}`;
    const prev = this.turnQueues.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.deliverPendingViaFreshTurn(jobId, orgId, repoId));
    this.turnQueues.set(
      key,
      next.finally(() => {
        if (this.turnQueues.get(key) === next) this.turnQueues.delete(key);
      }),
    );
    return next;
  }

  /**
   * Owned coalescing selection for a fresh operator turn (d18). Fetch the thread's eligible pending chat, then
   * build the chronological `<user>` chunks (one per message), the id set to stamp delivered, and the wake flag
   * (true when at least one pending message is wake-eligible — a thread whose only pending rows are `later`
   * composes them as ride-along but must NOT start a turn on its own). Returns null when nothing is pending.
   */
  private async collectPendingForTurn(jobId: string): Promise<{
    pending: ChatStimulus[];
    userChunks: TurnChunk[];
    ids: string[];
    wake: boolean;
  } | null> {
    const pending = await this.stimulusStore
      .eligiblePendingChat(jobId, AgentSessionManager.CHAT_DELIVERY_LEASE_MS)
      .catch((err) => {
        this.logger.warn(`pump: eligiblePendingChat failed for thread=${jobId}: ${err}`);
        return [] as ChatStimulus[];
      });
    if (pending.length === 0) return null;
    // Never coalesce a system seed with operator rows: a seed batched as a `<user>` chunk would render named
    // "System" and mis-decide the batch's awareness drain. Partition on the HEAD row's authorship — an operator
    // head takes the leading run of operator rows (coalesced as before); a seed head takes ONLY that one seed
    // (each seed delivers solo, keeping its `<system_notice>` framing + awareness-drain semantics). The
    // remainder stays pending and drains via the turn-end re-pump, so no 30 s stall.
    const operatorHead = isOperatorAuthored(pending[0]);
    const batch: ChatStimulus[] = [];
    for (const p of pending) {
      if (isOperatorAuthored(p) !== operatorHead) break;
      batch.push(p);
      if (!operatorHead) break; // seeds deliver one-at-a-time
    }
    return {
      pending: batch,
      userChunks: batch.map((p) => userChunkFor(p)),
      ids: batch.map((p) => p.id),
      // Wake is computed over the FULL eligible-pending set, not just `batch`: a wake-eligible row excluded by the
      // author partition (e.g. a `now` seed behind a `later` operator head) must still start a turn — otherwise no
      // turn runs, no turn-end re-pump reconsiders the remainder, and the thread stalls until an unrelated wake.
      wake: pending.some(isWakeEligible),
    };
  }

  /** Run ONE fresh turn that consumes the thread's pending operator messages (coalesced, oldest first). */
  private async deliverPendingViaFreshTurn(
    jobId: string,
    orgId: string,
    repoId: string,
  ): Promise<void> {
    const collected = await this.collectPendingForTurn(jobId);
    if (!collected) return;
    // Only WAKE for a wake-eligible (now/queue) message. A thread whose only pending rows are `later`
    // composes them as ride-along into some OTHER turn — it must never start a turn on its own.
    if (!collected.wake) return;

    // A turn may have appeared since pumpThread's check (a boot re-attach resumed one). Steer the `now`
    // messages into it instead of starting a SECOND turn on the same session; queue/later stay pending for
    // the turn-end drain.
    const live = await this.turnRegistry.runningBrainTurn(jobId).catch(() => null);
    if (live?.turn_id && typeof this.engineRunner.steer === 'function') {
      const nowOnly = collected.pending.filter(isNowPriority);
      if (nowOnly.length) await this.steerPending(live.turn_id, nowOnly);
      return;
    }

    const leased = await this.stimulusStore
      .leaseChatStimuli(collected.ids)
      .then(() => true)
      .catch((err) => {
        this.logger.warn(`pump: leaseChatStimuli failed for thread=${jobId}: ${err}`);
        return false;
      });
    if (!leased) return;
    const ids = collected.ids;
    // Coalesce into one turn: the operator already sees each as its own bubble (a `messages` row per
    // message); the brain reads them together as this turn's task. Base fields come from the oldest.
    const combined: ChatStimulus = {
      ...collected.pending[0],
      body: collected.pending.map((p) => p.body).join('\n\n'),
      // Per-message attribution: one `<user name at>` chunk each, so a batch coalesced from several
      // senders isn't misattributed to the oldest. `engineBody` renders these; the joined `body` above
      // is the clean fallback (used for logging + when `chunks` is absent on a replay).
      chunks: collected.userChunks,
    };
    // A solo seed-card delivery defers its stimulus stamp to the SUCCESS tail (stamped together with the card)
    // so a register-then-fail turn leaves BOTH unstamped and the sweep re-drives it (at-least-once atomicity).
    // Operator chat keeps the looser at-registration bar — its input rides the prompt the instant it registers.
    const deferStimulusStamp = isSeedCardDelivery(combined);
    await this.runChatTurn(combined, {
      // Restart-survivable hand-off: stamp every coalesced message delivered the instant the turn is
      // registered + kicked (a later crash resumes THIS turn rather than re-running these messages).
      onRegistered: () => {
        if (deferStimulusStamp) return;
        for (const id of ids) {
          void this.stimulusStore.markChatDelivered(id).catch((err) =>
            this.logger.debug(`markChatDelivered ${id} failed (sweep will retry): ${err}`),
          );
        }
      },
    });
  }

  /** Steer each pending message into a live turn (lease first; the engine `input_ack` stamps delivered). */
  private async steerPending(turnId: string, pending: ChatStimulus[]): Promise<void> {
    await this.stimulusStore.leaseChatStimuli(pending.map((p) => p.id)).catch((err) =>
      this.logger.debug(`pump: leaseChat failed (continuing): ${err}`),
    );
    for (const p of pending) {
      await this.engineRunner
        .steer!(turnId, p.id, this.engineBody(p))
        .catch((err) =>
          this.logger.warn(`pump: steer of turn ${turnId} failed (sweep will re-drive): ${err}`),
        );
    }
  }

  /** Stamp `delivered_at` when the engine acks a steered message (from either onEvent path). A steered
   *  completion/halt wake is also marked delivered HERE — the ack is the real consumption signal, so a wake
   *  whose steer was never injected (turn died, held pre-stream) stays owed for the sweep to re-fire. */
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
      this.logger.debug(`input_ack stamp for ${e.id} failed (sweep will retry): ${err}`),
    );
    const wake = this.pendingWakeAcks.get(e.id);
    if (wake) {
      this.pendingWakeAcks.delete(e.id);
      if (wake.kind === 'done') {
        void this.driverStore
          .markDoneWaked(wake.threadId, wake.gen)
          .catch((err) => this.logger.warn(`markDoneWaked (ack) failed: ${err}`));
      } else {
        void this.driverStore
          .markHaltWaked(wake.threadId, wake.gen)
          .catch((err) => this.logger.warn(`markHaltWaked (ack) failed: ${err}`));
      }
    }
  }

  /** LEADER periodic + boot re-drive of any operator message still undelivered (the at-least-once sweep). */
  private async sweepUndeliveredChat(): Promise<void> {
    if (this.election.getState() !== 'leader') return;
    let threads: Array<{ jobId: string; orgId: string; repoId: string }>;
    try {
      threads = await this.stimulusStore.undeliveredChatThreads();
    } catch (err) {
      this.logger.debug(`chat delivery sweep query failed (will retry): ${err}`);
      return;
    }
    for (const t of threads) {
      void this.pumpThread(t.jobId, t.orgId, t.repoId).catch((err) =>
        this.logger.debug(`chat sweep pump failed for thread=${t.jobId}: ${err}`),
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
    let running: CodexReviewEntity[];
    try {
      running = await this.planReview.findRunningReviews();
    } catch (err) {
      this.logger.debug(`work-owed review sweep query failed (will retry): ${err}`);
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
  private async nudgeWorkOwedReview(review: CodexReviewEntity): Promise<void> {
    const ageMs = Date.now() - new Date(review.updated_at).getTime();
    if (ageMs < PLAN_REVIEW_WEDGE_GRACE_MS) return; // in flight / reattach settling — not stranded yet
    const last = this.workOwedNudgedAt.get(review.job_id) ?? 0;
    if (Date.now() - last < WORK_OWED_RENUDGE_MS) return; // recently nudged — let the turn spin up

    const job = await this.store.loadJob(review.job_id).catch(() => null);
    if (!job) return;
    // A terminal job no longer owes a review continuation (operator already saw the plan, or it's closed).
    if (job.status === 'awaiting_approval' || job.status === 'running')
      return;
    const live = await this.turnRegistry
      .runningBrainTurn(review.job_id)
      .catch(() => null);
    if (live?.turn_id) return; // a live turn owns the review
    const pendingChat = await this.stimulusStore
      .eligiblePendingChat(
        review.job_id,
        AgentSessionManager.CHAT_DELIVERY_LEASE_MS,
      )
      .catch(() => [] as ChatStimulus[]);
    if (pendingChat.some(isWakeEligible)) return; // the chat sweep will re-drive this job (later-only never wakes on its own)

    this.workOwedNudgedAt.set(review.job_id, Date.now());
    this.logger.log(
      `work-owed review: re-driving job=${review.job_id} (review stranded 'running' for ${Math.round(ageMs / 1000)}s)`,
    );
    const stimulus = harnessDeliveryStimulus({
      jobId: review.job_id,
      orgId: review.org_id,
      repoId: job.repoId,
      body: renderWorkOwedNudge(),
      seedRow: {
        label: 'Resuming a stranded Codex review that was left running.',
        chunkKey: `seed:work-owed:${review.id}`,
      },
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
    const live = await this.turnRegistry.runningBrainTurn(jobId).catch(() => null);
    if (!live?.turn_id) return false;
    await this.engineRunner.stop(live.turn_id);
    this.logger.log(`stop requested for brain turn ${live.turn_id} (job ${jobId})`);
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
      void handler.run(row).catch((err) =>
        this.logger.warn(`watchdog re-attach turn ${row.turn_id} (${row.kind}) failed: ${err}`),
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
    const claimedAttach = this.engineRunner.tryClaimAttach?.(row.turn_id) ?? true;
    if (!claimedAttach) {
      this.logger.log(`re-attach turn ${row.turn_id}: already attached in this process — skipping`);
      return;
    }
    try {
      const ctx = (row.ctx ?? {}) as {
        repoId?: string;
        author?: { id: string; displayName: string };
        body?: string;
        seed?: boolean;
        seedQuestionId?: string;
        seedSecretId?: string;
        seedFileId?: string;
        // The durable `stimuli.id` for a seed-card delivery — carried so the reattach success tail can stamp
        // the RIGHT row (the reconstructed `ChatStimulus.id` below is `row.turn_id`, the engine turn, not the row).
        deliveryStimulusId?: string;
        seedHaltWake?: { threadId: string; gen: number };
        seedDoneWake?: { threadId: string; reason: 'final' | 'notable'; gen: number };
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
      // Rebuild the ChatStimulus buildTools closes over (orgId/repoId/jobId/author/body).
      const stimulus: ChatStimulus = {
        id: row.turn_id,
        kind: 'chat',
        trust: 'trusted',
        orgId: row.org_id,
        repoId: ctx.repoId,
        jobId: row.job_id,
        body: ctx.body,
        author: ctx.author,
        replyRoute: { surfaceId: 'web', jobRef: row.job_id },
        receivedAt: new Date(),
        ...(ctx.seed ? { seed: true } : {}),
        ...(ctx.seedQuestionId ? { seedQuestionId: ctx.seedQuestionId } : {}),
        ...(ctx.seedSecretId ? { seedSecretId: ctx.seedSecretId } : {}),
        ...(ctx.seedFileId ? { seedFileId: ctx.seedFileId } : {}),
        // Preserve the halt-wake key so a reattached wake turn still stamps `halt_waked_at` on success — else
        // the halt stays owed and the sweeps re-wake it forever (Codex review Medium-1).
        ...(ctx.seedHaltWake ? { seedHaltWake: ctx.seedHaltWake } : {}),
        // Same reasoning for the completion wake (decision d1) — else a reattached done-wake turn never
        // stamps `done_waked_at` and the sweeps re-wake it forever.
        ...(ctx.seedDoneWake ? { seedDoneWake: ctx.seedDoneWake } : {}),
      };
      // Rebuild the dispatch map with the SAME shape the original kick used: an onboarding thread's
      // container declares the curated onboarding toolset, so a re-attach that registers the normal map
      // would reject those calls as "Unknown tool" (finish_onboarding at the end of a long run).
      const reattachKind =
        (await this.store.loadJob(row.job_id).catch(() => null))?.kind ?? null;
      const repoSlug = await this.resolveRepoSlug(stimulus.repoId);
      const tools = this.buildTools(stimulus, reattachKind, repoSlug);
      // Drop any live-turn state stranded by a prior subscription that died without finish/abort/discard, so
      // the '0-0' event replay below rebuilds a CLEAN buffer (a fresh turn_start) instead of appending onto a
      // stale open block — the root cause of persistent multiple-cursor state. Silent (no turn_end) to avoid
      // racing the client's async reconcile; guarded so the empty boot path is a no-op. Lane defaults to
      // 'main' — matches create() below (no lane arg).
      this.turnHarness.resetLane(row.channel, row.job_id);
      const streamer = this.turnHarness.create({
        jobId: row.job_id,
        orgId: row.org_id,
        channel: row.channel,
        turnId: row.turn_id,
        // Tag a reattached completion-wake turn's blocks with its generation, exactly like a fresh run — else
        // the reattach's persisted summary is UNTAGGED, escapes `supersedeDoneWakeMessages`, and a later sweep
        // leaves it as a duplicate alongside the sweep's own re-run.
        ...(ctx.seedDoneWake
          ? {
              metaTag: {
                doneWakeGen: ctx.seedDoneWake.gen,
                doneWakeThreadId: ctx.seedDoneWake.threadId,
              },
            }
          : {}),
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
          },
        );
        if (result.sessionId && sandboxRow) {
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
              }
            : undefined,
        );
        // SUCCESS TAIL — reattach runs OUTSIDE `runChatTurnInner`, so stamp the wake dedup markers here too
        // (the same shared helper), else a reattached halt/done wake never stamps and the sweeps re-wake it
        // forever. (This also makes the `seedHaltWake`/`seedDoneWake` preserve-comments above actually true.)
        await this.stampWakeSuccessTails(stimulus);
        // SUCCESS TAIL — same for a seed-card delivery that completed via reattach: stamp its durable stimulus
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
          },
          result.usage,
        );
        this.logger.log(`re-attached turn ${row.turn_id} completed + persisted`);
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
        // A benign stream abort on a WAKE turn (halt or completion) will be re-delivered in full by the owed-
        // wake sweep (owed stays true — the success stamp above never ran), so DISCARD the truncated partial
        // rather than persisting a durable half-message. Matches the fresh-run error tail. Any other error (or a
        // non-wake turn) keeps its partial as context.
        if (this.isBenignStreamAbort(err) && (ctx.seedHaltWake || ctx.seedDoneWake)) {
          await streamer.discard();
        } else if (this.engineRunner.consumeClaim?.(row.turn_id) === false) {
          // Errored AFTER another attacher already claimed the row — discard the partial rather than
          // double-finishing (row.turn_id IS the engine turnId on the reattach path, so the claim is exact).
          await streamer.discard();
        } else {
          await streamer.finish();
        }
      } finally {
        await this.store
          .endTurnActivity(row.job_id)
          .catch(() => undefined);
      }
    } finally {
      if (this.engineRunner.tryClaimAttach) this.engineRunner.releaseAttach?.(row.turn_id);
    }
  }

  /**
   * One chat turn — marks the thread "actively working" for its WHOLE duration (including the ~30s first
   * provisioning), so the sidebar "needs you" dot clears while we work and returns the moment control
   * comes back to the operator (every early return below still hits the `finally`). Best-effort flag
   * writes never block the turn. Delegates the actual turn to `runChatTurnInner`.
   */
  private async runChatTurn(
    stimulus: ChatStimulus,
    opts?: TurnDeliveryOpts,
  ): Promise<void> {
    await this.store
      .setActivity(stimulus.jobId, 'turn')
      .catch(() => undefined);
    // A new turn is starting (a fresh operator message OR the Resume nudge) — clear any outstanding halted
    // flag so the thread reads as working again. Best-effort; never block the turn.
    await this.store
      .setHalted(stimulus.jobId, false)
      .catch(() => undefined);
    try {
      await this.runChatTurnInner(stimulus, opts);
    } finally {
      await this.latchDirectBuildAtTurnEnd(stimulus);
      await this.store
        .endTurnActivity(stimulus.jobId)
        .catch(() => undefined);
      // Turn-end re-pump (d18): drain any `queue` message that arrived mid-turn (it was intentionally NOT
      // steered) into a fresh turn now rather than waiting the 30s sweep. Best-effort + idempotent —
      // delivered rows are stamped, and a `later`-only thread won't wake (collectPendingForTurn's wake guard).
      void this.pumpThread(stimulus.jobId, stimulus.orgId, stimulus.repoId).catch((err) =>
        this.logger.debug(`turn-end re-pump failed (sweep will retry): ${err}`),
      );
    }
  }

  /**
   * DIRECT-BUILD TURN-END LATCH (decision d3). A `finalize_build` in this turn committed the change and
   * handed the brain `shipOpenPrBody` — the brain then reconciled/pushed/`gh pr create`d inline, so the PR
   * now exists. Record it + flip `running → done` PROMPTLY here, instead of waiting on the 30-min
   * `GitStateReconciler` discovery. Runs only when the pending flag was set for this job (consumed here); a
   * latch MISS leaves the job `running` for that same reconciler backstop.
   */
  private async latchDirectBuildAtTurnEnd(stimulus: ChatStimulus): Promise<void> {
    if (!this.directBuildShipPending.delete(stimulus.jobId)) return;
    const job = await this.store.loadJob(stimulus.jobId).catch(() => null);
    // Mirror the `finalize_build` refusal gate: only a `running` build with an owning feature branch latches.
    if (!job || job.status !== 'running' || !job.featureBranch) return;
    const sandbox = await this.lifecycle
      .findSandbox(job.id, job.orgId)
      .catch(() => null);
    const repo = sandbox ? await this.repos.resolve(job).catch(() => null) : null;
    if (!sandbox || !repo) return;
    // Follow the LIVE branch (the agent may have `git checkout -b …` mid-build) — `discoverOpenPr` matches
    // on `sandbox.branch`, so hand it the live branch, mirroring the full ship path.
    const liveSandbox = { ...sandbox, branch: job.currentBranch ?? sandbox.branch };
    await this.ship.latchPr(job, repo, liveSandbox).catch(() => undefined);
  }

  /** The turn body (provision → attach → in-sandbox engine turn → stream + persist). Serialized by the
   *  `handleChatTurn` queue above — never invoked concurrently for the same thread. `opts.onRegistered`
   *  (the delivery pump's fresh-turn path) fires when the turn becomes restart-survivable, so the pump can
   *  stamp the operator message(s) `delivered_at` at hand-off rather than at completion. */
  private async runChatTurnInner(
    stimulus: ChatStimulus,
    opts?: TurnDeliveryOpts,
  ): Promise<void> {
    const resetKey = `${stimulus.orgId}:${stimulus.jobId}`;
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
    if (stimulus.seedResetVerify && !this.pendingResetVerify.has(resetKey)) return;

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

    // Resolve the current session_id for this thread (resume across turns).
    const sandboxRow = await this.sandboxRows.findOne({
      where: { job_id: stimulus.jobId, org_id: stimulus.orgId },
    });
    const sessionId = sandboxRow?.session_id ?? undefined;

    // COMPACTION turn: summarize the fat session into a lean handoff, null the session id (abandon the heavy
    // transcript), and stash the summary as the next turn's seed. Runs a summarization engine turn and
    // returns early — NOT a normal conversational turn. Serialized on this per-job queue, so it never races
    // the turn it compacts, and the build (separate driver sessions) is unaffected.
    if (stimulus.compact) {
      await this.runCompaction(stimulus, sandbox, sandboxRow ?? null, sessionId);
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
        this.logger.log(`reset_sandbox: fresh container up for thread=${stimulus.jobId} — this turn verifies the environment`);
        // Operator-visible bookend to the reset pill: makes the reset→recreate→verify cycle legible in the
        // transcript (the fresh container was just attached; this turn re-establishes + checks the stack).
        await this.store
          .appendSystemEvent(
            stimulus.jobId,
            '🟢 Sandbox is back up on a fresh container — verifying the environment cold-booted from durable config.',
          )
          .catch((err) => this.logger.debug(`appendSystemEvent failed: ${err}`));
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

    // PASSIVE pipeline-milestone awareness (buffer-and-flush, NOT a push). On an OPERATOR turn — and only
    // after the provisioning guards above succeeded, so a closed/failed turn never clears the buffer
    // un-injected — atomically drain any milestones buffered while the brain was idle + the net-state
    // delta into a clearly-passive reminder so the brain knows where the build stands. SYNTHETIC
    // (atlas-authored) turns skip the drain (runDirectBuild / startFollowUpJob must not consume the
    // buffer before the operator sees it). Best-effort: a failure here never blocks the turn.
    if (isOperatorAuthored(stimulus)) {
      const awarenessPrefix = await this.buildAwarenessPrefix(
        stimulus.jobId,
        stimulus.orgId,
      );
      if (awarenessPrefix) {
        reminderChunks.push({
          kind: 'system_reminder',
          body: awarenessPrefix,
          attrs: { reminderKind: 'awareness' },
        });
      }
    }

    // Surface the brain's OWN still-open questions back into THIS turn. Question cards live outside the
    // engine session — a fresh turn (a new operator message, an event delivery, or a restart-rebuilt session
    // whose context was compacted) has no in-context memory of what it already asked, so without this the
    // brain re-asks the same question over and over. Advisory reminder listing each open card's id + gist, so
    // it waits (or `withdraw_question`s) instead of re-posting. Applies to every turn; best-effort.
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

    // AMENDING guidance — persistent while the ship gate is retracted for a follow-up fix. BOTH entry paths
    // land in `amending`: the brain's own `withdraw_ship` proposal (which wakes the brain) AND the operator's
    // manual "Amend build" click (which does NOT wake the brain at all). A one-time wake can also be compacted
    // mid-amend. So re-state the return path EVERY turn while amending, so the brain always knows how to get
    // back to ready-to-ship. Best-effort; null unless the job is `amending`.
    const amendingPrefix = await this.buildAmendingPrefix(stimulus.jobId);
    if (amendingPrefix) {
      reminderChunks.push({
        kind: 'system_reminder',
        body: amendingPrefix,
        attrs: { reminderKind: 'amending' },
      });
    }

    // JIT turn-prefix rail (d18): `operator-message` rules may prepend a `system_reminder`. The reserved
    // `memory` slot now carries auto-recalled facts (d1/d2) via `prependText`; empty → no chunk → byte-identical.
    if (isOperatorAuthored(stimulus) && this.jit?.hasEnabledOperatorPrepends()) {
      const prependText = (await this.buildMemoryRecallPrefix(stimulus, sessionId)) ?? undefined;
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
      const userChunks = stimulus.chunks?.length ? stimulus.chunks : [userChunkFor(stimulus)];
      task = composeTurn({ prefixChunks: [...noticeChunks, ...reminderChunks], userChunks });
    } else {
      // Non-operator seed body is RAW/already-framed passthrough (`engineBody` returns it verbatim) — it can't
      // be a `<user>` chunk, so frame it through the hub's seed-turn factory; `fromExternal` marks the non-hub
      // body at the seam rather than minting it locally.
      task = composeSeedTurn(
        [...noticeChunks, ...reminderChunks],
        fromExternal(this.engineBody(stimulus)),
      );
    }

    // COMPACTION seed fold: a prior compaction nulled the session + stashed a lean handoff summary here.
    // Open THIS turn with it as recovered memory so the fresh session (session_id is null → engine starts
    // new) re-orients. Cleared the instant the fresh session is born (see the eager session persist below)
    // — NOT here — so a crash before the new session exists re-folds it next turn rather than dropping it.
    // (Reset and compaction are mutually exclusive: compaction nulls the session id, so `wasReset &&
    // sessionId` above cannot also be true.)
    const compactionSeed = sandboxRow?.pending_compaction_seed ?? null;
    const hadCompactionSeed = !!compactionSeed;
    if (compactionSeed) {
      // The seed was hub-composed (CONTINUATION_PREAMBLE + summary) then stashed on the sandbox row, so it
      // re-crosses the seam as brand-erased external text; the fold + mint stay inside the hub factory.
      task = foldCompactionSeed(fromExternal(compactionSeed), task);
    }

    // Onboarding threads (`kind='onboarding'`) run a different mission prompt + a curated, build-free
    // toolset (the gating is enforced here, not just in prose — omitted tool names aren't registered).
    const brainJob = await this.store
      .loadJob(stimulus.jobId)
      .catch(() => null);
    if (brainJob?.status === 'blocked') return;

    // Build the host-side tool dispatch table, scoped to this thread. Curated by kind (onboarding/review
    // get build-free subsets — see buildTools). The repo SLUG (not the UUID) gates the atlas-prod toolset,
    // resolved once here and reused for the jobContext.isAtlasRepo prompt flag below.
    const repoSlug = await this.resolveRepoSlug(stimulus.repoId);
    const tools = this.buildTools(stimulus, brainJob?.kind ?? null, repoSlug);

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
    // The brain streams on the default `main` lane (no metaTag) — its blocks ARE the conversation. EXCEPT a
    // completion-wake turn: tag its blocks with the wake generation so a later re-delivery can supersede this
    // attempt's rows if it dies mid-stream (see `supersedeDoneWakeMessages`).
    const streamer = this.turnHarness.create({
      jobId: stimulus.jobId,
      orgId: stimulus.orgId,
      channel,
      ...(stimulus.seedDoneWake
        ? {
            metaTag: {
              doneWakeGen: stimulus.seedDoneWake.gen,
              doneWakeThreadId: stimulus.seedDoneWake.threadId,
            },
          }
        : {}),
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
      (await this.conventions?.resolveForRepo(stimulus.orgId, stimulus.repoId)) ?? null;
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
      (await this.skills?.resolveForTurn(stimulus.orgId, stimulus.repoId, 'brain')) ?? [];
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
    const branch = brainJob?.featureBranch ?? brainJob?.currentBranch ?? undefined;
    const baseBranch = brainJob?.baseBranch ?? gitTarget?.defaultBranch ?? undefined;
    const jobContext = {
      ...(gitTarget ? { repoName: `${gitTarget.owner}/${gitTarget.repo}` } : {}),
      cwd: sandbox.worktreePath,
      ...(branch ? { branch } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      ...(this.env && isAtlasRepo(repoSlug ?? '', this.env) ? { isAtlasRepo: true } : {}),
    };
    const runArgs: RunEngineArgs = {
      engine: 'claude',
      task,
      cwd: sandbox.worktreePath,
      // Assembled from fragments (ATLAS_MAIN): the onboarding vs normal-brain split is a jobKind condition,
      // not a separate prompt id — `isOnboarding` still gates the toolset above. Byte-identical to the legacy
      // (see prompt-service.spec — the brain is assembled purely from `@Fragment`s).
      systemPrompt: this.prompts.generate(Agent.ATLAS_MAIN, {
        jobKind: brainJob?.kind ?? null,
        job: jobContext,
        settings: { repoConventions, workspaceProfile, autoApproveMode: brainJob?.autoApproveMode ?? 'off' },
      }),
      sandboxKey,
      ...(auth ? { auth } : {}),
      ...(userMcpServers.length > 0 ? { userMcpServers } : {}),
      ...(repoConventions ? { repoConventions } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(grantedSkills && grantedSkills.size > 0 ? { grantedSkills: Array.from(grantedSkills) } : {}),
      mode: 'execute', // the session manages its own read-only posture via custom plan mode
      model: AgentSessionManager.BRAIN_MODEL, // the thread brain reasons/plans — pin it to Opus
      ...(threadKindSpec('main').reasoningEffort
        ? { modelReasoningEffort: threadKindSpec('main').reasoningEffort }
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
        lane: 'main',
        kind: 'brain',
        // Enough to rebuild the ChatStimulus + buildTools closure on a boot re-attach (see reattachOne).
        // `seed`/`seedQuestionId` are persisted so a re-attached DELIVERY turn can still stamp its card
        // `deliveredAt` on success — otherwise the boot sweep would re-seed that card on every restart forever.
        ctx: {
          repoId: stimulus.repoId,
          sandboxKey,
          author: stimulus.author,
          body: stimulus.body,
          ...(stimulus.seed ? { seed: true } : {}),
          ...(stimulus.seedQuestionId
            ? { seedQuestionId: stimulus.seedQuestionId }
            : {}),
          ...(stimulus.seedSecretId ? { seedSecretId: stimulus.seedSecretId } : {}),
          ...(stimulus.seedFileId ? { seedFileId: stimulus.seedFileId } : {}),
          // Durable stimulus id for a seed-CARD delivery — carried so a reattach-completed turn stamps the RIGHT
          // `stimuli` row + its card together (here `stimulus.id` is the fresh-turn `combined.id` = `stimuli.id`).
          // Scoped to card seeds so event/wake seeds (no card, no owned row) don't drag their id through the tail.
          ...(isSeedCardDelivery(stimulus) ? { deliveryStimulusId: stimulus.id } : {}),
          // Halt-wake key: a reattached wake turn must still stamp `halt_waked_at` on success (Medium-1).
          ...(stimulus.seedHaltWake ? { seedHaltWake: stimulus.seedHaltWake } : {}),
          // Done-wake key (decision d1): same reasoning, for `done_waked_at`.
          ...(stimulus.seedDoneWake ? { seedDoneWake: stimulus.seedDoneWake } : {}),
        },
      },
      ...(opts?.onRegistered ? { onTurnRegistered: opts.onRegistered } : {}),
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
        if (
          e.kind === 'session' &&
          e.sessionId &&
          sandboxRow &&
          sandboxRow.session_id !== e.sessionId
        ) {
          const sid = e.sessionId;
          sandboxRow.session_id = sid;
          // If this turn folded a compaction seed, the fresh session now exists — clear the seed AND the
          // abandon marker in the SAME write: the compacted session is fully retired, so recovery may resume
          // normal skips for this job. A crash before this point re-folds the seed + keeps the marker (both
          // safe — recovery keeps skipping the abandoned session until the fresh one is truly born).
          if (hadCompactionSeed) {
            sandboxRow.pending_compaction_seed = null;
            sandboxRow.compacting_session_id = null;
          }
          try {
            void Promise.resolve(
              this.sandboxRows.update(
                { job_id: stimulus.jobId, org_id: stimulus.orgId },
                {
                  session_id: sid,
                  ...(hadCompactionSeed
                    ? { pending_compaction_seed: null, compacting_session_id: null }
                    : {}),
                },
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
      // Classify BEFORE persisting so we can discard a partial that will be re-delivered in full. A benign
      // `aborted_streaming` on a WAKE turn is re-fired by the owed-wake sweep (the stamp never landed, so the
      // wake stays owed) — persisting its truncated partial would leave a durable half-message beside the
      // complete re-run (the ship-gate duplicate). Discard it. A normal turn's benign abort still finishes
      // (keeps its partial) and gets the continue-nudge below; a real failure always keeps its partial.
      const benignAbort = this.isBenignStreamAbort(err);
      const isWakeTurn = !!(stimulus.seedHaltWake || stimulus.seedDoneWake);
      if (benignAbort && isWakeTurn) {
        await streamer.discard();
      } else if (this.engineRunner.consumeClaim?.(stimulus.id) === false) {
        // Best-effort claim check: on the fresh-run path the engine turnId is generated INSIDE runner.run
        // (randomUUID) and never surfaced here, so `stimulus.id` won't match it — consumeClaim returns
        // undefined and we fall through to finish() (the safe back-compat default). The confirmed dup is the
        // SUCCESS path, which IS gated above via `result.claimed`.
        await streamer.discard();
      } else {
        await streamer.finish();
      }
      // ADR 0004 Phase 3 / decision d1: a halt-wake OR done-wake turn is an internal, auto-retried delivery
      // (the periodic + boot sweeps re-fire it because the stamp only lands on the success tail). Don't post a
      // scary operator error box for it — that's noise the operator can't act on. Just log; the sweep will
      // retry once the session settles. ORDERING is load-bearing: this wake early-return stays AHEAD of the
      // benign continue-nudge branch, so a wake turn is re-delivered ONLY by the (gen-superseding) owed-wake
      // sweep, never also by an untagged continue-nudge re-author.
      if (isWakeTurn) {
        this.logger.warn(
          `wake turn failed for thread=${stimulus.jobId} (sweep will retry): ${err}`,
        );
        return;
      }
      // A turn failure is a HARNESS error, never Atlas talking — both branches post a system→operator
      // notice (its own red box, not an Atlas bubble). Show the TRUE error verbatim, no narrative wrapper
      // ("I ran into an error — please try again") and no truncation — the box is a full panel, not a
      // card field with a length limit. An unresumable session gets one extra line of guidance and NO
      // resume option (retrying truly can't help — the transcript is gone, see `isUnresumableSessionMessage`);
      // any other failure is just the raw error, marked `retryable` so the web offers a "Resume" button
      // that re-pokes the SAME engine session (`POST …/retry-turn`) without a new operator message.
      if (isUnresumableSessionMessage(String(err))) {
        await this.saySystemOperator(
          stimulus,
          `${String(err)}\n\nThis thread can't continue — its engine session state is gone. Please start a new thread to pick this back up.`,
        );
      } else if (benignAbort) {
        // A self-recovering SDK stream abort (`aborted_streaming`) — NOT a real failure the operator must
        // act on. The engine-side hold makes the startup-race variant impossible; this is the net for any
        // residual/other abort. Instead of a scary red box, silently resume the SAME session once (the same
        // nudge the operator's Resume button seeds), bounded so a PERSISTENT abort still surfaces a box.
        const n = (this.benignAbortRedrives.get(stimulus.jobId) ?? 0) + 1;
        if (n <= AgentSessionManager.MAX_BENIGN_ABORT_REDRIVES) {
          this.benignAbortRedrives.set(stimulus.jobId, n);
          this.logger.warn(
            `benign aborted_streaming for thread=${stimulus.jobId} — auto-resuming (attempt ${n}/${AgentSessionManager.MAX_BENIGN_ABORT_REDRIVES}), no operator box: ${err}`,
          );
          // Name the task in the nudge — a bare "Please continue." on a cold re-attach is exactly what left
          // the brain disoriented (posting a needless "what should I continue?" question). The title orients it.
          const title = await this.store.jobTitle(stimulus.jobId).catch(() => null);
          const nudge = retryResumeNudge(title ?? undefined);
          this.surface.seedSystemNotification?.(stimulus.repoId, stimulus.jobId, nudge, {
            orgId: stimulus.orgId,
          });
        } else {
          this.logger.warn(
            `benign aborted_streaming recurred ${n}× for thread=${stimulus.jobId} — surfacing retryable box`,
          );
          await this.saySystemOperator(stimulus, String(err), { retryable: true });
        }
      } else {
        await this.saySystemOperator(stimulus, String(err), { retryable: true });
      }
      return;
    }
    // A turn completed without throwing — clear any benign-abort auto-resume budget for this thread.
    this.benignAbortRedrives.delete(stimulus.jobId);

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

    // Persist the session_id for resume.
    if (result.sessionId && sandboxRow) {
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
      if (this.lost(result)) { await streamer.discard(); return; }
      const rlType = result.sessionLimit.rateLimitType;
      const resumeAt =
        result.sessionLimit.resetAt ?? (await this.usage.getResetAt(stimulus.orgId, rlType));
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
        })
        .catch(() => undefined);
      const resetSource: 'usage_api' | 'parsed_string' = rlType ? 'usage_api' : 'parsed_string';
      const reason = `Claude session limit${rlType ? ` (${rlType})` : ''}${resumeAt ? `; resets ${resumeAt}` : ''}`;
      await this.store
        .setSessionResume(stimulus.jobId, resumeClock, { lane: 'main', reason, resetSource })
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
              contextLimit: resolveContextLimit(result.usage.contextModel ?? result.usage.model),
            }
          : undefined,
      );
      void this.usageProjector?.record(
        { jobId: stimulus.jobId, orgId: stimulus.orgId, lane: 'main', kind: 'brain', engine: 'claude' },
        result.usage,
      );
      await this.saySystemOperator(
        stimulus,
        `You've hit your session limit — resets ${resumeAt ? this.fmtReset(resumeAt) : 'soon'}. Auto-resumes then; use Force resume now to resume earlier.`,
        { retryable: false, sessionLimit: true, ...(resumeAt ? { resumeAt } : {}) },
      );
      return;
    }

    // Flush the durable transcript (persists any unpaired tool call + a text fallback if the turn emitted
    // no text block) + a `turn_meta` block (per-turn token usage + context-window occupancy, when the SDK
    // reported usage), then signal turn end so the client reconciles its live buffer against /messages.
    if (this.lost(result)) { await streamer.discard(); return; }
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
          }
        : undefined,
    );
    void this.usageProjector?.record(
      { jobId: stimulus.jobId, orgId: stimulus.orgId, lane: 'main', kind: 'brain', engine: 'claude' },
      result.usage,
    );

    // SUCCESS TAIL — ADR 0004 Phase 3 halt wake + decision d1 completion wake: the brain actually TRIAGED /
    // reviewed this wake this turn, so stamp its (generation-keyed) dedup marker now. Reached only on the
    // happy path — a swallowed engine error / single-turn-guard hit / detach all `return` above WITHOUT
    // stamping, so the periodic + boot sweeps re-fire the wake (at-least-once). Shared with the reattach
    // success path (which runs outside this method) so both stamp identically.
    await this.stampWakeSuccessTails(stimulus);

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
  private async maybeHonorSandboxReset(stimulus: ChatStimulus): Promise<void> {
    const key = `${stimulus.orgId}:${stimulus.jobId}`;
    const req = this.resetRequests.get(key);
    if (!req) return;
    this.resetRequests.delete(key);
    this.logger.log(
      `reset_sandbox: honoring ${req.hard ? 'HARD ' : ''}reset for thread=${stimulus.jobId} (reason: ${req.reason}) — tearing down`,
    );

    // HARD reset re-provisions the whole sandbox (worktree + container, session preserved); the default reset
    // recreates only the container. Both keep `session_id`, so the fresh box resumes the same brain session.
    const res = await (req.hard
      ? this.lifecycle.hardResetSandbox(stimulus.jobId, stimulus.orgId)
      : this.lifecycle.resetContainer(stimulus.jobId, stimulus.orgId)
    ).catch((err) => {
      this.logger.warn(`reset_sandbox ${req.hard ? 'hard-' : ''}teardown failed for thread=${stimulus.jobId}: ${err}`);
      return { reset: false, reason: 'no-container' } as const;
    });

    if (!res.reset) {
      this.logger.log(`reset_sandbox: skipped for thread=${stimulus.jobId} — ${res.reason}`);
      const pill =
        res.reason === 'busy'
          ? '🔄 Sandbox reset skipped — a build is currently running in this container. Try again once it finishes.'
          : '🔄 Sandbox reset skipped — no live container to recreate (it will start fresh on the next turn anyway).';
      await this.store
        .appendSystemEvent(stimulus.jobId, pill)
        .catch((err) => this.logger.debug(`appendSystemEvent failed: ${err}`));
      return;
    }
    this.logger.log(`reset_sandbox: container torn down for thread=${stimulus.jobId} — kicking verify continuation`);

    // NOTE: the operator-visible "reset requested" pill is posted by the TOOL (mid-turn, so it lands on this
    // turn's reconcile); the "back up — verifying" bookend is posted by the verify turn's notice-fold. Nothing
    // is posted here — a tail-posted pill would miss this turn's reconcile (turn_end already fired).
    this.pendingResetVerify.add(key);

    void this.handleChatTurn(
      resetContinuationStimulus({
        jobId: stimulus.jobId,
        orgId: stimulus.orgId,
        repoId: stimulus.repoId,
      }),
    ).catch((err) =>
      this.logger.warn(`reset_sandbox verify continuation failed for thread=${stimulus.jobId}: ${err}`),
    );
  }

  /** Resolve a repo's SLUG from its id (cached). The atlas-prod toolset gates on the SLUG (=== ATLAS_REPO_SLUG),
   *  NEVER the repoId UUID. A light RepoEntity lookup — NOT `repos.resolve()` (which does a network git GET). */
  private async resolveRepoSlug(repoId: string): Promise<string | null> {
    if (!this.repoRows) return null;
    if (this.repoSlugCache.has(repoId)) return this.repoSlugCache.get(repoId) ?? null;
    const row = await this.repoRows.findOne({ where: { id: repoId } }).catch(() => null);
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
    stimulus: ChatStimulus,
    kind: string | null = null,
    repoSlug: string | null = null,
  ): Record<string, ToolImpl> {
    const onboarding = kind === 'onboarding';
    const review = kind === 'review';
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
          ? (args['questionId'] as string).trim() || undefined
          : undefined;
      const answered = await this.resolveAnsweredCard(stimulus, explicitQuestionId);
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
        deriveDecisionTitle(hasAnswer ? answeredCard!.question : ruling);
      const { decision, all } = await this.store.createDecision(
        stimulus.jobId,
        {
          decisionClass,
          title,
          ruling,
          confirmedByOperator,
          ...(hasAnswer && answeredCard!.question
            ? { question: answeredCard!.question }
            : {}),
          ...(hasAnswer ? { answer: answeredCard!.answer } : {}),
        },
      );
      if (answeredId && hasAnswer) {
        await this.store.updateCardMessage(stimulus.jobId, answeredId, {
          loggedDecision: true,
        });
      }
      await this.writeDecisionRecordMd(stimulus.jobId, stimulus.orgId, all);
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

    // Diagnostics done-gate for the DIRECT-BUILD path (ADR 0004 rider 3) — this is the brain's own
    // `finalize_build` gate, which runs INSIDE a live brain turn (no separate resume needed): the brain
    // must self-report a clean verification pass via
    // `report_verification` before `finalize_build` will ship. Reset per turn (this closure is rebuilt fresh
    // at turn start / boot re-attach — see `buildTools` call sites), so a later turn must re-verify.
    let directBuildVerified = false;
    // The STRUCTURED live-verification evidence the brain reports alongside `passed` — the substance the
    // ADR-0005 judge grades in `finalize_build` (a bare boolean gives it nothing to judge). Mirrors the
    // driver's `complete_thread` `verification[]` shape. Turn-local (reset with `directBuildVerified`).
    let directBuildVerification: VerificationEvidence[] = [];

    const tools: Record<string, ToolImpl> = {
      report_verification: async (args) => {
        const passed = args['passed'] === true;
        directBuildVerified = passed;
        // Coerce `verification` with the SAME tolerant logic as the driver's `complete_thread`
        // (`thread-driver.service.ts`): an array of {kind,command,exitCode,outputTail} (filtered on a real
        // command), OR a free-text string collapsed into one `reported` entry — never silently drop evidence.
        directBuildVerification = Array.isArray(args['verification'])
          ? (args['verification'] as unknown[])
              .map((e) => {
                const o = (e ?? {}) as Record<string, unknown>;
                return {
                  kind: String(o['kind'] ?? '').trim(),
                  command: String(o['command'] ?? '').trim(),
                  exitCode: Number.isFinite(Number(o['exitCode'])) ? Number(o['exitCode']) : -1,
                  outputTail: clampEvidenceOutput(String(o['outputTail'] ?? '')),
                };
              })
              .filter((v) => v.command)
          : typeof args['verification'] === 'string' && args['verification'].trim()
            ? [
                {
                  kind: 'reported',
                  command: '(see outputTail)',
                  exitCode: 0,
                  outputTail: clampEvidenceOutput((args['verification'] as string).trim()),
                },
              ]
            : [];
        if (passed) {
          // AMEND RE-PARK: after an approved `withdraw_ship`, the job sits in `amending` while the brain does
          // the follow-up work it proposed. A clean verification here re-arms the ship gate DIRECTLY
          // (`amending → awaiting_ship_review`) and re-posts the "Ship it" card — the amend IS the fix, so
          // there is no detour back through a `running` build. On any other status this is the normal
          // direct-build flag-set (finalize_build ships), so leave it untouched.
          const job = await this.store.loadJob(stimulus.jobId).catch(() => null);
          if (job?.status === 'amending') {
            const title = job.title ?? 'this build';
            const summary =
              'Amend verified. Review the diff, then click **Ship it** to open the PR.';
            const card = webShipReviewCard({ jobId: job.id, title, summary });
            const parked = await this.driverStore.parkForShipReview(
              job.id,
              card as unknown as Record<string, unknown>,
              summary,
            );
            return {
              ok: true,
              message: parked
                ? 'Amend verified — re-parked at the ship-review gate. The operator can Ship it now.'
                : 'Amend verified.',
            };
          }
          return { ok: true };
        }
        const remaining = Array.isArray(args['remaining'])
          ? (args['remaining'] as unknown[]).map((x) => String(x).trim()).filter(Boolean)
          : [];
        return {
          ok: true,
          message: remaining.length
            ? `Noted as unverified — fix these before finalize_build: ${remaining.join('; ')}`
            : 'Noted as unverified — fix the remaining errors before finalize_build.',
        };
      },

      get_pipeline_state: async (_args) => {
        return this.driverStore.getPipelineState(
          stimulus.jobId,
          stimulus.orgId,
        );
      },

      get_decision_record: async (_args) => {
        const record = await this.driverStore.getDecisionRecord(
          stimulus.jobId,
        );
        if (record) return record;
        // No proposal yet — surface the working set logged so far so the brain can see what it has locked.
        const pending = await this.store.pendingDecisions(stimulus.jobId);
        return { status: 'drafting', decisions: pending };
      },

      recall: async (args) => {
        const query = String(args['query'] ?? stimulus.body);
        try {
          const facts = await this.memory.recall(query, {
            scopes: [`project:${stimulus.repoId}`, `team:${stimulus.orgId}`],
            orgId: stimulus.orgId,
            limit: 8,
          });
          return facts.map((f) => ({ fact: f.fact, scope: f.scope }));
        } catch (err) {
          this.logger.debug(`recall failed: ${err}`);
          return [];
        }
      },

      remember: async (args) => {
        const fact = String(args['fact'] ?? '').trim();
        if (!fact) return { stored: false, reason: 'empty fact' };
        const scope = String(args['scope'] ?? `project:${stimulus.repoId}`);
        try {
          await this.memory.remember({
            fact,
            scope,
            orgId: stimulus.orgId,
            assertedBy: stimulus.author.id,
          });
          return { stored: true };
        } catch (err) {
          return { stored: false, reason: String(err) };
        }
      },

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
          return { ok: false, reason: 'Could not open the question (thread not found).' };
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
        const res = await this.store.withdrawPlan(stimulus.jobId, reason || undefined);
        if (!res.withdrawn) {
          return {
            ok: false,
            message:
              'No plan is currently awaiting the operator’s approval — nothing to withdraw. ' +
              '(If it was already approved or denied, work from that instead.)',
          };
        }
        this.approvals.cancel(stimulus.jobId, reason || 'plan withdrawn by Atlas');
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
        const outcome = await this.driverStore.openAmendProposal(stimulus.jobId, reason);
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
                ? (args['questionId'] as string).trim() || undefined
                : undefined;
            const answered = await this.resolveAnsweredCard(
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
        await this.writeDecisionRecordMd(
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
        await this.writeDecisionRecordMd(
          stimulus.jobId,
          stimulus.orgId,
          all,
        );
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

        const blocking = outcome.findings.filter((f) => f.severity === 'BLOCKING');
        const advisory = outcome.findings.filter((f) => f.severity === 'ADVISORY');
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
        const stepsByThread = hasSteps ? threads.map((s) => s.steps) : undefined;

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
          status: 'awaiting_approval',
        });

        const rec = await this.store.loadDecisionRecord(decisionRecordId);
        if (!rec) {
          return { ok: false, reason: 'No decision record found for this plan.' };
        }

        // Surface the review disposition in the timeline so the operator sees a review ran (advisory).
        const findings = deserializeFindings(reviewed.row.findings);
        const blocking = findings.filter((f) => f.severity === 'BLOCKING').length;
        const reviewNote =
          reviewed.row.status === 'failed'
            ? `⚠️ Codex review did not run (${reviewed.row.error ?? 'infrastructure error'}) — proposed without an automated pass.`
            : findings.length
              ? `🔍 Codex review: ${blocking} blocking, ${findings.length - blocking} advisory (advisory — Atlas addressed or held firm).`
              : '🔍 Codex review: no findings.';
        await this.store
          .appendSystemEvent(job.id, reviewNote)
          .catch((err) => this.logger.debug(`appendSystemEvent failed: ${err}`));

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
        if (job.status !== 'running' || job.halt != null) {
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
            return { ok: true, jobId: job.id, message: 'Build already started.' };
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
        if (job.status !== 'running' || job.halt != null) {
          return {
            ok: false,
            reason: `Job ${job.id} is in status '${job.status}'${job.halt != null ? ' and halted' : ''} — hold_build only applies to a running, un-halted job in the pre-start base-check window.`,
          };
        }
        if (!(await this.store.buildNotStarted(job.id))) {
          return {
            ok: false,
            reason: 'The build has already started — too late to hold. Use the normal build controls.',
          };
        }
        await this.store.reopenPlanning(job.id);
        await this.recordMilestone(
          stimulus.jobId,
          `hold:${job.decisionRecordId ?? job.id}`,
          `Build held after the base-check — back to planning${reason ? `: ${reason}` : '.'}`,
        );
        return {
          ok: true,
          jobId: job.id,
          status: 'planning',
          message:
            'Build held — back to planning. Revise the plan against the new base and re-propose (propose_plan), or confirm with the operator.',
        };
      },

      retry_thread: async (args) => {
        // Phase 3 (ADR 0004 rider 4) — the brain's AUTONOMOUS fix of a halted thread it was just woken about.
        // Claim the durable per-thread re-drive budget FIRST (CAS): over the cap, refuse so the brain escalates
        // to the operator instead of looping. On success, re-drive the SAME build lane with the brain's
        // guidance (populates the thread's orientation cheat-sheet, read by the next build turn).
        const threadId = String(args['threadId'] ?? '').trim();
        const guidance = String(args['guidance'] ?? '').trim();
        if (!threadId) {
          return { ok: false, reason: 'threadId is required (the halted thread to re-drive)' };
        }
        // The driver owns the whole precondition chain atomically (active guard → job exists → thread belongs
        // to this job → claim the bounded budget → re-drive), so a refused/no-op re-drive never spends budget
        // or touches another job's thread (Codex review High-1/High-2). On any refusal → escalate.
        const r = await this.dispatcher.redriveThread(
          stimulus.jobId,
          threadId,
          guidance || undefined,
          HALT_FIX_ATTEMPT_CAP,
        );
        if (!r.ok) {
          return {
            ok: false,
            reason: `${r.reason} — post a diagnosis and escalate to the operator instead of re-driving again`,
          };
        }
        return {
          ok: true,
          attempt: r.attempt,
          message: `Thread re-driven with your guidance (attempt ${r.attempt}).`,
        };
      },

      note_cleared_block: async (args) => {
        // Retrieve-vs-author audit (the retrieve-vs-author rule): the brain CLEARED a builder's halt by
        // RETRIEVING an answer that already existed (the access was present; a spec/convention already
        // decided it) — NOT by authoring a new decision. Record the cited evidence to the durable
        // cleared-blocks audit (a non-blocking FYI card + a re-projected `atlas-cleared-blocks.md`) BEFORE
        // re-driving. Call this only when you actually hold the answer and intend to `retry_thread` next.
        const threadId = String(args['threadId'] ?? '').trim();
        const reason = String(args['reason'] ?? '').trim();
        const evidence = String(args['evidence'] ?? '').trim();
        if (!threadId || !evidence) {
          return {
            ok: false,
            reason:
              'threadId and evidence are required — evidence is the existing source you retrieved (the ' +
              'access you verified, or the spec/convention you cited). If you had to CHOOSE an answer, do ' +
              'not clear it: ask the operator instead.',
          };
        }
        const gen = stimulus.seedHaltWake?.gen ?? 0;
        await this.store
          .appendClearedBlockCard(stimulus.jobId, {
            threadId,
            gen,
            reason: reason || 'question',
            evidence,
            text: `FYI: cleared a ${reason || 'blocked'} block on a build thread by retrieving an existing answer — ${evidence.slice(0, 160)}`,
          })
          .catch(() => undefined);
        await this.writeClearedBlocksMd(stimulus.jobId, stimulus.orgId).catch(() => undefined);
        return {
          ok: true,
          message: 'Recorded to the cleared-blocks audit. Now call `retry_thread` with the retrieved answer as guidance.',
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
        if (job.status !== 'running') {
          return {
            ok: false,
            reason: `Job ${jobId} is '${job.status}' — only an approved (running) build can be finalized`,
          };
        }
        if (!directBuildVerified) {
          // ADR 0004 rider 3 — a `done` claim is only as good as the verification actually run. Run
          // `mcp__atlas-lsp-ts__diagnostics` on the changed files + the repo's own typecheck, fix anything
          // they find, then call `report_verification({ passed: true })` before finalize_build will ship.
          return {
            ok: false,
            reason:
              'Not yet verified — run mcp__atlas-lsp-ts__diagnostics on the files you changed and the ' +
              "repo's own typecheck, fix anything they find, then call report_verification({ passed: true }) " +
              'before calling finalize_build again.',
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

        const rec = (await this.driverStore
          .getDecisionRecord(stimulus.jobId)
          .catch(() => null)) as {
          overview: string;
          decisions: Decision[];
        } | null;
        const repo = await this.repos.resolve(job);

        // ADR-0005 LIVE-VERIFICATION GATE (direct-build analog of the driver's `complete_thread` gate). A
        // direct build that touched a runtime surface must have been EXERCISED LIVE (curl / drive / run),
        // not just typechecked — the judge grades the structured evidence the brain reported via
        // `report_verification`. Runs BEFORE `preShip`, mirroring the driver's pre-persist gate; the base ref
        // is `origin/<default>` (same ref preShip's leak-scan uses), and `changedFileNames` unions untracked
        // files so the brain's still-uncommitted direct-build changes are seen pre-commit. On a
        // touched-but-inadequate verdict this REFUSES the tool (synchronous, mid-turn) — the brain reads the
        // reason, does the live run, and calls `finalize_build` again. Fail-closed + always-on (mirrors the
        // driver: no key / malformed / throw → touched-but-unverified), no rollout dial.
        const changedFiles = await this.git.changedFileNames(
          sandbox.worktreePath,
          `origin/${repo.defaultBranch}`,
        );
        const nonRuntime =
          changedFiles.length === 0 || changedFiles.every((f) => NON_RUNTIME_FILE_RE.test(f));
        let verdict: LiveVerificationVerdict | undefined;
        if (!nonRuntime) {
          verdict = await this.liveVerificationJudge
            .judge({
              terminalRecordSummary: renderTerminalRecordSummary({
                summary: rec?.overview ?? job.title ?? 'direct build',
                verification: directBuildVerification,
              }),
              changedFiles,
              lockedDecisionsSummary: renderLockedDecisionsSummary(
                rec ? { decisions: rec.decisions } : null,
              ),
              orgId: stimulus.orgId,
            })
            .catch(() => undefined);
        }
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
        // Persist on BOTH paths (pass + refusal) so direct-build verdicts are queryable — the observability
        // hook the prod audit needs. Best-effort; a write failure must never wedge the ship turn.
        await this.store
          .recordDirectBuildVerification(jobId, { verdict: effective, at: new Date().toISOString() })
          .catch((err) => this.logger.debug(`recordDirectBuildVerification failed: ${err}`));
        if (effective.runtimeSurfaceTouched && !effective.liveVerificationAdequate) {
          let detail = [effective.reason, effective.missingChecks].filter(Boolean).join(' — ');
          // The judge was CONSULTED but returned nothing → UNAVAILABLE, not a real "inadequate" verdict.
          // Distinguish infra-unavailability from genuinely-inadequate evidence so the brain retries the ship
          // (rather than being told to go re-exercise work that may already be fine). A missing key is a real
          // config gap the operator must fix.
          let judgeUnavailable = false;
          if (!nonRuntime && !verdict) {
            const hasKey = await this.creds.anthropicKey(stimulus.orgId).catch(() => undefined);
            if (!hasKey) {
              detail = `no Anthropic API key configured for the live-verification judge — configure one. (${detail})`;
            } else {
              judgeUnavailable = true;
            }
          }
          if (judgeUnavailable) {
            await this.store.appendSystemEvent(
              jobId,
              `Live-verification judge temporarily unavailable during direct-build ship — ${detail}`,
            );
            return {
              ok: false,
              jobId,
              reason:
                `The live-verification judge is temporarily unavailable (transient infra: Anthropic outage or ` +
                `API-key rate/credit limit) — this is NOT a problem with your evidence. Wait a moment and call ` +
                `finalize_build again; it should clear once the service recovers.`,
            };
          }
          await this.store.appendSystemEvent(
            jobId,
            `Live-verification gate blocked the direct-build ship — ${detail}`,
          );
          return {
            ok: false,
            jobId,
            reason:
              `Live validation inadequate — ${detail}. Actually exercise the changed runtime surface ` +
              `(curl the endpoint / drive the UI / run the CLI) — or, if the change is internal plumbing ` +
              `never echoed in an HTTP/UI/CLI surface, boot the process and capture a log line proving the ` +
              `changed value was passed at runtime. Then re-report_verification with the captured evidence, ` +
              `then finalize_build again.`,
          };
        }

        // HOST PRE-SHIP GATE only (no-token + leak-scan — the host NEVER commits). We are ALREADY inside this
        // brain turn, so we cannot seed a nested open-PR turn (that is the driver/boot ship path). Hand
        // `shipOpenPrBody` back as the tool result so the brain — still in THIS turn — commits anything
        // uncommitted, reconciles, pushes, and opens the PR itself. The git-state reconciler then records
        // `pr_url` + flips the job `done` on discovery, and `latchDirectBuildAtTurnEnd` latches the PR the
        // moment the turn completes.
        const pre = await this.ship.preShip(job, repo, sandbox, (m) => this.say(stimulus, m));

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
            message: 'No GitHub token is configured — PR not opened. Commit your work; connect a token to ship.',
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
          this.logger.warn(
            `create_job: start of ${newJobId} failed: ${err}`,
          ),
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
            limit: typeof args['limit'] === 'number' ? args['limit'] : undefined,
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
      propose_convention_profile_change: this.buildProposeConventionProfileChangeTool(stimulus),
    };

    // The ceremony and an ordinary build thread share the SAME onboarding capabilities — the ceremony just
    // does it all up front in one pass; any other thread does it incrementally, on the fly, whenever it
    // hits the same kind of friction (a missing secret, a repo setup gap worth recording for next time).
    // Every thread can request a missing secret/file on the spot (the owner-gated provide endpoints accept
    // any job) AND amend the repo's DB-backed workspace config (mounts/seed) — writes land instantly for
    // every job on the repo, no PR/ship step needed outside the ceremony (see `write_workspace_config`).
    const intake = {
      request_secret: this.buildRequestSecretTool(stimulus),
      request_file: this.buildRequestFileTool(stimulus),
      withdraw_file_request: this.buildWithdrawFileRequestTool(stimulus),
      write_workspace_config: this.buildWriteWorkspaceConfigTool(stimulus),
      write_setup_script: this.buildWriteSetupScriptTool(stimulus),
      read_setup_script: this.buildReadSetupScriptTool(stimulus),
      write_preview_instructions: this.buildWritePreviewInstructionsTool(stimulus),
      read_preview_instructions: this.buildReadPreviewInstructionsTool(stimulus),
      derive_secret: this.buildDeriveSecretTool(stimulus),
      reset_sandbox: this.buildResetSandboxTool(stimulus),
      // Skills + MCP servers are Workspace Profile dimensions like mounts/setup — maintainable INCREMENTALLY
      // by any job, not just onboarding: list what exists + propose new/edited ones (owner-approved).
      list_skills: this.buildListSkillsTool(stimulus),
      propose_skill: this.buildProposeSkillTool(stimulus),
      propose_skill_install: this.buildProposeSkillInstallTool(stimulus),
      request_skill_edit_access: this.buildRequestSkillEditAccessTool(stimulus),
      propose_skill_removal: this.buildProposeSkillRemovalTool(stimulus),
      list_mcp_servers: this.buildListMcpServersTool(stimulus),
      propose_mcp_servers: this.buildProposeMcpServersTool(stimulus),
      propose_mcp_removal: this.buildProposeMcpRemovalTool(stimulus),
    };

    // atlas-prod: relocated prod-diagnostics reads + the gated write. Registered ONLY when this repo is the
    // Atlas repo (by SLUG === ATLAS_REPO_SLUG) and the prod-diagnostics service is wired — fail-closed
    // everywhere else (the tools are simply absent). The structural approval gate lives in proposeWrite.
    const atlasProd: Record<string, ToolImpl> =
      this.env && this.prodDiagnostics && isAtlasRepo(repoSlug ?? '', this.env)
        ? {
            atlas_query: (a) => this.prodDiagnostics!.runRead('atlas_query', a),
            atlas_schema: (a) => this.prodDiagnostics!.runRead('atlas_schema', a),
            atlas_job_overview: (a) => this.prodDiagnostics!.runRead('atlas_job_overview', a),
            atlas_session_raw: (a) => this.prodDiagnostics!.runRead('atlas_session_raw', a),
            atlas_context_read: (a) => this.prodDiagnostics!.runRead('atlas_context_read', a),
            atlas_worktree_tree: (a) => this.prodDiagnostics!.runRead('atlas_worktree_tree', a),
            atlas_worktree_file: (a) => this.prodDiagnostics!.runRead('atlas_worktree_file', a),
            propose_prod_write: (a) => this.prodDiagnostics!.proposeWrite(stimulus, String(a['sql'] ?? '')),
          }
        : {};

    // Review threads get a curated, build-free subset (they review an EXISTING PR via `gh`/Read/subagents,
    // never plan/build/ship) — no propose_plan/start_direct_build/decisions. They DO get the job tools
    // (list_jobs/create_job/link_job_dependency): a review may legitimately spin up or relate sibling jobs
    // even though it does not build its own PR. Matches the `reviewTools` prompt fragment; the omission of
    // the build/plan/ship tools is enforced (un-callable, not just discouraged).
    if (review) {
      return {
        ask_question: tools.ask_question,
        withdraw_question: tools.withdraw_question,
        set_job_kind: tools.set_job_kind,
        recall: tools.recall,
        remember: tools.remember,
        list_jobs: tools.list_jobs,
        create_job: tools.create_job,
        link_job_dependency: tools.link_job_dependency,
        ...intake,
        ...atlasProd,
      };
    }
    // Normal threads get the full toolset above + intake. Onboarding threads get a curated, build-free
    // subset (they don't build/PR; they explore, provision, and finish) — `finish_onboarding` stays
    // ceremony-only: it stamps `onboarded_at` and opens the ceremony's OWN dedicated config PR, which only
    // makes sense when there is no other in-flight build PR to fold the config change into.
    if (!onboarding) return { ...tools, ...intake, ...atlasProd };
    return {
      ask_question: tools.ask_question,
      withdraw_question: tools.withdraw_question,
      recall: tools.recall,
      remember: tools.remember,
      list_jobs: tools.list_jobs,
      create_job: tools.create_job,
      link_job_dependency: tools.link_job_dependency,
      ...intake,
      list_convention_profiles: this.buildListConventionProfilesTool(stimulus),
      propose_convention_profile: this.buildProposeConventionProfileTool(stimulus),
      propose_convention_profile_change: this.buildProposeConventionProfileChangeTool(stimulus),
      finish_onboarding: this.buildFinishOnboardingTool(stimulus),
      ...atlasProd,
    };
  }

  // ── Repo-onboarding tools (only handed to `kind='onboarding'` threads; see the onboarding fragments) ──

  /**
   * `request_secret({ name, path, description })` — securely request an env-file SECRET VALUE from the
   * operator. Mirrors `ask_question`: posts a value-FREE card + opens the durable `awaiting_secret_id`
   * gate, then the brain stops and waits. The value never passes through this tool — it arrives only at the
   * owner-gated `provide-secret` endpoint, which writes it to the encrypted store + grants it; the brain
   * later sees a masked confirmation. org/repo come from the closure (never tool args) — tenant safety.
   */
  private buildRequestSecretTool(stimulus: ChatStimulus): ToolImpl {
    return async (args) => {
      const name = String(args['name'] ?? '').trim();
      const path = String(args['path'] ?? '').trim();
      const description = String(args['description'] ?? '').trim();
      // Optional headless-login URL (e.g. `gcloud auth login --no-launch-browser`): surfaced as a clickable
      // link on the card so the operator opens it, then pastes the resulting code back. https only.
      const rawUrl = String(args['url'] ?? '').trim();
      const url = /^https:\/\//.test(rawUrl) ? rawUrl : undefined;
      const ephemeral = args['ephemeral'] === true;
      const deliverTo = String(args['deliver_to'] ?? '').trim();

      if (!description)
        return {
          ok: false,
          reason: 'description is required (why the secret is needed)',
        };

      // EPHEMERAL: a one-time, short-lived value (an OAuth verification code, a 2FA code) piped straight to a
      // process the brain has running and NEVER stored. `deliver_to` (an absolute in-container path — the FIFO
      // the brain already wired its waiting process to read) replaces `path`; `name` is just a display label.
      if (ephemeral) {
        if (!deliverTo.startsWith('/') || deliverTo.split('/').includes('..')) {
          return {
            ok: false,
            reason:
              'deliver_to must be an absolute in-container path (e.g. /tmp/atlas-login-in), no ..',
          };
        }
        const label = name || 'ONE_TIME_CODE';
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) {
          return {
            ok: false,
            reason: 'name (label) must be an identifier (e.g. GCLOUD_AUTH_CODE)',
          };
        }
        const requestId = `s-${randomUUID()}`;
        const card = webSecretInputCard({
          jobId: stimulus.jobId,
          requestId,
          name: label,
          description,
          ephemeral: true,
          deliver_to: deliverTo,
          ...(url ? { url } : {}),
        });
        const opened = await this.store.openSecretRequest(stimulus.jobId, {
          requestId,
          card,
        });
        if (!opened.ok) {
          return {
            ok: false,
            reason: opened.alreadyOpen
              ? 'A secret request is already awaiting the operator — wait for it before requesting another.'
              : 'Could not open the secret request (thread not found).',
          };
        }
        return {
          ok: true,
          requestId,
          message:
            `Ephemeral secure card posted for "${label}". Make SURE your process is already reading ${deliverTo} ` +
            `(open the FIFO read-write: \`exec 0<>${deliverTo}\`) before the operator submits. Stop and wait — ` +
            'the value is piped straight into that path and never stored; you only get a masked confirmation.',
        };
      }

      // MCP-TARGET: the value is a credential slot (header/env) for a user-defined MCP server the OWNER just
      // approved (via propose_mcp_servers). It writes into `mcp_servers.secrets_enc` (McpServerStore.setSecret)
      // — NOT the worktree store — and does not grant/rehydrate; the scope is re-derived from this thread's
      // repo at commit (never trusted from the card). No worktree `path`.
      const mcpArg = args['mcp'];
      if (mcpArg && typeof mcpArg === 'object' && !Array.isArray(mcpArg)) {
        const m = mcpArg as Record<string, unknown>;
        const server = String(m['server'] ?? '').trim();
        const slot = String(m['slot'] ?? '').trim();
        const key = String(m['key'] ?? '').trim();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(server)) {
          return { ok: false, reason: 'mcp.server must be the name of a registered MCP server' };
        }
        if (slot !== 'header' && slot !== 'env') {
          return { ok: false, reason: "mcp.slot must be 'header' or 'env'" };
        }
        if (!key) return { ok: false, reason: 'mcp.key is required (the header/env key name)' };
        // An OAuth server has NO fillable secret slot — its Authorization is minted by the owner Connect flow
        // (McpOAuthService), so a request_secret against it would inject a bearer that bypasses the token
        // lifecycle. Reject early (the host provideSecret lane enforces this authoritatively too). MCP secrets
        // land on THIS repo's scope, so check the repo-scoped row.
        const oauthRow = await this.mcpStore
          ?.rawRow(stimulus.orgId, stimulus.repoId, server)
          .catch(() => null);
        if (oauthRow?.auth_kind === 'oauth') {
          return {
            ok: false,
            reason: `MCP server "${server}" uses OAuth — it is connected by the OWNER via the Connect button on the MCP proposal card or in the console (MCP settings → Connect), not via a secret slot. Do not request a secret or inject an Authorization/Bearer header for it.`,
          };
        }
        const requestId = `s-${randomUUID()}`;
        const card = webSecretInputCard({
          jobId: stimulus.jobId,
          requestId,
          name: key,
          description,
          mcp: { server, slot, key },
          ...(url ? { url } : {}),
        });
        const opened = await this.store.openSecretRequest(stimulus.jobId, { requestId, card });
        if (!opened.ok) {
          return {
            ok: false,
            reason: opened.alreadyOpen
              ? 'A secret request is already awaiting the operator — wait for it before requesting another.'
              : 'Could not open the secret request (thread not found).',
          };
        }
        return {
          ok: true,
          requestId,
          message:
            `Secure secret card posted for MCP server "${server}" (${slot}:${key}). Stop and wait — the ` +
            "operator's value goes straight into the encrypted MCP store and activates the server; you only " +
            'see a masked confirmation. Never ask for the value in chat.',
        };
      }

      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return {
          ok: false,
          reason:
            'name must be an env-var-style identifier (e.g. DATABASE_URL)',
        };
      }
      if (!path || path.startsWith('/') || path.split('/').includes('..')) {
        return {
          ok: false,
          reason:
            'path must be a worktree-relative file path (e.g. .env), no leading / or ..',
        };
      }
      const requestId = `s-${randomUUID()}`;
      const card = webSecretInputCard({
        jobId: stimulus.jobId,
        requestId,
        name,
        path,
        description,
        ...(url ? { url } : {}),
      });
      const opened = await this.store.openSecretRequest(stimulus.jobId, {
        requestId,
        card,
      });
      if (!opened.ok) {
        return {
          ok: false,
          reason: opened.alreadyOpen
            ? 'A secret request is already awaiting the operator — wait for it before requesting another.'
            : 'Could not open the secret request (thread not found).',
        };
      }
      return {
        ok: true,
        requestId,
        message:
          `Secure secret card posted for "${name}". Stop and wait — the operator's value goes straight to ` +
          'encrypted storage; you will only see a masked confirmation. Never ask for the value in chat.',
      };
    };
  }

  /**
   * `request_file({ path, description })` — ask the operator to UPLOAD a file whose contents can't be
   * typed (a service-account JSON, a keystore/`.pem`, a gitignored `.env.keys`). Posts a value-FREE card;
   * the file arrives only at the owner-gated `provide-file` endpoint, which stores the contents ENCRYPTED
   * (as a file-valued secret) + grants them to `path` for future build threads. PER-CARD (multiple may be
   * open at once — no one-at-a-time gate). The brain only ever sees a masked confirmation. org/repo come
   * from the closure (never tool args) — tenant safety. The destination MUST be gitignored, or the
   * hydrator refuses to render it (it would leak into the PR).
   */
  private buildRequestFileTool(stimulus: ChatStimulus): ToolImpl {
    return async (args) => {
      const path = String(args['path'] ?? '').trim();
      const description = String(args['description'] ?? '').trim();
      if (!path || path.startsWith('/') || path.split('/').includes('..')) {
        return {
          ok: false,
          reason:
            'path must be a worktree-relative file path (e.g. .env.keys), no leading / or ..',
        };
      }
      if (!description)
        return {
          ok: false,
          reason: 'description is required (why the file is needed)',
        };
      const requestId = await this.store.nextFileRequestId(stimulus.jobId);
      const card = webFileRequestCard({
        jobId: stimulus.jobId,
        requestId,
        path,
        description,
      });
      const opened = await this.store.openFileRequest(stimulus.jobId, {
        requestId,
        card,
      });
      if (!opened.ok)
        return {
          ok: false,
          reason: 'Could not open the file request (thread not found).',
        };
      return {
        ok: true,
        requestId,
        message:
          `File-upload card posted for "${path}". The operator uploads the file through a secure field; ` +
          'its contents go straight to encrypted storage and you will only see a masked confirmation. ' +
          'Never ask them to paste file contents in chat. Ensure the destination is gitignored.',
      };
    };
  }

  /**
   * `withdraw_file_request({ requestId, reason? })` — retract a still-open `request_file` card (wrong path,
   * no longer needed). The file-card mirror of `withdraw_question`: race-safe + idempotent (if the operator
   * already uploaded, the withdraw is a no-op and you should work from the delivered file, not re-request).
   * A withdrawn card greys out (no file picker) and a racing upload for it becomes a no-op. org/repo/job
   * come from the closure (never tool args) — tenant safety.
   */
  private buildWithdrawFileRequestTool(stimulus: ChatStimulus): ToolImpl {
    return async (args) => {
      const requestId = String(args['requestId'] ?? '').trim();
      if (!requestId) return { ok: false, reason: 'requestId is required' };
      const reason = String(args['reason'] ?? '').trim();
      const res = await this.store.withdrawFileRequest(
        stimulus.jobId,
        requestId,
        reason || undefined,
      );
      if (!res.withdrawn) {
        return {
          ok: false,
          reason:
            'That file request could not be withdrawn — it was already uploaded, already withdrawn, or not ' +
            'found. If the operator already uploaded it, work from that file instead of re-requesting.',
        };
      }
      return {
        ok: true,
        requestId,
        message:
          'File request withdrawn — the operator no longer sees it as awaiting an upload. Post a corrected ' +
          'request_file if you still need a file.',
      };
    };
  }

  /**
   * `derive_secret({ name, path, value, description, overwrite? })` — durably store a value YOU already
   * computed (not operator-provided) — e.g. a webhook signing secret from `stripe listen --print-secret`,
   * derived from an already-granted API key. Unlike `request_secret`, there is NO operator round-trip: you
   * already hold the value (it never came from anywhere an operator needed to gate), so it writes straight
   * to the SAME encrypted store as this repo's secret file at (repo, path), then renders on your next
   * hydration and EVERY future job's — no re-derivation tax. Refuses by default if a value already exists
   * at `path` (protects an operator-provided secret from being silently clobbered) — pass `overwrite: true`
   * only when you are deliberately replacing it. Posts a quiet system-event pill for operator visibility
   * (name/path only, never the value — same rule as every other secret path).
   */
  private buildDeriveSecretTool(stimulus: ChatStimulus): ToolImpl {
    return async (args) => {
      const name = String(args['name'] ?? '').trim();
      const path = String(args['path'] ?? '').trim();
      const value = String(args['value'] ?? '');
      const description = String(args['description'] ?? '').trim();
      const overwrite = args['overwrite'] === true;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return {
          ok: false,
          reason:
            'name must be an env-var-style identifier (e.g. STRIPE_WEBHOOK_SECRET)',
        };
      }
      if (!path || path.startsWith('/') || path.split('/').includes('..')) {
        return {
          ok: false,
          reason:
            'path must be a worktree-relative file path (e.g. .env.personal), no leading / or ..',
        };
      }
      if (!value) {
        return {
          ok: false,
          reason:
            'value is required — this tool stores a value you already computed, it never generates or asks for one',
        };
      }
      if (!description) {
        return {
          ok: false,
          reason:
            'description is required (what this value is and how you derived it)',
        };
      }
      const existing = await this.secretStore.read(stimulus.orgId, stimulus.repoId, path);
      if (existing != null && !overwrite) {
        return {
          ok: false,
          reason:
            `a secret file already exists at "${path}" (possibly operator-provided) — pass overwrite: true ` +
            'only if you are deliberately replacing it, or pick a different path',
        };
      }
      // A single write IS the value + the authority: (repo, path) is the file's identity; `name` rides
      // along as the display label. Renders on your next hydration and every future job's.
      await this.secretStore.write(stimulus.orgId, stimulus.repoId, path, value, name);
      await this.store.appendSystemEvent(
        stimulus.jobId,
        `🔑 Derived and stored \`${name}\` (${description}) — future jobs on this repo won't need to re-derive it.`,
      );
      return { ok: true, name, path, overwritten: existing != null };
    };
  }

  /**
   * `write_workspace_config({ mounts })` — AMEND the repo's DB-backed workspace config (the NON-secret
   * hydration half: cache/auth mounts; see docs/adr/0003). A pure DB write keyed by org+repo — a mount is
   * upserted by `path` (same path replaces that entry, everything else untouched) — it never
   * blind-overwrites, and it needs no sandbox. This is what makes it safe as an ANY-THREAD tool: the
   * ceremony calls it repeatedly while authoring from scratch, and a later build thread can add ONE mount
   * without wiping out what the ceremony (or an earlier amendment) already recorded, AND it reaches every
   * OTHER in-flight job's very next hydration instantly — no PR, no wait. Secrets are NEVER written here
   * (they live as encrypted grants); a `secrets` field is rejected. Validated before write.
   */
  private buildWriteWorkspaceConfigTool(stimulus: ChatStimulus): ToolImpl {
    return async (args) => {
      if (args['secrets'] !== undefined) {
        return {
          ok: false,
          reason:
            'secrets do not go in workspace config — use request_secret instead',
        };
      }
      const { mounts: newMounts, warnings } = this.normalizeMounts(args['mounts']);

      // A DB hiccup here must never crash the turn — warn, tell Atlas the real error via `reason` (its
      // next tool call is retryable), don't leave it silently believing the write landed.
      try {
        // Snapshot the mount SET before the upserts: a genuinely new/changed mount changes the container's
        // mount fingerprint, so its NEXT attach recreates the container (binds only apply at create time).
        // We warn about that so the brain configures mounts BEFORE starting long-running processes — adding a
        // mount mid-login was what silently killed the gcloud process + wiped its `.gcloud` dir.
        const priorMountSig = (
          await this.configStore.listMounts(stimulus.orgId, stimulus.repoId)
        )
          .map((m) => `${m.path}:${m.mode}`)
          .sort()
          .join(',');
        for (const m of newMounts) {
          await this.configStore.upsertMount(stimulus.orgId, stimulus.repoId, m.path, m.mode);
        }

        const mounts = await this.configStore.listMounts(stimulus.orgId, stimulus.repoId);
        const mountSetChanged =
          mounts.map((m) => `${m.path}:${m.mode}`).sort().join(',') !==
          priorMountSig;
        await this.store.appendSystemEvent(
          stimulus.jobId,
          `⚙️ Updated workspace config (${mounts.length} mount(s)) — live for every job on this repo immediately.` +
            (mountSetChanged
              ? ' The mount set changed — this sandbox recreates on your NEXT turn (in-container processes/state are lost); configure mounts BEFORE starting a login or other long-running process.'
              : ''),
        );
        return {
          ok: true,
          mounts: mounts.length,
          ...(mountSetChanged ? { restarts_sandbox: true } : {}),
          ...(warnings.length ? { warnings } : {}),
        };
      } catch (err) {
        this.logger.warn(`write_workspace_config failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`);
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `write_setup_script({ script })` — save (or clear, with an empty `script`) the repo's DB-backed cold-boot
   * SETUP SCRIPT. The host runs it on every COLD sandbox bring-up (fresh create / restart-from-stopped /
   * `reset_sandbox`) for EVERY future job on this repo — no PR — and skips it on a warm reuse. It MUST be
   * idempotent (it re-runs on each cold boot) and must NOT init submodules (already automatic). org/repo come
   * from the closure (never tool args) — tenant safety. Writes to the same store as `write_workspace_config`.
   * The right way to test it is `reset_sandbox`, which recreates the container so the script runs cold.
   */
  private buildWriteSetupScriptTool(stimulus: ChatStimulus): ToolImpl {
    return async (args) => {
      const script = String(args['script'] ?? '').trim() ? String(args['script']) : null;
      try {
        await this.configStore.setSetupScript(stimulus.orgId, stimulus.repoId, script);
        // Recording a setup script is an "I've addressed the stack" moment — acknowledge the worktree's
        // current dependency manifests so a manifest already present stops reading as a NEW stack.
        if (script) {
          const sandbox = await this.lifecycle.findSandbox(stimulus.jobId, stimulus.orgId);
          if (sandbox) await this.refreshSeenManifests(stimulus.orgId, stimulus.repoId, sandbox.worktreePath);
        }
        await this.store.appendSystemEvent(
          stimulus.jobId,
          script
            ? '⚙️ Saved the repo setup script — it runs on every COLD sandbox bring-up for every job on this repo. Call `reset_sandbox` to test it cold.'
            : '⚙️ Cleared the repo setup script — no cold-boot setup step will run.',
        );
        return { ok: true, saved: !!script };
      } catch (err) {
        this.logger.warn(`write_setup_script failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`);
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `read_setup_script()` — return the repo's CURRENT cold-boot setup script (the raw body, not just its
   * length like the profile snapshot). Read-before-edit for `write_setup_script`, which REPLACES the whole
   * script: read it here, edit the body, then write the full new script back. Pure read — no mutation, no
   * system event. org/repo come from the closure (never tool args) — tenant safety. Reuses the same store
   * (`WorkspaceConfigStore.getSetupScript`) that resolves the script on cold attach.
   */
  private buildReadSetupScriptTool(stimulus: ChatStimulus): ToolImpl {
    return async () => {
      try {
        const script = await this.configStore.getSetupScript(stimulus.orgId, stimulus.repoId);
        return { ok: true, present: script !== null, script };
      } catch (err) {
        this.logger.warn(`read_setup_script failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`);
        return { ok: false, reason: errText(err) };
      }
    };
  }

  private buildWritePreviewInstructionsTool(stimulus: ChatStimulus): ToolImpl {
    return async (args) => {
      const instructions = String(args['instructions'] ?? '').trim() ? String(args['instructions']) : null;
      try {
        await this.configStore.setPreviewInstructions(stimulus.orgId, stimulus.repoId, instructions);
        await this.store.appendSystemEvent(
          stimulus.jobId,
          instructions
            ? '🎬 Saved the repo preview recipe — it is injected into the "Spin up preview" seed for every job on this repo. `read_preview_instructions` to amend (write REPLACES the whole recipe).'
            : '🎬 Cleared the repo preview recipe — the Spin-up-preview seed will prompt to save a fresh one.',
        );
        return { ok: true, saved: !!instructions };
      } catch (err) {
        this.logger.warn(`write_preview_instructions failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`);
        return { ok: false, reason: errText(err) };
      }
    };
  }

  private buildReadPreviewInstructionsTool(stimulus: ChatStimulus): ToolImpl {
    return async () => {
      try {
        const instructions = await this.configStore.getPreviewInstructions(stimulus.orgId, stimulus.repoId);
        return { ok: true, present: instructions !== null, instructions };
      } catch (err) {
        this.logger.warn(`read_preview_instructions failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`);
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * Record the worktree's current dependency manifests as ACKNOWLEDGED (`repos.profile_seen_manifests`) —
   * the baseline the new-stack gap diffs against (see `WorkspaceProfileService.computeGaps`). Seeded when
   * onboarding finishes (the bulk pass saw the whole stack) and refreshed when a setup script is recorded.
   * Best-effort: never throws into the caller.
   */
  private async refreshSeenManifests(orgId: string, repoId: string, worktreePath: string): Promise<void> {
    try {
      await this.configStore.setSeenManifests(orgId, repoId, detectRepoManifests(worktreePath));
    } catch (err) {
      this.logger.warn(`refreshSeenManifests failed for org=${orgId} repo=${repoId}: ${err}`);
    }
  }

  /**
   * `propose_mcp_servers({ servers })` — recommend a stack-matched set of MCP servers for the operator to
   * approve, mirroring Anthropic's "Claude Code Setup" plugin. The brain NEVER writes an MCP server itself
   * (that's an owner-only Administer action, gated the same as the console `McpServersController`): this
   * posts a value-FREE PROPOSAL card that the OWNER approves at the owner-gated
   * `…/jobs/:jobId/mcp-proposals/:requestId/approve` endpoint, which commits each server on THIS repo's
   * scope. Secret header/env slots are declared here by NAME only (`secret:true`) and filled AFTER approval
   * via `request_secret` (with an `mcp` target) — no secret value ever passes through this tool. Reserved
   * system names are rejected. org/repo/job come from the closure (never tool args) — tenant safety.
   */
  private buildProposeMcpServersTool(stimulus: ChatStimulus): ToolImpl {
    const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
    const VALID_SURFACES = new Set<McpSurface>(['brain', 'build', 'review']);
    // A secret entry carries NO value (the operator supplies it later via request_secret — invariant). A
    // non-secret entry may carry a static value (e.g. an API-version header) since it isn't a credential.
    const normPairs = (
      v: unknown,
    ): { name: string; secret?: boolean; value?: string }[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const out: { name: string; secret?: boolean; value?: string }[] = [];
      for (const e of v as unknown[]) {
        const rec = (e ?? {}) as Record<string, unknown>;
        const n = String(rec['name'] ?? '').trim();
        if (!n) continue;
        if (rec['secret'] === true) {
          out.push({ name: n, secret: true });
        } else {
          const val = rec['value'] != null ? String(rec['value']) : undefined;
          out.push(val != null ? { name: n, value: val } : { name: n });
        }
      }
      return out.length > 0 ? out : undefined;
    };
    return async (args) => {
      const raw = Array.isArray(args['servers'])
        ? (args['servers'] as unknown[])
        : null;
      if (!raw || raw.length === 0) {
        return {
          ok: false,
          reason: 'servers must be a non-empty array of proposed MCP server definitions',
        };
      }
      const servers: McpProposalServer[] = [];
      for (const item of raw) {
        const s = (item ?? {}) as Record<string, unknown>;
        const name = String(s['name'] ?? '').trim();
        if (!NAME_RE.test(name)) {
          return {
            ok: false,
            reason: `invalid server name "${name}" — use letters/digits/_/- (e.g. github, sentry)`,
          };
        }
        if (isReservedMcpName(name)) {
          return {
            ok: false,
            reason: `"${name}" is a reserved system server (already provided) — pick a different tool`,
          };
        }
        const transport = String(s['transport'] ?? '').trim();
        if (transport !== 'http' && transport !== 'sse' && transport !== 'stdio') {
          return { ok: false, reason: `server "${name}": transport must be http | sse | stdio` };
        }
        const url = String(s['url'] ?? '').trim() || undefined;
        const command = String(s['command'] ?? '').trim() || undefined;
        // Transport-shape guard (mirrors McpServersController.assertShape).
        if (transport === 'stdio') {
          if (!command) return { ok: false, reason: `server "${name}": stdio transport requires a command` };
        } else if (!url) {
          return { ok: false, reason: `server "${name}": ${transport} transport requires a url` };
        }
        const argv = Array.isArray(s['args'])
          ? (s['args'] as unknown[]).map((a) => String(a))
          : undefined;
        const headers = normPairs(s['headers']);
        const env = normPairs(s['env']);
        const surfaces = (
          Array.isArray(s['surfaces']) ? (s['surfaces'] as unknown[]).map((x) => String(x)) : []
        ).filter((x): x is McpSurface => VALID_SURFACES.has(x as McpSurface));
        const reason = String(s['reason'] ?? '').trim() || undefined;
        // Auth kind: 'static' (header/env slots filled via request_secret) or 'oauth' (interactive OAuth 2.1
        // the OWNER completes via Connect). OAuth is http/sse-only and owns the Authorization header itself,
        // so a secret slot on an oauth server is invalid (it would read as an unfillable gap). Mirrors
        // McpServersController.assertShape.
        const authKind: McpAuthKind = s['authKind'] === 'oauth' ? 'oauth' : 'static';
        if (authKind === 'oauth') {
          if (transport === 'stdio') {
            return { ok: false, reason: `server "${name}": oauth is only supported for http/sse transports` };
          }
          if ((headers ?? []).some((h) => h.secret) || (env ?? []).some((e) => e.secret)) {
            return {
              ok: false,
              reason: `server "${name}": an oauth server must NOT declare secret header/env slots — the OWNER completes OAuth with the proposal-card Connect button or in the console (MCP settings → Connect); OAuth manages the Authorization header itself`,
            };
          }
        }
        const oauthRaw = (s['oauth'] ?? {}) as Record<string, unknown>;
        const oauthScope = String(oauthRaw['scope'] ?? '').trim() || undefined;
        const oauthTam = ['none', 'client_secret_post', 'client_secret_basic'].includes(
          String(oauthRaw['tokenAuthMethod'] ?? ''),
        )
          ? (String(oauthRaw['tokenAuthMethod']) as McpOAuthTokenAuthMethod)
          : undefined;
        const oauth: StoredMcpOAuthConfig | undefined =
          authKind === 'oauth' && (oauthScope || oauthTam)
            ? { ...(oauthScope ? { scope: oauthScope } : {}), ...(oauthTam ? { tokenAuthMethod: oauthTam } : {}) }
            : undefined;
        servers.push({
          name,
          transport,
          ...(url ? { url } : {}),
          ...(command ? { command } : {}),
          ...(argv && argv.length ? { args: argv } : {}),
          ...(headers ? { headers } : {}),
          ...(env ? { env } : {}),
          ...(surfaces.length ? { surfaces } : {}),
          ...(reason ? { reason } : {}),
          ...(authKind === 'oauth' ? { authKind } : {}),
          ...(oauth ? { oauth } : {}),
        });
      }
      const lowerNames = servers.map((s) => s.name.toLowerCase());
      if (new Set(lowerNames).size !== lowerNames.length) {
        return { ok: false, reason: 'duplicate server names in the proposal' };
      }
      // Registration scope: 'repo' (this repo only, the default) or 'org' (every repo in the org) — mirrors
      // propose_skill. Repo scope OVERRIDES an org server of the same name at resolve time.
      const scope: 'org' | 'repo' = String(args['scope'] ?? 'repo').trim() === 'org' ? 'org' : 'repo';
      try {
        const requestId = `mcp-${randomUUID()}`;
        const card = webMcpProposalCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          scope,
          servers,
        });
        const opened = await this.store.openMcpProposal(stimulus.jobId, { requestId, card });
        if (!opened.ok) return { ok: false, reason: 'Could not open the MCP proposal (thread not found).' };
        const needSecrets = servers.flatMap((s) => [
          ...(s.headers ?? []).filter((h) => h.secret).map((h) => `${s.name} header:${h.name}`),
          ...(s.env ?? []).filter((e) => e.secret).map((e) => `${s.name} env:${e.name}`),
        ]);
        const oauthNames = servers.filter((s) => s.authKind === 'oauth').map((s) => s.name);
        return {
          ok: true,
          requestId,
          proposed: servers.map((s) => s.name),
          message:
            `Posted an MCP proposal card for ${servers.length} server(s), ${scope}-scoped. The OWNER approves ` +
            `it to register ${scope === 'org' ? 'them org-wide (every repo)' : 'them on this repo'} — you ` +
            'cannot register servers yourself. Stop and wait for approval. After approval, use request_secret ' +
            '(with an mcp target) to fill each secret slot' +
            (needSecrets.length ? `: ${needSecrets.join('; ')}.` : '.') +
            (oauthNames.length
              ? ` OAuth server(s) [${oauthNames.join(', ')}] have NO secret to fill — after approval the OWNER ` +
                'must Connect them from the MCP proposal card or in the console (MCP settings → Connect) to complete consent. You cannot ' +
                'consent yourself; do NOT try to inject an Authorization/Bearer header via request_secret.'
              : ''),
        };
      } catch (err) {
        this.logger.warn(`propose_mcp_servers failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`);
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `list_convention_profiles()` — list the org's reusable house-style profiles (slug/name/detect_hint) so
   * the onboarding brain can compare the stack it just mapped against each profile's `detect_hint` and pick
   * the best match (or decide none fits). Read-only; org comes from the closure (never a tool arg).
   */
  private buildListConventionProfilesTool(stimulus: ChatStimulus): ToolImpl {
    return async () => {
      if (!this.conventions) return { ok: true, profiles: [], message: 'No house-style profiles are configured.' };
      try {
        const profiles = await this.conventions.listProfiles(stimulus.orgId);
        return {
          ok: true,
          profiles,
          message: profiles.length
            ? 'Compare the repo stack you mapped against each `detectHint`, then call propose_convention_profile with the best-matching `slug` — or with "none" if the repo does not follow any of these house styles.'
            : 'This org has no house-style profiles defined — skip propose_convention_profile.',
        };
      } catch (err) {
        this.logger.warn(`list_convention_profiles failed for org=${stimulus.orgId}: ${err}`);
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `propose_convention_profile({ slug, rationale })` — recommend the house-style profile that matches THIS
   * repo's stack for the operator to approve. Like `propose_mcp_servers`, the brain NEVER attaches a profile
   * itself (owner-only): a concrete `slug` posts an owner-gated proposal card that the OWNER approves at
   * `…/jobs/:jobId/convention-proposals/:requestId/approve`, which sets `repos.convention_profile_slug`.
   * `slug:'none'` (or empty) posts NO card — a repo that follows no house style just stays unset (the safe
   * default), and the tool acknowledges. org/repo/job come from the closure (never tool args) — tenant safety.
   */
  private buildProposeConventionProfileTool(stimulus: ChatStimulus): ToolImpl {
    return async (args) => {
      const slug = String(args['slug'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      // "none"/empty ⇒ the repo matches no house style; leave the pointer unset (the default) — nothing to approve.
      if (!slug || slug.toLowerCase() === 'none') {
        return {
          ok: true,
          proposed: null,
          message:
            'Recorded that no house-style profile matches this repo — leaving its conventions unset (the default). Continue onboarding.',
        };
      }
      if (!this.conventions) return { ok: false, reason: 'house-style profiles are not configured for this org' };
      try {
        const profile = await this.conventions.getProfile(stimulus.orgId, slug);
        if (!profile) {
          return {
            ok: false,
            reason: `no house-style profile "${slug}" exists in this org — call list_convention_profiles to see the valid slugs`,
          };
        }
        const requestId = `conv-${randomUUID()}`;
        const card = webConventionProposalCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          slug: profile.slug,
          profileName: profile.name,
          rationale: rationale || `Matches this repo's stack.`,
        });
        const opened = await this.store.openConventionProposal(stimulus.jobId, { requestId, card });
        if (!opened.ok) return { ok: false, reason: 'Could not open the convention proposal (thread not found).' };
        return {
          ok: true,
          requestId,
          proposed: profile.slug,
          message:
            `Posted a house-style proposal card for the "${profile.name}" profile. The OWNER approves it to ` +
            'attach it to this repo — you cannot attach it yourself. Stop and wait for approval, then continue.',
        };
      } catch (err) {
        this.logger.warn(
          `propose_convention_profile failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `propose_convention_profile_change({ slug, name?, body, detectHint?, rationale })` — propose CREATING or
   * EDITING a reusable house-style profile's CONTENT (distinct from `propose_convention_profile`, which
   * ATTACHES an existing one to a repo). A house-style change is cross-cutting — it affects EVERY repo and
   * job in the org — so the brain NEVER writes it: this posts an owner-approvable card, and only the OWNER's
   * approval at `…/jobs/:jobId/convention-edit-proposals/:requestId/approve` upserts the profile. Use this when
   * you notice the reusable convention itself is wrong/outdated (NOT for a this-repo-only durable fact — that
   * belongs in repo memory via `remember`). If `slug` matches an existing profile it's an EDIT (the card
   * shows the prior body); a new `slug` is a CREATE. org/repo/job come from the closure (never tool args).
   */
  private buildProposeConventionProfileChangeTool(stimulus: ChatStimulus): ToolImpl {
    const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    return async (args) => {
      const slug = String(args['slug'] ?? '').trim();
      const body = String(args['body'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      const nameArg = String(args['name'] ?? '').trim();
      const detectHintArg = String(args['detectHint'] ?? '').trim();
      if (!SLUG_RE.test(slug)) {
        return { ok: false, reason: 'slug must be lowercase letters/digits/_/- (e.g. nestjs-next-shared)' };
      }
      if (!body) return { ok: false, reason: 'body (the house-style rules) is required' };
      if (!rationale) return { ok: false, reason: 'rationale — why the house style should change — is required' };
      if (!this.conventions) return { ok: false, reason: 'house-style profiles are not configured for this org' };
      try {
        const existing = await this.conventions.getProfile(stimulus.orgId, slug);
        const mode: 'create' | 'update' = existing ? 'update' : 'create';
        const name = nameArg || existing?.name;
        if (!name) return { ok: false, reason: 'name is required when creating a new profile' };
        const requestId = `conv-edit-${randomUUID()}`;
        const card = webConventionEditProposalCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          slug,
          name,
          body,
          detectHint: detectHintArg || existing?.detect_hint || null,
          mode,
          ...(existing ? { priorBody: existing.body } : {}),
          rationale,
        });
        const opened = await this.store.openConventionEditProposal(stimulus.jobId, { requestId, card });
        if (!opened.ok) return { ok: false, reason: 'Could not open the proposal (thread not found).' };
        return {
          ok: true,
          requestId,
          mode,
          message:
            `Posted a house-style ${mode === 'create' ? 'creation' : 'change'} proposal for "${name}". Because ` +
            'this changes the reusable convention for EVERY repo in the org, only the OWNER can approve it — you ' +
            'cannot apply it yourself. Do NOT hand-edit repo code to force the new convention; keep building to ' +
            'the CURRENT house style. Mention the proposal, then continue.',
        };
      } catch (err) {
        this.logger.warn(
          `propose_convention_profile_change failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `list_mcp_servers()` — the MCP servers currently registered for this org (org-wide + repo-scoped).
   * Read-only, ungated — the brain reads it before proposing so it doesn't duplicate an existing server.
   * NEVER returns a secret value (secret header/env slots surface as `secretKeys` names only). org comes
   * from the closure (never tool args) — tenant safety.
   */
  private buildListMcpServersTool(stimulus: ChatStimulus): ToolImpl {
    return async () => {
      if (!this.mcpStore) return { ok: true, servers: [], message: 'MCP servers are not configured for this org.' };
      try {
        const servers = (await this.mcpStore.list(stimulus.orgId)).map((s) => ({
          name: s.name,
          scope: s.scope === 'org' ? 'org' : 'repo',
          transport: s.transport,
          surfaces: s.surfaces,
          enabled: s.enabled,
          secretKeys: s.secretKeys,
          // Auth model, so the brain reads a 401 correctly: `authKind:'oauth'` + `oauthConnected:false` means
          // the OWNER must Connect it (NOT a request_secret target); `'static'` uses secretKeys.
          authKind: s.authKind,
          oauthConnected: s.oauthConnected,
          // Secret-SAFE failure state so a brain that lists servers sees a broken one directly (not only
          // via the PROFILE GAPS block): `validationError` is a safe message; `needsReauth` is OAuth-only.
          validationError: s.validationError,
          needsReauth: s.needsReauth,
        }));
        return {
          ok: true,
          servers,
          message:
            (servers.length
              ? 'Existing MCP servers — propose_mcp_servers with the SAME name to REPLACE one, or a new name to add one.'
              : 'No MCP servers registered yet — propose_mcp_servers to add the first (owner-approved).') +
            (servers.some((s) => s.authKind === 'oauth' && !s.oauthConnected)
              ? ' An oauth server with oauthConnected:false is NOT broken auth you can fix — the OWNER must Connect it from the MCP proposal card or in the console (MCP settings → Connect). Do not use request_secret / inject an Authorization header for it.'
              : ''),
        };
      } catch (err) {
        this.logger.warn(`list_mcp_servers failed for org=${stimulus.orgId}: ${err}`);
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `list_skills()` — the skills currently registered for this org (org-wide + repo-scoped). Read-only,
   * ungated (like `list_convention_profiles`) — the brain reads it before proposing a new/edited one so it
   * doesn't duplicate an existing skill. org comes from the closure (never tool args) — tenant safety.
   */
  private buildListSkillsTool(stimulus: ChatStimulus): ToolImpl {
    return async () => {
      if (!this.skillStore) return { ok: true, skills: [], message: 'Skills are not configured for this org.' };
      try {
        const skills = (await this.skillStore.list(stimulus.orgId)).map((s) => ({
          name: s.name,
          scope: s.scope === 'org' ? 'org' : 'repo',
          description: s.description,
          surfaces: s.surfaces,
          enabled: s.enabled,
        }));
        return {
          ok: true,
          skills,
          message: skills.length
            ? 'Existing skills — propose_skill with a NEW name to create another; request_skill_edit_access ' +
              'to iteratively edit one of these (Edit/Write, once the owner grants it).'
            : 'No skills registered yet — propose_skill to create the first.',
        };
      } catch (err) {
        this.logger.warn(`list_skills failed for org=${stimulus.orgId}: ${err}`);
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `propose_skill({ name, description, scope?, rationale })` — SUBMIT a skill the brain AUTHORED as real
   * files (via its built-in `run-skill-generator` skill) under `/context/skill-drafts/<name>/` for owner
   * approval. NO `body` — a skill is a multi-file dir (SKILL.md + references/scripts/assets), authored with
   * `Read`/`Write`/`Edit` in the writable `/context` scratch area, NOT crammed into a tool arg. This tool
   * FREEZES that draft into an immutable request-scoped staging dir (the brain cannot mutate it after) and
   * posts an owner-approvable card with a preview; only the OWNER's approval at
   * `…/jobs/:jobId/skill-proposals/:requestId/approve` vendors the frozen copy into the store and removes the
   * draft. CREATE-ONLY: a `name` that already exists is refused — to change one, `request_skill_edit_access`
   * and Edit/Write it in place. `scope` is `'repo'` (default) or `'org'`. All lanes (brain/build/review) get
   * the skill — on-demand description-match already gates loading, so there is no per-lane knob. org/repo/job
   * come from the closure (never tool args) — tenant safety.
   */
  private buildProposeSkillTool(stimulus: ChatStimulus): ToolImpl {
    const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    const ALL_SURFACES: McpSurface[] = ['brain', 'build', 'review'];
    return async (args) => {
      const name = String(args['name'] ?? '').trim();
      const description = String(args['description'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      const scope: 'org' | 'repo' = String(args['scope'] ?? 'repo').trim() === 'org' ? 'org' : 'repo';

      if (!NAME_RE.test(name)) {
        return { ok: false, reason: 'name must be lowercase letters/digits/_/- (e.g. house-migrations)' };
      }
      if (!description) return { ok: false, reason: 'description (the "Use when …" trigger blurb) is required' };
      if (!rationale) return { ok: false, reason: 'rationale — why this skill helps builds here — is required' };
      if (!this.skillStore || !this.skillFiles) {
        return { ok: false, reason: 'skills are not configured for this org' };
      }
      try {
        const dbScope = scope === 'org' ? '*' : stimulus.repoId;
        const existing = await this.skillStore.get(stimulus.orgId, dbScope, name);
        if (existing) {
          return {
            ok: false,
            reason:
              `a ${scope}-scoped skill "${name}" already exists — propose_skill only CREATES. Call ` +
              'request_skill_edit_access({ skill: \'' + name + '\' }) to get owner-approved edit access, ' +
              'then Edit/Write its files directly.',
          };
        }
        // The brain authors the skill as real files here first (with its built-in run-skill-generator).
        const draftDir = join(this.lifecycle.contextDirHost(stimulus.jobId, stimulus.orgId), 'skill-drafts', name);
        if (!existsSync(join(draftDir, 'SKILL.md'))) {
          return {
            ok: false,
            reason:
              `no authored skill found at /context/skill-drafts/${name}/SKILL.md. Author it FIRST — use your ` +
              'built-in run-skill-generator skill to scaffold and write the folder (SKILL.md + any ' +
              'references/scripts) under /context/skill-drafts/' + name + '/, then call propose_skill again.',
          };
        }
        const requestId = `skill-${randomUUID()}`;
        // Freeze exactly what exists now — approval vendors this immutable copy, not the still-writable draft.
        const stagingPath = this.skillFiles.freezeDraft(draftDir, stimulus.orgId, requestId);
        const preview = this.skillFiles.previewDir(stagingPath) ?? undefined;
        const card = webSkillProposalCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          scope,
          name,
          description,
          surfaces: ALL_SURFACES,
          mode: 'create',
          rationale,
          stagingPath,
          preview,
        });
        const opened = await this.store.openSkillProposal(stimulus.jobId, { requestId, card });
        if (!opened.ok) {
          this.skillFiles.removeStaging(stimulus.orgId, requestId);
          return { ok: false, reason: 'Could not open the skill proposal (thread not found).' };
        }
        return {
          ok: true,
          requestId,
          mode: 'create',
          message:
            `Posted a skill creation proposal for "${name}" (${scope}-scoped) from your authored files. Only the ` +
            'OWNER can approve it — you cannot register it yourself. On approval it moves into the durable skill ' +
            'store (every future job inherits it) and the draft is removed; it loads on the next fresh session ' +
            '(reset_sandbox to pick it up). Mention the proposal, then continue.',
        };
      } catch (err) {
        this.logger.warn(
          `propose_skill failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `propose_skill_install({ sourceUrl, ref?, subpath?, scope?, rationale })` — propose INSTALLING a
   * maintained skill from a git marketplace (e.g. `github.com/anthropics/skills`,
   * `github.com/agents-inc/skills`) instead of authoring one from stale memory. SINGLE-skill only: `subpath`
   * MUST point at one skill dir (a `SKILL.md`), not a marketplace root. The tool DRY-RUNS the source
   * (`SkillInstallerService.preview`) to resolve the REAL frontmatter name/description and detect an overwrite
   * conflict, so the owner's card shows exactly what will land. The brain never installs directly — only the
   * OWNER's approval routes to `SkillInstallerService.install` (`provenance:'git'`, auto-updating). `scope` is
   * `'repo'` (default) or `'org'`. org/repo/job come from the closure (never tool args) — tenant safety.
   */
  private buildProposeSkillInstallTool(stimulus: ChatStimulus): ToolImpl {
    return async (args) => {
      const sourceUrl = String(args['sourceUrl'] ?? '').trim();
      const ref = String(args['ref'] ?? '').trim() || undefined;
      const subpath = String(args['subpath'] ?? '').trim() || undefined;
      const rationale = String(args['rationale'] ?? '').trim();
      const scope: 'org' | 'repo' = String(args['scope'] ?? 'repo').trim() === 'org' ? 'org' : 'repo';

      if (!/^https:\/\/\S+$/.test(sourceUrl)) {
        return { ok: false, reason: 'sourceUrl must be an https git URL (e.g. https://github.com/anthropics/skills)' };
      }
      if (!rationale) return { ok: false, reason: 'rationale — why this skill helps builds here — is required' };
      if (!this.skillStore || !this.skillInstaller) {
        return { ok: false, reason: 'skills are not configured for this org' };
      }
      try {
        const dbScope = scope === 'org' ? '*' : stimulus.repoId;
        let rows;
        try {
          rows = await this.skillInstaller.preview({ orgId: stimulus.orgId, scope: dbScope, sourceUrl, ref, subpath });
        } catch (err) {
          return { ok: false, reason: `could not resolve that skill source: ${errText(err)}` };
        }
        const resolved = rows[0];
        if (!resolved) return { ok: false, reason: 'that source resolved no installable skill' };
        const requestId = `skill-${randomUUID()}`;
        const card = webSkillProposalCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          scope,
          name: resolved.name,
          description: resolved.description,
          surfaces: ['brain', 'build', 'review'],
          mode: 'install',
          rationale,
          sourceUrl,
          sourceRef: ref,
          sourceSubpath: subpath,
          installPreview: { rows },
        });
        const opened = await this.store.openSkillProposal(stimulus.jobId, { requestId, card });
        if (!opened.ok) return { ok: false, reason: 'Could not open the skill install proposal (thread not found).' };
        return {
          ok: true,
          requestId,
          mode: 'install',
          message:
            `Posted an install proposal for the "${resolved.name}" skill (${scope}-scoped)${resolved.overwrites ? ' — NOTE it would overwrite an existing skill of that name' : ''}. ` +
            'Only the OWNER can approve it. On approval it installs from git (kept up to date) and loads on the ' +
            'next fresh session (reset_sandbox to pick it up). Mention the proposal, then continue.',
        };
      } catch (err) {
        this.logger.warn(`propose_skill_install failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`);
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `request_skill_edit_access({ skill, rationale })` — request live `Edit`/`Write` access to an ALREADY
   * REGISTERED skill for the rest of THIS session. Skills are read-only by default (`makeCanUseTool`'s
   * skill guard, `engine-core.ts`) — a small fix or an iterative multi-file edit shouldn't need a whole new
   * `propose_skill` body-replace proposal. Mirrors `request_secret`'s shape: posts an owner-approvable card
   * and tells the model to stop and wait — the owner approves at
   * `…/jobs/:jobId/skill-edit-access/:requestId/approve`, which (for a `git`-provenance skill) forks it to a
   * custom copy FIRST, then records the grant this manager forwards on every subsequent brain turn
   * (`grantSkillEditAccess` → `RunEngineArgs.grantedSkills`). PER-CARD (like `request_file`) — several may
   * be open at once. org/repo/job come from the closure (never tool args) — tenant safety.
   */
  private buildRequestSkillEditAccessTool(stimulus: ChatStimulus): ToolImpl {
    return async (args) => {
      const name = String(args['skill'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      if (!name) return { ok: false, reason: 'skill (the name to unlock) is required — call list_skills first' };
      if (!rationale) return { ok: false, reason: 'rationale — why you need to edit this skill — is required' };
      if (!this.skillStore) return { ok: false, reason: 'skills are not configured for this org' };
      try {
        // Repo scope overrides an org skill of the same name (SkillResolver's own precedence) — resolve
        // whichever one is actually ACTIVE for this repo/job.
        const repoRow = await this.skillStore.get(stimulus.orgId, stimulus.repoId, name);
        const orgRow = repoRow
          ? null
          : await this.skillStore.get(stimulus.orgId, WorkspaceSkillStore.toDbScope('org'), name);
        const row = repoRow ?? orgRow;
        if (!row) {
          return {
            ok: false,
            reason: `no skill named "${name}" is registered — call list_skills to see what's available`,
          };
        }
        const scope: 'org' | 'repo' = repoRow ? 'repo' : 'org';
        const requestId = `skill-edit-${randomUUID()}`;
        const card = webSkillEditAccessCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          scope,
          name,
          provenance: row.provenance,
          sourceUrl: row.source_url,
          sourceRef: row.source_ref,
          rationale,
        });
        const opened = await this.store.openSkillEditAccessRequest(stimulus.jobId, { requestId, card });
        if (!opened.ok) {
          return { ok: false, reason: 'Could not open the edit-access request (thread not found).' };
        }
        return {
          ok: true,
          requestId,
          message:
            `Posted an edit-access request for the "${name}" skill. Stop and wait — only the OWNER can grant ` +
            'it. If it is installed from git, approval forks it to a custom copy first (the git original ' +
            'stays clean and updatable) and the grant applies to the fork under a possibly DIFFERENT name — ' +
            'the confirmation names the exact skill/dir to edit.',
        };
      } catch (err) {
        this.logger.warn(
          `request_skill_edit_access failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `propose_skill_removal({ name, scope?, rationale })` — propose DELETING a registered skill. Like
   * `propose_skill`, the brain never deletes directly (a skill affects every future build): this posts an
   * owner-approvable card showing what would be removed, and only the OWNER's approval at the skill-proposal
   * approve endpoint deletes it via `WorkspaceSkillStore`. `scope` is `'repo'` (default) or `'org'` — it must
   * match the tier the skill lives on. org/repo/job come from the closure (never tool args) — tenant safety.
   */
  private buildProposeSkillRemovalTool(stimulus: ChatStimulus): ToolImpl {
    return async (args) => {
      const name = String(args['name'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      const scope: 'org' | 'repo' = String(args['scope'] ?? 'repo').trim() === 'org' ? 'org' : 'repo';
      if (!name) return { ok: false, reason: 'name (the skill to remove) is required' };
      if (!rationale) return { ok: false, reason: 'rationale — why the skill should be removed — is required' };
      if (!this.skillStore) return { ok: false, reason: 'skills are not configured for this org' };
      try {
        const dbScope = scope === 'org' ? '*' : stimulus.repoId;
        const existing = await this.skillStore.get(stimulus.orgId, dbScope, name);
        if (!existing) {
          return {
            ok: false,
            reason: `no ${scope}-scoped skill "${name}" exists — call list_skills to see the registered skills`,
          };
        }
        const requestId = `skill-${randomUUID()}`;
        const card = webSkillProposalCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          scope,
          name,
          description: '',
          surfaces: existing.surfaces,
          mode: 'remove',
          priorBody: this.skillFiles?.readSkillBody(stimulus.orgId, dbScope, name),
          rationale,
        });
        const opened = await this.store.openSkillProposal(stimulus.jobId, { requestId, card });
        if (!opened.ok) return { ok: false, reason: 'Could not open the skill removal proposal (thread not found).' };
        return {
          ok: true,
          requestId,
          message:
            `Posted a removal proposal for the "${name}" skill (${scope}-scoped). Only the OWNER can approve ` +
            'the deletion — you cannot remove it yourself. Mention the proposal, then continue.',
        };
      } catch (err) {
        this.logger.warn(`propose_skill_removal failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`);
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /**
   * `propose_mcp_removal({ name, scope?, rationale })` — propose DELETING a registered MCP server. Owner-gated
   * like `propose_mcp_servers`: posts a removal card; only the OWNER's approval at the mcp-proposal approve
   * endpoint deletes it via `McpServerStore`. `scope` is `'repo'` (default) or `'org'` — the tier the server
   * lives on. org/repo/job come from the closure (never tool args) — tenant safety.
   */
  private buildProposeMcpRemovalTool(stimulus: ChatStimulus): ToolImpl {
    return async (args) => {
      const name = String(args['name'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      const scope: 'org' | 'repo' = String(args['scope'] ?? 'repo').trim() === 'org' ? 'org' : 'repo';
      if (!name) return { ok: false, reason: 'name (the MCP server to remove) is required' };
      if (!rationale) return { ok: false, reason: 'rationale — why the server should be removed — is required' };
      if (!this.mcpStore) return { ok: false, reason: 'MCP servers are not configured for this org' };
      try {
        const dbScope = scope === 'org' ? '*' : stimulus.repoId;
        const existing = await this.mcpStore.rawRow(stimulus.orgId, dbScope, name);
        if (!existing) {
          return {
            ok: false,
            reason: `no ${scope}-scoped MCP server "${name}" exists — call list_mcp_servers to see the registered servers`,
          };
        }
        const requestId = `mcp-${randomUUID()}`;
        const card = webMcpProposalCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          scope,
          mode: 'remove',
          removeNames: [name],
          servers: [],
        });
        const opened = await this.store.openMcpProposal(stimulus.jobId, { requestId, card });
        if (!opened.ok) return { ok: false, reason: 'Could not open the MCP removal proposal (thread not found).' };
        return {
          ok: true,
          requestId,
          message:
            `Posted a removal proposal for the "${name}" MCP server (${scope}-scoped). Only the OWNER can ` +
            'approve the deletion — you cannot remove it yourself. Mention the proposal, then continue.',
        };
      } catch (err) {
        this.logger.warn(`propose_mcp_removal failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`);
        return { ok: false, reason: errText(err) };
      }
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
  private buildResetSandboxTool(stimulus: ChatStimulus): ToolImpl {
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
          return { ok: false, reason: 'No sandbox for this job yet — nothing to hard-reset.' };
        }
        const dirty = await this.git.hasChanges(sandbox.worktreePath).catch(() => true);
        const safe = dirty
          ? false
          : await this.git.worktreeSafeToRecut(sandbox.worktreePath, sandbox.branch).catch(() => false);
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
   * `finish_onboarding({ summary })` — conclude the onboarding session. Posts the operator-visible summary.
   * Secrets and workspace config (mounts/seed) are ALREADY live the instant they were written (encrypted
   * grants / DB rows — see docs/adr/0003), so `onboarded_at` is stamped immediately regardless. If the
   * ceremony also made an actual repo edit (a script fix, a `.gitignore` change, a dependency bump — real
   * code changes are a normal part of onboarding, not just config), that diff still needs to reach the
   * repo, so it's shipped as its own PR for the operator to merge.
   */
  private buildFinishOnboardingTool(stimulus: ChatStimulus): ToolImpl {
    return async (args) => {
      const summary = String(args['summary'] ?? '').trim();
      // Green-gate: onboarding may only conclude once Atlas has actually brought the stack up and checked
      // it. `verified` is that evidence (which services booted, how they were health-checked, any dry-run).
      // It is required + non-trivial so the ceremony can't rubber-stamp a stack it never ran; the operator
      // approving/merging the PR is the final human gate. (See docs/adr/0002 §6.)
      const verified = String(args['verified'] ?? '').trim();
      if (verified.length < 20) {
        return {
          ok: false,
          reason:
            'finish_onboarding requires `verified`: describe what you actually booted and how you checked it ' +
            '(the services you brought up via atlas-svc, the health checks/log lines, any dry-run). For a repo ' +
            'with USER-FACING surfaces, `verified` must ALSO include live preview-accessibility proof — each ' +
            'public preview URL loaded + hydrated as a browser via atlas-probe, AND (where the surface has ' +
            'auth) the authed-handshake proof via a real dev-login + `atlas-probe --storage-state`; a local ' +
            'health check is not enough. If the stack would not boot or a surface is not browser-accessible, ' +
            'do NOT finish — say what is still blocking instead.',
        };
      }
      const sandbox = await this.lifecycle.findSandbox(
        stimulus.jobId,
        stimulus.orgId,
      );
      if (!sandbox)
        return { ok: false, reason: 'no sandbox for this thread yet' };

      // Persist the boot evidence as a durable, operator-visible record before concluding.
      await this.store.appendSystemEvent(
        stimulus.jobId,
        `✅ Boot verified — ${verified}`,
      );
      if (summary)
        await this.store.appendSystemEvent(
          stimulus.jobId,
          `🎉 Onboarding complete — ${summary}`,
        );

      // Everything past this point (marking onboarded, checking for a diff, shipping) can hit a transient
      // DB/git/GitHub failure — never let that throw and crash the turn. Warn, and give Atlas the real
      // error via `reason` so it can retry (e.g. re-call finish_onboarding) instead of the ceremony
      // silently wedging with no feedback.
      try {
        // Secrets + workspace config are already durably live (encrypted grants / DB rows) the instant
        // they were written — onboarding is marked done regardless of whether there's a code diff to ship.
        await this.lifecycle.markRepoOnboarded(stimulus.orgId, stimulus.repoId);
        // Seed the new-stack baseline: the bulk pass has seen the whole stack, so acknowledge every
        // dependency manifest now — future jobs only flag manifests that appear AFTER this.
        await this.refreshSeenManifests(stimulus.orgId, stimulus.repoId, sandbox.worktreePath);

        const hasChanges = await this.git.hasChanges(sandbox.worktreePath);
        if (!hasChanges) {
          return {
            ok: true,
            prOpened: false,
            message: 'Onboarding complete. Repo marked ready.',
          };
        }

        // A real repo edit was made along the way (script fix, .gitignore change, etc.) — ship it as its
        // own PR (reuses the shared ship path: commit → autofix → push → open ONE PR → record
        // pr_url/pr_number on the thread → flips it done).
        const job = await this.store.loadJob(stimulus.jobId);
        const repo = await this.repos.resolve(job);
        // HOST PRE-SHIP GATE only (no-token + leak-scan — the host NEVER commits). `finish_onboarding` runs
        // INSIDE this brain turn, so (like `finalize_build`) it cannot seed a nested open-PR turn — it
        // leak-scans host-side, then hands `shipOpenPrBody` back so the brain commits its env-setup changes and
        // opens the PR itself in THIS turn. The git-state reconciler records the PR later.
        const pre = await this.ship.preShip(job, repo, sandbox, (m) =>
          this.store.appendSystemEvent(stimulus.jobId, m),
        );
        if (!pre.ok) {
          if (pre.reason === 'leak-scan') {
            // Hard security block — a hydrated secret/seed path was committed on the onboarding branch.
            return {
              ok: false,
              reason:
                `PR blocked by the pre-ship security scan — a managed secret/seed file was committed: ` +
                `${pre.leaked.join(', ')}. Remove it from the branch history and retry.`,
            };
          }
          return {
            ok: true,
            prOpened: false,
            message: 'Made repo changes but no GitHub token is set — connect one to open the PR.',
          };
        }
        return {
          ok: true,
          prOpened: false,
          message: shipOpenPrBody({
            branch: sandbox.branch,
            defaultBranch: repo.defaultBranch,
            title: 'Environment setup',
          }),
        };
      } catch (err) {
        this.logger.warn(`finish_onboarding failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`);
        return { ok: false, reason: errText(err) };
      }
    };
  }

  /** Coerce `write_workspace_config` mounts arg into validated {path, mode} specs (drops malformed entries). */
  private normalizeMounts(raw: unknown): {
    mounts: { path: string; mode: MountMode }[];
    warnings: string[];
  } {
    if (!Array.isArray(raw)) return { mounts: [], warnings: [] };
    const out: { path: string; mode: MountMode }[] = [];
    const warnings: string[] = [];
    for (const e of raw) {
      const o = e as Record<string, unknown>;
      const path = String(o?.['path'] ?? '').trim();
      if (!path || path.split('/').includes('..') || path.length > MAX_MOUNT_PATH_LEN) continue;
      if (isExternalMountPath(path)) {
        // ABSOLUTE path = an EXTERNAL durable mount at that exact container location (e.g. a tool's default
        // `~/.config/gcloud` → `/root/.config/gcloud`), bound OUTSIDE /workspace so nothing lands in the
        // repo. Guarded so it can't shadow a system bind or OS root.
        if (isReservedContainerPath(path)) {
          warnings.push(`mount "${path}" targets a reserved/system container path (do not mount it) — dropped`);
          continue;
        }
      } else if (isReservedMountPath(path)) {
        // Worktree-relative reserved paths (e.g. `.pnpm-store`) are system-managed caches with no
        // legitimate reason to be mounted into a repo's own worktree — drop + warn.
        warnings.push(`mount "${path}" is auto-managed by the system (do not add it) — dropped`);
        continue;
      }
      const mode: MountMode =
        o?.['mode'] === 'shared-ro' || o?.['mode'] === 'shared-rw'
          ? (o['mode'] as MountMode)
          : 'per-thread';
      out.push({ path, mode });
    }
    return { mounts: out, warnings };
  }

  /**
   * (Re)generate the thread's `decision-record.md` from its working-set decisions and write it to the
   * READ-ONLY `/context/generated/` bucket (host-side path; the container sees `/context/generated` as a
   * read-only mount). Called on every decision mutation, so the file stays incremental + in lockstep with
   * the structured `pending_decisions` — coding agents read it for grounding but never author it.
   */
  /**
   * Resolve which ANSWERED `ask_question` card a decision should attach, with multiple questions possibly
   * open: an explicit `questionId` (the brain named one) wins, else the card THIS turn delivered
   * (`stimulus.seedQuestionId`), else the most-recently-answered not-yet-logged card. Returns the card +
   * its id, or null when none is answered. There is no single-slot pointer to read.
   */
  private async resolveAnsweredCard(
    stimulus: ChatStimulus,
    explicitQuestionId?: string,
  ): Promise<{ id: string; card: WebQuestionCard } | null> {
    const byId = async (id?: string) => {
      if (!id) return null;
      const card = await this.store.getQuestionCard(stimulus.jobId, id);
      return card?.answer != null ? { id, card } : null;
    };
    const explicit = await byId(explicitQuestionId);
    if (explicit) return explicit;
    const seeded = await byId(stimulus.seedQuestionId);
    if (seeded) return seeded;
    const row = await this.store.latestAnsweredQuestionCard(stimulus.jobId);
    const card = row?.card as WebQuestionCard | undefined;
    return row?.ts && card?.answer != null ? { id: row.ts, card } : null;
  }

  private async writeDecisionRecordMd(
    jobId: string,
    orgId: string,
    decisions: Decision[],
  ): Promise<void> {
    const generatedDir = join(
      this.lifecycle.contextDirHost(jobId, orgId),
      'generated',
    );
    await mkdir(generatedDir, { recursive: true });
    await writeFile(
      join(generatedDir, 'decision-record.md'),
      renderDecisionRecordMd(decisions),
      'utf8',
    );
  }

  /**
   * Re-render `/context/generated/atlas-cleared-blocks.md` — the audit of build blocks Atlas CLEARED itself by
   * retrieving an existing answer (via `note_cleared_block`). A pure PROJECTION of the durable `cleared:*` FYI
   * card rows (mirrors `writeDecisionRecordMd`): the card rows are the source of truth (they survive sandbox
   * teardown), the file is a re-render, so idempotency falls out of re-projecting a deduped store. This is a
   * job-scoped audit only — NOT ADR-promotable; Atlas never authors significant decisions on its own.
   */
  private async writeClearedBlocksMd(jobId: string, orgId: string): Promise<void> {
    const entries = await this.store.listClearedBlockCards(jobId);
    const generatedDir = join(this.lifecycle.contextDirHost(jobId, orgId), 'generated');
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
    // Statuses past the approval gate (post-`awaiting_approval`) — never (re)propose over these. A build
    // FAILURE is now the orthogonal `halt` axis (JobStatus has no 'failed'/'paused'); a failed/paused job
    // keeps its phase (typically 'running'), so it's still caught here. `amending` is deliberately NOT
    // listed — like `planning`, it's a shaping state where a fresh propose_plan is allowed.
    const pastGate: JobStatus[] = ['running', 'awaiting_ship_review', 'done', 'cancelled', 'deleting'];
    if (pastGate.includes(existing.status)) {
      return { refuse: `This job is already '${existing.status}' — can’t (re)propose a plan for it.` };
    }
    if (existing.status === 'awaiting_approval' && existing.decisionRecordId) {
      const res = await this.store.withdrawPlan(jobId, 'superseded by a re-proposed plan');
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
    if (!owner) throw new Error(`no auto-approve approver for job ${job.id} (no auto_approve_by and no org owner)`);
    return owner;
  }

  /**
   * Post the approval card and act on the verdict — mirrors the old `ConversationalBrainService`
   * flow but without blocking the session turn on it.
   */
  async requestApprovalAndAct(
    stimulus: ChatStimulus,
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
    this.surface.emitThreadMeta?.(
      stimulus.repoId,
      stimulus.jobId,
      card.title,
    );

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
      await this.saySystemNotice(stimulus, 'Auto-approve is on — approving this plan automatically.');
      this.approvals.resolve(autoApprovalJob.id, 'approve', approver, undefined, decisionRecordId);
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
    stimulus: ChatStimulus,
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
      await this.store.setActivity(stimulus.jobId, 'base_check').catch(() => undefined);
      // Passive milestone — the plan WAS approved (drained into the NEXT operator turn). Recorded AFTER the
      // durable `approve`. The former `dispatched:` milestone is dropped — it now fires when the build
      // actually starts (inside `dispatch_build`), not at approval.
      await this.recordMilestone(
        stimulus.jobId,
        `approved:${decisionRecordId}`,
        'Your plan was approved by the operator.',
      );
      await this.saySystemNotice(stimulus, 'Approved — checking the base branch before starting…');
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
          harnessDeliveryStimulus({
            jobId: job.id,
            orgId: job.orgId,
            repoId: job.repoId,
            body: renderRequestChangesDelivery(resolution.note),
            seedRow: {
              label: 'Operator requested changes — revising the plan.',
              chunkKey: `seed:request-changes:${decisionRecordId}`,
            },
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
    const stimulus = harnessDeliveryStimulus({
      jobId: job.id,
      orgId: job.orgId,
      repoId: job.repoId,
      body: agentMessage(''),
      // Empty body — a pure mechanism to drive `actOnApprovalVerdict`; the verdict itself is visible.
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
    stimulus: ChatStimulus,
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

    // Durably mark the session being ABANDONED before the summary turn runs. Two duties: (1) recovery-skip —
    // `TurnRecoveryService` must not surface this session's transcript, whose tail becomes the internal
    // summary; (2) resume signal — if `session_id` still equals this after a restart, the reseed never
    // committed and the boot reconciler completes it. Cleared on a non-crash failure below, and when the
    // fresh session is born (the eager session-id persist).
    await this.sandboxRows
      .update(
        { job_id: stimulus.jobId, org_id: stimulus.orgId },
        { compacting_session_id: sessionId },
      )
      .catch((err) =>
        this.logger.warn(`compaction: marker set failed for job=${stimulus.jobId}: ${err}`),
      );

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
        { jobId: stimulus.jobId, orgId: stimulus.orgId, lane: 'main', kind: 'compaction', engine: 'claude' },
        result.usage,
      );
      summary = (result.result ?? '').trim();
    } catch (err) {
      // A non-clean summary turn never reaches `end_turn`, so recovery would not surface it — safe to clear
      // the marker (no leak) and give up this cycle (best-effort; no boot retry-loop).
      this.logger.error(
        `compaction: summary turn failed for job=${stimulus.jobId} — leaving session intact: ${err}`,
      );
      await this.clearCompactionMarker(stimulus.jobId, stimulus.orgId);
      return;
    }

    if (!summary) {
      this.logger.warn(
        `compaction: empty summary for job=${stimulus.jobId} — leaving session intact`,
      );
      await this.clearCompactionMarker(stimulus.jobId, stimulus.orgId);
      return;
    }

    try {
      await this.completeCompaction(stimulus.jobId, stimulus.orgId, summary);
    } catch (err) {
      // The summary is durable in the SDK JSONL and `compacting_session_id` still points at this session, so
      // the boot reconciler re-drives it (by then the exec is done → safe). Leave the marker set; keep the
      // in-memory row coherent (session NOT abandoned yet).
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

  /** Clear the {@link JobSandboxEntity.compacting_session_id} marker (best-effort). */
  private async clearCompactionMarker(jobId: string, orgId: string): Promise<void> {
    await this.sandboxRows
      .update({ job_id: jobId, org_id: orgId }, { compacting_session_id: null })
      .catch((err) =>
        this.logger.warn(`compaction: marker clear failed for job=${jobId}: ${err}`),
      );
  }

  /**
   * ATOMIC compaction completion — the reseed (null `session_id`, stash the lean seed) and the inspectable
   * `build_event` pill land in ONE transaction, so a crash can never leave the session abandoned without its
   * audit pill (Codex review). `compacting_session_id` is deliberately KEPT (recovery keeps skipping the
   * abandoned session until the fresh one is born). Bounded in-process retry rides out a transient DB blip;
   * on exhaustion it throws and the caller leaves the marker set for the boot reconciler. Shared by the
   * fresh run and {@link reattachCompactionOne}.
   */
  private async completeCompaction(
    jobId: string,
    orgId: string,
    summary: string,
  ): Promise<void> {
    const seed = `${CONTINUATION_PREAMBLE}\n\n${summary}`;
    const pillText =
      '🗜️ Compacted the planning conversation into a lean handoff — the build is running and future turns start fresh.';
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.sandboxRows.manager.transaction(async (mgr) => {
          await mgr.update(
            JobSandboxEntity,
            { job_id: jobId, org_id: orgId },
            { session_id: null, pending_compaction_seed: seed },
          );
          await mgr.insert(MessageEntity, {
            job_id: jobId,
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
      result = await this.engineRunner.reattach!(row.turn_id, row.container_id, {
        onEvent: () => {
          /* internal turn — not surfaced in the operator transcript */
        },
      });
    } catch (err) {
      // Lost the tail (detached again) — the row survives; the next boot re-attempts. Best-effort.
      this.logger.warn(
        `compaction re-attach ${row.turn_id}: reattach failed: ${err}`,
      );
      return;
    }
    const summary = (result.result ?? '').trim();
    if (!summary) {
      // The exec concluded with no usable summary — drop the abandon marker and leave the session intact
      // (a fresh compaction can be re-driven later). The turn row was finalized by reattach's own path.
      await this.clearCompactionMarker(row.job_id, row.org_id);
      return;
    }
    await this.completeCompaction(row.job_id, row.org_id, summary);
    this.logger.log(
      `Leader: completed re-attached compaction for job=${row.job_id}`,
    );
  }

  /**
   * Re-drive a compaction STRANDED between its finished exec and the reseed commit (leader-only) — the
   * observed failure class (crash after the summary turn concluded, before the reseed landed). `session_id`
   * still equals `compacting_session_id`, but no `active_turns` compaction row remains (the exec finished),
   * so the exec is provably dead and a fresh run cannot race it. The `hasRunningForThread` guard defers to
   * {@link reattachOwnedTurns} whenever a turn IS still live (never double-run).
   */
  private async reconcileStrandedCompactions(): Promise<void> {
    let stranded: JobSandboxEntity[];
    try {
      stranded = await this.sandboxRows
        .createQueryBuilder('s')
        .where('s.compacting_session_id IS NOT NULL')
        .andWhere('s.session_id IS NOT NULL')
        .andWhere("s.lifecycle <> 'closed'")
        .getMany();
    } catch (err) {
      this.logger.warn(`compaction reconcile: query failed: ${err}`);
      return;
    }
    for (const row of stranded) {
      const live = await this.turnRegistry
        .hasRunningForThread(row.job_id)
        .catch(() => false);
      if (live) continue; // a turn is live — reattach (or the queue) owns it; don't race a second run.
      this.logger.log(
        `Leader: re-driving stranded compaction for job=${row.job_id}`,
      );
      void this.enqueueCompaction(
        this.compactionStimulus(row.job_id, row.org_id, row.repo_id),
      );
    }
  }

  /** Minimal synthetic stimulus for a server-driven compaction re-drive (body unused — `compact` short-circuits). */
  private compactionStimulus(
    jobId: string,
    orgId: string,
    repoId: string,
  ): ChatStimulus {
    return {
      id: randomUUID(),
      kind: 'chat',
      trust: 'trusted',
      orgId,
      repoId,
      jobId,
      body: '',
      author: { id: 'atlas', displayName: 'Atlas' },
      replyRoute: { surfaceId: 'web', jobRef: jobId },
      receivedAt: new Date(),
    };
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
  private async enqueueCompaction(stimulus: ChatStimulus): Promise<void> {
    if (await this.shouldSkipCompaction(stimulus.jobId)) {
      this.logger.log(
        `compaction: job=${stimulus.jobId} skipped — session lean (below ${COMPACTION_MIN_OCCUPANCY_FRAC} of the window)`,
      );
      return;
    }
    const compaction: ChatStimulus = {
      ...stimulus,
      id: randomUUID(),
      body: '',
      receivedAt: new Date(),
      author: { id: 'atlas', displayName: 'Atlas' },
      compact: true,
    };
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
    stimulus: ChatStimulus,
    job: Job,
  ): Promise<void> {
    const instruction =
      'The direct-build plan was APPROVED. Implement the change now, directly, in the repo ' +
      '(`/workspace`) — follow the spec/notes you wrote under `/context`. When the change is complete, ' +
      'run `mcp__atlas-lsp-ts__diagnostics` on the files you changed and the repo\'s own typecheck, and fix ' +
      'anything they find. Then — if your change touched a runtime surface (an HTTP endpoint/route, a UI ' +
      'page/component, a CLI entry point, or a background job) — ACTUALLY EXERCISE IT LIVE: boot the process ' +
      'and curl the endpoint / drive the UI / run the CLI for real. If the change is internal plumbing whose ' +
      'effect is never echoed in an HTTP/UI/CLI surface (e.g. an option/value handed to an SDK), instead boot ' +
      'the process and capture a log line proving the changed value was passed at runtime. Typecheck, build, ' +
      'lint, and the test suite are NOT live verification on their own. Report what you ran with ' +
      '`report_verification({ passed: true, verification: [{ kind, command, exitCode, outputTail }, …] })` — ' +
      'capture the real command, its exit code, and a tail of its output. `finalize_build` now runs a ' +
      'live-verification judge over that evidence and REFUSES to ship a runtime change you only typechecked. ' +
      'Only then call `finalize_build` to commit, review, and open the PR. Do NOT call submit_plan or ' +
      'start_direct_build again.';
    const synthetic: ChatStimulus = {
      ...stimulus,
      id: randomUUID(),
      body: instruction,
      receivedAt: new Date(),
      author: { id: 'atlas', displayName: 'Atlas' },
    };
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
    const stimulus: ChatStimulus = {
      id: randomUUID(), // synthetic — the brain path doesn't persist the stimulus row
      orgId,
      repoId,
      body: firstMessage,
      receivedAt: new Date(),
      kind: 'chat',
      trust: 'trusted',
      jobId,
      author: { id: 'atlas', displayName: 'Atlas' },
      replyRoute: { surfaceId: 'web', jobRef: jobId },
    };
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
    const stimulus: ChatStimulus = {
      id: randomUUID(),
      orgId,
      repoId,
      body,
      receivedAt: new Date(),
      kind: 'chat',
      trust: 'trusted',
      jobId,
      author: { id: 'atlas', displayName: 'Atlas' },
      replyRoute: { surfaceId: 'web', jobRef: jobId },
    };
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
  async deliverEvent(stimulus: EventStimulus): Promise<void> {
    await this.pumpEvent(stimulus);
  }

  /**
   * Deliver ONE event to its job's brain. FAST PATH: a running brain turn is steered (the event-row id is the
   * steer id, so the engine's `input_ack` stamps THIS row). SLOW PATH (no running turn): a fresh turn framed
   * by `renderEventDelivery` is queued on the per-thread turn queue and stamps delivery at its registration
   * hand-off. Idempotent (skips an already-delivered row); lease-guarded so a concurrent sweep can't
   * double-drive. Deliberately does NOT go through `handleChatTurn` — that method's seed steer fast-path
   * (`steerIntoLiveBrainTurn`) reports "handled" on a bare XADD, which would re-open the swallowed-steer race.
   */
  async pumpEvent(stimulus: EventStimulus): Promise<void> {
    if (this.election.getState() === 'draining') return;

    // Already delivered (an intake / sweep / boot race) → no-op. Cheap guard before paying a turn.
    const row = await this.stimulusRows.findOne({ where: { id: stimulus.id } });
    if (row?.delivered_at) return;

    const body = renderEventDelivery(stimulus);
    const live = await this.turnRegistry.runningBrainTurn(stimulus.jobId).catch(() => null);
    if (live?.turn_id && typeof this.engineRunner.steer === 'function') {
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
  private async steerEvent(turnId: string, eventRowId: string, body: AgentMessage): Promise<void> {
    await this.stimulusStore
      .leaseChatStimuli([eventRowId]) // kind-agnostic (updates by id) — reused for the event row
      .catch((err) => this.logger.debug(`pump: lease event failed (continuing): ${err}`));
    await this.engineRunner
      .steer!(turnId, eventRowId, body)
      .catch((err) =>
        this.logger.warn(`pump: steer event into turn ${turnId} failed (sweep will re-drive): ${err}`),
      );
  }

  /** Run ONE fresh turn that consumes a single event, stamping delivery at the registration hand-off. */
  private async deliverEventViaFreshTurn(stimulus: EventStimulus, body: AgentMessage): Promise<void> {
    // A turn may have appeared since pumpEvent's check (a boot re-attach resumed one). Steer it instead of
    // starting a SECOND turn on the same session (never two concurrent turns resuming one session id).
    const live = await this.turnRegistry.runningBrainTurn(stimulus.jobId).catch(() => null);
    if (live?.turn_id && typeof this.engineRunner.steer === 'function') {
      await this.steerEvent(live.turn_id, stimulus.id, body);
      return;
    }

    // Lease BEFORE dispatch (like the chat fresh path) so a concurrent sweep can't re-drive a duplicate
    // while this potentially-long turn runs.
    await this.stimulusStore.leaseChatStimuli([stimulus.id]);
    const delivery = eventDeliveryStimulus({
      id: stimulus.id, // the DURABLE event-row id — so `onRegistered` stamps THIS row (not a synthetic uuid)
      jobId: stimulus.jobId,
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      body,
      seedRow: 'skip', // the untrusted event body already has a durable `system_event` row from intake
    });
    await this.runChatTurn(delivery, {
      // Restart-survivable hand-off: stamp delivered the instant the turn is registered + kicked (a later
      // crash resumes THIS turn rather than re-running the event).
      onRegistered: () => {
        void this.stimulusStore
          .markChatDelivered(stimulus.id)
          .catch((err) =>
            this.logger.debug(`event markDelivered ${stimulus.id} failed (sweep will retry): ${err}`),
          );
      },
    });
  }

  /** LEADER periodic + boot re-drive of any routed event still undelivered (the event at-least-once sweep). */
  private async sweepUndeliveredEvents(): Promise<void> {
    if (this.election.getState() !== 'leader') return;
    let events: EventStimulus[];
    try {
      events = await this.stimulusStore.eligiblePendingEvents(
        AgentSessionManager.CHAT_DELIVERY_LEASE_MS,
      );
    } catch (err) {
      this.logger.debug(`event delivery sweep query failed (will retry): ${err}`);
      return;
    }
    for (const ev of events) {
      void this.pumpEvent(ev).catch((err) =>
        this.logger.debug(`event sweep pump failed for stimulus=${ev.id}: ${err}`),
      );
    }
  }

  // ── Passive pipeline-milestone awareness ─────────────────────────────────────────────────────────

  /**
   * Drain the thread's buffered milestones + the net-current-state delta and render the clearly-passive
   * prefix to prepend to this OPERATOR turn (null when there's nothing to convey). Atomic drain (a single
   * locked transaction in the store) so a milestone the driver appends mid-turn isn't read-cleared and
   * lost. Best-effort: any failure returns null so the turn proceeds — `get_pipeline_state` remains the
   * authoritative pull.
   */
  private async buildAwarenessPrefix(
    jobId: string,
    orgId: string,
  ): Promise<string | null> {
    try {
      const state = await this.driverStore.getPipelineState(jobId, orgId);
      const sig = pipelineStateSignature(state);
      const { markers, stateChanged } = await this.awareness.drainAndAdvance(
        jobId,
        sig,
      );
      if (markers.length === 0 && !stateChanged) return null;
      const prefix = renderAwarenessPrefix(
        markers,
        stateChanged ? renderPipelineStateSummary(state) : null,
      );
      return prefix || null;
    } catch (err) {
      this.logger.debug(
        `pipeline-awareness prefix failed (continuing): ${err}`,
      );
      return null;
    }
  }

  /**
   * An advisory prefix listing this thread's still-OPEN `ask_question` cards (asked, not yet answered or
   * withdrawn) so a fresh turn doesn't re-ask them — the fix for the "brain keeps asking the same question"
   * loop, whose root cause is that question cards live OUTSIDE the engine session and are never otherwise
   * re-surfaced once the session's in-context memory is lost (a new turn, an event, a restart/compaction).
   * Null when nothing is open. Best-effort — a failure here never blocks the turn.
   */
  private async buildOpenQuestionsPrefix(
    jobId: string,
  ): Promise<string | null> {
    try {
      const open = await this.store.openQuestionCards(jobId);
      if (open.length === 0) return null;
      const lines = open.map((c) => {
        const gist = (c.header?.trim() || c.question || '').replace(/\s+/g, ' ').trim().slice(0, 160);
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
   * brain) and survives compaction. Returns null unless the job is `amending`. Best-effort.
   */
  private async buildAmendingPrefix(jobId: string): Promise<string | null> {
    try {
      const job = await this.store.loadJob(jobId).catch(() => null);
      if (job?.status !== 'amending') return null;
      return (
        'This build is AMENDING — the ship-review gate was retracted so you can make a follow-up fix. ' +
        'Make the change in the sandbox and verify it (typecheck/build/tests, plus a live run of any ' +
        'runtime surface you touched). When it is done and verified, call ' +
        '`report_verification({ passed: true })` with your live evidence — that re-parks the job DIRECTLY ' +
        'at the ship-review gate (amending → ready-to-ship, no rebuild) and re-posts the "Ship it" card for ' +
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
  private injectedMemoryFactIds(jobId: string, sessionId: string | null): Set<string> {
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
    this.injectedMemoryByJob.set(jobId, { sessionId, factIds: new Set<string>() });
  }

  private async buildMemoryRecallPrefix(
    stimulus: ChatStimulus,
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
      const seen = this.injectedMemoryFactIds(stimulus.jobId, sessionId ?? null);
      const fresh = facts.filter((f) => !seen.has(f.id));
      if (fresh.length === 0) return null;
      const body = renderMemoryRecall(fresh.map((f) => ({ fact: f.fact, scope: f.scope })));
      if (!body) return null;
      for (const f of fresh) seen.add(f.id);
      return body;
    } catch (err) {
      this.logger.debug(`memory auto-recall prefix failed (continuing): ${err}`);
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
      this.logger.debug(`open-file-requests prefix failed (continuing): ${err}`);
      return null;
    }
  }

  /**
   * Build an `onMilestone` callback for the provisioning chain (`ensureProvisioned`/`ensureContainer`) —
   * narrates the genuinely slow attach sub-steps (a real image rebuild, a cold container create) as a
   * quiet operator-visible pill via `appendSystemEvent`, NOT a fake Atlas reply and NOT `recordMilestone`
   * (that mechanism buffers for the BRAIN's own next turn — this needs to be seen by the operator now).
   * Fire-and-forget with a debug-logged catch, matching this file's other best-effort append style.
   */
  private sandboxMilestoneNotifier(stimulus: ChatStimulus): (stage: SandboxMilestoneStage) => void {
    return (stage) => {
      const text =
        stage === 'image_build'
          ? 'Building the sandbox image — this can take a few minutes on first run or after a workspace-setup change…'
          : "Preparing this thread's workspace container — one moment…";
      void this.store
        .appendSystemEvent(stimulus.jobId, text)
        .catch((err) => this.logger.debug(`milestone event append failed: ${err}`));
    };
  }

  /** Buffer a passive pipeline milestone for the brain (no turn runs). Best-effort + idempotent by `id`. */
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

  // ── Helpers ────────────────────────────────────────────────────────────────────────────────────

  /** Post a reply in-thread AND append it to the durable transcript. */
  private async say(stimulus: ChatStimulus, text: string): Promise<void> {
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
      .catch((err) => this.logger.warn(`failed to persist brain reply: ${err}`));
  }

  /** Post a calm SYSTEM→OPERATOR notice (meta.source='system_notice') in-thread AND append the durable
   *  row. Mirrors {@link say} but is NOT in Atlas's voice — a benign harness ack the resumed brain
   *  session never authored, with no error/Resume semantics (contrast {@link saySystemOperator}). */
  private async saySystemNotice(stimulus: ChatStimulus, text: string): Promise<void> {
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
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  private async saySystemOperator(
    stimulus: ChatStimulus,
    text: string,
    opts: { retryable?: boolean; sessionLimit?: boolean; resumeAt?: string } = {},
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

  /** Find the open scoping job on this thread, or open a fresh one. */
  private async ensureJob(
    stimulus: ChatStimulus,
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
function isOperatorAuthored(stimulus: ChatStimulus): boolean {
  return (
    stimulus.author.id !== ATLAS_AUTHOR_ID &&
    stimulus.author.id !== SYSTEM_SEED_AUTHOR.id
  );
}

/** Wake-eligible (d18): `now`/`queue` (absent = `now`) may WAKE a fresh turn; `later` only rides along. */
function isWakeEligible(s: ChatStimulus): boolean {
  return (s.priority ?? 'now') !== 'later';
}

/** A durable system seed that stamps a card (question/secret/file). Its stimulus row + card must be stamped
 *  TOGETHER on the consumption tail (fresh-turn success / steer ack / reattach), never on steer-dispatch or
 *  registration — so a register-then-fail turn re-drives instead of stranding a card behind a delivered row. */
function isSeedCardDelivery(s: ChatStimulus): boolean {
  return !!s.seed && (!!s.seedQuestionId || !!s.seedSecretId || !!s.seedFileId);
}

/** Steer-eligible (d18): only `now` (absent = `now`) steers mid-turn; `queue`/`later` never interrupt a live turn. */
function isNowPriority(s: ChatStimulus): boolean {
  return (s.priority ?? 'now') === 'now';
}

/** Build the `<user name at>` chunk for a human message — attribution reconstructed from the stimulus
 *  author + receipt time at engine-render time (the persisted body stays clean). `role` is provisioned
 *  for later multi-operator persona context; unset for now. */
function userChunkFor(stimulus: ChatStimulus): TurnChunk {
  return {
    kind: 'user',
    body: stimulus.body,
    attrs: {
      name: stimulus.author.displayName,
      at: stimulus.receivedAt.toISOString(),
    },
  };
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
 * Build the synthetic SEED stimulus that wakes the brain after a `reset_sandbox` teardown. Its only job is
 * to guarantee a turn happens (so Atlas verifies on the fresh container) — the actual verify instruction
 * rides the reset-notice ({@link RESET_VERIFY_TEXT}), consumed by whichever turn cold-attaches first. Marked
 * `seedResetVerify` so it no-ops if an earlier turn already consumed that notice (see `runChatTurnInner`).
 */
function resetContinuationStimulus(input: {
  jobId: string;
  orgId: string;
  repoId: string;
}): ChatStimulus {
  return {
    id: randomUUID(),
    orgId: input.orgId,
    repoId: input.repoId,
    body: wrapSystemNotification(resetContinuationNotice()),
    receivedAt: new Date(),
    kind: 'chat',
    trust: 'trusted',
    jobId: input.jobId,
    author: { id: SYSTEM_SEED_AUTHOR.id, displayName: SYSTEM_SEED_AUTHOR.name },
    replyRoute: { surfaceId: 'web', jobRef: input.jobId },
    seed: true,
    seedResetVerify: true,
  };
}

/**
 * Build the synthetic SYSTEM-SEED stimulus that delivers a completed Codex review's findings to the brain
 * straight through `handleChatTurn`. Reuses the canonical host-seed convention (SYSTEM_SEED_AUTHOR + `seed`
 * + `<system_notification>` envelope, same as the `/answer-question` delivery) so it skips the operator-only
 * paths (passive-awareness drain + typed-answer linkage). The wrapped body is what the brain reads; the
 * operator sees the same findings as the durable, idempotent "Codex review" message.
 */
function harnessDeliveryStimulus(input: {
  jobId: string;
  orgId: string;
  repoId: string;
  body: AgentMessage;
  /** File-gate delivery: the `request_file` card id this seed confirms, so the tail stamps it delivered. */
  seedFileId?: string;
  /** How this seed renders as a visible transcript row (see {@link SeedRow}). */
  seedRow?: SeedRow;
}): ChatStimulus {
  return {
    id: randomUUID(), // synthetic — the brain path doesn't persist the stimulus row
    orgId: input.orgId,
    repoId: input.repoId,
    body: wrapSystemNotification(input.body),
    receivedAt: new Date(),
    kind: 'chat',
    trust: 'trusted',
    jobId: input.jobId,
    author: { id: SYSTEM_SEED_AUTHOR.id, displayName: SYSTEM_SEED_AUTHOR.name },
    replyRoute: { surfaceId: 'web', jobRef: input.jobId },
    seed: true,
    ...(input.seedFileId ? { seedFileId: input.seedFileId } : {}),
    ...(input.seedRow ? { seedRow: input.seedRow } : {}),
  };
}

/**
 * Build the synthetic harness stimulus that delivers an EVENT to the brain through `handleChatTurn`. Same
 * trusted seed convention as {@link harnessDeliveryStimulus} (SYSTEM_SEED_AUTHOR + `seed`, no operator
 * bubble), but the body is NOT `wrapSystemNotification`-wrapped — `renderEventDelivery` already framed it
 * and fenced the untrusted event. The untrusted boundary lives in that fence + the system-prompt clause,
 * so this stays a `trust: 'trusted'` harness turn carrying clearly-fenced untrusted data.
 */
function eventDeliveryStimulus(input: {
  /** The DURABLE event-row id — pass it so a steer's `input_ack` and the fresh turn's `onRegistered` both
   *  stamp the same `stimuli` row. Omitted only by callers that don't drive delivery bookkeeping. */
  id?: string;
  jobId: string;
  orgId: string;
  repoId: string;
  body: AgentMessage;
  seedRow?: SeedRow;
}): ChatStimulus {
  return {
    id: input.id ?? randomUUID(),
    orgId: input.orgId,
    repoId: input.repoId,
    body: input.body, // already framed + fenced by renderEventDelivery
    receivedAt: new Date(),
    kind: 'chat',
    trust: 'trusted',
    jobId: input.jobId,
    author: { id: SYSTEM_SEED_AUTHOR.id, displayName: SYSTEM_SEED_AUTHOR.name },
    replyRoute: { surfaceId: 'web', jobRef: input.jobId },
    seed: true,
    ...(input.seedRow ? { seedRow: input.seedRow } : {}),
  };
}

/**
 * Build the synthetic harness stimulus that delivers a THREAD-HALT wake to the brain (ADR 0004 Phase 3).
 * Same trusted-seed convention as {@link eventDeliveryStimulus} (SYSTEM_SEED_AUTHOR + `seed`, no operator
 * bubble, body NOT `wrapSystemNotification`-wrapped since `renderHaltDelivery` already framed + fenced it).
 */
function haltDeliveryStimulus(input: {
  jobId: string;
  orgId: string;
  repoId: string;
  body: AgentMessage;
  seedHaltWake: { threadId: string; gen: number };
  seedRow?: SeedRow;
}): ChatStimulus {
  return {
    id: randomUUID(), // synthetic — the brain path doesn't persist the stimulus row
    orgId: input.orgId,
    repoId: input.repoId,
    body: input.body, // already framed + fenced by renderHaltDelivery
    receivedAt: new Date(),
    kind: 'chat',
    trust: 'trusted',
    jobId: input.jobId,
    author: { id: SYSTEM_SEED_AUTHOR.id, displayName: SYSTEM_SEED_AUTHOR.name },
    replyRoute: { surfaceId: 'web', jobRef: input.jobId },
    seed: true,
    // Stamped on the turn's SUCCESS tail — a failed/guard-hit/detached wake turn stays un-waked for the sweeps.
    seedHaltWake: input.seedHaltWake,
    ...(input.seedRow ? { seedRow: input.seedRow } : {}),
  };
}

/**
 * Build the synthetic harness stimulus that delivers a COMPLETION wake to the brain (decision d1). Same
 * trusted-seed convention as {@link haltDeliveryStimulus} (SYSTEM_SEED_AUTHOR + `seed`, no operator bubble,
 * body NOT `wrapSystemNotification`-wrapped since `renderDoneDelivery` already framed + fenced it).
 */
function doneDeliveryStimulus(input: {
  jobId: string;
  orgId: string;
  repoId: string;
  body: AgentMessage;
  seedDoneWake: { threadId: string; reason: 'final' | 'notable'; gen: number };
  seedRow?: SeedRow;
}): ChatStimulus {
  return {
    id: randomUUID(), // synthetic — the brain path doesn't persist the stimulus row
    orgId: input.orgId,
    repoId: input.repoId,
    body: input.body, // already framed + fenced by renderDoneDelivery
    receivedAt: new Date(),
    kind: 'chat',
    trust: 'trusted',
    jobId: input.jobId,
    author: { id: SYSTEM_SEED_AUTHOR.id, displayName: SYSTEM_SEED_AUTHOR.name },
    replyRoute: { surfaceId: 'web', jobRef: input.jobId },
    seed: true,
    // Stamped on the turn's SUCCESS tail — a failed/guard-hit/detached wake turn stays un-waked for the sweeps.
    seedDoneWake: input.seedDoneWake,
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
      typeof d['id'] === 'string' && d['id']
        ? (d['id'] as string)
        : nextDecisionId(out);
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
    return String((err as { message: unknown }).message).slice(0, 200);
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
