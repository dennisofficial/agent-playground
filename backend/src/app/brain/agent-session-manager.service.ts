import { EnvService } from '@core/config/env/env.service';
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
import type {
  Decision,
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
import { DECISION_CLASS_IDS, nextDecisionId } from '@shared/domain';
import type { DecisionClass } from '@shared/domain/decision-record';
import type { EngineHomeKey } from '@shared/engine/engine-home';
import type {
  EngineEvent,
  EngineRunnerPort,
  EngineRunResult,
  GitAuth,
  RunEngineArgs,
  ToolImpl,
} from '@shared/engine/engine.types';
import {
  ENGINE_RUNNER,
  HOST_RETRY_BACKOFF_MS,
  INTERNAL_PROFILE_AWARENESS_TOOL,
  isEngineDetachedError,
  isRetryableTransientError,
  isUnresumableSessionMessage,
  MAX_HOST_RETRIES,
  resolveContextLimit,
  SANDBOX_RESET_NOTICE,
} from '@shared/engine/engine.types';
import {
  defaultResumeAt,
  isCorroboratedSessionLimit,
  SESSION_LIMIT_TEXT_MISFIRE_MAX,
} from '@shared/engine/session-limit';
import type { TurnFailureCategory } from '@shared/engine/turn-failure-summary';
import { summarizeTurnFailure } from '@shared/engine/turn-failure-summary';
import { isReservedMcpName } from '@shared/mcp/reserved-mcp-names';
import { chunkKey } from '@shared/prompt-kit/harness/chunk-keys';
import { renderTurn, TurnChunk } from '@shared/prompt-kit/harness/tag-vocabulary';
import { isSubstantiveQuery, renderMemoryRecall } from '@shared/prompt-kit/jit';
import type { AgentMessage } from '@shared/prompt-kit/message';
import { fromExternal } from '@shared/prompt-kit/message';
import { Agent, composePreviewPrepSeed } from '@shared/prompt-kit/system';
import { coerceThreadType, type ThreadType } from '@shared/thread-kind/thread-types';
import { modeApprovesPlan } from '@workspace/shared';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Subscription } from 'rxjs';
import { Repository } from 'typeorm';
import { TurnUsageProjector } from '../analytics/turn-usage-projector.service';
import { BrainGateway } from '../brain-gateway/brain-gateway.service';
import { LeaderElectionService } from '../cluster/leader-election.service';
import { ConventionProfileResolver } from '../conventions/convention-profile.resolver';
import { DecisionClassifier } from '../decision-gate/decision-classifier.service';
import { AutoMergeService } from '../driver/auto-merge.service';
import { BuildShipService } from '../driver/build-ship.service';
import { DriverStoreService } from '../driver/driver-store.service';
import { JobLifecycleService, ProvisioningNotReadyError } from '../driver/job-lifecycle.service';
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
import {
  pipelineStateSignature,
  renderAwarenessPrefix,
  renderPipelineStateSummary,
} from '../driver/pipeline-awareness';
import { PipelineAwarenessStore } from '../driver/pipeline-awareness.store';
import { DRIVER_REPO, type DriverRepoResolver } from '../driver/repo-resolver';
import { LocalGitService } from '../git/local-git.service';
import { JobBootstrapService } from '../job-bootstrap/job-bootstrap.service';
import { JobDependencyService } from '../job-deps/job-dependency.service';
import { McpResolver } from '../mcp/mcp-resolver.service';
import { McpServerStore } from '../mcp/mcp-server.store';
import { MemoryStore } from '../memory/memory.store';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { OauthUsageService } from '../onboarding/oauth-usage.service';
import { WorkspaceConfigStore } from '../onboarding/workspace-config.store';
import { WorkspaceSecretFileStore } from '../onboarding/workspace-secret.store';
import { DB_CONNECTION } from '../persistence/database.module';
import type {
  McpAuthKind,
  McpOAuthTokenAuthMethod,
  McpSurface,
  StoredMcpOAuthConfig,
} from '../persistence/entities';
import {
  ActiveTurnEntity,
  InboundMessageEntity,
  JobSandboxEntity,
  RepoEntity,
  TranscriptMessageEntity,
} from '../persistence/entities';
import { ProdDiagnosticsService } from '../prod-mcp/prod-diagnostics.service';
import { composeMessageBody } from '../prompt-kit/harness/compose-message';
import { composeSeedTurn, composeTurn } from '../prompt-kit/harness/compose-turn';
import {
  COMPACTION_INSTRUCTION,
  COMPACTION_SYSTEM,
  CONTINUATION_PREAMBLE,
  foldCompactionSeed,
  frameAnswer,
  interruptRedriveNudge,
  maskedFileNotice,
  maskedSecretNotice,
  renderEventDelivery,
  renderFollowUpJobSeed,
  renderUnblockedNote,
  RESET_VERIFY_TEXT,
  retryResumeNudge,
  wakeForAmendApprovedBody,
} from '../prompt-kit/harness/seed-catalog';
import { postBuildGateSeed } from '../prompt-kit/messages/post-build-gate';
import type { PlannedStep } from '../prompt-kit/messages/render-plan';
import { shipOpenPrBody } from '../prompt-kit/messages/ship-open-pr';
import { PromptService } from '../prompt-kit/prompt.service';
import { isAtlasRepo } from '../sandbox/atlas-repo';
import { CONTAINER_CONTEXT, normalizeMounts } from '../sandbox/container-paths';
import type { SandboxMilestoneStage } from '../sandbox/sandbox-provider.port';
import { TurnReattachRegistry, type ReattachOutcome } from '../sandbox/turn-reattach.registry';
import { BrainTurnAlreadyRunningError, TurnRegistry } from '../sandbox/turn-registry.service';
import { SkillFileWriter } from '../skills/skill-file-writer.service';
import { SkillInstallerService } from '../skills/skill-installer.service';
import { SkillResolver } from '../skills/skill-resolver.service';
import { WorkspaceSkillStore } from '../skills/workspace-skill.store';
import {
  CHAT_DELIVERY_LEASE_MS,
  CollectedPending,
  DeliveryLane,
  isNowPriority,
  isWakeEligible,
  steerPending,
  trySteerLive,
  userChunkFor,
} from '../stimulus/delivery-pump.service';
import { StimulusStoreService } from '../stimulus/stimulus-store.service';
import { DecisionApprovalCard } from '../surface/approval-blocks';
import {
  CHAT_SURFACE,
  SYSTEM_SEED_AUTHOR,
  wrapSystemNotification,
  type ChatSurface,
} from '../surface/chat-surface.port';
import { LiveTurnStore, MAIN_LANE } from '../surface/live-turn-store';
import {
  MESSAGE_CHANGE_NOTIFIER,
  type MessageChangeNotifier,
} from '../surface/message-change-notifier.port';
import { makeTaskTools } from '../surface/task-tools';
import { ThreadInputService } from '../surface/thread-input.service';
import { laneFor } from '../surface/thread-registry';
import {
  TASK_EVENT_SINK,
  TurnHarnessFactory,
  type TaskEventSink,
} from '../surface/turn-harness.service';
import { webShipReviewCard } from '../surface/web-approval-card';
import { webConventionEditProposalCard } from '../surface/web-convention-edit-proposal-card';
import { webConventionProposalCard } from '../surface/web-convention-proposal-card';
import { McpProposalServer, webMcpProposalCard } from '../surface/web-mcp-proposal-card';
import { WebQuestionCard, webQuestionCard } from '../surface/web-question-card';
import { webSkillEditAccessCard } from '../surface/web-skill-edit-access-card';
import { webSkillProposalCard } from '../surface/web-skill-proposal-card';
import { ThreadRole } from '../thread-kind/__tests__/spec';
import { threadKindSpec } from '../thread-kind/registry';
import { detectRepoManifests } from '../workspace-profile/manifest-detect';
import { ProfileAwarenessService } from '../workspace-profile/profile-awareness.service';
import { WorkspaceProfileService } from '../workspace-profile/workspace-profile.service';
import { BrainStoreService, type CreateJobAutoMode } from './brain-store.service';
import type { ApprovalResolution, ApprovalVerdict } from './decision-approval.service';
import { DecisionApprovalService } from './decision-approval.service';
import { renderDecisionRecordMd } from './decision-record-md';
import { JitHostExecutor } from './jit-host-executor';
import { JOB_DISPATCHER, type JobDispatcher } from './job-dispatcher';
import { deserializeFindings, PlanReviewService, type PlanReviewRow } from './plan-review.service';
import { SelfSufficiencyToolsService } from './self-sufficiency-tools.service';
import { TurnRecoveryService } from './turn-recovery.service';

type InjectedMemoryDedupState = {
  sessionId: string | null;
  factIds: Set<string>;
};

const NOOP_TASK_EVENT_SINK: TaskEventSink = {
  createTask: async () => ({ id: 'noop' }),
  updateTask: async () => ({ ok: false, error: 'task sink not wired' }),
  readTasks: async () => [],
};

