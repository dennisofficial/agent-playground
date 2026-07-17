import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { DecisionRecord, Job, SessionEngine, Step, ThreadCondition } from '../../_shared/domain';
import { CODEX_REVIEW_OUTAGE_RETRY_MS } from '../../_shared/domain';
import {
  cleanAuthHaltReason,
  EngineAuthError,
  EngineSessionLimitError,
  isEngineDetachedError,
  isSessionLimitError,
  UNRESUMABLE_SESSION_MARKER,
  type EngineHomeKey,
  type EngineHomeType,
  type ToolBridgeOptions,
  type ToolImpl,
} from '../../_shared/engine';
import type { GitAuth } from '../../_shared/engine/engine.types';
import {
  HOST_RETRY_BACKOFF_MS,
  HOST_TRANSPORT_TRANSIENT_RE,
  INTERNAL_PROFILE_AWARENESS_TOOL,
  isTransientAuthError,
  MAX_HOST_RETRIES,
} from '../../_shared/engine/engine.types';
import {
  defaultResumeAt,
  isCorroboratedSessionLimit,
  SESSION_LIMIT_TEXT_MISFIRE_MAX,
} from '../../_shared/engine/session-limit';
import { summarizeTurnFailure } from '../../_shared/engine/turn-failure-summary';
import { modeApprovesShip } from '@workspace/shared';
import { Sema } from 'async-sema';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LeaderElectionService } from '../cluster/leader-election.service';
import { ClaudeCredentialStore } from '../onboarding/claude-credential.store';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { OauthUsageService } from '../onboarding/oauth-usage.service';
import { WorkspaceConfigStore } from '../onboarding/workspace-config.store';
import { threadDirName } from '../prompt-kit/harness/thread-dir-name';
import { CONTAINER_CONTEXT } from '../sandbox/container-paths';
import { LiveTurnStore, MAIN_LANE } from '../surface/live-turn-store';
import { chunkKey } from '../../_shared/prompt-kit/harness/chunk-keys';
import { legRotationRule } from '../../_shared/prompt-kit/jit';
import { fromExternal, type AgentMessage } from '../../_shared/prompt-kit/message';
import {
  composeLegSeed,
  foldLegTurn,
  RECORD_LEG_HANDOFF_STOP,
  ROTATION_REMINDER_NUDGE,
  ROTATION_SOFT_NUDGE,
  stripContextPressureTag,
} from '../../_shared/prompt-kit/messages/build-handoff';
import { renderAgentPrompt, renderRunningServicesNote } from '../../_shared/prompt-kit/system';
import { coerceThreadType, ThreadType } from '../../_shared/thread-kind/thread-types';
import {
  dedupeFindings,
  lensById,
  meetsSeverity,
  reviewAgentsForThread,
} from '../autofix/autofix-lenses';
import { AutoFixStage } from '../autofix/autofix.stage';
import { AutoFixContext, FindingSeverity } from '../autofix/autofix.types';
import { BrainGateway } from '../brain-gateway/brain-gateway.service';
import { JitHostExecutor } from '../brain/jit-host-executor';
import { JobDispatcher } from '../brain/job-dispatcher';
import { SelfSufficiencyToolsService } from '../brain/self-sufficiency-tools.service';
import {
  ConventionProfileResolver,
  ResolvedConventions,
} from '../conventions/convention-profile.resolver';
import { PlanVisibilityService } from '../decision-gate/plan-visibility.service';
import { ExposureService } from '../exposure/exposure.service';
import { readServiceMarkers, serviceStatus } from '../exposure/service-markers';
import { GithubPrService } from '../git/github-pr.service';
import { FeatureSandbox, LocalGitService } from '../git/local-git.service';
import { JobBootstrapService } from '../job-bootstrap/job-bootstrap.service';
import { McpOAuthService } from '../mcp/mcp-oauth.service';
import { McpResolver } from '../mcp/mcp-resolver.service';
import type {
  ActiveTurnEntity,
  SessionAnchor,
  TaskItem,
  ThreadGroupEntity,
  ThreadTerminalRecord,
} from '../persistence/entities';
import { composeTurn } from '../prompt-kit/harness/compose-turn';
import {
  renderBatchTask,
  renderMasterReviewTask,
  renderOpenLegTasks,
  renderOpenTasksAdvisory,
} from '../prompt-kit/messages/batch-task';
import { renderCommitTurnTask } from '../prompt-kit/messages/commit-turn';
import { renderPlan, type PlannedStep } from '../prompt-kit/messages/render-plan';
import { TurnRunnerService } from '../runner/turn-runner.service';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox/sandbox-provider.port';
import type { ReattachOutcome } from '../sandbox/turn-reattach.registry';
import { TurnRegistry } from '../sandbox/turn-registry.service';
import { SKILL_NUDGE_SELECTOR, type SkillNudgeSelector } from '../skills/skill-nudge-llm';
import { SkillResolver } from '../skills/skill-resolver.service';
import { CHAT_DELIVERY_LEASE_MS, userChunkFor } from '../stimulus/delivery-pump.service';
import { StimulusStoreService } from '../stimulus/stimulus-store.service';
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';
import { makeTaskTools } from '../surface/task-tools';
import { laneFor } from '../surface/thread-registry';
import {
  BLOCK_SINK,
  TASK_EVENT_SINK,
  TurnHarnessFactory,
  type BlockSink,
  type TaskEventSink,
} from '../surface/turn-harness.service';
import { ShipThreadVerification, webShipReviewCard } from '../surface/web-approval-card';
import { threadGroupKindSpec } from '../thread-group-kind/registry';
import { isDriverExecutableKind, threadKindSpec } from '../thread-kind/registry';
import { ProfileAwarenessService } from '../workspace-profile/profile-awareness.service';
import { AutoMergeService } from './auto-merge.service';
import { BuildShipService } from './build-ship.service';
import {
  DriverStoreService,
  type DriverThread,
  type JobRoute,
  type ReviewChildThread,
} from './driver-store.service';
import { JobLifecycleService } from './job-lifecycle.service';
import {
  freshLegRotationState,
  LegRotationWatch,
  resolveRotationThresholds,
  type LegRotationRunState,
  type LegRotationThresholds,
} from './leg-rotation-watch';
import { clampEvidenceOutput } from './live-verification-support';
import { PipelineAwarenessStore } from './pipeline-awareness.store';
import { DRIVER_REPO, type DriverRepoResolver, type ResolvedRepo } from './repo-resolver';

type ThreadOutcome = 'done' | 'incomplete' | 'rotated';

interface BatchResult {
  outcome: ThreadOutcome;
  report: string;
}

interface ThreadResult {
  outcome: ThreadOutcome;
  handoff: string | null;
}

type ThreadGroupDriveResult =
  | { kind: 'advanced'; handoff: string | null }
  | { kind: 'yield' }
  | {
      kind: 'halt';
      thread: DriverThread;
      outcome: ThreadOutcome;
    };

function isTransientDriveError(err: unknown): boolean {
  if (err instanceof EngineAuthError) return false; // → paused
  if (err instanceof EngineSessionLimitError) return false; // → parked on session limit
  if (isEngineDetachedError(err)) return false; // → leave running for boot re-attach
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes(UNRESUMABLE_SESSION_MARKER.toLowerCase())) return false; // session gone — retry futile
  if (msg.includes('phase_timeout_ms')) return false; // a runaway turn stays terminal (ADR 0001 §52)
  return HOST_TRANSPORT_TRANSIENT_RE.test(msg);
}

function isCodexReviewOutageError(err: unknown): boolean {
  if (err instanceof EngineAuthError) return err.engine === 'codex';
  return isTransientDriveError(err); // network/transport shapes, retries already exhausted upstream
}

const REVIEW_LENS_CONCURRENCY = 8;

const REVIEW_LENS_MODEL = 'claude-sonnet-5';