@Injectable()
export class AgentSessionManager implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AgentSessionManager.name);

  private leaderBootSub?: Subscription;
  private bootSweepsDone = false;
  private chatSweepPromoteSub?: Subscription;
  private chatSweepDemoteSub?: Subscription;

  private readonly workOwedNudgedAt = new Map<string, number>();

  private static readonly _CHAT_DELIVERY_LEASE_MS = CHAT_DELIVERY_LEASE_MS;

  private static readonly BRAIN_MODEL = 'opus';

  private readonly turnQueues = new Map<string, Promise<void>>();

  private static readonly MAX_BENIGN_ABORT_REDRIVES = 2;

  private readonly hostRetryTimers = new Map<string, NodeJS.Timeout>();

  private readonly resetRequests = new Map<string, { reason: string; hard?: boolean }>();
  private readonly pendingResetVerify = new Set<string>();
  private readonly consecutiveResets = new Map<string, number>();
  private readonly pendingHardReset = new Set<string>();
  private readonly directBuildShipPending = new Map<string, boolean>();
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
  private readonly skillEditGrantsByJob = new Map<string, Set<string>>();

  private readonly repoSlugCache = new Map<string, string | null>();

  private readonly injectedMemoryByJob = new Map<string, InjectedMemoryDedupState>();

  constructor(
    private readonly store: BrainStoreService,
    private readonly driverStore: DriverStoreService,
    private readonly autoMerge: AutoMergeService,
    private readonly memory: MemoryStore,
    private readonly approvals: DecisionApprovalService,
    private readonly lifecycle: JobLifecycleService,
    @Inject(ENGINE_RUNNER) private readonly engineRunner: EngineRunnerPort,
    private readonly turnRegistry: TurnRegistry,
    private readonly planReview: PlanReviewService,
    @Inject(JOB_DISPATCHER) private readonly dispatcher: JobDispatcher,
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    @InjectRepository(JobSandboxEntity, DB_CONNECTION)
    private readonly sandboxRows: Repository<JobSandboxEntity>,
    @InjectRepository(InboundMessageEntity, DB_CONNECTION)
    private readonly stimulusRows: Repository<InboundMessageEntity>,
    private readonly stimulusStore: StimulusStoreService,
    private readonly turnHarness: TurnHarnessFactory,
    private readonly classifier: DecisionClassifier,
    private readonly ship: BuildShipService,
    @Inject(DRIVER_REPO) private readonly repos: DriverRepoResolver,
    private readonly awareness: PipelineAwarenessStore,
    private readonly jobDeps: JobDependencyService,
    private readonly creds: CredentialResolver,
    private readonly mcp: McpResolver,
    private readonly election: LeaderElectionService,
    private readonly turnRecovery: TurnRecoveryService,
    private readonly secretStore: WorkspaceSecretFileStore,
    private readonly configStore: WorkspaceConfigStore,
    private readonly git: LocalGitService,
    private readonly prompts: PromptService,
    private readonly threadInput: ThreadInputService,
    @Inject(LIVE_VERIFICATION_JUDGE)
    private readonly liveVerificationJudge: LiveVerificationJudge,
    private readonly usage: OauthUsageService,
    private readonly selfSufficiency: SelfSufficiencyToolsService,
    @Optional() private readonly usageProjector?: TurnUsageProjector,
    @Optional() private readonly env?: EnvService,
    @Optional() private readonly conventions?: ConventionProfileResolver,
    @Optional() private readonly workspaceProfile?: WorkspaceProfileService,
    @Optional() private readonly skills?: SkillResolver,
    @Optional() private readonly skillStore?: WorkspaceSkillStore,
    @Optional() private readonly skillFiles?: SkillFileWriter,
    @Optional() private readonly skillInstaller?: SkillInstallerService,
    @Optional() private readonly mcpStore?: McpServerStore,
    @Optional() private readonly scheduler?: SchedulerRegistry,
    @Optional() private readonly brainGateway?: BrainGateway,
    @Optional() private readonly reattachRegistry?: TurnReattachRegistry,
    @Optional() private readonly jit?: JitHostExecutor,
    @Optional() private readonly prodDiagnostics?: ProdDiagnosticsService,
    @Optional()
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repoRows?: Repository<RepoEntity>,
    @Optional() private readonly liveTurns?: LiveTurnStore,
    @Optional() private readonly jobBootstrap?: JobBootstrapService,
    @Optional() private readonly profileAwareness?: ProfileAwarenessService,
    @Inject(TASK_EVENT_SINK)
    private readonly taskSink: TaskEventSink = NOOP_TASK_EVENT_SINK,
    @Optional()
    @Inject(MESSAGE_CHANGE_NOTIFIER)
    private readonly messageNotifier?: MessageChangeNotifier,
  ) {}

  private async planningThreadId(jobId: string): Promise<string> {
    if (!this.jobBootstrap) throw new Error('agent-session-manager: JobBootstrapService not wired');
    return this.jobBootstrap.planningThreadId(jobId);
  }

  private async resolveBrainGitAuth(jobId: string): Promise<GitAuth | undefined> {
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

  onApplicationBootstrap(): void {
    this.brainGateway?.bind(this);

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
    for (const kind of ['brain', 'compaction'] as const) {
      this.reattachRegistry?.register(kind, (row) => this.reattachTurnRow(row));
    }

    this.leaderBootSub = this.election.onPromote(() => this.runLeaderBootSweeps());
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
    if (!this.scheduler) return;
    if (this.scheduler.doesExist('interval', CHAT_SWEEP_INTERVAL)) return;
    const iv = setInterval(() => {
      void this.sweepUndeliveredChat();
      void this.sweepUndeliveredEvents();
      void this.reconcileWorkOwedReviews();
    }, CHAT_SWEEP_INTERVAL_MS);
    iv.unref?.(); // never keep the process alive (SchedulerRegistry does not unref for us)
    this.scheduler.addInterval(CHAT_SWEEP_INTERVAL, iv);
  }

  private stopChatDeliverySweep(): void {
    if (this.scheduler?.doesExist('interval', CHAT_SWEEP_INTERVAL)) {
      this.scheduler.deleteInterval(CHAT_SWEEP_INTERVAL);
    }
  }

  private async runLeaderBootSweeps(): Promise<void> {
    if (this.bootSweepsDone) return;
    this.bootSweepsDone = true;

    try {
      const reset = await this.store.resetAllActivity();
      if (reset > 0) this.logger.log(`Leader: reset stale activity on ${reset} thread(s)`);
    } catch (err) {
      this.logger.warn(`activity reconciliation failed: ${err}`);
    }

    try {
      await this.reattachOwnedTurns();
    } catch (err) {
      this.logger.warn(`redis turn re-attach failed: ${err}`);
    }

    try {
      await this.reconcileStrandedCompactions();
    } catch (err) {
      this.logger.warn(`compaction reconcile failed: ${err}`);
    }

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
            seedRow: {
              label: `The operator answered your question ${JSON.stringify(q.question)}: ${q.answer}`,
              chunkKey: chunkKey.qa(q.jobId, q.questionId),
            },
            type: 'answer_question',
            seedQuestionId: q.questionId,
          }).catch((err) =>
            this.logger.warn(`question backfill failed for thread=${q.jobId}: ${err}`),
          );
        }
      }
      await this.store.reconcileOpenQuestionCounts();
    } catch (err) {
      this.logger.warn(`question-delivery reconciliation failed: ${err}`);
    }

    try {
      await this.store.reconcileOpenSecretCounts();
    } catch (err) {
      this.logger.warn(`open-secret-count reconciliation failed: ${err}`);
    }

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
            seedRow: {
              label: notice,
              chunkKey: chunkKey.secret(s.jobId, s.name),
            },
            type: 'secret_provided',
            seedSecretId: s.requestId,
          }).catch((err) =>
            this.logger.warn(`secret backfill failed for thread=${s.jobId}: ${err}`),
          );
        }
      }
    } catch (err) {
      this.logger.warn(`secret-delivery reconciliation failed: ${err}`);
    }

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
            seedRow: {
              label: notice,
              chunkKey: chunkKey.file(f.jobId, f.path),
            },
            type: 'file_answered',
            seedFileId: f.requestId,
          }).catch((err) => this.logger.warn(`file backfill failed for thread=${f.jobId}: ${err}`));
        }
      }
    } catch (err) {
      this.logger.warn(`file-delivery reconciliation failed: ${err}`);
    }

    await this.reconcileWorkOwedReviews();

    try {
      await this.stimulusStore.resetEventLeases();
      const events = await this.stimulusStore.eligiblePendingEvents(
        AgentSessionManager._CHAT_DELIVERY_LEASE_MS,
      );
      if (events.length > 0) {
        this.logger.log(`Leader: re-driving ${events.length} seeded-but-undelivered event(s)`);
        for (const ev of events) {
          void this.pumpEvent(ev).catch((err) =>
            this.logger.warn(`boot event re-drive failed for stimulus=${ev.id}: ${err}`),
          );
        }
      }
    } catch (err) {
      this.logger.warn(`event-delivery reconciliation failed: ${err}`);
    }

    try {
      await this.stimulusStore.resetChatLeases();
      const lanes = await this.stimulusStore.undeliveredChatLanes();
      if (lanes.length > 0) {
        this.logger.log(
          `Leader: re-driving undelivered operator message(s) across ${lanes.length} lane(s)`,
        );
        for (const t of lanes) {
          void this.pumpThread(t.jobId, t.orgId, t.repoId, t.lane).catch((err) =>
            this.logger.warn(`boot chat re-drive failed for thread=${t.jobId}: ${err}`),
          );
        }
      }
    } catch (err) {
      this.logger.warn(`chat-delivery reconciliation failed: ${err}`);
    }

    try {
      const recovered = await this.turnRecovery.recoverInterruptedTurns();
      if (recovered > 0)
        this.logger.log(`Leader: JSONL backstop back-filled ${recovered} lost turn(s)`);
    } catch (err) {
      this.logger.warn(`JSONL turn-recovery backstop failed: ${err}`);
    }
  }

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

  private async escalateBuildLaneLeftovers(jobId: string, threadId: string): Promise<void> {
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

  async recordUnblockNote(
    jobId: string,
    orgId: string,
    repoId: string,
    input: { blockers: UnblockBlockerInfo[] },
  ): Promise<void> {
    if (
      await this.stimulusStore.hasChatStimulusForSeedTarget(jobId, {
        unblockNote: true,
      })
    ) {
      return;
    }
    await this.stimulusStore.recordChatStimulus({
      orgId,
      repoId,
      jobId,
      author: {
        id: SYSTEM_SEED_AUTHOR.id,
        displayName: SYSTEM_SEED_AUTHOR.name,
      },
      type: 'unblocked_job_wake',
      body: renderUnblockedNote(input.blockers),
      lane: 'main',
      replyRoute: { surfaceId: 'web', jobRef: jobId },
      unblockNote: true,
      systemChunk: {
        label: 'All blocking jobs resolved — unblocked.',
        chunkKey: chunkKey.unblock(jobId),
      },
    });
  }

  async pumpUnblockedJob(jobId: string, orgId: string, repoId: string): Promise<void> {
    await this.pumpThread(jobId, orgId, repoId, 'main');
  }

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


  async handleChatTurn(stimulus: TurnEnvelope): Promise<void> {
    if (this.election.getState() === 'draining') return;

    if (await this.isJobBlocked(stimulus.jobId)) {
      this.logger.log(
        `job=${stimulus.jobId} is blocked; dropping system turn until it is unblocked`,
      );
      return;
    }

    this.persistSeedRow(stimulus);

    if (
      !isStandaloneSeed(stimulus.message.type) &&
      (await this.steerIntoLiveBrainTurn(stimulus).catch((err) => {
        this.logger.warn(`steer-into-live pre-check failed for job=${stimulus.jobId}: ${err}`);
        return false;
      }))
    ) {
      return;
    }

    const key = `${stimulus.orgId}:${stimulus.jobId}`;
    const prev = this.turnQueues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.runChatTurn(stimulus));
    this.turnQueues.set(
      key,
      next.finally(() => {
        if (this.turnQueues.get(key) === next) this.turnQueues.delete(key);
      }),
    );
    return next;
  }

  private engineBody(stimulus: TurnEnvelope): string {
    if (stimulus.chunks?.length) return renderTurn(stimulus.chunks);
    if (!isOperatorAuthored(stimulus)) return stimulus.body;
    return renderTurn([userChunkFor(stimulus)]);
  }

  private pendingRowToChunk(p: TurnEnvelope): TurnChunk {
    if (isOperatorAuthored(p)) return userChunkFor(p);
    if (p.message.type === 'event') {
      return {
        kind: 'untrusted',
        body: p.body,
        attrs: { at: p.receivedAt.toISOString() },
      };
    }
    return {
      kind: 'passthrough',
      body: p.body,
      attrs: { name: p.author.displayName, at: p.receivedAt.toISOString() },
    };
  }

  private stampBatchOnRegistered(pending: TurnEnvelope[]): void {
    for (const p of pending) {
      if (isSeedCardDelivery(p)) continue;
      void this.stimulusStore
        .markChatDelivered(p.id)
        .catch((err) =>
          this.logger.debug(`markChatDelivered ${p.id} failed (sweep will retry): ${err}`),
        );
    }
  }

  private persistSeedRow(stimulus: TurnEnvelope): void {
    if (stimulus.author.id !== SYSTEM_SEED_AUTHOR.id) return; // harness seeds only
    if (stimulus.message.type === 'reset_verify') return; // reset already rides a notice chunk row
    const desc = stimulus.seedRow;
    if (desc === 'skip') return; // content already has a durable row elsewhere
    const row: Exclude<SeedRow, 'skip'> = desc ?? {
      label: 'A harness system notification was delivered to Atlas.',
      chunkKey: `seed:generic:${stimulus.jobId}:${createHash('sha1').update(stimulus.body).digest('hex').slice(0, 16)}`,
    };
    const isUntrusted = (row.kind ?? 'system_notice') === 'untrusted';
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
        ...(stimulus.message.type !== 'user' ? { seedType: stimulus.message.type } : {}),
      })
      ?.catch((err: unknown) => this.logger.debug(`persistSeedRow failed (best-effort): ${err}`));
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
          ...(chunk.attrs?.reminderKind ? { reminderKind: chunk.attrs.reminderKind } : {}),
          createdAt,
        })
        ?.catch((err: unknown) =>
          this.logger.debug(`recordSystemChunk failed (best-effort): ${err}`),
        );
    });
  }

  private async steerIntoLiveBrainTurn(stimulus: TurnEnvelope): Promise<boolean> {
    if (typeof this.engineRunner.steer !== 'function') return false;
    const live = await this.turnRegistry.runningBrainTurn(stimulus.jobId).catch(() => null);
    if (!live?.turn_id) return false;
    if (this.activeTurnLane(live) !== this.laneForStimulus(stimulus)) return false;
    try {
      await this.engineRunner.steer(live.turn_id, stimulus.id, this.engineBody(stimulus));
    } catch (err) {
      this.logger.warn(
        `steer into live turn ${live.turn_id} failed for job=${stimulus.jobId}: ${err}`,
      );
      return true;
    }
    if (isSeedCardDelivery(stimulus)) {
      const durableRow = await this.stimulusStore.findChatStimulusById(stimulus.id).catch((err) => {
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

  private async stampLegacySeedCard(stimulus: TurnEnvelope): Promise<void> {
    for (const questionId of stimulus.deliveredQuestionIds ?? []) {
      const card = await this.store.getQuestionCard(stimulus.jobId, questionId).catch(() => null);
      if (card?.answer != null && card.deliveredAt == null) {
        await this.store
          .markQuestionDelivered(stimulus.jobId, questionId)
          .catch((err) => this.logger.warn(`markQuestionDelivered (steer) failed: ${err}`));
      }
    }
    for (const secretId of stimulus.deliveredSecretIds ?? []) {
      const card = await this.store.getSecretCard(stimulus.jobId, secretId).catch(() => null);
      if (card?.provided_at != null) {
        if (card.delivered_at == null) {
          await this.store
            .markSecretDelivered(stimulus.jobId, secretId)
            .catch((err) => this.logger.warn(`markSecretDelivered (legacy seed) failed: ${err}`));
        }
        await this.store
          .clearAwaitingSecret(stimulus.jobId, secretId)
          .catch((err) => this.logger.warn(`clearAwaitingSecret (legacy seed) failed: ${err}`));
      }
    }
    for (const fileId of stimulus.deliveredFileIds ?? []) {
      const card = await this.store.getFileCard(stimulus.jobId, fileId).catch(() => null);
      if (card?.provided_at != null && card.delivered_at == null) {
        await this.store
          .markFileDelivered(stimulus.jobId, fileId)
          .catch((err) => this.logger.warn(`markFileDelivered (steer) failed: ${err}`));
      }
    }
    this.messageNotifier?.emitMessagesChanged(stimulus.repoId, stimulus.jobId);
  }

  private async markCardDeliveredForStimulus(id: string): Promise<boolean> {
    const stimulus = await this.stimulusStore.findChatStimulusById(id);
    if (!stimulus) return false;
    const { jobId, deliveredQuestionIds, deliveredSecretIds, deliveredFileIds } = stimulus;

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

  private async stampSeedCardSuccessTails(stimulusRowId: string): Promise<SeedCardStampResult> {
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

  private async stampCardTail(ids: string[], legacyFallback?: TurnEnvelope): Promise<void> {
    for (const id of ids) {
      const result = await this.stampSeedCardSuccessTails(id);
      if (result === 'missing' && legacyFallback) {
        await this.stampLegacySeedCard(legacyFallback);
      }
    }
  }

  private async markTerminallyDelivered(
    stimulus: TurnEnvelope,
    opts?: TurnDeliveryOpts,
  ): Promise<void> {
    const cardBearingIds = cardBearingIdsOf(stimulus);
    if (cardBearingIds.length) {
      await this.stampCardTail(cardBearingIds, stimulus.cardBearingIds ? undefined : stimulus);
      opts?.onRegistered?.();
      return;
    }
    opts?.onRegistered?.();
  }

  private async backfillSeedDelivery(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    body: string;
    seedRow: SeedRow;
    type: Extract<MessageType, 'answer_question' | 'secret_provided' | 'file_answered'>;
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


  async enqueueChat(stimulus: TurnEnvelope): Promise<void> {
    await this.pumpThread(
      stimulus.jobId,
      stimulus.orgId,
      stimulus.repoId,
      this.laneForStimulus(stimulus),
    );
  }

  private laneForStimulus(stimulus: { resumeThreadId?: string }): string {
    return stimulus.resumeThreadId ? `thread:${stimulus.resumeThreadId}` : 'main';
  }

  private activeTurnLane(turn: { lane?: string | null }): string {
    return turn.lane ?? 'main';
  }

  async pumpThread(jobId: string, orgId: string, repoId: string, lane = 'main'): Promise<void> {
    if (this.election.getState() === 'draining') return;

    if (await this.isJobBlocked(jobId)) {
      this.logger.log(`job=${jobId} is blocked; parking pending chat delivery`);
      return;
    }

    const deliveryLane = this.deliveryLane(jobId, orgId, repoId, lane);
    if (
      await trySteerLive(
        this.stimulusStore,
        deliveryLane,
        AgentSessionManager._CHAT_DELIVERY_LEASE_MS,
        this.logger,
      )
    ) {
      return;
    }

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

  private deliveryLane(jobId: string, orgId: string, repoId: string, lane: string): DeliveryLane {
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
        const won = new Set(
          await this.stimulusStore.claimChatStimuli(
            collected.ids,
            AgentSessionManager._CHAT_DELIVERY_LEASE_MS,
          ),
        );
        if (won.size === 0) return; // another caller claimed this batch — it will deliver them
        const claimed = collected.pending.filter((p) => won.has(p.id));
        const chunks = claimed.map((p) => this.pendingRowToChunk(p));
        const cardBearingIds = claimed.filter((p) => isSeedCardDelivery(p)).map((p) => p.id);
        const combined: TurnEnvelope = {
          ...claimed[0],
          body: claimed.map((p) => p.body).join('\n\n'),
          chunks,
          containsOperator: claimed.some((p) => isOperatorAuthored(p)),
          cardBearingIds,
        };
        await this.runChatTurn(combined, {
          coalesced: claimed,
          onRegistered: () => this.stampBatchOnRegistered(claimed),
        });
      },
    };
  }

  private async collectPendingForTurn(
    jobId: string,
    lane: string,
  ): Promise<CollectedPending | null> {
    const pending = await this.stimulusStore
      .eligiblePendingChat(jobId, AgentSessionManager._CHAT_DELIVERY_LEASE_MS, lane)
      .catch((err) => {
        this.logger.warn(`pump: eligiblePendingChat failed for thread=${jobId}: ${err}`);
        return [] as TurnEnvelope[];
      });
    if (pending.length === 0) return null;
    return {
      pending,
      userChunks: pending.map((p) => userChunkFor(p)),
      ids: pending.map((p) => p.id),
      wake: pending.some(isWakeEligible),
    };
  }

  private async deliverPendingViaFreshTurn(lane: DeliveryLane): Promise<void> {
    const collected = await this.collectPendingForTurn(lane.jobId, lane.lane);
    if (!collected) return;
    if (!collected.wake) return;

    const live = await lane.resolveLiveTurn().catch(() => null);
    if (live?.turn_id && lane.canSteer()) {
      const nowOnly = collected.pending.filter(isNowPriority);
      if (nowOnly.length)
        await steerPending(this.stimulusStore, lane, live.turn_id, nowOnly, this.logger);
      return;
    }

    const otherLive = await this.turnRegistry.runningBrainTurn(lane.jobId).catch(() => null);
    if (otherLive?.turn_id && this.activeTurnLane(otherLive) !== lane.lane) {
      return;
    }

    await lane.drainFreshTurn(collected);
  }

  private stampInputAck(e: EngineEvent): void {
    if (e.kind !== 'input_ack' || !e.id) return;
    void (async () => {
      await this.markCardDeliveredForStimulus(e.id);
      await this.stimulusStore.markChatDelivered(e.id);
    })().catch((err) =>
      this.logger.debug(`input_ack stamp for ${e.id} failed (sweep will retry): ${err}`),
    );
  }

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
      this.logger.debug(`chat delivery sweep query failed (will retry): ${err}`);
      return;
    }
    for (const t of lanes) {
      void this.pumpThread(t.jobId, t.orgId, t.repoId, t.lane).catch((err) =>
        this.logger.debug(`chat sweep pump failed for thread=${t.jobId}: ${err}`),
      );
    }
  }

  private async reconcileWorkOwedReviews(): Promise<void> {
    if (this.election.getState() !== 'leader') return;
    let running: PlanReviewRow[];
    try {
      running = await this.planReview.findRunningReviews();
    } catch (err) {
      this.logger.debug(`work-owed review sweep query failed (will retry): ${err}`);
      return;
    }
    for (const review of running) {
      void this.nudgeWorkOwedReview(review).catch((err) =>
        this.logger.warn(`work-owed review re-drive failed for job=${review.job_id}: ${err}`),
      );
    }
  }

  private async nudgeWorkOwedReview(review: PlanReviewRow): Promise<void> {
    const ageMs = Date.now() - new Date(review.updated_at).getTime();
    if (ageMs < PLAN_REVIEW_WEDGE_GRACE_MS) return; // in flight / reattach settling — not stranded yet
    const last = this.workOwedNudgedAt.get(review.job_id) ?? 0;
    if (Date.now() - last < WORK_OWED_RENUDGE_MS) return; // recently nudged — let the turn spin up

    const job = await this.store.loadJob(review.job_id).catch(() => null);
    if (!job) return;
    if (job.status === 'awaiting_approval' || job.status === 'running') return;
    const live = await this.turnRegistry.runningBrainTurn(review.job_id).catch(() => null);
    if (live?.turn_id) return; // a live turn owns the review
    const pendingChat = await this.stimulusStore
      .eligiblePendingChat(review.job_id, AgentSessionManager._CHAT_DELIVERY_LEASE_MS)
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

  grantSkillEditAccess(jobId: string, skillName: string): void {
    const set = this.skillEditGrantsByJob.get(jobId) ?? new Set<string>();
    set.add(skillName);
    this.skillEditGrantsByJob.set(jobId, set);
  }

  async drainInFlight(graceMs: number): Promise<boolean> {
    const tails = [...this.turnQueues.values()].map((p) => p.catch(() => undefined));
    if (tails.length === 0) return true;
    this.logger.log(`Drain: awaiting ${tails.length} in-flight turn(s) (grace ${graceMs}ms)`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), graceMs);
    });
    const done = Promise.all(tails).then(() => 'done' as const);
    const result = await Promise.race([done, timeout]);
    if (timer) clearTimeout(timer);
    return result === 'done';
  }

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

  private async reattachOwnedTurns(): Promise<void> {
    if (!this.engineRunner.reattach) {
      this.logger.warn('redis re-attach: the bound ENGINE_RUNNER has no reattach() — skipping');
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
    this.logger.log(`Leader: re-attaching ${owned.length} in-flight turn(s) over Redis`);
    const blocking: Promise<void>[] = [];
    for (const row of owned) {
      const { run, awaitCompletion } = handlers[row.kind];
      const p = run(row).catch((err) =>
        this.logger.warn(`re-attach turn ${row.turn_id} (${row.kind}) failed: ${err}`),
      );
      if (awaitCompletion) blocking.push(p);
      else void p;
    }
    await Promise.all(blocking);
  }

  async reattachTurnRow(row: ActiveTurnEntity): Promise<ReattachOutcome> {
    const handler = this.reattachHandlers()[row.kind];
    if (!handler) return 'deferred';
    if (!this.engineRunner.reattach) return 'deferred';
    if (this.engineRunner.isAttached?.(row.turn_id)) {
      return 'attached';
    }
    if (handler.awaitCompletion) {
      await handler.run(row);
    } else {
      void handler
        .run(row)
        .catch((err) =>
          this.logger.warn(`watchdog re-attach turn ${row.turn_id} (${row.kind}) failed: ${err}`),
        );
    }
    return 'attached';
  }

  private lost(result?: { claimed?: boolean }): boolean {
    return result?.claimed === false;
  }

  private async reattachOne(row: ActiveTurnEntity): Promise<void> {
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
        type?: MessageType;
        deliveredQuestionIds?: string[];
        deliveredSecretIds?: string[];
        deliveredFileIds?: string[];
        deliveryStimulusIds?: string[];
        resumeThreadId?: string;
        credentialId?: string;
      };
      if (!row.container_id || !ctx.repoId || !ctx.author || ctx.body === undefined) {
        this.logger.warn(
          `re-attach turn ${row.turn_id}: insufficient registry ctx — skipping (watchdog owns cleanup)`,
        );
        return;
      }
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
        ...(ctx.deliveredSecretIds?.length ? { deliveredSecretIds: ctx.deliveredSecretIds } : {}),
        ...(ctx.deliveredFileIds?.length ? { deliveredFileIds: ctx.deliveredFileIds } : {}),
        ...(ctx.resumeThreadId ? { resumeThreadId: ctx.resumeThreadId } : {}),
      };
      const reattachKind = (await this.store.loadJob(row.job_id).catch(() => null))?.kind ?? null;
      const repoSlug = await this.resolveRepoSlug(stimulus.repoId);
      const stageRole = await this.resolveStageKind(stimulus);
      const tools = this.buildTools(stimulus, reattachKind, repoSlug, stageRole);
      this.turnHarness.resetLane(row.channel, row.job_id);
      const threadId = stimulus.resumeThreadId ?? (await this.planningThreadId(row.job_id));
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
        const result = await this.engineRunner.reattach!(row.turn_id, row.container_id, {
          onEvent: (e) => {
            this.stampInputAck(e);
            streamer.onEvent(e);
          },
          toolBridge: { jobId: row.job_id, tools },
          ...(ctx.credentialId ? { credentialId: ctx.credentialId } : {}),
          liveRoute: {
            channel: row.channel,
            jobId: row.job_id,
            lane: 'main',
          },
        });
        if (result.sessionId && stimulus.resumeThreadId) {
          await this.driverStore
            .setThreadSessionId(stimulus.resumeThreadId, result.sessionId)
            .catch(() => undefined);
        } else if (result.sessionId && sandboxRow) {
          sandboxRow.session_id = result.sessionId;
          await this.sandboxRows.save(sandboxRow).catch(() => undefined);
        }
        if (this.lost(result)) {
          await streamer.discard();
          return;
        }
        await streamer.finish(
          result.result,
          result.usage
            ? {
                usage: result.usage,
                contextTokens: result.usage.contextTokens ?? null,
                contextLimit: resolveContextLimit(result.usage.contextModel ?? result.usage.model),
                credentialId: result.credentialId ?? null,
              }
            : undefined,
        );
        if (ctx.deliveryStimulusIds?.length) {
          for (const id of ctx.deliveryStimulusIds) {
            await this.stampSeedCardSuccessTails(id);
          }
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
        this.logger.log(`re-attached turn ${row.turn_id} completed + persisted`);
      } catch (err) {
        if (isEngineDetachedError(err)) {
          this.logger.warn(
            `re-attached turn ${row.turn_id} detached again — leaving it for the next boot re-attach`,
          );
          return;
        }
        this.logger.warn(`re-attached turn ${row.turn_id} ended in error: ${err}`);
        if (this.engineRunner.consumeClaim?.(row.turn_id) === false) {
          await streamer.discard();
        } else {
          await streamer.finish();
        }
      } finally {
        await this.store.endTurnActivity(row.job_id).catch(() => undefined);
      }
    } finally {
      if (this.engineRunner.tryClaimAttach) this.engineRunner.releaseAttach?.(row.turn_id);
    }
  }

  private async runChatTurn(stimulus: TurnEnvelope, opts?: TurnDeliveryOpts): Promise<void> {
    await this.store.setActivity(stimulus.jobId, 'turn').catch(() => undefined);
    await this.store.setHalted(stimulus.jobId, false).catch(() => undefined);
    try {
      await this.runChatTurnInner(stimulus, opts);
    } finally {
      await this.latchDirectBuildAtTurnEnd(stimulus);
      await this.store.endTurnActivity(stimulus.jobId).catch(() => undefined);
      void this.pumpThread(
        stimulus.jobId,
        stimulus.orgId,
        stimulus.repoId,
        this.laneForStimulus(stimulus),
      ).catch((err) => this.logger.debug(`turn-end re-pump failed (sweep will retry): ${err}`));
      void this.autoMerge.maybeAutoMerge(stimulus.jobId).catch(() => undefined);
    }
  }

  private async latchDirectBuildAtTurnEnd(stimulus: TurnEnvelope): Promise<void> {
    if (!this.directBuildShipPending.delete(stimulus.jobId)) return;
    const job = await this.store.loadJob(stimulus.jobId).catch(() => null);
    if (!job || job.status !== 'running' || !job.featureBranch) return;
    const sandbox = await this.lifecycle.findSandbox(job.id, job.orgId).catch(() => null);
    const repo = sandbox ? await this.repos.resolve(job).catch(() => null) : null;
    if (!sandbox || !repo) return;
    const liveSandbox = {
      ...sandbox,
      branch: job.currentBranch ?? sandbox.branch,
    };
    await this.ship.latchPr(job, repo, liveSandbox).catch(() => undefined);
  }

  private async resolveStageKind(stimulus: TurnEnvelope): Promise<ThreadRole> {
    const stageRole = stimulus.resumeThreadId
      ? await this.driverStore.threadRole(stimulus.resumeThreadId).catch(() => null)
      : null;
    return stageRole ?? 'planning';
  }

  private async resolvePromptAgent(stimulus: TurnEnvelope): Promise<Agent> {
    return threadKindSpec(await this.resolveStageKind(stimulus)).agent;
  }

  private async runChatTurnInner(stimulus: TurnEnvelope, opts?: TurnDeliveryOpts): Promise<void> {
    const resetKey = `${stimulus.orgId}:${stimulus.jobId}`;
    await this.clearPendingHostRetry(stimulus.jobId);
    if (turnHasOperatorInput(stimulus)) {
      this.consecutiveResets.delete(resetKey);
      this.pendingHardReset.delete(resetKey);
    }
    if (stimulus.message.type === 'reset_verify' && !this.pendingResetVerify.has(resetKey)) return;

    if (await this.isJobBlocked(stimulus.jobId)) return;



    const alreadyProvisioned = await this.lifecycle.findSandbox(stimulus.jobId, stimulus.orgId);
    if (!alreadyProvisioned) {
      await this.store
        .appendSystemEvent(
          stimulus.jobId,
          'Setting up an isolated workspace for this thread — one moment…',
        )
        .catch((err) => this.logger.debug(`appendSystemEvent failed: ${err}`));
    }
    const onMilestone = this.sandboxMilestoneNotifier(stimulus);
    try {
      const provisioned = await this.lifecycle.ensureProvisioned(
        stimulus.jobId,
        stimulus.orgId,
        onMilestone,
      );
      if (!provisioned) {
        await this.say(stimulus, 'This thread is closed — start a new one to keep working.');
        await this.markTerminallyDelivered(stimulus, opts);
        return;
      }
    } catch (err) {
      if (err instanceof ProvisioningNotReadyError) {
        await this.say(stimulus, err.message);
        await this.markTerminallyDelivered(stimulus, opts);
      } else {
        this.logger.error(`provisioning failed for thread=${stimulus.jobId}: ${err}`);
        await this.say(
          stimulus,
          `I couldn't set up a workspace for this thread. (${String(err).slice(0, 200)})`,
        );
      }
      return;
    }

    let ensured: Awaited<ReturnType<JobLifecycleService['ensureContainer']>>;
    try {
      ensured = await this.lifecycle.ensureContainer(stimulus.jobId, stimulus.orgId, onMilestone);
    } catch (err) {
      this.logger.error(`container attach failed for thread=${stimulus.jobId}: ${err}`);
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

    const sandboxRow = await this.sandboxRows.findOne({
      where: { job_id: stimulus.jobId, org_id: stimulus.orgId },
    });
    const sessionId = stimulus.resumeThreadId
      ? ((await this.driverStore.threadSessionId(stimulus.resumeThreadId)) ?? undefined)
      : (sandboxRow?.session_id ?? undefined);

    if (stimulus.message.type === 'compaction') {
      await this.runCompaction(stimulus, sandbox, sandboxRow ?? null, sessionId);
      return;
    }

    const noticeChunks: TurnChunk[] = [];
    const reminderChunks: TurnChunk[] = [];

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
        await this.store
          .appendSystemEvent(
            stimulus.jobId,
            '🟢 Sandbox is back up on a fresh container — verifying the environment cold-booted from durable config.',
          )
          .catch((err) => this.logger.debug(`appendSystemEvent failed: ${err}`));
      }
    }

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

    const stageRole = await this.resolveStageKind(stimulus);

    if (turnHasOperatorInput(stimulus) && stageRole === 'planning') {
      const awarenessPrefix = await this.buildAwarenessPrefix(stimulus.jobId, stimulus.orgId);
      if (awarenessPrefix) {
        reminderChunks.push({
          kind: 'system_reminder',
          body: awarenessPrefix,
          attrs: { reminderKind: 'awareness' },
        });
      }
    }

    if (stageRole === 'planning') {
      const openQuestionsPrefix = await this.buildOpenQuestionsPrefix(stimulus.jobId);
      if (openQuestionsPrefix) {
        reminderChunks.push({
          kind: 'system_reminder',
          body: openQuestionsPrefix,
          attrs: { reminderKind: 'open_questions' },
        });
      }
    }

    const openFilesPrefix = await this.buildOpenFileRequestsPrefix(stimulus.jobId);
    if (openFilesPrefix) {
      reminderChunks.push({
        kind: 'system_reminder',
        body: openFilesPrefix,
        attrs: { reminderKind: 'open_file_requests' },
      });
    }

    const openSecretsPrefix = await this.buildOpenSecretRequestsPrefix(stimulus.jobId);
    if (openSecretsPrefix) {
      reminderChunks.push({
        kind: 'system_reminder',
        body: openSecretsPrefix,
        attrs: { reminderKind: 'open_secret_requests' },
      });
    }

    const amendingPrefix =
      stageRole === 'post_build' ? await this.buildAmendingPrefix(stimulus.jobId) : null;
    if (amendingPrefix) {
      reminderChunks.push({
        kind: 'system_reminder',
        body: amendingPrefix,
        attrs: { reminderKind: 'amending' },
      });
    }

    if (turnHasOperatorInput(stimulus) && this.jit?.hasEnabledOperatorPrepends()) {
      const prependText = (await this.buildMemoryRecallPrefix(stimulus, sessionId)) ?? undefined;
      reminderChunks.push(
        ...(this.jit?.collectOperatorPrepends({
          jobId: stimulus.jobId,
          ...(prependText ? { prependText } : {}),
        }) ?? []),
      );
    }

    let task: AgentMessage;
    const prefixChunks = [...noticeChunks, ...reminderChunks];
    if (stimulus.chunks?.length) {
      task = composeTurn({ prefixChunks, userChunks: stimulus.chunks });
    } else if (turnHasOperatorInput(stimulus)) {
      task = composeTurn({
        prefixChunks,
        userChunks: [userChunkFor(stimulus)],
      });
    } else {
      task = composeSeedTurn(prefixChunks, fromExternal(this.engineBody(stimulus)));
    }

    const compactionSeed = sandboxRow?.pending_compaction_seed ?? null;
    const hadCompactionSeed = !!compactionSeed;
    if (compactionSeed) {
      task = foldCompactionSeed(fromExternal(compactionSeed), task);
    }

    const brainJob = await this.store.loadJob(stimulus.jobId).catch(() => null);
    if (brainJob?.status === 'blocked') return;

    const repoSlug = await this.resolveRepoSlug(stimulus.repoId);
    const tools = this.buildTools(stimulus, brainJob?.kind ?? null, repoSlug, stageRole);

    const runner: EngineRunnerPort = this.engineRunner;

    const route = await this.store.route({
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      jobId: stimulus.jobId,
    });
    const channel = route.channel ?? stimulus.replyRoute.jobRef;
    const threadId = stimulus.resumeThreadId ?? (await this.planningThreadId(stimulus.jobId));
    const streamer = this.turnHarness.create({
      jobId: stimulus.jobId,
      orgId: stimulus.orgId,
      threadId,
      channel,
      livePush: !this.engineRunner.pushesLiveRouteEvents,
    });
    let promptEmitted = false;

    const branchCommandById = new Map<string, string>();
    let lastObservedBranch: string | null = null;

    const sandboxKey: EngineHomeKey = {
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      jobId: stimulus.jobId,
      type: 'brain',
    };
    const auth = await this.creds.engineAuth(stimulus.orgId, 'claude');
    const userMcpServers = await this.mcp.resolveForTurn(stimulus.orgId, stimulus.repoId, 'brain');
    const repoConventions =
      (await this.conventions?.resolveForRepo(stimulus.orgId, stimulus.repoId)) ?? null;
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
    const skills =
      (await this.skills?.resolveForTurn(stimulus.orgId, stimulus.repoId, 'brain')) ?? [];
    const grantedSkills = this.skillEditGrantsByJob.get(stimulus.jobId);
    const gitAuth = await this.resolveBrainGitAuth(stimulus.jobId);
    const gitTarget = this.gitTargetByJob.get(stimulus.jobId);
    const branch = brainJob?.featureBranch ?? brainJob?.currentBranch ?? undefined;
    const baseBranch = brainJob?.baseBranch ?? gitTarget?.defaultBranch ?? undefined;
    const jobContext = {
      ...(gitTarget ? { repoName: `${gitTarget.owner}/${gitTarget.repo}` } : {}),
      ...(brainJob?.title ? { title: brainJob.title } : {}),
      ...(branch ? { branch } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      ...(this.env && isAtlasRepo(repoSlug ?? '', this.env) ? { isAtlasRepo: true } : {}),
    };
    const promptAgent = threadKindSpec(stageRole).agent;

    const runArgs: RunEngineArgs = {
      engine: 'claude',
      task,
      cwd: sandbox.worktreePath,
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
      turnMeta: {
        jobId: stimulus.jobId,
        orgId: stimulus.orgId,
        channel,
        lane: this.laneForStimulus(stimulus),
        kind: 'brain',
        ctx: {
          repoId: stimulus.repoId,
          sandboxKey,
          author: stimulus.author,
          body: stimulus.body,
          type: stimulus.message.type,
          ...(stimulus.deliveredQuestionIds?.length
            ? { deliveredQuestionIds: stimulus.deliveredQuestionIds }
            : {}),
          ...(stimulus.deliveredFileIds?.length
            ? { deliveredFileIds: stimulus.deliveredFileIds }
            : {}),
          ...(stimulus.deliveredSecretIds?.length
            ? { deliveredSecretIds: stimulus.deliveredSecretIds }
            : {}),
          ...(cardBearingIdsOf(stimulus).length
            ? { deliveryStimulusIds: cardBearingIdsOf(stimulus) }
            : {}),
          ...(stimulus.resumeThreadId ? { resumeThreadId: stimulus.resumeThreadId } : {}),
        },
      },
      ...(opts?.onRegistered ? { onTurnRegistered: opts.onRegistered } : {}),
      liveRoute: { channel, jobId: stimulus.jobId, lane: 'main' },
      onEvent: (e) => {
        if (e.kind === 'session' && e.sessionId) {
          this.bindInjectedMemorySession(stimulus.jobId, e.sessionId);
        }
        if (e.kind === 'session' && !promptEmitted) {
          promptEmitted = true;
          void streamer.emitPrompt(task, `brain:${stimulus.id}`);
          this.persistChunkRows(stimulus, noticeChunks, reminderChunks);
        }
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
                    ? {
                        pending_compaction_seed: null,
                        compacting_session_id: null,
                      }
                    : {}),
                },
              ),
            ).catch((err) =>
              this.logger.warn(
                `eager session_id persist failed for thread=${stimulus.jobId}: ${err}`,
              ),
            );
          } catch (err) {
            this.logger.warn(`eager session_id persist threw for thread=${stimulus.jobId}: ${err}`);
          }
        }
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
              this.logger.warn(`live-branch sample failed for thread=${stimulus.jobId}: ${err}`),
            );
        }
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
        const members = opts?.coalesced?.length ? opts.coalesced : [stimulus];
        let steered = false;
        for (const m of members) {
          if (await this.steerIntoLiveBrainTurn(m)) steered = true;
        }
        if (!steered) {
          this.logger.warn(
            `single-brain-turn guard hit but no live turn to steer for job=${stimulus.jobId} — leaving for re-drive`,
          );
        }
        return;
      }
      if (isEngineDetachedError(err)) {
        this.logger.warn(
          `turn detached mid-flight for thread=${stimulus.jobId} — awaiting boot re-attach: ${err}`,
        );
        return;
      }
      this.logger.error(`in-sandbox turn failed for thread=${stimulus.jobId}: ${err}`);
      const benignAbort = this.isBenignStreamAbort(err);
      if (this.engineRunner.consumeClaim?.(stimulus.id) === false) {
        await streamer.discard();
      } else {
        await streamer.finish();
      }
      if (isUnresumableSessionMessage(String(err))) {
        const { category, summary } = summarizeTurnFailure(err);
        await this.saySystemOperator(
          stimulus,
          `${String(err)}\n\nThis thread can't continue — its engine session state is gone. Please start a new thread to pick this back up.`,
          { category, summary },
        );
      } else if (benignAbort) {
        const { ok, used: n } = await this.store.claimBenignAbortRedrive(
          stimulus.jobId,
          AgentSessionManager.MAX_BENIGN_ABORT_REDRIVES,
        );
        if (ok) {
          this.logger.warn(
            `benign aborted_streaming for thread=${stimulus.jobId} — auto-resuming (attempt ${n}/${AgentSessionManager.MAX_BENIGN_ABORT_REDRIVES}), no operator box: ${err}`,
          );
          const title = await this.store.jobTitle(stimulus.jobId).catch(() => null);
          const nudge = interruptRedriveNudge(title ?? undefined);
          this.surface.seedSystemNotification?.(stimulus.repoId, stimulus.jobId, nudge, {
            orgId: stimulus.orgId,
            seedRow: 'skip',
          });
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
    if (!result.sessionLimit) {
      await this.store.clearBrainRetryCounters(stimulus.jobId);
    }
    await this.clearPendingHostRetry(stimulus.jobId);

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
        this.logger.warn(`live-branch backstop failed for thread=${stimulus.jobId}: ${err}`),
      );

    if (result.sessionId && stimulus.resumeThreadId) {
      this.bindInjectedMemorySession(stimulus.jobId, result.sessionId);
      await this.driverStore.setThreadSessionId(stimulus.resumeThreadId, result.sessionId);
    } else if (result.sessionId && sandboxRow) {
      this.bindInjectedMemorySession(stimulus.jobId, result.sessionId);
      sandboxRow.session_id = result.sessionId;
      await this.sandboxRows.save(sandboxRow);
    }

    if (result.sessionLimit) {
      if (this.lost(result)) {
        await streamer.discard();
        return;
      }
      const rlType = result.sessionLimit.rateLimitType;
      const source = result.sessionLimit.source;
      const util =
        source === 'text'
          ? await this.usage.getUtilization(stimulus.orgId, rlType).catch(() => undefined)
          : undefined;

      const durablePark = async (): Promise<void> => {
        const resumeAt =
          result.sessionLimit?.resetAt ?? (await this.usage.getResetAt(stimulus.orgId, rlType));
        const resumeClock = resumeAt ?? defaultResumeAt();
        void this.usage
          .applyHarvest(stimulus.orgId, {
            status: 'rejected',
            rateLimitType: rlType,
            resetsAt: new Date(resumeClock).getTime(),
            utilization: 100,
            credentialId: auth?.refreshBack?.credentialId,
          })
          .catch(() => undefined);
        const resetSource: 'usage_api' | 'parsed_string' = rlType ? 'usage_api' : 'parsed_string';
        const reason = `Claude session limit${rlType ? ` (${rlType})` : ''}${resumeAt ? `; resets ${resumeAt}` : ''}`;
        await this.store
          .setSessionResume(stimulus.jobId, resumeClock, {
            lane: 'main',
            reason,
            resetSource,
          })
          .catch((err) => this.logger.warn(`setSessionResume failed: ${err}`));
        await streamer.finish(
          undefined,
          result.usage
            ? {
                usage: result.usage,
                contextTokens: result.usage.contextTokens ?? null,
                contextLimit: resolveContextLimit(result.usage.contextModel ?? result.usage.model),
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
            summary: "You've hit your Claude session limit — it auto-resumes at reset.",
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
          await this.scheduleHostRetry(stimulus, 'unconfirmed session limit (text fallback)');
        }
      }
      return;
    }

    if (this.lost(result)) {
      await streamer.discard();
      return;
    }
    await streamer.finish(
      result.result,
      result.usage
        ? {
            usage: result.usage,
            contextTokens: result.usage.contextTokens ?? null,
            contextLimit: resolveContextLimit(result.usage.contextModel ?? result.usage.model),
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

    const cardBearingIds = cardBearingIdsOf(stimulus);
    if (cardBearingIds.length) {
      await this.stampCardTail(cardBearingIds, stimulus.cardBearingIds ? undefined : stimulus);
    }

    await this.maybeHonorSandboxReset(stimulus);
  }

  private async maybeHonorSandboxReset(stimulus: TurnEnvelope): Promise<void> {
    const key = `${stimulus.orgId}:${stimulus.jobId}`;
    const req = this.resetRequests.get(key);
    if (!req) return;
    this.resetRequests.delete(key);
    this.logger.log(
      `reset_sandbox: honoring ${req.hard ? 'HARD ' : ''}reset for thread=${stimulus.jobId} (reason: ${req.reason}) — tearing down`,
    );

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
    this.logger.log(
      `reset_sandbox: container torn down for thread=${stimulus.jobId} — kicking verify continuation`,
    );

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

  private async resolveRepoSlug(repoId: string): Promise<string | null> {
    if (!this.repoRows) return null;
    if (this.repoSlugCache.has(repoId)) return this.repoSlugCache.get(repoId) ?? null;
    const row = await this.repoRows.findOne({ where: { id: repoId } }).catch(() => null);
    const slug = row?.slug ?? null;
    this.repoSlugCache.set(repoId, slug);
    return slug;
  }


  buildTools(
    stimulus: TurnEnvelope,
    kind: string | null = null,
    repoSlug: string | null = null,
    role: ThreadRole | null = null,
  ): Record<string, ToolImpl> {
    const onboarding = kind === 'onboarding';
    const review = kind === 'review';
    const postBuild = role === 'post_build';
    const ci = role === 'ci';
    const taskTools = makeTaskTools(this.taskSink, {
      kind: 'main',
      id: stimulus.jobId,
    });
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

      const explicitQuestionId =
        typeof args['questionId'] === 'string' ? args['questionId'].trim() || undefined : undefined;
      const answered = await this.resolveAnsweredCard(stimulus, explicitQuestionId);
      const answeredId = answered?.id;
      const answeredCard = answered?.card;
      const hasAnswer = answeredCard?.answer != null;
      const confirmedByOperator = args['confirmedByOperator'] === true && hasAnswer;
      const title =
        String(args['title'] ?? '').trim() ||
        deriveDecisionTitle(hasAnswer ? answeredCard.question : ruling);
      const { decision, all } = await this.store.createDecision(stimulus.jobId, {
        decisionClass,
        title,
        ruling,
        confirmedByOperator,
        ...(hasAnswer && answeredCard.question ? { question: answeredCard.question } : {}),
        ...(hasAnswer ? { answer: answeredCard.answer } : {}),
      });
      if (answeredId && hasAnswer) {
        await this.store.updateCardMessage(stimulus.jobId, answeredId, {
          loggedDecision: true,
        });
      }
      await this.writeDecisionRecordMd(stimulus.jobId, stimulus.orgId, all);
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

    let directBuildVerified = false;
    let directBuildVerification: VerificationEvidence[] = [];

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
      report_verification: async (args) => {
        const passed = args['passed'] === true;
        directBuildVerified = passed;
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
                  outputTail: clampEvidenceOutput(args['verification'].trim()),
                },
              ]
            : [];
        if (passed) {
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
              job.orgId,
              job.decisionRecordId ?? null,
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
        return this.driverStore.getPipelineState(stimulus.jobId, stimulus.orgId);
      },

      get_decision_record: async (_args) => {
        const record = await this.driverStore.getDecisionRecord(stimulus.jobId);
        if (record) return record;
        const pending = await this.store.pendingDecisions(stimulus.jobId);
        return { status: 'drafting', decisions: pending };
      },

      recall: this.selfSufficiencyTools(stimulus).recall,

      remember: this.selfSufficiencyTools(stimulus).remember,

      forget: this.selfSufficiencyTools(stimulus).forget,

      update_memory: this.selfSufficiencyTools(stimulus).update_memory,

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
        const patch: Partial<
          Pick<Decision, 'ruling' | 'title' | 'decisionClass' | 'confirmedByOperator'>
        > = {};
        if (args['confirmedByOperator'] !== undefined) {
          const wantsConfirm = args['confirmedByOperator'] === true;
          if (wantsConfirm) {
            const explicitQuestionId =
              typeof args['questionId'] === 'string'
                ? args['questionId'].trim() || undefined
                : undefined;
            const answered = await this.resolveAnsweredCard(stimulus, explicitQuestionId);
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

        const result = await this.store.updateDecision(stimulus.jobId, id, patch);
        if (!result) {
          const pending = await this.store.pendingDecisions(stimulus.jobId);
          return {
            ok: false,
            reason: `no decision with id "${id}"`,
            knownIds: pending.map((d) => d.id),
          };
        }
        await this.writeDecisionRecordMd(stimulus.jobId, stimulus.orgId, result.all);
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
        const { removed, all } = await this.store.deleteDecision(stimulus.jobId, id);
        if (!removed) {
          return {
            ok: false,
            reason: `no decision with id "${id}"`,
            knownIds: all.map((d) => d.id),
          };
        }
        await this.writeDecisionRecordMd(stimulus.jobId, stimulus.orgId, all);
        return { ok: true, removed: id, remainingIds: all.map((d) => d.id) };
      },

      review_plan: async (args) => {
        const overview = String(args['overview'] ?? '').trim();
        const goal = String(args['goal'] ?? '').trim();
        const note = String(args['note'] ?? '').trim();
        const decisions =
          args['decisions'] != null
            ? normalizeDecisions(args['decisions'])
            : await this.store.pendingDecisions(stimulus.jobId);
        const threads = normalizeThreads(args['threads']);
        const hasSteps = threads.some((s) => s.steps.length > 0);

        const jobId = await this.ensureJob(stimulus, overview || goal, 'feature');
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

        const overview = String(args['overview'] ?? '').trim();
        const goal = String(args['goal'] ?? '').trim();
        const kind: JobKind =
          (await this.store.jobKind(stimulus.jobId)) ??
          (args['kind'] === 'bugfix' ? 'bugfix' : 'feature');
        const rename = args['rename'] === true;
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

        const reviewed = await this.planReview.reviewForCurrentSpecs(jobId, stimulus.orgId);
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

        const prep = await this.prepareRepropose(stimulus.jobId);
        if (prep.refuse) return { ok: false, reason: prep.refuse };

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
        if (job.buildPath === 'direct') {
          if (!(await this.store.buildNotStarted(job.id))) {
            return {
              ok: true,
              jobId: job.id,
              message: 'Build already started.',
            };
          }
          await this.store.markDirectBuildStarted(job.id);
          void this.runDirectBuild(stimulus, job);
        } else {
          await this.dispatcher.dispatch(job);
        }
        void this.enqueueCompaction(stimulus);
        return { ok: true, jobId: job.id, message: 'Build started.' };
      },

      hold_build: async (args) => {
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
            reason:
              'The build has already started — too late to hold. Use the normal build controls.',
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

      start_direct_build: async (args) => {
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
        const kind: JobKind =
          (await this.store.jobKind(stimulus.jobId)) ??
          (args['kind'] === 'bugfix' ? 'bugfix' : 'feature');
        const decisions =
          args['decisions'] != null
            ? normalizeDecisions(args['decisions'])
            : await this.store.pendingDecisions(stimulus.jobId);

        const classification = await this.classifier.classify(
          {
            description: summary,
            ...(changeOutline.length ? { context: changeOutline.join('\n') } : {}),
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

        const prep = await this.prepareRepropose(stimulus.jobId);
        if (prep.refuse) return { ok: false, reason: prep.refuse };

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
          return {
            ok: false,
            reason:
              'Not yet verified — run mcp__atlas-lsp-ts__diagnostics on the files you changed and the ' +
              "repo's own typecheck, fix anything they find, then call report_verification({ passed: true }) " +
              'before calling finalize_build again.',
          };
        }
        const sandbox = await this.lifecycle.findSandbox(stimulus.jobId, stimulus.orgId);
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
        await this.store
          .recordDirectBuildVerification(jobId, {
            verdict: effective,
            at: new Date().toISOString(),
          })
          .catch((err) => this.logger.debug(`recordDirectBuildVerification failed: ${err}`));
        if (effective.runtimeSurfaceTouched && !effective.liveVerificationAdequate) {
          let detail = [effective.reason, effective.missingChecks].filter(Boolean).join(' — ');
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

        const pre = await this.ship.preShip(job, repo, sandbox, (m) => this.say(stimulus, m));

        if (!pre.ok) {
          if (pre.reason === 'leak-scan') {
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
        const title = String(args['title'] ?? '').trim() || jobTitle(firstMessage);
        if (!firstMessage) {
          return {
            ok: false,
            reason: "firstMessage is required (the new thread's opening intent)",
          };
        }

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

        const current = await this.store.loadJob(stimulus.jobId);
        const autoMode = (args['autoMode'] as CreateJobAutoMode | undefined) ?? {};
        const newJobId = await this.store.createFollowUpJob({
          orgId: stimulus.orgId,
          repoId: stimulus.repoId,
          title,
          baseBranch: current.baseBranch,
          createdByJobId: stimulus.jobId,
          createdByTitle: current.title,
          autoMode,
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

        void this.startFollowUpJob(newJobId, stimulus.orgId, stimulus.repoId, firstMessage).catch(
          (err) => this.logger.warn(`create_job: start of ${newJobId} failed: ${err}`),
        );
        this.logger.log(`thread ${stimulus.jobId} created + started follow-up ${newJobId}`);
        return {
          ok: true,
          jobId: newJobId,
          blocked: false,
          message: `Created follow-up "${title}" and started it.`,
        };
      },

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

      propose_convention_profile_change: this.buildProposeConventionProfileChangeTool(stimulus),
    };

    const intake = {
      request_secret: this.selfSufficiencyTools(stimulus).request_secret,
      request_file: this.selfSufficiencyTools(stimulus).request_file,
      withdraw_file_request: this.buildWithdrawFileRequestTool(stimulus),
      withdraw_secret_request: this.buildWithdrawSecretRequestTool(stimulus),
      write_workspace_config: this.buildWriteWorkspaceConfigTool(stimulus),
      write_setup_script: this.buildWriteSetupScriptTool(stimulus),
      read_setup_script: this.buildReadSetupScriptTool(stimulus),
      write_preview_instructions: this.buildWritePreviewInstructionsTool(stimulus),
      read_preview_instructions: this.buildReadPreviewInstructionsTool(stimulus),
      derive_secret: this.buildDeriveSecretTool(stimulus),
      reset_sandbox: this.buildResetSandboxTool(stimulus),
      list_skills: this.buildListSkillsTool(stimulus),
      propose_skill: this.buildProposeSkillTool(stimulus),
      propose_skill_install: this.buildProposeSkillInstallTool(stimulus),
      request_skill_edit_access: this.buildRequestSkillEditAccessTool(stimulus),
      propose_skill_removal: this.buildProposeSkillRemovalTool(stimulus),
      list_mcp_servers: this.buildListMcpServersTool(stimulus),
      propose_mcp_servers: this.buildProposeMcpServersTool(stimulus),
      propose_mcp_removal: this.buildProposeMcpRemovalTool(stimulus),
    };

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
            propose_prod_write: (a) =>
              this.prodDiagnostics!.proposeWrite(stimulus, String(a['sql'] ?? '')),
          }
        : {};

    if (review) {
      return {
        [INTERNAL_PROFILE_AWARENESS_TOOL]: tools[INTERNAL_PROFILE_AWARENESS_TOOL],
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
    if (postBuild || ci) {
      const base = {
        [INTERNAL_PROFILE_AWARENESS_TOOL]: tools[INTERNAL_PROFILE_AWARENESS_TOOL],
        get_pipeline_state: tools.get_pipeline_state,
        recall: tools.recall,
        remember: tools.remember,
        report_verification: tools.report_verification,
        create_job: tools.create_job,
        list_jobs: tools.list_jobs,
        link_job_dependency: tools.link_job_dependency,
        ...intake,
        ...atlasProd,
      };
      return postBuild ? { ...base, withdraw_ship: tools.withdraw_ship } : base;
    }
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
      list_convention_profiles: this.buildListConventionProfilesTool(stimulus),
      propose_convention_profile: this.buildProposeConventionProfileTool(stimulus),
      propose_convention_profile_change: this.buildProposeConventionProfileChangeTool(stimulus),
      finish_onboarding: this.buildFinishOnboardingTool(stimulus),
      ...taskTools,
      ...atlasProd,
    };
  }


  private selfSufficiencyTools(stimulus: TurnEnvelope) {
    return this.selfSufficiency.buildTools({
      jobId: stimulus.jobId,
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      authorId: stimulus.author.id,
      defaultQuery: stimulus.body,
    });
  }

  private buildWithdrawFileRequestTool(stimulus: TurnEnvelope): ToolImpl {
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

  private buildWithdrawSecretRequestTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const requestId = String(args['requestId'] ?? '').trim();
      if (!requestId) return { ok: false, reason: 'requestId is required' };
      const reason = String(args['reason'] ?? '').trim();
      const res = await this.store.withdrawSecretRequest(
        stimulus.jobId,
        requestId,
        reason || undefined,
      );
      if (!res.withdrawn) {
        return {
          ok: false,
          reason:
            'That secret request could not be withdrawn — it was already provided, already withdrawn, or not ' +
            'found. If the operator already provided it, work from that secret instead of re-requesting.',
        };
      }
      return {
        ok: true,
        requestId,
        message:
          'Secret request withdrawn — the operator no longer sees it as awaiting a value. Post a corrected ' +
          'request_secret if you still need one.',
      };
    };
  }

  private buildDeriveSecretTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const name = String(args['name'] ?? '').trim();
      const path = String(args['path'] ?? '').trim();
      const value = String(args['value'] ?? '');
      const description = String(args['description'] ?? '').trim();
      const overwrite = args['overwrite'] === true;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return {
          ok: false,
          reason: 'name must be an env-var-style identifier (e.g. STRIPE_WEBHOOK_SECRET)',
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
          reason: 'description is required (what this value is and how you derived it)',
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
      await this.secretStore.write(stimulus.orgId, stimulus.repoId, path, value, name);
      await this.store.appendSystemEvent(
        stimulus.jobId,
        `🔑 Derived and stored \`${name}\` (${description}) — future jobs on this repo won't need to re-derive it.`,
      );
      return { ok: true, name, path, overwritten: existing != null };
    };
  }

  private buildWriteWorkspaceConfigTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      if (args['secrets'] !== undefined) {
        return {
          ok: false,
          reason: 'secrets do not go in workspace config — use request_secret instead',
        };
      }
      const { mounts: newMounts, warnings } = normalizeMounts(args['mounts']);

      try {
        const priorMountSig = (await this.configStore.listMounts(stimulus.orgId, stimulus.repoId))
          .map((m) => `${m.path}:${m.mode}`)
          .sort()
          .join(',');
        for (const m of newMounts) {
          await this.configStore.upsertMount(stimulus.orgId, stimulus.repoId, m.path, m.mode);
        }

        const mounts = await this.configStore.listMounts(stimulus.orgId, stimulus.repoId);
        const mountSetChanged =
          mounts
            .map((m) => `${m.path}:${m.mode}`)
            .sort()
            .join(',') !== priorMountSig;
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
        this.logger.warn(
          `write_workspace_config failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  private buildWriteSetupScriptTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const script = String(args['script'] ?? '').trim() ? String(args['script']) : null;
      try {
        await this.configStore.setSetupScript(stimulus.orgId, stimulus.repoId, script);
        if (script) {
          const sandbox = await this.lifecycle.findSandbox(stimulus.jobId, stimulus.orgId);
          if (sandbox)
            await this.refreshSeenManifests(stimulus.orgId, stimulus.repoId, sandbox.worktreePath);
        }
        await this.store.appendSystemEvent(
          stimulus.jobId,
          script
            ? '⚙️ Saved the repo setup script — it runs on every COLD sandbox bring-up for every job on this repo. Call `reset_sandbox` to test it cold.'
            : '⚙️ Cleared the repo setup script — no cold-boot setup step will run.',
        );
        return { ok: true, saved: !!script };
      } catch (err) {
        this.logger.warn(
          `write_setup_script failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  private buildReadSetupScriptTool(stimulus: TurnEnvelope): ToolImpl {
    return async () => {
      try {
        const script = await this.configStore.getSetupScript(stimulus.orgId, stimulus.repoId);
        return { ok: true, present: script !== null, script };
      } catch (err) {
        this.logger.warn(
          `read_setup_script failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  private buildWritePreviewInstructionsTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const instructions = String(args['instructions'] ?? '').trim()
        ? String(args['instructions'])
        : null;
      try {
        await this.configStore.setPreviewInstructions(
          stimulus.orgId,
          stimulus.repoId,
          instructions,
        );
        await this.store.appendSystemEvent(
          stimulus.jobId,
          instructions
            ? '🎬 Saved the repo preview recipe — it is injected into the "Spin up preview" seed for every job on this repo. `read_preview_instructions` to amend (write REPLACES the whole recipe).'
            : '🎬 Cleared the repo preview recipe — the Spin-up-preview seed will prompt to save a fresh one.',
        );
        return { ok: true, saved: !!instructions };
      } catch (err) {
        this.logger.warn(
          `write_preview_instructions failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  private buildReadPreviewInstructionsTool(stimulus: TurnEnvelope): ToolImpl {
    return async () => {
      try {
        const instructions = await this.configStore.getPreviewInstructions(
          stimulus.orgId,
          stimulus.repoId,
        );
        return { ok: true, present: instructions !== null, instructions };
      } catch (err) {
        this.logger.warn(
          `read_preview_instructions failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  private async refreshSeenManifests(
    orgId: string,
    repoId: string,
    worktreePath: string,
  ): Promise<void> {
    try {
      await this.configStore.setSeenManifests(orgId, repoId, detectRepoManifests(worktreePath));
    } catch (err) {
      this.logger.warn(`refreshSeenManifests failed for org=${orgId} repo=${repoId}: ${err}`);
    }
  }

  private buildProposeMcpServersTool(stimulus: TurnEnvelope): ToolImpl {
    const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
    const VALID_SURFACES = new Set<McpSurface>(['brain', 'build', 'review']);
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
      const raw = Array.isArray(args['servers']) ? (args['servers'] as unknown[]) : null;
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
          return {
            ok: false,
            reason: `server "${name}": transport must be http | sse | stdio`,
          };
        }
        const url = String(s['url'] ?? '').trim() || undefined;
        const command = String(s['command'] ?? '').trim() || undefined;
        if (transport === 'stdio') {
          if (!command)
            return {
              ok: false,
              reason: `server "${name}": stdio transport requires a command`,
            };
        } else if (!url) {
          return {
            ok: false,
            reason: `server "${name}": ${transport} transport requires a url`,
          };
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
        const authKind: McpAuthKind = s['authKind'] === 'oauth' ? 'oauth' : 'static';
        if (authKind === 'oauth') {
          if (transport === 'stdio') {
            return {
              ok: false,
              reason: `server "${name}": oauth is only supported for http/sse transports`,
            };
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
            ? {
                ...(oauthScope ? { scope: oauthScope } : {}),
                ...(oauthTam ? { tokenAuthMethod: oauthTam } : {}),
              }
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
      const scope: 'org' | 'repo' =
        String(args['scope'] ?? 'repo').trim() === 'org' ? 'org' : 'repo';
      try {
        const requestId = `mcp-${randomUUID()}`;
        const card = webMcpProposalCard({
          jobId: stimulus.jobId,
          requestId,
          repoId: stimulus.repoId,
          scope,
          servers,
        });
        const opened = await this.store.openMcpProposal(stimulus.jobId, {
          requestId,
          card,
        });
        if (!opened.ok)
          return {
            ok: false,
            reason: 'Could not open the MCP proposal (thread not found).',
          };
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
        this.logger.warn(
          `propose_mcp_servers failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  private buildListConventionProfilesTool(stimulus: TurnEnvelope): ToolImpl {
    return async () => {
      if (!this.conventions)
        return {
          ok: true,
          profiles: [],
          message: 'No house-style profiles are configured.',
        };
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

  private buildProposeConventionProfileTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const slug = String(args['slug'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      if (!slug || slug.toLowerCase() === 'none') {
        return {
          ok: true,
          proposed: null,
          message:
            'Recorded that no house-style profile matches this repo — leaving its conventions unset (the default). Continue onboarding.',
        };
      }
      if (!this.conventions)
        return {
          ok: false,
          reason: 'house-style profiles are not configured for this org',
        };
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
        const opened = await this.store.openConventionProposal(stimulus.jobId, {
          requestId,
          card,
        });
        if (!opened.ok)
          return {
            ok: false,
            reason: 'Could not open the convention proposal (thread not found).',
          };
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

  private buildProposeConventionProfileChangeTool(stimulus: TurnEnvelope): ToolImpl {
    const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    return async (args) => {
      const slug = String(args['slug'] ?? '').trim();
      const body = String(args['body'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      const nameArg = String(args['name'] ?? '').trim();
      const detectHintArg = String(args['detectHint'] ?? '').trim();
      if (!SLUG_RE.test(slug)) {
        return {
          ok: false,
          reason: 'slug must be lowercase letters/digits/_/- (e.g. nestjs-next-shared)',
        };
      }
      if (!body)
        return {
          ok: false,
          reason: 'body (the house-style rules) is required',
        };
      if (!rationale)
        return {
          ok: false,
          reason: 'rationale — why the house style should change — is required',
        };
      if (!this.conventions)
        return {
          ok: false,
          reason: 'house-style profiles are not configured for this org',
        };
      try {
        const existing = await this.conventions.getProfile(stimulus.orgId, slug);
        const mode: 'create' | 'update' = existing ? 'update' : 'create';
        const name = nameArg || existing?.name;
        if (!name)
          return {
            ok: false,
            reason: 'name is required when creating a new profile',
          };
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
        const opened = await this.store.openConventionEditProposal(stimulus.jobId, {
          requestId,
          card,
        });
        if (!opened.ok)
          return {
            ok: false,
            reason: 'Could not open the proposal (thread not found).',
          };
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

  private buildListMcpServersTool(stimulus: TurnEnvelope): ToolImpl {
    return async () => {
      if (!this.mcpStore)
        return {
          ok: true,
          servers: [],
          message: 'MCP servers are not configured for this org.',
        };
      try {
        const servers = (await this.mcpStore.list(stimulus.orgId)).map((s) => ({
          name: s.name,
          scope: s.scope === 'org' ? 'org' : 'repo',
          transport: s.transport,
          surfaces: s.surfaces,
          enabled: s.enabled,
          secretKeys: s.secretKeys,
          authKind: s.authKind,
          oauthConnected: s.oauthConnected,
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

  private buildListSkillsTool(stimulus: TurnEnvelope): ToolImpl {
    return async () => {
      if (!this.skillStore)
        return {
          ok: true,
          skills: [],
          message: 'Skills are not configured for this org.',
        };
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

  private buildProposeSkillTool(stimulus: TurnEnvelope): ToolImpl {
    const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    const ALL_SURFACES: McpSurface[] = ['brain', 'build', 'review'];
    return async (args) => {
      const name = String(args['name'] ?? '').trim();
      const description = String(args['description'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      const scope: 'org' | 'repo' =
        String(args['scope'] ?? 'repo').trim() === 'org' ? 'org' : 'repo';

      if (!NAME_RE.test(name)) {
        return {
          ok: false,
          reason: 'name must be lowercase letters/digits/_/- (e.g. house-migrations)',
        };
      }
      if (!description)
        return {
          ok: false,
          reason: 'description (the "Use when …" trigger blurb) is required',
        };
      if (!rationale)
        return {
          ok: false,
          reason: 'rationale — why this skill helps builds here — is required',
        };
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
              "request_skill_edit_access({ skill: '" +
              name +
              "' }) to get owner-approved edit access, " +
              'then Edit/Write its files directly.',
          };
        }
        const draftDir = join(
          this.lifecycle.contextDirHost(stimulus.jobId, stimulus.orgId),
          'skill-drafts',
          name,
        );
        if (!existsSync(join(draftDir, 'SKILL.md'))) {
          return {
            ok: false,
            reason:
              `no authored skill found at /context/skill-drafts/${name}/SKILL.md. Author it FIRST — use your ` +
              'built-in run-skill-generator skill to scaffold and write the folder (SKILL.md + any ' +
              'references/scripts) under /context/skill-drafts/' +
              name +
              '/, then call propose_skill again.',
          };
        }
        const requestId = `skill-${randomUUID()}`;
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
        const opened = await this.store.openSkillProposal(stimulus.jobId, {
          requestId,
          card,
        });
        if (!opened.ok) {
          this.skillFiles.removeStaging(stimulus.orgId, requestId);
          return {
            ok: false,
            reason: 'Could not open the skill proposal (thread not found).',
          };
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

  private buildProposeSkillInstallTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const sourceUrl = String(args['sourceUrl'] ?? '').trim();
      const ref = String(args['ref'] ?? '').trim() || undefined;
      const subpath = String(args['subpath'] ?? '').trim() || undefined;
      const rationale = String(args['rationale'] ?? '').trim();
      const scope: 'org' | 'repo' =
        String(args['scope'] ?? 'repo').trim() === 'org' ? 'org' : 'repo';

      if (!/^https:\/\/\S+$/.test(sourceUrl)) {
        return {
          ok: false,
          reason: 'sourceUrl must be an https git URL (e.g. https://github.com/anthropics/skills)',
        };
      }
      if (!rationale)
        return {
          ok: false,
          reason: 'rationale — why this skill helps builds here — is required',
        };
      if (!this.skillStore || !this.skillInstaller) {
        return { ok: false, reason: 'skills are not configured for this org' };
      }
      try {
        const dbScope = scope === 'org' ? '*' : stimulus.repoId;
        let rows;
        try {
          rows = await this.skillInstaller.preview({
            orgId: stimulus.orgId,
            scope: dbScope,
            sourceUrl,
            ref,
            subpath,
          });
        } catch (err) {
          return {
            ok: false,
            reason: `could not resolve that skill source: ${errText(err)}`,
          };
        }
        const resolved = rows[0];
        if (!resolved)
          return {
            ok: false,
            reason: 'that source resolved no installable skill',
          };
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
        const opened = await this.store.openSkillProposal(stimulus.jobId, {
          requestId,
          card,
        });
        if (!opened.ok)
          return {
            ok: false,
            reason: 'Could not open the skill install proposal (thread not found).',
          };
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
        this.logger.warn(
          `propose_skill_install failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  private buildRequestSkillEditAccessTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const name = String(args['skill'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      if (!name)
        return {
          ok: false,
          reason: 'skill (the name to unlock) is required — call list_skills first',
        };
      if (!rationale)
        return {
          ok: false,
          reason: 'rationale — why you need to edit this skill — is required',
        };
      if (!this.skillStore) return { ok: false, reason: 'skills are not configured for this org' };
      try {
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
        const opened = await this.store.openSkillEditAccessRequest(stimulus.jobId, {
          requestId,
          card,
        });
        if (!opened.ok) {
          return {
            ok: false,
            reason: 'Could not open the edit-access request (thread not found).',
          };
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

  private buildProposeSkillRemovalTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const name = String(args['name'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      const scope: 'org' | 'repo' =
        String(args['scope'] ?? 'repo').trim() === 'org' ? 'org' : 'repo';
      if (!name) return { ok: false, reason: 'name (the skill to remove) is required' };
      if (!rationale)
        return {
          ok: false,
          reason: 'rationale — why the skill should be removed — is required',
        };
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
        const opened = await this.store.openSkillProposal(stimulus.jobId, {
          requestId,
          card,
        });
        if (!opened.ok)
          return {
            ok: false,
            reason: 'Could not open the skill removal proposal (thread not found).',
          };
        return {
          ok: true,
          requestId,
          message:
            `Posted a removal proposal for the "${name}" skill (${scope}-scoped). Only the OWNER can approve ` +
            'the deletion — you cannot remove it yourself. Mention the proposal, then continue.',
        };
      } catch (err) {
        this.logger.warn(
          `propose_skill_removal failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  private buildProposeMcpRemovalTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const name = String(args['name'] ?? '').trim();
      const rationale = String(args['rationale'] ?? '').trim();
      const scope: 'org' | 'repo' =
        String(args['scope'] ?? 'repo').trim() === 'org' ? 'org' : 'repo';
      if (!name)
        return {
          ok: false,
          reason: 'name (the MCP server to remove) is required',
        };
      if (!rationale)
        return {
          ok: false,
          reason: 'rationale — why the server should be removed — is required',
        };
      if (!this.mcpStore)
        return {
          ok: false,
          reason: 'MCP servers are not configured for this org',
        };
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
        const opened = await this.store.openMcpProposal(stimulus.jobId, {
          requestId,
          card,
        });
        if (!opened.ok)
          return {
            ok: false,
            reason: 'Could not open the MCP removal proposal (thread not found).',
          };
        return {
          ok: true,
          requestId,
          message:
            `Posted a removal proposal for the "${name}" MCP server (${scope}-scoped). Only the OWNER can ` +
            'approve the deletion — you cannot remove it yourself. Mention the proposal, then continue.',
        };
      } catch (err) {
        this.logger.warn(
          `propose_mcp_removal failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  private buildResetSandboxTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const key = `${stimulus.orgId}:${stimulus.jobId}`;
      const reason = String(args['reason'] ?? '').trim() || 'no reason given';
      const hard = args['hard'] === true;

      if (hard) {
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
        const dirty = await this.git.hasChanges(sandbox.worktreePath).catch(() => true);
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

  private buildFinishOnboardingTool(stimulus: TurnEnvelope): ToolImpl {
    return async (args) => {
      const summary = String(args['summary'] ?? '').trim();
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
      const sandbox = await this.lifecycle.findSandbox(stimulus.jobId, stimulus.orgId);
      if (!sandbox) return { ok: false, reason: 'no sandbox for this thread yet' };

      await this.store.appendSystemEvent(stimulus.jobId, `✅ Boot verified — ${verified}`);
      if (summary)
        await this.store.appendSystemEvent(stimulus.jobId, `🎉 Onboarding complete — ${summary}`);

      try {
        await this.lifecycle.markRepoOnboarded(stimulus.orgId, stimulus.repoId);
        await this.refreshSeenManifests(stimulus.orgId, stimulus.repoId, sandbox.worktreePath);

        const hasChanges = await this.git.hasChanges(sandbox.worktreePath);
        if (!hasChanges) {
          return {
            ok: true,
            prOpened: false,
            message: 'Onboarding complete. Repo marked ready.',
          };
        }

        const job = await this.store.loadJob(stimulus.jobId);
        const repo = await this.repos.resolve(job);
        const pre = await this.ship.preShip(job, repo, sandbox, async (m) => {
          await this.store.appendSystemEvent(stimulus.jobId, m);
        });
        if (!pre.ok) {
          if (pre.reason === 'leak-scan') {
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
        this.logger.warn(
          `finish_onboarding failed for org=${stimulus.orgId} repo=${stimulus.repoId}: ${err}`,
        );
        return { ok: false, reason: errText(err) };
      }
    };
  }

  private async resolveAnsweredCard(
    stimulus: TurnEnvelope,
    explicitQuestionId?: string,
  ): Promise<{ id: string; card: WebQuestionCard } | null> {
    const byId = async (id?: string) => {
      if (!id) return null;
      const card = await this.store.getQuestionCard(stimulus.jobId, id);
      return card?.answer != null ? { id, card } : null;
    };
    const explicit = await byId(explicitQuestionId);
    if (explicit) return explicit;
    const seeded = await byId(stimulus.deliveredQuestionIds?.[0]);
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
    const generatedDir = join(this.lifecycle.contextDirHost(jobId, orgId), 'generated');
    await mkdir(generatedDir, { recursive: true });
    await writeFile(
      join(generatedDir, 'decision-record.md'),
      renderDecisionRecordMd(decisions),
      'utf8',
    );
  }

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


  private async prepareRepropose(jobId: string): Promise<{ refuse?: string }> {
    const existing = await this.store.loadJob(jobId).catch(() => null);
    if (!existing) return {};
    const pastGate: JobStatus[] = [
      'running',
      'awaiting_ship_review',
      'done',
      'cancelled',
      'deleting',
      'archived',
    ];
    if (pastGate.includes(existing.status)) {
      return {
        refuse: `This job is already '${existing.status}' — can’t (re)propose a plan for it.`,
      };
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

  private async resolveAutoApprover(job: Job): Promise<string> {
    if (job.autoApproveBy) return job.autoApproveBy;
    const owner = await this.store.ownerUserId(job.orgId);
    if (!owner)
      throw new Error(
        `no auto-approve approver for job ${job.id} (no auto_approve_by and no org owner)`,
      );
    return owner;
  }

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

    const handle = await this.approvals.request({ channel, threadTs, orgId: stimulus.orgId }, card);

    this.surface.emitThreadMeta?.(stimulus.repoId, stimulus.jobId, card.title);

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

  private async actOnApprovalVerdict(
    stimulus: TurnEnvelope,
    job: Job,
    decisionRecordId: string,
    isDirect: boolean,
    resolution: ApprovalResolution,
  ): Promise<void> {
    if (resolution.verdict === 'approve') {
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
      await this.store.setActivity(stimulus.jobId, 'base_check').catch(() => undefined);
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
      await this.saySystemNotice(
        stimulus,
        'Got it — back to the drawing board. What should change?',
      );
      return;
    }

    await this.store.cancel(job.id);
    await this.saySystemNotice(stimulus, "Understood — I'll drop this one.");
  }

  async resolveApprovalDurably(
    jobId: string,
    verdict: ApprovalVerdict,
    ruledBy: string,
    note?: string,
    clickedDecisionRecordId?: string,
  ): Promise<boolean> {
    const job = await this.store.loadJob(jobId).catch(() => null);
    if (!job || job.status !== 'awaiting_approval' || !job.decisionRecordId) return false;
    const rec = await this.store.loadDecisionRecord(job.decisionRecordId);
    if (!rec) return false;
    const stimulus = internalEnvelope({
      jobId: job.id,
      orgId: job.orgId,
      repoId: job.repoId,
      author: {
        id: SYSTEM_SEED_AUTHOR.id,
        displayName: SYSTEM_SEED_AUTHOR.name,
      },
      type: 'user',
      body: '',
      seedRow: 'skip',
    });
    const isDirect = (rec.threadTitles?.length ?? 0) === 0;
    this.logger.log(
      `durable approval fallback for job ${jobId}: "${verdict}" by ${ruledBy} (direct=${isDirect})`,
    );
    await this.actOnApprovalVerdict(stimulus, job, job.decisionRecordId, isDirect, {
      jobId,
      verdict,
      ruledBy,
      ...(note ? { note } : {}),
      ...(clickedDecisionRecordId ? { clickedDecisionRecordId } : {}),
    });
    return true;
  }


  private async runCompaction(
    stimulus: TurnEnvelope,
    sandbox: { worktreePath: string; containerId?: string | null },
    sandboxRow: { session_id: string | null } | null,
    sessionId: string | undefined,
  ): Promise<void> {
    if (!sessionId || !sandboxRow) {
      this.logger.log(`compaction: no live session for job=${stimulus.jobId} — nothing to compact`);
      return;
    }

    const sandboxKey: EngineHomeKey = {
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      jobId: stimulus.jobId,
      type: 'brain',
    };
    const auth = await this.creds.engineAuth(stimulus.orgId, 'claude');

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
        mode: 'review',
        model: AgentSessionManager.BRAIN_MODEL,
        sessionId,
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
      this.logger.error(
        `compaction: completion failed for job=${stimulus.jobId} (will re-drive on boot): ${err}`,
      );
      return;
    }
    sandboxRow.session_id = null;
    this.logger.log(
      `compaction: job=${stimulus.jobId} compacted (${summary.length} chars) — session reseeded`,
    );
  }

  private async clearCompactionMarker(jobId: string, orgId: string): Promise<void> {
    await this.sandboxRows
      .update({ job_id: jobId, org_id: orgId }, { compacting_session_id: null })
      .catch((err) => this.logger.warn(`compaction: marker clear failed for job=${jobId}: ${err}`));
  }

  private async completeCompaction(jobId: string, orgId: string, summary: string): Promise<void> {
    const seed = `${CONTINUATION_PREAMBLE}\n\n${summary}`;
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
            { session_id: null, pending_compaction_seed: seed },
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

  private async reattachCompactionOne(row: ActiveTurnEntity): Promise<void> {
    if (this.engineRunner.isAttached?.(row.turn_id)) return;
    if (!row.container_id) {
      this.logger.warn(
        `compaction re-attach ${row.turn_id}: no container — deferring to reconciler`,
      );
      return;
    }
    let result: EngineRunResult;
    try {
      const ctx = (row.ctx ?? {}) as { credentialId?: string };
      result = await this.engineRunner.reattach!(row.turn_id, row.container_id, {
        onEvent: () => {
        },
        ...(ctx.credentialId ? { credentialId: ctx.credentialId } : {}),
      });
    } catch (err) {
      this.logger.warn(`compaction re-attach ${row.turn_id}: reattach failed: ${err}`);
      return;
    }
    const summary = (result.result ?? '').trim();
    if (!summary) {
      await this.clearCompactionMarker(row.job_id, row.org_id);
      return;
    }
    await this.completeCompaction(row.job_id, row.org_id, summary);
    this.logger.log(`Leader: completed re-attached compaction for job=${row.job_id}`);
  }

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
      const live = await this.turnRegistry.hasRunningForThread(row.job_id).catch(() => false);
      if (live) continue; // a turn is live — reattach (or the queue) owns it; don't race a second run.
      this.logger.log(`Leader: re-driving stranded compaction for job=${row.job_id}`);
      void this.enqueueCompaction(this.compactionStimulus(row.job_id, row.org_id, row.repo_id));
    }
  }

  private compactionStimulus(jobId: string, orgId: string, repoId: string): TurnEnvelope {
    return internalEnvelope({
      jobId,
      orgId,
      repoId,
      author: { id: 'atlas', displayName: 'Atlas' },
      type: 'user',
      body: '',
    });
  }

  private async shouldSkipCompaction(jobId: string): Promise<boolean> {
    const occ = await this.store.latestBrainOccupancy(jobId).catch(() => null);
    return !!(
      occ &&
      occ.contextTokens != null &&
      occ.contextLimit != null &&
      occ.contextTokens < COMPACTION_MIN_OCCUPANCY_FRAC * occ.contextLimit
    );
  }

  private async enqueueCompaction(stimulus: TurnEnvelope): Promise<void> {
    if (await this.shouldSkipCompaction(stimulus.jobId)) {
      this.logger.log(
        `compaction: job=${stimulus.jobId} skipped — session lean (below ${COMPACTION_MIN_OCCUPANCY_FRAC} of the window)`,
      );
      return;
    }
    const compaction = internalEnvelope({
      jobId: stimulus.jobId,
      orgId: stimulus.orgId,
      repoId: stimulus.repoId,
      author: { id: 'atlas', displayName: 'Atlas' },
      type: 'compaction',
      body: '',
    });
    void this.handleChatTurn(compaction).catch((err) =>
      this.logger.error(`compaction turn failed to run for job=${stimulus.jobId}: ${err}`),
    );
  }


  private async runDirectBuild(stimulus: TurnEnvelope, job: Job): Promise<void> {
    const instruction =
      'The direct-build plan was APPROVED. Implement the change now, directly, in the repo ' +
      '(`/workspace`) — follow the spec/notes you wrote under `/context`. When the change is complete, ' +
      "run `mcp__atlas-lsp-ts__diagnostics` on the files you changed and the repo's own typecheck, and fix " +
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
      this.logger.error(`direct build implementation turn failed for thread=${job.id}: ${err}`);
      await this.say(stimulus, `The direct build hit an error — ${String(err).slice(0, 200)}`);
    }
  }


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

  async startOnboardingThread(jobId: string, orgId: string, repoId: string): Promise<void> {
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


  async deliverEvent(stimulus: EventMessage): Promise<void> {
    await this.pumpEvent(stimulus);
  }

  async pumpEvent(stimulus: EventMessage): Promise<void> {
    if (this.election.getState() === 'draining') return;

    const row = await this.stimulusRows.findOne({ where: { id: stimulus.id } });
    if (row?.delivered_at) return;

    const body = renderEventDelivery(stimulus);
    const lane = this.laneForStimulus(stimulus);
    const live = await this.turnRegistry.runningBrainTurn(stimulus.jobId).catch(() => null);
    if (
      live?.turn_id &&
      this.activeTurnLane(live) === lane &&
      typeof this.engineRunner.steer === 'function'
    ) {
      await this.steerEvent(live.turn_id, stimulus.id, body);
      return;
    }

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

  private async steerEvent(turnId: string, eventRowId: string, body: AgentMessage): Promise<void> {
    await this.stimulusStore
      .leaseChatStimuli([eventRowId]) // kind-agnostic (updates by id) — reused for the event row
      .catch((err) => this.logger.debug(`pump: lease event failed (continuing): ${err}`));
    await this.engineRunner.steer!(turnId, eventRowId, body).catch((err) =>
      this.logger.warn(
        `pump: steer event into turn ${turnId} failed (sweep will re-drive): ${err}`,
      ),
    );
  }

  private async deliverEventViaFreshTurn(
    stimulus: EventMessage,
    body: AgentMessage,
  ): Promise<void> {
    const lane = this.laneForStimulus(stimulus);
    const live = await this.turnRegistry.runningBrainTurn(stimulus.jobId).catch(() => null);
    if (
      live?.turn_id &&
      this.activeTurnLane(live) === lane &&
      typeof this.engineRunner.steer === 'function'
    ) {
      await this.steerEvent(live.turn_id, stimulus.id, body);
      return;
    }
    if (live?.turn_id && this.activeTurnLane(live) !== lane) return;

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

  private async sweepUndeliveredEvents(): Promise<void> {
    if (this.election.getState() !== 'leader') return;
    let events: EventMessage[];
    try {
      events = await this.stimulusStore.eligiblePendingEvents(
        AgentSessionManager._CHAT_DELIVERY_LEASE_MS,
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


  private async buildAwarenessPrefix(jobId: string, orgId: string): Promise<string | null> {
    try {
      const state = await this.driverStore.getPipelineState(jobId, orgId);
      const sig = pipelineStateSignature(state);
      const { markers, stateChanged } = await this.awareness.drainAndAdvance(jobId, sig);
      if (markers.length === 0 && !stateChanged) return null;
      const prefix = renderAwarenessPrefix(
        markers,
        stateChanged ? renderPipelineStateSummary(state) : null,
      );
      return prefix || null;
    } catch (err) {
      this.logger.debug(`pipeline-awareness prefix failed (continuing): ${err}`);
      return null;
    }
  }

  private async buildOpenQuestionsPrefix(jobId: string): Promise<string | null> {
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
      const seen = this.injectedMemoryFactIds(stimulus.jobId, sessionId ?? null);
      const fresh = facts.filter((f) => !seen.has(f.id));
      if (fresh.length === 0) return null;
      const body = renderMemoryRecall(
        fresh.map((f) => ({ id: f.id, fact: f.fact, scope: f.scope })),
      );
      if (!body) return null;
      for (const f of fresh) seen.add(f.id);
      return body;
    } catch (err) {
      this.logger.debug(`memory auto-recall prefix failed (continuing): ${err}`);
      return null;
    }
  }

  private async buildOpenFileRequestsPrefix(jobId: string): Promise<string | null> {
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

  private async buildOpenSecretRequestsPrefix(jobId: string): Promise<string | null> {
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
      this.logger.debug(`open-secret-requests prefix failed (continuing): ${err}`);
      return null;
    }
  }

  private sandboxMilestoneNotifier(stimulus: TurnEnvelope): (stage: SandboxMilestoneStage) => void {
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

  private async recordMilestone(jobId: string, id: string, text: string): Promise<void> {
    await this.awareness
      .appendMarker(jobId, { id, text, at: new Date().toISOString() })
      .catch((err) => this.logger.debug(`milestone append failed (continuing): ${err}`));
  }


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
      .catch((err) => this.logger.warn(`failed to persist brain reply: ${err}`));
  }

  private async saySystemNotice(stimulus: TurnEnvelope, text: string): Promise<void> {
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

  private isBenignStreamAbort(err: unknown): boolean {
    return /aborted_streaming/.test(String(err));
  }

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
    if (await this.store.hasRecentSystemOperatorNotice(stimulus.jobId, text)) {
      this.logger.debug(
        `suppressing duplicate system→operator notice for thread=${stimulus.jobId}`,
      );
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
    await this.store.setHalted(stimulus.jobId, true).catch(() => undefined);
  }

  private async clearPendingHostRetry(jobId: string): Promise<void> {
    const t = this.hostRetryTimers.get(jobId);
    if (t) {
      clearTimeout(t);
      this.hostRetryTimers.delete(jobId);
    }
    await this.store
      .clearRetrySessionResume(jobId, 'main')
      .catch((e) => this.logger.warn(`clearPendingHostRetry(${jobId}) clock clear failed: ${e}`));
  }

  private async scheduleHostRetry(stimulus: TurnEnvelope, reason: string): Promise<void> {
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
          const title = await this.store.jobTitle(stimulus.jobId).catch(() => null);
          this.surface.seedSystemNotification?.(
            stimulus.repoId,
            stimulus.jobId,
            retryResumeNudge(title ?? undefined),
            { orgId: stimulus.orgId, seedRow: 'skip' },
          );
        } catch (e) {
          this.logger.warn(`host-retry re-drive for thread=${stimulus.jobId} failed: ${e}`);
        }
      })();
    }, HOST_RETRY_BACKOFF_MS);
    if (typeof t.unref === 'function') t.unref();
    this.hostRetryTimers.set(stimulus.jobId, t);
  }

  private async ensureJob(stimulus: TurnEnvelope, title: string, kind: JobKind): Promise<string> {
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

const CHAT_SWEEP_INTERVAL_MS = 30_000;
const CHAT_SWEEP_INTERVAL = 'brain:chat-delivery-sweep';

const PLAN_REVIEW_WEDGE_GRACE_MS = 90_000;

const WORK_OWED_RENUDGE_MS = 5 * 60_000;

interface TurnDeliveryOpts {
  onRegistered?: () => void;
  coalesced?: TurnEnvelope[];
}

type SeedCardStampResult = 'stamped' | 'missing' | 'failed';

const ATLAS_AUTHOR_ID = 'atlas';

function isOperatorAuthored(stimulus: TurnEnvelope): boolean {
  return stimulus.author.id !== ATLAS_AUTHOR_ID && stimulus.author.id !== SYSTEM_SEED_AUTHOR.id;
}

function turnHasOperatorInput(stimulus: TurnEnvelope): boolean {
  return stimulus.containsOperator ?? isOperatorAuthored(stimulus);
}

function isStandaloneSeed(type: MessageType): boolean {
  return type === 'reset_verify' || type === 'compaction';
}

function isSeedCardDelivery(s: TurnEnvelope): boolean {
  const t = s.message.type;
  if (t === 'answer_question' || t === 'file_answered' || t === 'secret_provided') return true;
  return (
    (s.deliveredQuestionIds?.length ?? 0) > 0 ||
    (s.deliveredFileIds?.length ?? 0) > 0 ||
    (s.deliveredSecretIds?.length ?? 0) > 0
  );
}

function cardBearingIdsOf(stimulus: TurnEnvelope): string[] {
  return stimulus.cardBearingIds ?? (isSeedCardDelivery(stimulus) ? [stimulus.id] : []);
}

const RESET_LOOP_CAP = 3;

const COMPACTION_MIN_OCCUPANCY_FRAC = 0.3;

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

function seedEnvelope(
  message: Exclude<Message, { type: 'user' }>,
  opts?: {
    id?: string;
    body?: AgentMessage;
    seedRow?: SeedRow;
    resumeThreadId?: string;
    deliveredFileIds?: string[];
  },
): TurnEnvelope {
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

function normalizeDecisions(raw: unknown): Decision[] {
  const arr = Array.isArray(raw) ? raw : [];
  const candidates = arr.filter(
    (d): d is Record<string, unknown> =>
      typeof d === 'object' && d !== null && 'decisionClass' in d && 'title' in d && 'ruling' in d,
  );
  const out: Decision[] = [];
  for (const d of candidates) {
    const id = typeof d['id'] === 'string' && d['id'] ? d['id'] : nextDecisionId(out);
    out.push({
      id,
      decisionClass: d['decisionClass'] as Decision['decisionClass'],
      title: String(d['title']),
      ruling: String(d['ruling']),
      ...(typeof d['question'] === 'string' ? { question: d['question'] } : {}),
      ...(typeof d['answer'] === 'string' ? { answer: d['answer'] } : {}),
      ...(d['confirmedByOperator'] === true ? { confirmedByOperator: true } : {}),
    });
  }
  return out;
}

function jobTitle(summary: string): string {
  const firstLine =
    summary
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? summary;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}


const DECISION_CLASSES: ReadonlySet<string> = new Set<string>(DECISION_CLASS_IDS);

function asDecisionClass(v: unknown): DecisionClass | undefined {
  if (typeof v !== 'string') return undefined;
  const norm = v
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return DECISION_CLASSES.has(norm) ? (norm as DecisionClass) : undefined;
}

function missingArgsEnvelope(args: Record<string, unknown>): { ok: false; reason: string } | null {
  if (args && Object.keys(args).length > 0) return null;
  return {
    ok: false,
    reason:
      'No arguments received — pass the required fields directly in this tool call ' +
      '(e.g. { decisionClass, ruling, title }).',
  };
}

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

function deriveDecisionTitle(source: string): string {
  const firstLine =
    source
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? source;
  const cleaned = firstLine.replace(/[?:.]+$/, '').trim();
  return cleaned.length > 72 ? `${cleaned.slice(0, 69)}...` : cleaned || 'Decision';
}


function optStr(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : undefined;
}

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

function errText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String(err.message).slice(0, 200);
  return String(err).slice(0, 200);
}

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