@Injectable()
export class ThreadDriver implements JobDispatcher {
  private readonly logger = new Logger(ThreadDriver.name);
  private readonly active = new Set<string>();
  private readonly driveAfterActiveTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    private readonly usage: OauthUsageService,
    private readonly mcp: McpResolver,
    private readonly mcpOAuth: McpOAuthService,
    private readonly skills: SkillResolver,
    @Inject(SKILL_NUDGE_SELECTOR)
    private readonly skillNudge: SkillNudgeSelector,
    private readonly threadLifecycle: JobLifecycleService,
    private readonly ship: BuildShipService,
    private readonly autoMerge: AutoMergeService,
    private readonly awareness: PipelineAwarenessStore,
    private readonly election: LeaderElectionService,
    private readonly turnHarness: TurnHarnessFactory,
    @Inject(BLOCK_SINK) private readonly blockSink: BlockSink,
    private readonly liveTurns: LiveTurnStore,
    private readonly turnRegistry: TurnRegistry,
    private readonly brainGateway: BrainGateway,
    @Inject(TASK_EVENT_SINK) private readonly taskSink: TaskEventSink,
    @Optional() private readonly exposure?: ExposureService,
    @Optional() private readonly conventions?: ConventionProfileResolver,
    @Optional() private readonly claudeCreds?: ClaudeCredentialStore,
    @Optional() private readonly configStore?: WorkspaceConfigStore,
    @Optional() private readonly stimulusStore?: StimulusStoreService,
    @Optional() private readonly jit?: JitHostExecutor,
    @Optional() private readonly jobBootstrap?: JobBootstrapService,
    @Optional() private readonly profileAwareness?: ProfileAwarenessService,
    @Optional() private readonly selfSufficiency?: SelfSufficiencyToolsService,
  ) {}

  private async planningThreadId(jobId: string): Promise<string> {
    if (!this.jobBootstrap) throw new Error('thread-driver: JobBootstrapService not wired');
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

  private readonly hostRetryTimers = new Map<string, NodeJS.Timeout>();

  private async repoConventionsFor(job: Job): Promise<ResolvedConventions | null> {
    if (!this.conventions) return null;
    return this.conventions.resolveForRepo(job.orgId, job.repoId).catch(() => null);
  }

  private async previewRecipeFor(job: Job): Promise<string | null> {
    try {
      const recipe = await this.configStore?.getPreviewInstructions(job.orgId, job.repoId);
      return recipe?.trim() ? recipe : null;
    } catch {
      return null;
    }
  }

  private async resolveTurnGitAuth(orgId: string, gitUrl: string): Promise<GitAuth> {
    const token = await this.creds.githubToken(orgId);
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

  private async recordMilestone(jobId: string, id: string, text: string): Promise<void> {
    await this.awareness
      .appendMarker(jobId, { id, text, at: new Date().toISOString() })
      .catch((err) => this.logger.debug(`milestone append failed (continuing): ${err}`));
  }

  private get maxThreads(): number {
    return 12;
  }

  private get phaseTimeoutMs(): number {
    const raw = Number(this.env.get('PHASE_TIMEOUT_MS'));
    if (Number.isFinite(raw) && raw > 0) return raw;
    return 60 * 60_000;
  }

  async dispatch(job: Job): Promise<void> {
    this.logger.log(`dispatch thread=${job.id} kind=${job.kind} title="${job.title}"`);
    if (job.halt != null) {
      this.logger.warn(`dispatch job=${job.id} halted (${job.halt.kind}) — not driving`);
      return;
    }
    await this.store.clearShipApproval(job.id).catch(() => undefined);
    void this.drive(job.id).catch((err) => {
      this.logger.error(`drive job=${job.id} crashed: ${err instanceof Error ? err.stack : err}`);
    });
  }

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

  async resumePaused(jobId: string): Promise<void> {
    const job = await this.store.loadJob(jobId).catch(() => null);
    if (
      !job ||
      !['blocked_credentials', 'session_limit', 'codex_review_unavailable'].includes(
        job.halt?.kind ?? '',
      )
    ) {
      this.logger.warn(
        `resumePaused job=${jobId}: not a resumable halt (${job?.halt?.kind ?? 'gone'}) — ignoring`,
      );
      return;
    }
    this.logger.log(`resumePaused job=${jobId} — re-driving the halted session`);
    await this.store.clearDriverRetryCounters(jobId);
    await this.store.clearJobHalt(jobId);
    await this.store.setSessionResume(jobId, null, null);
    await this.store.setJobStatus(jobId, 'running');
    void this.drive(jobId).catch((err) => {
      this.logger.error(
        `resumePaused job=${jobId} crashed: ${err instanceof Error ? err.stack : err}`,
      );
    });
  }

  async reattachTurnRow(row: ActiveTurnEntity): Promise<ReattachOutcome> {
    const job = await this.store.loadJob(row.job_id).catch(() => null);
    if (!job || job.status !== 'running' || job.halt != null) {
      return 'deferred';
    }
    if (this.active.has(row.job_id)) {
      return 'attached';
    }
    void this.drive(row.job_id).catch((err) =>
      this.logger.error(
        `reattach drive job=${row.job_id} crashed: ${err instanceof Error ? err.stack : err}`,
      ),
    );
    return 'attached';
  }

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
      this.logger.warn(`retry job=${jobId}: not retryable (not halted) — ignoring`);
      return;
    }
    this.logger.log(`retry job=${jobId} — re-driving a ${job.halt.kind} halt`);
    await this.store.clearDriverRetryCounters(jobId);
    await this.store.clearJobHalt(jobId);
    await this.store.setSessionResume(jobId, null, null);
    await this.store.setJobStatus(jobId, 'running');
    void this.drive(jobId).catch((err) => {
      this.logger.error(`retry job=${jobId} crashed: ${err instanceof Error ? err.stack : err}`);
    });
  }

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
    const current = await this.store.getThread(threadId).catch(() => null);
    if (current?.status === 'done') {
      this.logger.warn(
        `redriveThread job=${jobId}: thread ${threadId} already done — refusing (won't resurrect a completed thread)`,
      );
      return { ok: false, reason: `thread ${threadId} is already complete` };
    }
    await this.store.clearTerminalRecord(threadId).catch(() => undefined);
    await this.store.clearJobHalt(jobId).catch(() => undefined);
    await this.store.clearDriverRetryCounters(jobId).catch(() => undefined);
    await this.store.setThreadStatus(threadId, 'executing').catch(() => undefined);
    await this.store.setThreadCondition(threadId, 'none').catch(() => undefined);
    if (guidance) {
      await this.store.setThreadOrientation(threadId, guidance).catch(() => undefined);
    }
    if (job.status !== 'running') {
      await this.store.setJobStatus(jobId, 'running').catch(() => undefined);
    }
    this.logger.log(`redriveThread job=${jobId} thread=${threadId} — re-driving`);
    void this.drive(jobId).catch((err) =>
      this.logger.error(
        `redriveThread drive job=${jobId} crashed: ${err instanceof Error ? err.stack : err}`,
      ),
    );
    return { ok: true };
  }

  async operatorRetryStuckThread(
    jobId: string,
    threadId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const r = await this.redriveThread(jobId, threadId);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }

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

  async operatorShipWithoutReview(jobId: string): Promise<{ ok: boolean; reason?: string }> {
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
      await this.store.setStepState(p.id, 'done', 'done').catch(() => undefined);
    }
    await this.store.setThreadStatus(mr.id, 'done').catch(() => undefined);
    await this.store.clearJobHalt(jobId).catch(() => undefined);
    await this.store.setSessionResume(jobId, null, null).catch(() => undefined);
    await this.store.setJobStatus(jobId, 'running').catch(() => undefined);
    void this.drive(jobId).catch((err) =>
      this.logger.error(`operatorShipWithoutReview job=${jobId} crashed: ${err}`),
    );
    return { ok: true };
  }


  private async drive(jobId: string): Promise<void> {
    if (this.active.has(jobId)) {
      this.logger.warn(`drive job=${jobId} already active — skipping duplicate`);
      return;
    }
    this.active.add(jobId);
    const pendingTimer = this.hostRetryTimers.get(jobId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.hostRetryTimers.delete(jobId);
    }
    await this.store
      .clearRetrySessionResume(jobId, 'build')
      .catch((err) => this.logger.warn(`clearRetrySessionResume(${jobId}) failed: ${err}`));
    try {
      await this.runJobWithTransientRetry(jobId);
      await this.store.clearDriverRetryCounters(jobId);
    } catch (err) {
      if (isEngineDetachedError(err)) {
        this.logger.warn(
          `job=${jobId} left running — engine detached (lost tail); boot will re-attach`,
        );
        return;
      }
      if (this.election.isDraining()) {
        this.logger.warn(
          `job=${jobId} left running — aborted by shutdown drain; will resume on next boot`,
        );
        return;
      }
      if (err instanceof EngineAuthError) {
        this.logger.warn(`job=${jobId} halted on credential error: ${err.message}`);
        await this.classifyAndSurfaceAuthHalt(jobId, err);
      } else if (isSessionLimitError(err)) {
        const limit = err as EngineSessionLimitError;
        const job = await this.store.loadJob(jobId).catch(() => null);
        const orgId = job?.orgId;
        const util =
          limit.source === 'text' && orgId
            ? await this.usage.getUtilization(orgId, limit.rateLimitType).catch(() => undefined)
            : undefined;

        const durablePark = async (): Promise<void> => {
          this.logger.warn(`job=${jobId} parked on session limit: ${limit.message}`);
          const resumeAt =
            limit.resetAt ??
            (orgId ? await this.usage.getResetAt(orgId, limit.rateLimitType) : undefined);
          const resumeClock = resumeAt ?? defaultResumeAt();
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
          const resetSource: 'usage_api' | 'parsed_string' = limit.rateLimitType
            ? 'usage_api'
            : 'parsed_string';
          const at = new Date().toISOString();
          await this.store
            .setJobHalt(jobId, {
              kind: 'session_limit',
              reason: limit.message,
              at,
              resumeAt: resumeClock,
            })
            .catch(() => undefined);
          await this.store
            .setSessionResume(jobId, resumeClock, {
              lane: 'build',
              reason: limit.message,
              resetSource,
            })
            .catch(() => undefined);
          await this.relaySessionLimitPaused(jobId, resumeAt);
          await this.store.clearDriverRetryCounters(jobId).catch(() => undefined);
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
        this.logger.warn(
          `job=${jobId} master_review Codex outage — holding (not failing): ${err instanceof Error ? err.message : err}`,
        );
        await this.holdForCodexReviewOutage(jobId, err);
      } else {
        this.logger.error(`job=${jobId} failed: ${err instanceof Error ? err.stack : err}`);
        await this.store
          .setJobHalt(jobId, {
            kind: 'failed',
            reason: shortReason(err),
            at: new Date().toISOString(),
          })
          .catch(() => undefined);
        await this.relayFailure(jobId, err);
      }
    } finally {
      this.active.delete(jobId);
    }
  }

  private async runJobWithTransientRetry(jobId: string): Promise<void> {
    const maxRetries = MAX_HOST_RETRIES;
    const { count, lastAttemptAt } = await this.store.driverTransientRetryState(jobId);
    if (count > 0 && lastAttemptAt) {
      const remaining = HOST_RETRY_BACKOFF_MS - (Date.now() - lastAttemptAt.getTime());
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
        const { ok, used: n } = await this.store.claimDriverTransientRetry(jobId, maxRetries);
        if (!ok) {
          throw err;
        }
        this.logger.warn(
          `job=${jobId} transient drive error (attempt ${n}/${maxRetries}) — retrying in ${HOST_RETRY_BACKOFF_MS}ms: ${
            err instanceof Error ? err.message : err
          }`,
        );
        await this.relayRetrying(jobId, n, maxRetries);
        const job = await this.store.loadJob(jobId).catch(() => null);
        const lane = await this.retryLaneForJob(jobId);
        try {
          this.liveTurns.retry(job?.repoId ?? jobId, jobId, lane, {
            attempt: n,
            max: maxRetries,
            nextAttemptAt: Date.now() + HOST_RETRY_BACKOFF_MS,
          });
        } catch {
        }
        await new Promise((r) => setTimeout(r, HOST_RETRY_BACKOFF_MS));
      }
    }
  }

  private async classifyAndSurfaceAuthHalt(jobId: string, err: EngineAuthError): Promise<void> {
    const job = await this.store.loadJob(jobId).catch(() => null);
    const orgId = job?.orgId;
    const isClaudeAuthHalt = err.engine !== 'codex';
    const selected =
      isClaudeAuthHalt && orgId && this.claudeCreds
        ? await this.claudeCreds.getSelectedRefreshMeta(orgId).catch(() => null)
        : null;
    if (isTransientAuthError(err)) {
      const { ok, used: n } = await this.store.claimAuthRetryAttempt(jobId, MAX_HOST_RETRIES);
      if (ok) {
        await this.relayRetrying(jobId, n, MAX_HOST_RETRIES);
        const lane = await this.retryLaneForJob(jobId);
        try {
          this.liveTurns.retry(job?.repoId ?? jobId, jobId, lane, {
            attempt: n,
            max: MAX_HOST_RETRIES,
            nextAttemptAt: Date.now() + HOST_RETRY_BACKOFF_MS,
          });
        } catch {
        }
        await this.scheduleBuildHostRetry(jobId, err.message);
        this.logger.warn(
          `job=${jobId} transient auth halt — auto-retry ${n}/${MAX_HOST_RETRIES} in ${HOST_RETRY_BACKOFF_MS}ms`,
        );
        return;
      }
    }

    await this.store.clearDriverRetryCounters(jobId);
    if (err.engine === 'codex' && (await this.inFlightThreadIsMasterReview(jobId))) {
      await this.holdForCodexReviewOutage(jobId, err);
      return;
    }
    await this.store
      .setJobHalt(jobId, {
        kind: 'blocked_credentials',
        reason: cleanAuthHaltReason(err.message, err.engine),
        at: new Date().toISOString(),
      })
      .catch(() => undefined);
    let markedReauth = false;
    if (orgId && selected && this.claudeCreds) {
      markedReauth = await this.claudeCreds
        .markNeedsReauth(orgId, selected.id, err.message)
        .then(() => true)
        .catch(() => false);
    }
    await this.relayPaused(
      jobId,
      err,
      markedReauth
        ? 'Your Claude login expired and could not be refreshed — reconnect it in Settings, then resume.'
        : cleanAuthHaltReason(err.message, err.engine),
    );
  }

  private async retryLaneForJob(jobId: string): Promise<string> {
    const threads = await this.store.threadsForJob(jobId).catch(() => []);
    const thread = threads.find((t) => isDriverExecutableKind(t.kind) && t.status !== 'done');
    return thread ? laneFor('builder', thread.id) : MAIN_LANE;
  }

  private async inFlightThreadIsMasterReview(jobId: string): Promise<boolean> {
    const threads = await this.store.threadsForJob(jobId).catch(() => []);
    const thread = threads.find((t) => isDriverExecutableKind(t.kind) && t.status !== 'done');
    return thread?.kind === 'master_review';
  }

  private async holdForCodexReviewOutage(jobId: string, err: unknown): Promise<void> {
    const at = new Date().toISOString();
    const reason = 'Master review is paused — Codex is unreachable.';
    const resumeAt = new Date(Date.now() + CODEX_REVIEW_OUTAGE_RETRY_MS).toISOString();
    await this.store
      .setJobHalt(jobId, {
        kind: 'codex_review_unavailable',
        reason,
        at,
        resumeAt,
      })
      .catch(() => undefined);
    await this.store
      .setSessionResume(jobId, resumeAt, {
        lane: 'build',
        reason,
        resetSource: 'usage_api',
      })
      .catch(() => undefined);
    await this.relayCodexReviewOutage(jobId, resumeAt);
  }

  private async scheduleBuildHostRetry(jobId: string, reason: string): Promise<void> {
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
    await this.store.setJobStatus(jobId, 'running').catch(() => undefined);
    void this.drive(jobId).catch((err) =>
      this.logger.error(
        `resumeRetry job=${jobId} crashed: ${err instanceof Error ? err.stack : err}`,
      ),
    );
  }

  private async relayRetrying(jobId: string, n: number, max: number): Promise<void> {
    const text = `Reconnecting to Claude — auto-retry ${n}/${max}…`;
    const threadId = await this.planningThreadId(jobId);
    await this.blockSink
      .appendBlock(jobId, {
        kind: 'chat',
        threadId,
        text,
        meta: { source: 'system_notice' },
      })
      .catch((e) => this.logger.warn(`could not record retry notice for job=${jobId}: ${e}`));
  }

  private async relayPaused(jobId: string, err: unknown, overrideText?: string): Promise<void> {
    const text =
      overrideText != null
        ? `:lock: Build paused — ${overrideText}\n_Your work + the engine session are saved; resume (or reply here) to continue the SAME session._`
        : `:lock: Build paused — a credential/auth error halted the engine (${shortReason(err)}).\n_Your work + the engine session are saved; fix the credentials and ping resume (or reply here) to continue the SAME session._`;
    const { summary } = summarizeTurnFailure(err);
    const threadId = await this.planningThreadId(jobId);
    await this.blockSink
      .appendBlock(jobId, {
        kind: 'chat',
        threadId,
        text,
        meta: {
          source: 'system_operator',
          severity: 'warning',
          category: 'auth',
          summary,
        },
      })
      .catch((e) => this.logger.error(`could not durably record pause for job=${jobId}: ${e}`));
    try {
      const job = await this.store.loadJob(jobId);
      const route = await this.store.route(job);
      await this.post(route, text);
    } catch (e) {
      this.logger.warn(`could not live-relay pause for job=${jobId}: ${e}`);
    }
  }

  private async relaySessionLimitPaused(jobId: string, resumeAt?: string): Promise<void> {
    const text = `You've hit your session limit — resets ${resumeAt ? fmtReset(resumeAt) : 'soon'}. Auto-resumes then; use Force resume now to resume earlier.`;
    const alreadyPosted = await this.store
      .hasRecentSystemOperatorNotice(jobId, text)
      .catch(() => false);
    if (!alreadyPosted) {
      const threadId = await this.planningThreadId(jobId);
      await this.blockSink
        .appendBlock(jobId, {
          kind: 'chat',
          threadId,
          text,
          meta: {
            source: 'system_operator',
            severity: 'warning',
            sessionLimit: true,
            category: 'session_limit',
            summary: "You've hit your Claude session limit — it auto-resumes at reset.",
            ...(resumeAt ? { resumeAt } : {}),
          },
        })
        .catch((e) =>
          this.logger.error(`could not durably record session-limit park for job=${jobId}: ${e}`),
        );
    }
    try {
      const job = await this.store.loadJob(jobId);
      const route = await this.store.route(job);
      if (route.channel && !alreadyPosted) {
        await this.surface.post(route.channel, text, {
          ...(route.threadTs ? { threadTs: route.threadTs } : {}),
          ...(route.orgId ? { orgId: route.orgId } : {}),
          meta: {
            source: 'system_operator',
            severity: 'warning',
            sessionLimit: true,
            category: 'session_limit',
            summary: "You've hit your Claude session limit — it auto-resumes at reset.",
            ...(resumeAt ? { resumeAt } : {}),
          },
        });
      }
    } catch (e) {
      this.logger.warn(`could not live-relay session-limit park for job=${jobId}: ${e}`);
    }
  }

  private async relayCodexReviewOutage(jobId: string, resumeAt?: string): Promise<void> {
    const text = `:hourglass: Master review is paused — Codex is unreachable. It auto-retries every few minutes; you can also “Ship without review” to skip the automated review and proceed to the ship gate now.`;
    const alreadyPosted = await this.store
      .hasRecentSystemOperatorNotice(jobId, text, CODEX_REVIEW_OUTAGE_RETRY_MS + 60_000)
      .catch(() => false);
    if (!alreadyPosted) {
      await this.blockSink
        .appendBlock(jobId, {
          kind: 'chat',
          threadId: await this.planningThreadId(jobId),
          text,
          meta: {
            source: 'system_operator',
            severity: 'warning',
            codexReviewUnavailable: true,
            ...(resumeAt ? { resumeAt } : {}),
          },
        })
        .catch((e) =>
          this.logger.error(
            `could not durably record codex-review-outage hold for job=${jobId}: ${e}`,
          ),
        );
    }
    try {
      const job = await this.store.loadJob(jobId);
      const route = await this.store.route(job);
      if (route.channel && !alreadyPosted) {
        await this.surface.post(route.channel, text, {
          ...(route.threadTs ? { threadTs: route.threadTs } : {}),
          ...(route.orgId ? { orgId: route.orgId } : {}),
          meta: {
            source: 'system_operator',
            severity: 'warning',
            codexReviewUnavailable: true,
            ...(resumeAt ? { resumeAt } : {}),
          },
        });
      }
    } catch (e) {
      this.logger.warn(`could not live-relay codex-review-outage hold for job=${jobId}: ${e}`);
    }
  }

  private async relayFailure(jobId: string, err: unknown): Promise<void> {
    const text = `:x: Build failed — ${shortReason(err)}\n_The job is marked failed; reply in this thread to retry or adjust the plan._`;
    const { category, summary } = summarizeTurnFailure(err);
    const threadId = await this.planningThreadId(jobId);
    await this.blockSink
      .appendBlock(jobId, {
        kind: 'chat',
        threadId,
        text,
        meta: {
          source: 'system_operator',
          severity: 'error',
          category,
          summary,
        },
      })
      .catch((e) => this.logger.error(`could not durably record failure for job=${jobId}: ${e}`));
    try {
      const job = await this.store.loadJob(jobId);
      const route = await this.store.route(job);
      await this.post(route, text);
    } catch (e) {
      this.logger.warn(`could not live-relay failure for job=${jobId}: ${e}`);
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const job = await this.store.loadJob(jobId);
    if (job.status !== 'running') {
      this.logger.warn(`job=${jobId} not running (status=${job.status}) — not driving`);
      return;
    }
    if (job.halt != null) {
      this.logger.warn(`job=${jobId} halted (${job.halt.kind}) — not driving`);
      return;
    }
    const record = await this.store.decisionRecord(job.decisionRecordId);
    const route = await this.store.route(job);
    const repo = await this.repos.resolve(job);
    const sandbox = await this.ensureSandbox(job);
    await this.refreshOAuthHubIfRotated(job);

    this.logger.log(`job=${jobId} on branch ${sandbox.branch} @ ${sandbox.worktreePath}`);

    const threadGroups = await this.store.threadGroupsForJob(jobId);
    const activeRecordId = job.decisionRecordId ?? null;
    const currentThreadGroups = threadGroups.filter(
      (s) => s.decision_record_id == null || s.decision_record_id === activeRecordId,
    );
    const executableThreadGroups = currentThreadGroups.filter((s) =>
      threadGroupKindSpec(s.kind).roles.some((r) => isDriverExecutableKind(r.role)),
    );
    if (executableThreadGroups.length === 0) {
      this.logger.log(
        `job=${jobId} has no driver-executable thread groups (brain-owned/direct build) — driver yielding, nothing to build or ship`,
      );
      return;
    }
    await this.store.setActivity(jobId, 'build').catch(() => undefined);
    await this.store.recomputeBuildStageProgress(jobId).catch(() => undefined);
    const buildThreadGroups = executableThreadGroups.filter((s) =>
      threadGroupKindSpec(s.kind).roles.some((r) => r.role === 'builder'),
    );
    const reviewThreadGroups = executableThreadGroups.filter((s) => s.kind === 'master_review');
    const cappedBuildThreadGroups = buildThreadGroups.slice(0, this.maxThreads);
    if (buildThreadGroups.length > cappedBuildThreadGroups.length) {
      this.logger.warn(
        `job=${jobId} has ${buildThreadGroups.length} build thread groups > MAX_SECTIONS (${this.maxThreads}) — capping`,
      );
    }
    const threadGroupsToRun = [...cappedBuildThreadGroups, ...reviewThreadGroups].sort(
      (a, b) => a.ordinal - b.ordinal,
    );

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
      if (!this.election.isLeader()) {
        this.logger.warn(
          `job=${job.id} lost leadership mid-drive — yielding (a leader will re-drive; job left running)`,
        );
        return;
      }
      const spec = threadGroupKindSpec(threadGroup.kind);
      const isMasterReviewThreadGroup = spec.roles.some((r) => r.role === 'master_review');
      await this.store
        .setActivity(job.id, isMasterReviewThreadGroup ? 'master_review' : 'build')
        .catch(() => undefined);
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
        : await this.driveBuildThreadGroup(job, record, route, repo, sandbox, threadGroup, handoff);
      if (res.kind === 'yield') return;
      if (res.kind === 'halt') {
        await this.haltJob(job, route, res.thread, res.outcome);
        return;
      }
      handoff = res.handoff;
    }

    if (!this.election.isLeader()) {
      this.logger.warn(
        `job=${job.id} lost leadership before ship — yielding (a leader will re-drive; job left running)`,
      );
      return;
    }
    if (shipGateApplies(job)) {
      const gateJob =
        job.shipReviewApprovedAt == null ? await this.store.loadJob(job.id).catch(() => job) : job;
      if (gateJob.shipReviewApprovedAt == null) {
        const autoApproved = await this.parkForShipReview(job, route);
        if (!autoApproved) return;
      }
    }
    await this.finalizeBuild(job, record, route, repo, sandbox);
    await this.store.setActivity(job.id, 'idle').catch(() => undefined);
  }

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
      if (!this.election.isLeader()) {
        this.logger.warn(
          `job=${job.id} lost leadership mid-drive — yielding (a leader will re-drive; job left running)`,
        );
        return { kind: 'yield' };
      }
      const builders = (await this.store.driverThreadsForThreadGroup(threadGroup.id)).filter(
        (t) => t.kind === 'builder',
      );
      const builderFinished = (t: DriverThread) =>
        t.status === 'done' || t.status === 'auto_fixing';
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
      if (res.outcome === 'rotated') continue;
      if (res.outcome !== 'done') {
        return { kind: 'halt', thread: next, outcome: res.outcome };
      }
      handoff = res.handoff;
    }

    await this.store.recomputeBuildStageProgress(job.id).catch(() => undefined);

    if (threadGroupKindSpec(threadGroup.kind).hasReview) {
      const builders = (await this.store.driverThreadsForThreadGroup(threadGroup.id)).filter(
        (t) => t.kind === 'builder',
      );
      const firstBuilder = builders[0];
      const lastBuilder = builders[builders.length - 1];
      if (firstBuilder && lastBuilder) {
        const existingReview = await this.store.reviewChildren(lastBuilder.id).catch(() => []);
        const reviewAlreadyTerminal =
          existingReview.length > 0 &&
          existingReview.every((c) => c.status === 'done' || c.condition === 'failed');
        if (!reviewAlreadyTerminal) {
          const threadGroupStartSha = await this.resolveThreadStartSha(firstBuilder, sandbox);
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
          await this.store.setThreadStatus(lastBuilder.id, 'done').catch(() => undefined);
        }
      }
    }
    return { kind: 'advanced', handoff };
  }

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
    const res = await this.runThread(job, record, route, repo, sandbox, mr, incomingHandoff);
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

  private async buildShipVerifications(jobId: string): Promise<ShipThreadVerification[]> {
    const threads = await this.store.threadsForJob(jobId).catch(() => []);
    const buildThreads = threads.filter((t) => isDriverExecutableKind(t.kind));
    const summaries: ShipThreadVerification[] = [];
    for (const t of buildThreads) {
      const term = await this.store.getTerminalRecord(t.id).catch(() => null);
      const verification = term?.verification ?? [];
      const status = t.status === 'done' && term?.status === 'done' ? 'done' : 'not_done';
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
    this.logger.log(`job=${job.id} parked at ship-review gate — awaiting operator "Ship it"`);
    const postBuildThreadId = await this.store.postBuildThreadId(job.id);
    if (postBuildThreadId) {
      await this.brainGateway
        .seedPostBuildGate({
          jobId: job.id,
          orgId: job.orgId,
          repoId: job.repoId,
          threadId: postBuildThreadId,
        })
        .catch((err) => this.logger.warn(`post_build gate seed failed (continuing): ${err}`));
    }
    await this.post(
      route,
      `:mag: Build reviewed — ready to ship *${title}*. Review the diff, then click *Ship it* to open the PR.`,
    ).catch(() => undefined);
    await this.recordMilestone(
      job.id,
      `ship-review:${job.id}`,
      'The build finished; it is parked awaiting your ship-review approval (with each thread’s self-reported verification) before the PR opens.',
    ).catch(() => undefined);
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

  async resolveMergeApprovalDurably(jobId: string, ruledBy: string): Promise<boolean> {
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

  private async haltJob(
    job: Job,
    route: JobRoute,
    thread: DriverThread,
    outcome: ThreadOutcome,
  ): Promise<void> {
    void outcome; // the only non-done/non-rotated outcome is `incomplete`
    const term = await this.store.getTerminalRecord(thread.id).catch(() => null);
    const at = new Date().toISOString();
    const reason = `${thread.brief} ended without asserting completion (no complete_thread)`;
    await this.store.setJobHalt(job.id, { kind: 'incomplete', reason, at }).catch(() => undefined);
    const text = `:warning: Build halted — *${thread.brief}* ended without asserting completion (no \`complete_thread\`), so nothing shipped. Ping to retry, or open the thread to see what it did.`;
    await this.blockSink
      .appendBlock(job.id, {
        kind: 'chat',
        threadId: await this.planningThreadId(job.id),
        text,
        meta: { source: 'system_operator', severity: 'warning' },
      })
      .catch((e) => this.logger.error(`could not durably record halt for job=${job.id}: ${e}`));
    await this.post(route, text).catch(() => undefined);
    await this.recordMilestone(job.id, `thread:${thread.id}:incomplete`, text).catch(
      () => undefined,
    );
    await this.writeCompletionMd(job, thread, term).catch((e) =>
      this.logger.warn(`could not write completion.md for thread=${thread.id}: ${e}`),
    );
  }

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
    const anchor = await this.store.resolveSessionAnchor(thread.id).catch(() => undefined);
    await writeFile(
      join(dir, 'completion.md'),
      renderCompletionMd(thread, term, new Date().toISOString(), anchor),
      'utf8',
    );
  }

  private async evidenceDirForThread(job: Job, thread: DriverThread): Promise<string> {
    const leg = threadDirName(thread);
    try {
      const hostDir = join(this.threadLifecycle.contextDirHost(job.id, job.orgId), 'evidence', leg);
      await mkdir(hostDir, { recursive: true });
    } catch (err) {
      this.logger.debug(
        `evidence dir pre-create for thread ${thread.ordinal} failed (continuing): ${String(err)}`,
      );
    }
    return `${CONTAINER_CONTEXT}/evidence/${leg}`;
  }

  private async runThread(
    job: Job,
    record: DecisionRecord | null,
    route: JobRoute,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
    thread: DriverThread,
    handoffIn: string | null,
  ): Promise<ThreadResult> {
    const live = await this.store.getThread(thread.id).catch(() => null);
    if (live?.status === 'done') {
      this.logger.warn(
        `thread ${thread.ordinal} "${thread.brief}" — already done (stale/overlapping drive); fast-forwarding`,
      );
      return { outcome: 'done', handoff: live.handoffOut ?? handoffIn };
    }
    this.logger.log(`thread ${thread.ordinal} "${thread.brief}" — planning`);
    await this.post(route, `:hammer_and_wrench: Planning thread — *${thread.brief}*`);

    const { steps } = await this.planThread(thread, handoffIn);

    const planView = steps.map(asPlannedStep);

    await this.visibility.postSectionPlan({
      channel: route.channel ?? '',
      ...(route.threadTs ? { threadTs: route.threadTs } : {}),
      ...(route.orgId ? { orgId: route.orgId } : {}),
      title: thread.brief,
      plan: renderPlan(planView),
      decisions: [],
    });

    const sectionStartSha = await this.resolveThreadStartSha(thread, sandbox);
    await this.store.setThreadStatus(thread.id, 'executing');
    await this.store.setThreadCondition(thread.id, 'none').catch(() => undefined);
    const { outcome, reports } = await this.executeSteps(
      job,
      route,
      sandbox,
      thread,
      record,
      repo,
      sectionStartSha,
    );

    if (outcome === 'rotated') {
      await this.store.setThreadStatus(thread.id, 'done').catch(() => undefined);
      await this.store.setThreadCondition(thread.id, 'none').catch(() => undefined);
      this.logger.log(
        `thread ${thread.ordinal} "${thread.brief}" — rotated to a fresh builder leg; this leg marked done`,
      );
      return { outcome: 'rotated', handoff: null };
    }

    if (outcome !== 'done') {
      const condition: ThreadCondition = 'incomplete';
      await this.store.setThreadCondition(thread.id, condition).catch(() => undefined);
      this.logger.warn(`thread ${thread.ordinal} "${thread.brief}" not done — ${outcome}`);
      return { outcome, handoff: null };
    }


    const handoffOut = this.summarizeHandoff(thread, steps, reports);
    await this.store.setThreadHandoffOut(thread.id, handoffOut);
    const droppedTasks = await this.store.dropOpenThreadTasks(thread.id).catch(() => 0);
    if (droppedTasks > 0) {
      this.logger.log(
        `thread ${thread.ordinal} — dropped ${droppedTasks} unreconciled open task(s) on done`,
      );
    }
    await this.store.setThreadStatus(thread.id, 'done');
    await this.store.setThreadCondition(thread.id, 'none').catch(() => undefined);
    this.logger.log(`thread ${thread.ordinal} done`);
    await this.recordMilestone(
      job.id,
      `thread:${thread.id}:done`,
      `Thread "${thread.brief}" finished building.` +
        (droppedTasks > 0 ? ` (${droppedTasks} unreconciled task(s) dropped)` : ''),
    );
    await this.post(route, `:white_check_mark: Thread done — *${thread.brief}*`);
    const stopped = await this.sandboxes.stopAllServices?.(job.id).catch(() => undefined);
    if (stopped && !stopped.ok) {
      this.logger.warn(`thread ${thread.ordinal} — service teardown skipped: ${stopped.reason}`);
    }
    return { outcome: 'done', handoff: handoffOut };
  }

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
    threadGroupType: ThreadType,
  ): Promise<void> {
    const spec = threadKindSpec(thread.kind);
    if (!spec.children) return;
    await this.store.setThreadStatus(thread.id, 'auto_fixing').catch(() => undefined);

    const channel = route.channel ?? job.repoId;

    const baseCtx: AutoFixContext = {
      worktreePath: sandbox.worktreePath,
      sandboxKey: jobHomeKey(job, 'autofix'),
      ...(sectionStartSha ? { gitRange: `${sectionStartSha}..HEAD` } : {}),
      intent: `${record?.overview ?? ''}\n\nSection: ${thread.brief}`.trim(),
      label: thread.brief,
      jobId: job.id,
      channel,
      orgId: job.orgId,
      repoId: job.repoId,
      autofixId: thread.id,
      scope: 'thread',
      gitAuth: await this.resolveTurnGitAuth(job.orgId, repo.projectRepo.gitUrl),
      ...(sandbox.containerId
        ? {
            containerId: sandbox.containerId,
            ...(sandbox.execUser ? { execUser: sandbox.execUser } : {}),
          }
        : {}),
    };
    const ctx = await this.autofix.ensureContextDiff(baseCtx).catch(() => baseCtx);

    if (!ctx.changedFiles?.length) {
      const already = await this.store.reviewChildren(thread.id);
      const notice = `No changes to review in this section (empty diff for "${thread.brief}") — this review was skipped.`;
      for (const c of already) {
        if (c.status === 'done') continue;
        const sub =
          c.kind === 'review_agent'
            ? {
                lensId: String((c.config as { lensId?: string }).lensId ?? c.id),
              }
            : { fix: true as const };
        await this.autofix.emitReviewNotice(ctx, sub, notice).catch(() => undefined);
        if (c.kind === 'review_agent') {
          await this.store.setThreadReviewFindings(c.id, []).catch(() => undefined);
        }
        await this.store.setThreadStatus(c.id, 'done').catch(() => undefined);
        await this.store.setThreadCondition(c.id, 'skipped').catch(() => undefined);
      }
      return;
    }

    const frameworkSkills = await this.skills
      .resolveReviewSkillsForThread(job.orgId, job.repoId, threadGroupType, ctx.changedFiles ?? [])
      .catch((err) => {
        this.logger.warn(`framework-skill resolution failed (no framework lens): ${err}`);
        return [] as { name: string; body: string }[];
      });
    const frameworkSkillNames = frameworkSkills.map((s) => s.name);

    const lenses = reviewAgentsForThread(threadGroupType, frameworkSkillNames);
    const childSpecs = [
      ...lenses.map((l) => ({
        kind: 'review_agent',
        brief: l.label,
        config:
          l.id === 'framework' ? { lensId: l.id, skills: frameworkSkillNames } : { lensId: l.id },
      })),
      ...spec.children({ id: thread.id, config: {} }),
    ];
    const children = await this.store
      .materializeReviewChildren({ id: thread.id, jobId: job.id, orgId: thread.orgId }, childSpecs)
      .catch((err) => {
        this.logger.warn(`review-children materialize failed (skipping review): ${err}`);
        return [] as ReviewChildThread[];
      });
    if (children.length === 0) return;

    const lensChildren = children.filter((c) => c.kind === 'review_agent');
    const postReview = children.find((c) => c.kind === 'review_fix');

    await this.postAutofixAnchor(job, route, {
      autofixId: thread.id,
      scope: 'thread',
      label: thread.brief,
      lensIds: lensChildren.map((c) => String((c.config as { lensId?: string }).lensId ?? c.id)),
    });

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

    if (postReview && postReview.status !== 'done') {
      await this.runPostReview(ctx, thread, postReview);
    }

    await this.recordMilestone(
      job.id,
      `thread:${thread.id}:autofix`,
      `Post-build review + fix pass ran over the diff for thread "${thread.brief}".`,
    );
  }

  private async runOneReviewLens(
    ctx: AutoFixContext,
    child: ReviewChildThread,
    frameworkBodies: { name: string; body: string }[] = [],
  ): Promise<void> {
    if (child.status === 'done') return;
    const lensId = String((child.config as { lensId?: string }).lensId ?? '');
    const lens = lensById(lensId);
    if (!lens) {
      this.logger.warn(`review-lens child ${child.id} has unknown lensId "${lensId}" — skipping`);
      await this.store.setThreadStatus(child.id, 'done').catch(() => undefined);
      await this.store.setThreadCondition(child.id, 'skipped').catch(() => undefined);
      return;
    }
    await this.store.setThreadStatus(child.id, 'executing').catch(() => undefined);
    await this.store.setThreadCondition(child.id, 'none').catch(() => undefined);
    try {
      const lensCtx = {
        ...(lens.scope === 'framework' ? { ...ctx, frameworkBodies } : ctx),
        threadId: child.id,
      };
      const findings = await this.autofix.runReviewLens(lensCtx, lens, {
        model: REVIEW_LENS_MODEL,
      });
      await this.store.setThreadReviewFindings(child.id, findings);
      await this.store.setThreadStatus(child.id, 'done');
      await this.store.setThreadCondition(child.id, 'none').catch(() => undefined);
    } catch (err) {
      this.logger.warn(`review lens "${lensId}" failed (continuing): ${err}`);
      await this.autofix
        .emitReviewNotice(ctx, { lensId }, `This review lens failed to run: ${shortReason(err)}`)
        .catch(() => undefined);
      await this.store.setThreadReviewFindings(child.id, []).catch(() => undefined);
      await this.store.setThreadCondition(child.id, 'failed').catch(() => undefined);
    }
  }

  private async runPostReview(
    ctx: AutoFixContext,
    thread: DriverThread,
    child: ReviewChildThread,
  ): Promise<void> {
    await this.store.setThreadStatus(child.id, 'executing').catch(() => undefined);
    try {
      const siblings = await this.store.reviewChildren(thread.id);
      const all = siblings
        .filter((c) => c.kind === 'review_agent')
        .flatMap((c) => c.reviewFindings ?? []);
      const minSeverity =
        (child.config as { minSeverity?: FindingSeverity }).minSeverity ?? 'medium';
      const deduped = dedupeFindings(all);
      const actionable = deduped.filter((f) => meetsSeverity(f.severity, minSeverity));
      if (actionable.length === 0) {
        await this.autofix
          .emitReviewNotice(
            ctx,
            { fix: true },
            'No findings met the fix threshold — nothing to fix.',
          )
          .catch(() => undefined);
        await this.store.setThreadStatus(child.id, 'done').catch(() => undefined);
        await this.store.setThreadCondition(child.id, 'none').catch(() => undefined);
        return;
      }
      await this.autofix.applyReviewFindings({ ...ctx, threadId: child.id }, actionable);
      await this.store.setThreadStatus(child.id, 'done');
      await this.store.setThreadCondition(child.id, 'none').catch(() => undefined);
    } catch (err) {
      this.logger.warn(`post-review fix failed (continuing): ${err}`);
      await this.autofix
        .emitReviewNotice(ctx, { fix: true }, `Post-review fix failed to run: ${shortReason(err)}`)
        .catch(() => undefined);
      await this.store.setThreadCondition(child.id, 'failed').catch(() => undefined);
    }
  }

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

  private async runTurnBounded(
    input: Parameters<TurnRunnerService['runTurn']>[0],
    label: string,
    deadline?: PausableDeadline,
  ): Promise<Awaited<ReturnType<TurnRunnerService['runTurn']>>> {
    const dl = deadline ?? new PausableDeadline(this.phaseTimeoutMs, label);
    dl.start(); // idempotent — arms the clock now (a caller-supplied deadline is armed exactly once here)
    try {
      return await Promise.race([this.turn.runTurn({ ...input, signal: dl.signal }), dl.expired]);
    } finally {
      dl.clear();
    }
  }

  private buildTurnBridge(
    job: Job,
    thread: DriverThread,
    route: JobRoute,
    deadline: PausableDeadline,
    sandbox: FeatureSandbox,
    record: DecisionRecord | null,
    sectionStartSha: string | undefined,
    rotationHolder: LegRotationRunState | null,
  ): ToolBridgeOptions {
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
        const openTasks = (
          await this.store.getThreadTasks(thread.id).catch(() => [] as TaskItem[])
        ).filter((t) => t.status === 'pending' || t.status === 'in_progress');
        const taskAdvisory = openTasks.length ? renderOpenTasksAdvisory(openTasks) : undefined;
        const asStrings = (v: unknown): string[] | undefined =>
          Array.isArray(v) && v.length ? v.map((x) => String(x).trim()).filter(Boolean) : undefined;
        const verification = Array.isArray(args['verification'])
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
            : undefined;
        const candidate: ThreadTerminalRecord = {
          status: 'done',
          summary,
          ...(asStrings(args['changes']) ? { changes: asStrings(args['changes']) } : {}),
          ...(verification && verification.length ? { verification } : {}),
          ...(asStrings(args['deviations']) ? { deviations: asStrings(args['deviations']) } : {}),
          ...(asStrings(args['gaps']) ? { gaps: asStrings(args['gaps']) } : {}),
        };
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
        const existing = await this.store.findOpenOperatorInputCard(job.id);
        const questionId =
          existing?.questionId ??
          (await this.store.openOperatorInputCard(job.id, question)).questionId;
        if (!existing) {
          await this.store.setThreadCondition(thread.id, 'paused').catch(() => undefined);
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
        deadline.pause();
        try {
          const answer = await this.pollOperatorAnswer(job.id, questionId, deadline.signal);
          await this.store.markOperatorInputDelivered(job.id, questionId).catch(() => undefined);
          await this.store.setThreadStatus(thread.id, 'executing').catch(() => undefined);
          await this.store.setThreadCondition(thread.id, 'none').catch(() => undefined);
          return { answer };
        } finally {
          deadline.resume();
        }
      },
    };

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

    if (thread.kind !== 'master_review') {
      tools.record_deviation = async (args) => {
        const note = String(args['note'] ?? '').trim();
        if (!note) {
          return {
            ok: false,
            error: 'note is required (one line: what you changed off-spec and why)',
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

    Object.assign(tools, makeTaskTools(this.taskSink, { kind: 'thread', id: thread.id }));

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

    if (steps.some((p) => p.status !== 'done' && p.batchOrdinal == null)) {
      await this.store.setBatchOrdinals(steps.map((p) => [p.id, 1]));
      this.logger.log(
        `thread ${thread.ordinal}: ${steps.length} step(s) as one orchestrator batch`,
      );
      steps = await this.store.stepsForThread(thread.id);
    }

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
      if (batch[0].commitSha) {
        this.logger.log(
          `batch [${batch.map((p) => p.ordinal).join(',')}] already committed — fast-forward`,
        );
        for (const p of batch) await this.store.setStepState(p.id, 'done', 'done');
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
        outcome = res.outcome;
        break;
      }
    }
    return { outcome, reports };
  }

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
    for (const p of steps) await this.store.setStepState(p.id, 'build', 'building');

    const channel = route.channel ?? job.repoId;
    const lane = laneFor('builder', thread.id);
    const batchOrdinal = anchor.batchOrdinal ?? null;
    const currentLeg = anchor.legOrdinal;
    const metaTag: Record<string, unknown> = {
      phaseId: anchor.id,
      legOrdinal: currentLeg,
      ...(batchOrdinal != null ? { batchOrdinal } : {}),
    };
    const nudge =
      thread.kind === 'builder' ? await this.resolveSkillNudge(job, thread, record) : [];
    const baseTask =
      thread.kind === 'master_review'
        ? renderMasterReviewTask(record, repo)
        : renderBatchTask(record, thread, steps, nudge);
    const legSeed = await this.store.getPendingLegSeed(anchor.id);
    const servicesBlock =
      thread.kind === 'builder' ? await this.renderLiveServicesBlock(job.id) : '';

    const priorTerm = isLastBatch ? await this.store.getTerminalRecord(thread.id) : null;

    let report: string;
    let outcome: ThreadOutcome = 'done';

    if (priorTerm?.status === 'done') {
      this.logger.log(
        `thread ${thread.ordinal} batch [${steps.map((p) => p.ordinal).join(',')}] — terminal record already 'done' from a prior attempt; resuming completion checks without re-kicking the orchestrator`,
      );
      report = priorTerm.summary;
    } else {
      const deadline = new PausableDeadline(this.phaseTimeoutMs, `batch "${label}"`);
      const rotationArmed =
        legRotationRule.enabled &&
        thread.kind === 'builder' &&
        threadKindSpec(thread.kind).engine === 'claude' &&
        (thread as DriverThread & { config?: { rotationCapped?: unknown } }).config
          ?.rotationCapped !== true;
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

      const reattachRow =
        this.turn.canReattach() && anchor.sessionId
          ? await this.findReattachableTurn(
              job.id,
              lane,
              anchor.id,
              (ctx) => ctx.commitNudge == null,
            )
          : null;
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
      if (!reattachRow && !anchor.sessionId) {
        if (isLastBatch) {
          await this.store.clearTerminalRecord(thread.id).catch(() => undefined);
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
            this.logger.warn(`build_anchor append failed for thread=${job.id}: ${err}`),
          );
      }

      let result: Awaited<ReturnType<TurnRunnerService['runTurn']>> | null = null;
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
          rotationArmed ? { state: rotationState, thresholds: rotationThresholds } : null,
          initialSeedIds,
        );
      }
      const rotated =
        rotationArmed && (await this.maybeRotateLeg(job, route, thread, anchor, rotationState));
      if (rotated) {
        await this.store
          .recordActiveLeg(anchor.id, result.session?.id ?? null, rotationState.peakTokens)
          .catch((err) =>
            this.logger.debug(`recordActiveLeg failed (display-only): ${shortReason(err)}`),
          );
        return { outcome: 'rotated', report: result.report };
      }
      report = result.report;

      if (rotationArmed) {
        await this.store
          .recordActiveLeg(anchor.id, result.session?.id ?? null, rotationState.peakTokens)
          .catch((err) =>
            this.logger.debug(`recordActiveLeg failed (display-only): ${shortReason(err)}`),
          );
      }

      const deviations = extractDeviations(report);
      if (deviations.length) {
        await this.post(
          route,
          `:warning: Off-spec changes in *${label}*:\n${deviations.map((d) => `• ${d}`).join('\n')}`,
        );
      }


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
      return { outcome, report };
    }

    const committed = await this.ensureCommitted(job, thread, sandbox, anchor, lane, channel, repo);
    if (!committed.ok) {
      this.logger.warn(`thread ${thread.ordinal} — ${committed.detail} (advisory; advancing done)`);
      const prior = await this.store.getTerminalRecord(thread.id).catch(() => null);
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

    const head = await this.git.headSha(sandbox.worktreePath).catch(() => null);
    const sha = head && head !== sectionStartSha ? head : NOTHING_COMMITTED;
    this.logger.log(
      `batch commit (writer-authored) ${sha === NOTHING_COMMITTED ? '(nothing)' : sha.slice(0, 8)}`,
    );
    await this.store.setStepCommit(anchor.id, sha);
    for (const p of steps) await this.store.setStepState(p.id, 'done', 'done');
    void this.git
      .currentBranch(sandbox.worktreePath)
      .then((live) =>
        live && live !== job.currentBranch ? this.store.setCurrentBranch(job.id, live) : undefined,
      )
      .catch((err) => this.logger.warn(`live-branch build backstop failed: ${err}`));
    return { outcome: 'done', report };
  }

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
      const reattachRow = this.turn.canReattach()
        ? await this.findReattachableTurn(job.id, lane, anchor.id, (ctx) => ctx.commitNudge != null)
        : null;
      if (reattachRow?.container_id) {
        const result = await this.reattachBatchTurn(
          job,
          thread,
          lane,
          {
            phaseId: anchor.id,
            commitNudge:
              (reattachRow.ctx as { commitNudge?: unknown } | null)?.commitNudge ?? 'reattach',
          },
          reattachRow,
          anchor.id,
        );
        if (result) continue;
      }
      if (attempt === COMMIT_NUDGE_MAX) break;
      const deadline = new PausableDeadline(this.phaseTimeoutMs, `commit nudge "${thread.brief}"`);
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
    const previewInstructions = thread.kind === 'builder' ? await this.previewRecipeFor(job) : null;
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
          ...(spec.reasoningEffort ? { modelReasoningEffort: spec.reasoningEffort } : {}),
          task,
          auth: await this.creds.engineAuth(job.orgId, spec.engine),
          userMcpServers: await this.mcp.resolveForTurn(job.orgId, job.repoId, 'build'),
          skills: await this.skills.resolveForTurn(job.orgId, job.repoId, 'build'),
          ...(repoConventions ? { repoConventions } : {}),
          ...(previewInstructions ? { previewInstructions } : {}),
          gitAuth: await this.resolveTurnGitAuth(job.orgId, repo.projectRepo.gitUrl),
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
      result.usage ? { usage: result.usage, credentialId: result.credentialId ?? null } : undefined,
    );
    return result;
  }

  private async findReattachableTurn(
    jobId: string,
    lane: string,
    anchorStepId: string,
    matchCtx: (ctx: Record<string, unknown>) => boolean = () => true,
  ): Promise<ActiveTurnEntity | null> {
    const rows = await this.turnRegistry.listRunning().catch((err) => {
      this.logger.warn(`reattach lookup failed (will kick a fresh turn): ${err}`);
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
      const reattachCredentialId = (row.ctx as { credentialId?: string } | null)?.credentialId;
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
        ...(toolBridge ? { toolBridge } : {}),
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
        this.logger.warn(`re-attach turn ${row.turn_id} detached — leaving it for the next boot`);
        throw err;
      }
      if (isSessionLimitError(err)) {
        await harness.abort();
        throw err;
      }
      await harness.abort();
      await this.turnRegistry.finalize(row.turn_id, 'failed').catch(() => undefined);
      this.logger.warn(`re-attach turn ${row.turn_id} failed; re-running the batch: ${err}`);
      return null;
    }
  }

  private async foldLegTaskWithSeeds(
    job: Job,
    thread: DriverThread,
    _anchorId: string,
    legSeed: string | null,
    baseTask: AgentMessage,
    servicesBlock: string,
  ): Promise<{ task: AgentMessage; seedIds: string[] }> {
    const drainable = thread.kind === 'builder' && threadKindSpec(thread.kind).engine === 'claude';
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
    const combinedSeed = [legSeed, String(composed)].filter(Boolean).join('\n\n---\n\n');
    return {
      task: foldLegTurn(combinedSeed, baseTask, servicesBlock),
      seedIds,
    };
  }

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
    rotation: {
      state: LegRotationRunState;
      thresholds: LegRotationThresholds;
    } | null,
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
    const spec = threadKindSpec(thread.kind);
    const engine: SessionEngine = spec.engine;
    const steerable = engine === 'claude' && thread.kind === 'builder';
    const repoConventions = await this.repoConventionsFor(job);
    const previewInstructions = thread.kind === 'builder' ? await this.previewRecipeFor(job) : null;
    const systemPrompt = renderAgentPrompt(spec.agent, {
      jobKind: job.kind,
      settings: { repoConventions },
      turnPhase: 'batch',
      ...(previewInstructions ? { previewInstructions } : {}),
    });
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
            chunkKey: chunkKey.rotNudge(anchor.id, legOrdinal, sig.phase, sig.reminderIndex),
            reminderKind: 'context_pressure',
          })
          .catch((err) =>
            this.logger.debug(`rotation nudge row failed (display-only): ${shortReason(err)}`),
          );
      },
    );
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
          ...(spec.reasoningEffort ? { modelReasoningEffort: spec.reasoningEffort } : {}),
          task,
          auth: await this.creds.engineAuth(job.orgId, engine),
          userMcpServers: await this.mcp.resolveForTurn(job.orgId, job.repoId, 'build'),
          skills: await this.skills.resolveForTurn(job.orgId, job.repoId, 'build'),
          ...(repoConventions ? { repoConventions } : {}),
          ...(previewInstructions ? { previewInstructions } : {}),
          gitAuth: await this.resolveTurnGitAuth(job.orgId, repo.projectRepo.gitUrl),
          richStream: true, // full transcript (thinking + tool calls/results + subagent forwarding)
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
          toolBridge,
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
            if (e.kind === 'usage' && e.parentToolUseId == null) {
              rotationWatch.observe(e);
              if (rotation && e.contextTokens != null) {
                rotation.state.peakTokens = Math.max(
                  rotation.state.peakTokens ?? 0,
                  e.contextTokens,
                );
              }
            }
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
      await harness.abort();
      throw err;
    }
    await harness.finish(
      result.report,
      result.usage ? { usage: result.usage, credentialId: result.credentialId ?? null } : undefined,
    );
    return result;
  }

  private async maybeRotateLeg(
    job: Job,
    route: JobRoute,
    thread: DriverThread,
    anchor: Step,
    state: LegRotationRunState,
  ): Promise<boolean> {
    const term = await this.store.getTerminalRecord(thread.id).catch(() => null);
    if (term?.status === 'done') return false;

    const handoff = state.handoff;
    if (!handoff) return false;

    const legCount = await this.store.builderLegCountForThreadGroup(thread.id).catch(() => 0);
    const rotationCapped = legCount >= MAX_LEGS_PER_THREAD_GROUP;
    if (rotationCapped) {
      this.logger.warn(
        `leg-rotation: thread ${thread.ordinal} hit MAX_LEGS_PER_THREAD_GROUP (${MAX_LEGS_PER_THREAD_GROUP}) builder legs — ` +
          `rotating once more to a capped final leg with rotation disabled`,
      );
    }

    const seed = await this.buildLegSeed(thread.id, handoff);
    const res = await this.store
      .completeLegRotation({
        anchorStepId: anchor.id,
        handoff,
        seed,
        ...(rotationCapped ? { rotationCapped: true } : {}),
        ...(state.peakTokens != null ? { contextTokensPeak: state.peakTokens } : {}),
      })
      .catch((err) => {
        this.logger.error(
          `leg-rotation: completeLegRotation failed for thread ${thread.ordinal}: ${err}`,
        );
        return null;
      });
    if (!res) return false; // nothing live to rotate (already rotated / raced), or the txn failed — don't loop

    await this.writeLegHandoffArtifact(job, res.fromLeg, handoff);

    this.logger.log(
      `leg-rotation: thread ${thread.ordinal} rotated Leg ${res.fromLeg}→${res.toLeg} ` +
        `(abandoned ${res.abandonedSessionId.slice(0, 8)}; handoff ${handoff.length} chars; ` +
        `peak ${state.peakTokens ?? '?'})`,
    );
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
        this.logger.debug(`rotation handoff row failed (display-only): ${shortReason(err)}`),
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
        this.logger.debug(`rotation seed row failed (display-only): ${shortReason(err)}`),
      );
    await this.post(
      route,
      `:recycle: Rotated *${thread.brief}* to a fresh session (Leg ${res.toLeg}) — its context was filling; ` +
        `work continues from a handoff with the in-progress files intact.`,
    ).catch(() => undefined);
    return true;
  }

  private async buildLegSeed(threadId: string, handoff: string): Promise<AgentMessage> {
    const tasks = await this.store.getThreadTasks(threadId).catch(() => [] as TaskItem[]);
    return composeLegSeed(handoff, renderOpenLegTasks(tasks));
  }

  private async renderLiveServicesBlock(jobId: string): Promise<string> {
    try {
      const dir = this.threadLifecycle.supervisorDirHost(jobId);
      if (!dir) return '';
      const markers = readServiceMarkers(dir);
      if (markers.length === 0) return '';
      const pgids = markers.map((m) => m.pgid).filter((p): p is number => p != null);
      const probe = await this.threadLifecycle.probeLiveness(jobId, pgids);
      const running = markers.filter((m) => serviceStatus(m, probe) === 'running');
      if (running.length === 0) return '';
      return renderRunningServicesNote(
        running.map((m) => ({
          name: m.name,
          port: m.port,
          url: m.port != null && m.expose ? (this.exposure?.urlFor(jobId, m.name) ?? null) : null,
        })),
      );
    } catch (err) {
      this.logger.debug(`renderLiveServicesBlock(${jobId.slice(0, 8)}) failed: ${err}`);
      return '';
    }
  }

  private async resolveSkillNudge(
    job: Job,
    thread: DriverThread,
    record: DecisionRecord | null,
  ): Promise<{ name: string; reason: string }[]> {
    try {
      const groupId = thread.threadGroupId;
      const prior = await this.store.readGroupSkillNudge(groupId);
      if (prior) return prior.skills;

      const resolved = await this.skills.resolveForTurn(job.orgId, job.repoId, 'build');
      if (!resolved.length) {
        await this.store.persistGroupSkillNudge(groupId, {
          skills: [],
          at: new Date().toISOString(),
        });
        return [];
      }

      const decisions = record?.decisions.length
        ? record.decisions.map((d) => `- [${d.decisionClass}] ${d.title}: ${d.ruling}`).join('\n')
        : '(none)';
      const context = [
        record?.overview ?? '',
        `Thread: ${thread.brief}`,
        `Locked decisions:\n${decisions}`,
      ].join('\n');

      const picked = await this.skillNudge.select({
        context,
        skills: resolved.map(({ name, description }) => ({
          name,
          description,
        })),
        orgId: job.orgId,
      });
      await this.store.persistGroupSkillNudge(groupId, {
        skills: picked,
        at: new Date().toISOString(),
      });
      return picked;
    } catch (err) {
      this.logger.debug(`resolveSkillNudge(${thread.id.slice(0, 8)}) failed: ${err}`);
      return [];
    }
  }

  private async writeLegHandoffArtifact(job: Job, leg: number, handoff: string): Promise<void> {
    try {
      const generated = join(this.threadLifecycle.contextDirHost(job.id, job.orgId), 'generated');
      await mkdir(join(generated, 'handoffs'), { recursive: true });
      await writeFile(join(generated, 'handoffs', `leg-${leg}.md`), `${handoff}\n`, 'utf8');
    } catch (err) {
      this.logger.debug(`leg handoff artifact write failed (display-only): ${shortReason(err)}`);
    }
  }

  private async writeDeviationsMd(job: Job): Promise<void> {
    try {
      const groups = await this.store.getJobDeviations(job.id);
      const generated = join(this.threadLifecycle.contextDirHost(job.id, job.orgId), 'generated');
      await mkdir(generated, { recursive: true });
      const body = groups.length
        ? groups
            .map((g) => {
              const lines = g.deviations.map((d) => `- ${d.note}  \n  _(${d.ts})_`).join('\n');
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

  private async finalizeBuild(
    job: Job,
    record: DecisionRecord | null,
    route: JobRoute,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
  ): Promise<void> {
    this.logger.log(`job=${job.id} all threads done — shipping`);
    await this.ship.ship({
      job,
      record,
      repo,
      sandbox,
      notify: (m) => this.post(route, m),
    });
  }


  private async ensureSandbox(job: Job): Promise<FeatureSandbox> {
    const ensured = await this.threadLifecycle.ensureContainer(job.id, job.orgId);
    if (!ensured) {
      throw new Error(
        `job=${job.id}: thread has no sandbox (unprovisioned or closed) — cannot build`,
      );
    }
    const branch = ensured.sandbox.branch; // the thread's feature branch is the source of truth
    if (job.featureBranch !== branch) await this.store.setFeatureBranch(job.id, branch);
    this.logger.log(
      `job=${job.id} using thread sandbox on ${branch}${ensured.wasReset ? ' (cold re-attach)' : ''}`,
    );
    return ensured.sandbox;
  }

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

  private summarizeHandoff(thread: DriverThread, steps: Step[], reports: string[]): string {
    const report = reports.filter(Boolean).join('\n\n').trim();
    if (report) {
      return `Thread "${thread.brief}" complete.\n\n${report}`.slice(0, 4000);
    }
    const built = steps.map((p) => p.title ?? p.brief).join('; ');
    return `Thread "${thread.brief}" complete. Built: ${built || '(see commits)'}.`;
  }

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
      .catch((err) => this.logger.warn(`autofix_anchor append failed for job=${job.id}: ${err}`));
  }
}


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
    this.expired = new Promise<never>((_resolve, reject) => {
      this.rejectExpired = reject;
    });
    this.expired.catch(() => undefined);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

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
      this.rejectExpired(new Error(`${this.label} exceeded PHASE_TIMEOUT_MS (${this.totalMs}ms)`));
    }, this.remaining);
  }

  pause(): void {
    if (!this.armed || this.paused || this.done) return;
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.startedAt));
  }

  resume(): void {
    if (!this.armed || !this.paused || this.done) return;
    this.paused = false;
    this.arm();
  }

  clear(): void {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

const NOTHING_COMMITTED = '(nothing)';

const COMMIT_NUDGE_MAX = 2;

const MAX_LEGS_PER_THREAD_GROUP = 8;

function asPlannedStep(step: Step): PlannedStep {
  return { title: step.title ?? step.brief, brief: step.brief };
}

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
  if (term?.gaps?.length) lines.push(``, `## Known gaps`, ...term.gaps.map((g) => `- ${g}`));
  if (term?.verification?.length) {
    lines.push(``, `## Verification run`);
    for (const v of term.verification) {
      lines.push(`- [${v.kind}] \`${v.command}\` → exit ${v.exitCode}`);
      if (v.outputTail) lines.push('```', v.outputTail, '```');
    }
  }
  return lines.join('\n') + '\n';
}

export function extractOrientation(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(/<repo-orientation>([\s\S]*?)<\/repo-orientation>/i);
  const body = m?.[1]?.trim();
  if (!body) return null;
  return body.length > 1500 ? `${body.slice(0, 1500)}…` : body;
}

function jobHomeKey(job: Job, type: EngineHomeType): EngineHomeKey {
  return { orgId: job.orgId, repoId: job.repoId, jobId: job.id, type };
}

function shipGateApplies(job: Job): boolean {
  return job.kind === 'feature' || job.kind === 'bugfix';
}

function extractDeviations(report: string): string[] {
  return report
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^DEVIATION:/i.test(l))
    .map((l) => l.replace(/^DEVIATION:\s*/i, '').trim())
    .filter(Boolean);
}

export function shortReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const detail = msg
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' | ');
  return detail.length > 500 ? `${detail.slice(0, 497)}...` : detail || 'unknown error';
}

export function fmtReset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
