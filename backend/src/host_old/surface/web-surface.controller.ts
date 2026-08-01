import type { MessageEvent } from '@nestjs/common';
import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Patch,
  PayloadTooLargeException,
  Post,
  Put,
  Query,
  ServiceUnavailableException,
  Sse,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { InjectRepository } from '@nestjs/typeorm';
import { CurrentUser, Public } from '@dltech/jwt-auth/server';
import {
  isAutoApproveMode,
  modeApprovesPlan,
  modeApprovesShip,
  type AutoApproveMode,
} from '@workspace/shared';
import { Allow, IsOptional, IsString } from 'class-validator';
import { randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { Observable, catchError, defer, filter, from, map, merge, switchMap } from 'rxjs';
import { In, Not, Repository } from 'typeorm';
import type { ReviewComment } from '../../_shared/domain/composer-draft';
import type { JobKind } from '../../_shared/domain/job';
import { deriveNeedsYou } from '../../_shared/domain/job';
import { isReservedMcpName } from '../../_shared/mcp/reserved-mcp-names';
import { chunkKey } from '../../_shared/prompt-kit/harness/chunk-keys';
import type { AgentMessage } from '../../_shared/prompt-kit/message';
import { renderTurn, type TurnChunk } from '../../_shared/stimulus/chunk-vocabulary';
import { BrainGateway } from '../brain-gateway/brain-gateway.service';
import { AgentSessionManager } from '../brain/agent-session-manager.service';
import { BrainStoreService } from '../brain/brain-store.service';
import { JitHostExecutor } from '../brain/jit-host-executor';
import { JOB_DISPATCHER, type JobDispatcher } from '../brain/job-dispatcher';
import { LeaderElectionService } from '../cluster/leader-election.service';
import { ConventionProfileResolver } from '../conventions/convention-profile.resolver';
import { DriverApprovalGateway } from '../driver-approval-gateway/driver-approval-gateway.service';
import { AutoMergeService } from '../driver/auto-merge.service';
import { DriverStoreService } from '../driver/driver-store.service';
import { JobLifecycleService } from '../driver/job-lifecycle.service';
import { resolveSafeTarget } from '../driver/worktree-path-guard';
import { ExposureService } from '../exposure/exposure.service';
import { readServiceMarkers, serviceStatus } from '../exposure/service-markers';
import { LocalGitService } from '../git/local-git.service';
import { JobBootstrapService } from '../job-bootstrap/job-bootstrap.service';
import { JobDependencyService } from '../job-deps/job-dependency.service';
import { McpProbeService } from '../mcp/mcp-probe.service';
import type { McpHeaderInput, McpServerInput } from '../mcp/mcp-server.store';
import { McpServerStore } from '../mcp/mcp-server.store';
import { UsageEventBus } from '../onboarding/usage-event-bus';
import { WorkspaceConfigStore } from '../onboarding/workspace-config.store';
import { WorkspaceSecretFileStore } from '../onboarding/workspace-secret.store';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { OrganizationService } from '../org/organization.service';
import { DB_CONNECTION } from '../persistence/database.module';
import type { McpSurface } from '../persistence/entities';
import {
  JobEntity,
  RepoEntity,
  SubagentEntity,
  TranscriptMessageEntity,
  UserEntity,
} from '../persistence/entities';
import {
  answeredQuestionBody,
  batchAnswerBody,
  fileUploaded,
  mcpSecretStored,
  secretStored,
} from '../prompt-kit/harness/seed-catalog';
import {
  AttachmentCardItem,
  renderReviewSeedXml,
  renderUploadedFilesXml,
} from '../prompt-kit/messages/first-turn-seeds';
import { RealtimeService } from '../realtime/realtime.service';
import { realtimeDisabledStream, subscriptionToObservable } from '../realtime/sse-observable';
import { ServiceLivenessProbe } from '../sandbox/sandbox-provider.port';
import { SkillFileWriter } from '../skills/skill-file-writer.service';
import { parseSkillFrontmatter } from '../skills/skill-frontmatter';
import { SkillInstallerService } from '../skills/skill-installer.service';
import { WorkspaceSkillStore } from '../skills/workspace-skill.store';
import { StimulusIntake } from '../stimulus/stimulus-intake.service';
import { StimulusStoreService } from '../stimulus/stimulus-store.service';
import {
  AMEND_APPROVE_ACTION_ID,
  AMEND_DISMISS_ACTION_ID,
  APPROVE_ACTION_ID,
  DB_WRITE_APPROVE_ACTION_ID,
  DB_WRITE_DENY_ACTION_ID,
  DENY_ACTION_ID,
  MERGE_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
  RETRACT_SHIP_ACTION_ID,
  SHIP_ACTION_ID,
} from './approval-blocks';
import {
  ATTACHMENT_EXTS,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MIME_BY_EXT,
  safeUploadName,
  type UploadedAttachment,
} from './attachment-upload';
import { SYSTEM_SEED_AUTHOR } from './chat-surface.port';
import type {
  DraftAttachmentDto,
  DraftPayloadWire,
  DraftStagedAnswerWire,
} from './composer-draft.service';
import { ComposerDraftService } from './composer-draft.service';
import { buildDiffSummary, parseGitDiff, type JobDiff, type JobDiffSummary } from './job-diff';
import { JobTitleService } from './job-title.service';
import { LiveTurnStore } from './live-turn-store';
import { closeTailFd, nextTailFrame, openTailFd, readServiceLogTail } from './service-log-tail';
import { ThreadInputService } from './thread-input.service';
import { parseWebApprovalMeta } from './web-approval-card';
import type { WebFileRequestCard } from './web-file-request-card';
import type { McpProposalServer } from './web-mcp-proposal-card';
import type { WebQuestionCard } from './web-question-card';
import type { WebSecretInputCard } from './web-secret-input-card';
import type { WebOutboundMessage } from './web-surface';
import { WebSurface } from './web-surface';

const VALID_ACTION_IDS = new Set([
  APPROVE_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
  DENY_ACTION_ID,
  SHIP_ACTION_ID,
  RETRACT_SHIP_ACTION_ID,
  AMEND_APPROVE_ACTION_ID,
  AMEND_DISMISS_ACTION_ID,
  MERGE_ACTION_ID,
  DB_WRITE_APPROVE_ACTION_ID,
  DB_WRITE_DENY_ACTION_ID,
]);
function operatorAuthor(user: UserEntity): {
  authorId: string;
  authorName: string;
} {
  return { authorId: user.id, authorName: user.name?.trim() || user.email };
}

export interface ContextFile {
  name: string;
  size: number;
  mtime: string;
}

export interface ContextFileContent {
  name: string;
  path: string;
  size: number;
  mtime: string;
  encoding: 'text' | 'base64';
  mime: string;
  content: string;
}

const MAX_CONTEXT_FILE_BYTES = 2 * 1024 * 1024;

const MAX_DIFF_BYTES = 2_000_000;

export interface ServiceInfo {
  id: string;
  name: string;
  cmd: string;
  pid: number | null;
  pgid: number | null;
  startedAt: string | null;
  port: number | null;
  url: string | null;
  logBytes: number;
  logUpdatedAt: string | null;
  status: 'running' | 'stopped' | 'unknown';
}

const SERVICE_ID_RE = /^[a-z0-9_-]+$/;
const LIVENESS_MEMO_TTL_MS = 2_500;
const MAX_SERVICE_LOG_TAIL_BYTES = 512 * 1024;
const SERVICE_LOG_POLL_MS = 750;

function resolveContextFilePath(root: string, relPath: string): string {
  const cleaned = relPath.replace(/^[/\\]+/, '');
  const abs = resolve(root, cleaned);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (!abs.startsWith(rootWithSep)) {
    throw new BadRequestException('path escapes the context directory');
  }
  const bucket = relative(root, abs).split(sep)[0];
  if (
    bucket !== 'specs' &&
    bucket !== 'generated' &&
    bucket !== 'artifacts' &&
    bucket !== 'evidence'
  ) {
    throw new BadRequestException(
      'path must be inside specs/, generated/, artifacts/, or evidence/',
    );
  }
  return abs;
}

function listContextBucket(dir: string, prefix = '', depth = 0): ContextFile[] {
  if (depth > 4) return [];
  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // bucket not created yet
  }
  const out: ContextFile[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    try {
      if (e.isDirectory()) {
        out.push(...listContextBucket(join(dir, e.name), rel, depth + 1));
      } else if (e.isFile()) {
        const st = statSync(join(dir, e.name));
        out.push({ name: rel, size: st.size, mtime: st.mtime.toISOString() });
      }
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

class CreateThreadDto {
  @IsOptional()
  @IsString()
  firstMessage?: string;
  @IsOptional()
  @IsString()
  title?: string;
  @IsOptional()
  @IsString()
  baseBranch?: string;
  @IsOptional()
  @IsString()
  kind?: string;
  @Allow()
  prNumber?: string | number;
  @IsOptional()
  @IsString()
  autoApproveMode?: string;
  @Allow()
  autoMerge?: boolean;
  @Allow()
  dependsOn?: string | string[];
}

const OPERATOR_JOB_KINDS: ReadonlySet<JobKind> = new Set<JobKind>(['feature', 'bugfix', 'review']);

function coerceOperatorKind(raw: string | undefined): JobKind | null {
  if (raw && OPERATOR_JOB_KINDS.has(raw as JobKind)) return raw as JobKind;
  return null;
}

type MessageInput =
  | { type: 'user'; text: string; lane?: string }
  | { type: 'answer_question'; questionId: string; answer: string }
  | {
      type: 'file_answered';
      requestId: string;
      filename: string;
      content: string;
    }
  | { type: 'secret_provided'; requestId: string; value: string };
class MessageBatchDto {
  @Allow()
  messages!: MessageInput[] | string;
}
interface ReviewCommentItemDto {
  file: string;
  quote: string;
  note?: string;
  lines?: {
    path: string;
    oldStart?: number;
    oldEnd?: number;
    newStart?: number;
    newEnd?: number;
    fragment: string;
  };
}
class ReviewCommentsDto {
  @Allow()
  items!: ReviewCommentItemDto[];
  @IsOptional()
  @IsString()
  message?: string;
}
class DraftPayloadDto {
  @IsString()
  text!: string;
  @Allow()
  stagedAnswers!: DraftStagedAnswerWire[];
  @Allow()
  comments!: ReviewComment[];
}
class RenameThreadDto {
  @IsString()
  title!: string;
}
class SetAutoApproveDto {
  @IsString()
  mode!: AutoApproveMode;
}
class SetAutoMergeDto {
  @Allow()
  autoMerge!: boolean;
}
function coerceBoolean(raw: unknown): boolean | undefined {
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  return undefined;
}
function toStringArray(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
}
class ApproveDto {
  @IsString()
  actionId!: string;
  @IsString()
  value!: string;
  @IsOptional()
  @IsString()
  note?: string;
  @IsOptional()
  @IsString()
  ruledBy?: string;
}
interface ApproveResult {
  ok: boolean;
  jobId?: string;
  message?: string;
}
class ProvideSecretDto {
  @IsString()
  requestId!: string;
  @IsString()
  value!: string;
}
const MAX_FILE_UPLOAD_BYTES = 512 * 1024;

function resolveUploadFilePath(root: string, relPath: string): string {
  const cleaned = relPath.replace(/^[/\\]+/, '');
  const abs = resolve(root, cleaned);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (!abs.startsWith(rootWithSep)) {
    throw new BadRequestException('path escapes the context directory');
  }
  if (relative(root, abs).split(sep)[0] !== 'uploads') {
    throw new BadRequestException('path must be inside uploads/');
  }
  return abs;
}
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_ITEMS = 50;

function requiredBatchString(value: unknown, field: string): string {
  const s = String(value ?? '').trim();
  if (!s) throw new BadRequestException(`${field} is required`);
  return s;
}

function requiredBatchValue(value: unknown, field: string): string {
  const s = String(value ?? '');
  if (!s) throw new BadRequestException(`${field} is required`);
  return s;
}

function normalizeMessageInput(item: unknown): MessageInput {
  if (item == null || typeof item !== 'object') {
    throw new BadRequestException('each message must be an object');
  }
  const raw = item as Record<string, unknown>;
  if (raw.type === 'user') {
    return {
      type: 'user',
      text: String(raw.text ?? ''),
      ...(raw.lane != null && raw.lane !== '' ? { lane: String(raw.lane) } : {}),
    };
  }
  if (raw.type === 'answer_question') {
    return {
      type: 'answer_question',
      questionId: requiredBatchString(raw.questionId, 'questionId'),
      answer: requiredBatchString(raw.answer, 'answer'),
    };
  }
  if (raw.type === 'file_answered') {
    return {
      type: 'file_answered',
      requestId: requiredBatchString(raw.requestId, 'requestId'),
      filename: String(raw.filename ?? 'upload').trim() || 'upload',
      content: requiredBatchValue(raw.content, 'content'),
    };
  }
  if (raw.type === 'secret_provided') {
    return {
      type: 'secret_provided',
      requestId: requiredBatchString(raw.requestId, 'requestId'),
      value: requiredBatchValue(raw.value, 'value'),
    };
  }
  throw new BadRequestException('unsupported message type');
}

interface ApplyResult {
  status: 'applied' | 'stale' | 'withdrawn' | 'noop' | 'notfound';
  notice?: AgentMessage;
  seedId?: string;
  kind?: 'question' | 'file' | 'secret';
  rehydrate?: boolean;
  withdrawnReason?: 'oauth_refused' | 'store_failed';
}

export type WebMessageSource =
  | 'operator'
  | 'atlas'
  | 'system_operator'
  | 'system_shared'
  | 'system_event'
  | 'system_notice'
  | 'system_reminder'
  | 'untrusted';

export function mapMessageSource(stored: unknown, isAtlas: boolean): WebMessageSource {
  if (stored === 'system_operator') return 'system_operator';
  if (stored === 'system_shared') return 'system_shared';
  if (stored === 'system_event') return 'system_event';
  if (stored === 'system_notice') return 'system_notice';
  if (stored === 'system_reminder') return 'system_reminder';
  if (stored === 'untrusted') return 'untrusted';
  return isAtlas ? 'atlas' : 'operator';
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function formatReviewComments(items: ReviewCommentItemDto[], message?: string): string {
  const out: string[] = [`<review-comments count="${items.length}">`];
  const span = (s?: number, e?: number): string | null =>
    s == null ? null : e != null && e !== s ? `${s}-${e}` : `${s}`;
  for (const item of items) {
    if (item.lines) {
      const attrs = [`file="${xmlEscape(item.lines.path)}"`];
      const oldSpan = span(item.lines.oldStart, item.lines.oldEnd);
      const newSpan = span(item.lines.newStart, item.lines.newEnd);
      if (oldSpan) attrs.push(`old-lines="${oldSpan}"`);
      if (newSpan) attrs.push(`new-lines="${newSpan}"`);
      out.push(`  <comment ${attrs.join(' ')}>`);
      out.push('    ```diff');
      for (const line of item.lines.fragment.split('\n')) out.push(`    ${line}`);
      out.push('    ```');
      if (item.note?.trim()) out.push(`    <note>${xmlEscape(item.note.trim())}</note>`);
      out.push('  </comment>');
      continue;
    }
    out.push(`  <comment file="${xmlEscape(item.file)}">`);
    out.push(`    <quote>${xmlEscape(item.quote)}</quote>`);
    if (item.note?.trim()) out.push(`    <note>${xmlEscape(item.note.trim())}</note>`);
    out.push('  </comment>');
  }
  if (message?.trim()) out.push(`  <message>${xmlEscape(message.trim())}</message>`);
  out.push('</review-comments>');
  return out.join('\n');
}

@Controller('web')
export class WebSurfaceController {
  private readonly logger = new Logger(WebSurfaceController.name);

  private static readonly MANUAL_RETRY_COOLDOWN_MS = 4_000;

  constructor(
    private readonly surface: WebSurface,
    private readonly liveTurns: LiveTurnStore,
    private readonly driverStore: DriverStoreService,
    private readonly threadLifecycle: JobLifecycleService,
    private readonly autoMerge: AutoMergeService,
    private readonly orgService: OrganizationService,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(TranscriptMessageEntity, DB_CONNECTION)
    private readonly messages: Repository<TranscriptMessageEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    @InjectRepository(SubagentEntity, DB_CONNECTION)
    private readonly subagents: Repository<SubagentEntity>,
    private readonly threadTitle: JobTitleService,
    private readonly usageBus: UsageEventBus,
    private readonly realtime: RealtimeService,
    private readonly election: LeaderElectionService,
    @Inject(JOB_DISPATCHER) private readonly dispatcher: JobDispatcher,
    private readonly secrets: WorkspaceSecretFileStore,
    private readonly store: BrainStoreService,
    private readonly brain: AgentSessionManager,
    private readonly mcpStore: McpServerStore,
    private readonly mcpProbe: McpProbeService,
    private readonly conventions: ConventionProfileResolver,
    private readonly skillStore: WorkspaceSkillStore,
    private readonly skillFiles: SkillFileWriter,
    private readonly skillInstaller: SkillInstallerService,
    private readonly git: LocalGitService,
    private readonly jobDeps: JobDependencyService,
    private readonly driverApproval: DriverApprovalGateway,
    private readonly intake: StimulusIntake,
    @Optional() private readonly exposure?: ExposureService,
    @Optional() private readonly jit?: JitHostExecutor,
    @Optional() private readonly configStore?: WorkspaceConfigStore,
    @Optional() private readonly jobBootstrap?: JobBootstrapService,
    @Optional() private readonly threadInput?: ThreadInputService,
    @Optional() private readonly brainGateway?: BrainGateway,
    @Optional() private readonly draftService?: ComposerDraftService,
    @Optional() private readonly stimulusStore?: StimulusStoreService,
  ) {}

  @Public()
  @Get('ping')
  ping(): { ok: boolean; surface: string } {
    return { ok: true, surface: this.surface.name };
  }

  @Get('jobs')
  async allThreads(@CurrentUser() user: UserEntity): Promise<unknown[]> {
    const orgs = await this.orgService.listForUser(user.id);
    if (orgs.length === 0) return [];
    const threads = await this.jobs.find({
      where: { org_id: In(orgs.map((o) => o.id)), status: Not('archived') },
      order: { created_at: 'DESC' },
    });
    return this.toInboxRows(threads, orgs);
  }

  @Get('jobs/archived')
  async archivedThreads(@CurrentUser() user: UserEntity): Promise<unknown[]> {
    const orgs = await this.orgService.listForUser(user.id);
    if (orgs.length === 0) return [];
    const threads = await this.jobs.find({
      where: { org_id: In(orgs.map((o) => o.id)), status: 'archived' },
      order: { archived_at: 'DESC' },
    });
    return this.toInboxRows(threads, orgs);
  }

  private async toInboxRows(
    threads: JobEntity[],
    orgs: Awaited<ReturnType<OrganizationService['listForUser']>>,
  ): Promise<unknown[]> {
    const repos = await this.repos.find({
      where: { org_id: In(orgs.map((o) => o.id)) },
    });
    const blockedIds = threads.filter((t) => t.status === 'blocked').map((t) => t.id);
    const blockersByJob = await this.jobDeps.blockersOfManyBlocked(blockedIds);
    const blockedPreviews =
      (await this.stimulusStore?.pendingLockedPreviews(blockedIds)) ??
      new Map<string, string | null>();
    const orgById = new Map(orgs.map((o) => [o.id, o]));
    const repoName = new Map(repos.map((r) => [`${r.org_id}:${r.id}`, r.name]));
    return threads.map((t) => {
      const org = orgById.get(t.org_id);
      return {
        jobId: t.id,
        title: t.title,
        origin: t.origin,
        kind: t.kind, // job kind ('feature'/'bugfix'/'onboarding'/'event'/'review'/null) — drives the web badge
        status: t.status,
        archivedAt: t.archived_at, // null unless archived — orders the collapsed "Archived" group
        halt: t.halt ?? null,
        activity: t.activity,
        halted: t.halted,
        shipping: t.status === 'running' && t.ship_review_approved_at != null,
        createdBy: t.created_by ?? null,
        blockedBy: blockersByJob.get(t.id) ?? [],
        blockedSeedMessage: blockedPreviews.get(t.id) ?? null,
        needsYou: deriveNeedsYou({
          status: t.status,
          activity: t.activity,
          openQuestion: t.open_question_count > 0,
          awaitingSecret: t.awaiting_secret_id != null || t.open_secret_count > 0,
          halted: t.halted || t.halt != null,
        }),
        createdAt: t.created_at,
        pr: t.pr_state
          ? {
              state: t.pr_state,
              number: t.pr_number,
              mergeable: t.pr_mergeable,
              url: t.pr_url,
            }
          : null,
        ciStatus: t.ci_status,
        ciCounts: t.ci_counts,
        portState: t.port_state,
        buildStagesDone: t.build_stages_done,
        buildStagesTotal: t.build_stages_total,
        sectionFirstEntered: t.section_first_entered ?? null,
        org: { id: t.org_id, slug: org?.slug, name: org?.name },
        repo: {
          id: t.repo_id,
          name: repoName.get(`${t.org_id}:${t.repo_id}`) ?? t.repo_id,
        },
      };
    });
  }

  @Sse('jobs/realtime')
  threadsRealtime(@CurrentUser() user: UserEntity): Observable<MessageEvent> {
    if (!this.realtime.available) return realtimeDisabledStream();
    return defer(async () => {
      const orgs = await this.orgService.listForUser(user.id);
      return this.realtime.openThreadSubscription({
        userId: user.id,
        orgIds: orgs.map((o) => o.id),
      });
    }).pipe(
      switchMap((sub) => subscriptionToObservable(sub)),
      catchError(() => realtimeDisabledStream()),
    );
  }

  @Get('orgs/:orgId/repos/:repoId/jobs')
  @UseGuards(OrgMembershipGuard)
  async listThreads(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
  ): Promise<unknown[]> {
    const rows = await this.jobs.find({
      where: { org_id: org.id, repo_id: repoId, status: Not('archived') },
      order: { created_at: 'DESC' },
    });
    const blockedIds = rows.filter((t) => t.status === 'blocked').map((t) => t.id);
    const blockersByJob = await this.jobDeps.blockersOfManyBlocked(blockedIds);
    const blockedPreviews =
      (await this.stimulusStore?.pendingLockedPreviews(blockedIds)) ??
      new Map<string, string | null>();
    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      origin: t.origin,
      status: t.status,
      halt: t.halt ?? null,
      activity: t.activity,
      halted: t.halted,
      createdBy: t.created_by ?? null,
      blockedBy: blockersByJob.get(t.id) ?? [],
      blockedSeedMessage: blockedPreviews.get(t.id) ?? null,
      needsYou: deriveNeedsYou({
        status: t.status,
        activity: t.activity,
        openQuestion: t.open_question_count > 0,
        awaitingSecret: t.awaiting_secret_id != null || t.open_secret_count > 0,
        halted: t.halted || t.halt != null,
      }),
      baseBranch: t.base_branch,
      createdAt: t.created_at,
    }));
  }

  @Post('orgs/:orgId/repos/:repoId/jobs')
  @UseGuards(OrgMembershipGuard)
  @UseInterceptors(
    FilesInterceptor('files', MAX_ATTACHMENTS, {
      limits: { fileSize: MAX_ATTACHMENT_BYTES },
    }),
  )
  async createJob(
    @CurrentOrg() org: CurrentOrgCtx,
    @CurrentUser() user: UserEntity,
    @Param('repoId') repoId: string,
    @Body() body: CreateThreadDto,
    @UploadedFiles() files?: UploadedAttachment[],
  ): Promise<{ jobId: string }> {
    const text = body?.firstMessage?.trim();
    if (!text && !files?.length) {
      throw new BadRequestException('firstMessage is required');
    }
    const repo = await this.requireRepo(repoId, org.id);
    const dependsOn = toStringArray(body.dependsOn);
    if (dependsOn.length > 0) {
      await this.jobDeps.assertDependenciesValid({
        orgId: org.id,
        repoId: repo.id,
        dependsOnJobIds: dependsOn,
      });
    }
    const placeholder = body.title ?? null;
    const kind = coerceOperatorKind(typeof body.kind === 'string' ? body.kind.trim() : undefined);
    const orgRow = await this.orgService.get(org.id);
    let autoApproveMode: AutoApproveMode;
    if (body.autoApproveMode === undefined) {
      autoApproveMode = orgRow?.default_auto_approve_mode ?? 'off';
    } else if (isAutoApproveMode(body.autoApproveMode)) {
      autoApproveMode = body.autoApproveMode;
    } else {
      throw new BadRequestException('invalid autoApproveMode');
    }
    let autoMerge: boolean;
    const mergeCoerced = coerceBoolean(body.autoMerge);
    if (body.autoMerge === undefined) {
      autoMerge = orgRow?.default_auto_merge ?? false;
    } else if (mergeCoerced !== undefined) {
      autoMerge = mergeCoerced;
    } else {
      throw new BadRequestException('invalid autoMerge');
    }
    const thread = await this.jobs.save(
      this.jobs.create({
        org_id: org.id,
        repo_id: repo.id,
        origin: 'control',
        surface_thread_ref: null,
        title: placeholder,
        base_branch: body.baseBranch ?? null,
        ...(kind ? { kind } : {}),
        ...(autoApproveMode !== 'off'
          ? { auto_approve_mode: autoApproveMode, auto_approve_by: user.id }
          : {}),
        ...(autoMerge
          ? {
              auto_merge: true,
              auto_merge_by: user.id,
            }
          : {}),
      }),
    );
    await this.jobBootstrap?.ensurePlanningThreadGroup(thread.id, org.id);
    const operatorText = text ?? '';
    const attach = files?.length ? await this.ingestAttachments(org.id, thread.id, files) : null;
    const prNumber = kind === 'review' ? Number(body.prNumber) : NaN;
    const prXml =
      kind === 'review' && Number.isInteger(prNumber) && prNumber > 0
        ? renderReviewSeedXml(prNumber, repo.slug)
        : null;
    const bodyText = [prXml, attach?.xml, operatorText].filter(Boolean).join('\n\n');
    let anyBlocked = false;
    try {
      for (const dependsOnJobId of dependsOn) {
        const { blocked } = await this.jobDeps.addDependency({
          orgId: org.id,
          repoId: repo.id,
          jobId: thread.id,
          dependsOnJobId,
          seed: bodyText,
        });
        anyBlocked ||= blocked;
      }
    } catch (err) {
      this.logger.warn(`web createJob: dependency wiring failed for ${thread.id}: ${err}`);
      throw new HttpException(
        {
          message:
            err instanceof Error ? err.message : 'failed to wire one or more dependsOn blockers',
          jobId: thread.id,
        },
        HttpStatus.CONFLICT,
      );
    }
    if (!anyBlocked) {
      this.surface.receiveFromClient(repo.id, bodyText, {
        orgId: org.id,
        threadTs: thread.id,
        ...operatorAuthor(user),
        ...(attach
          ? {
              card: {
                type: 'attachments_card',
                items: attach.items,
                ...(operatorText ? { message: operatorText } : {}),
              },
            }
          : {}),
      });
    }

    void this.threadTitle
      .generateAndApply(thread.id, org.id, repo.id, operatorText || 'Attached files', placeholder)
      .catch((err) => this.logger.warn(`title gen dispatch failed for ${thread.id}: ${err}`));
    this.logger.log(`web created thread ${thread.id} on ${org.id}/${repo.id}`);
    return { jobId: thread.id };
  }

  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/messages')
  @UseGuards(OrgMembershipGuard)
  async messageHistory(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<unknown[]> {
    await this.requireThread(jobId, org.id);
    const rows = await this.messages
      .createQueryBuilder('m')
      .where('m.job_id = :jobId', { jobId })
      .orderBy('COALESCE(m.order_at, m.delivered_at, m.created_at)', 'ASC')
      .addOrderBy('m.created_at', 'ASC')
      .addOrderBy('m.id', 'ASC')
      .getMany();
    // Join the spawned subagents so each anchor (Task launching) message carries its subagent's AUTHORITATIVE
    // status — the web keys the durable card's running/done off this instead of the launch-ack heuristic. The
    // join is `subagents.parent_message_id = messages.id`; scoped by the threads present in this transcript.
    const threadIds = [...new Set(rows.map((m) => m.thread_id))];
    const subs = threadIds.length
      ? await this.subagents.find({ where: { thread_id: In(threadIds) } })
      : [];
    const subByParentMsg = new Map(subs.map((s) => [s.parent_message_id, s]));
    return rows.map((m) => ({
      id: m.id,
      threadId: m.thread_id,
      subagentId: m.subagent_id,
      ts: m.ts,
      author: m.author,
      authorId: m.author_id,
      isAtlas: m.author_bot_id != null,
      source: mapMessageSource(
        (m.meta as { source?: unknown } | null)?.source,
        m.author_bot_id != null,
      ),
      text: m.text,
      kind: m.kind,
      ...(m.card ? { card: m.card } : {}),
      ...(m.meta ? { meta: m.meta } : {}),
      ...(subByParentMsg.has(m.id)
        ? {
            subagentStatus: subByParentMsg.get(m.id)!.status,
            subagentEndedAt: subByParentMsg.get(m.id)!.ended_at?.toISOString() ?? null,
          }
        : {}),
      postedAt: m.created_at,
      stimulusId: m.stimulus_id,
      deliveredAt: m.delivered_at,
      // Effective render-order override (mid-turn pure-UI notices only) — see transcript_messages.order_at.
      // The client falls back to deliveredAt then postedAt when absent.
      orderAt: m.order_at,
    }));
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/message')
  @UseGuards(OrgMembershipGuard)
  @UseInterceptors(
    FilesInterceptor('files', MAX_ATTACHMENTS, {
      limits: { fileSize: MAX_ATTACHMENT_BYTES },
    }),
  )
  async postMessage(
    @CurrentOrg() org: CurrentOrgCtx,
    @CurrentUser() user: UserEntity,
    @Param('jobId') jobId: string,
    @Body() body: MessageBatchDto,
    @UploadedFiles() files?: UploadedAttachment[],
  ): Promise<{
    ok: boolean;
    ts: string;
    results: Array<{ id: string; status: string }>;
  }> {
    let rawMessages: unknown = body?.messages;
    if (typeof rawMessages === 'string') {
      try {
        rawMessages = JSON.parse(rawMessages);
      } catch {
        throw new BadRequestException('messages must be valid JSON');
      }
    }
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      throw new BadRequestException('messages must be a non-empty array');
    }
    if (rawMessages.length > MAX_BATCH_ITEMS) {
      throw new BadRequestException(`message batch may contain at most ${MAX_BATCH_ITEMS} items`);
    }
    const inputs = rawMessages.map((m) => normalizeMessageInput(m));
    const totalBytes = inputs.reduce(
      (n, m) =>
        n +
        (m.type === 'user'
          ? Buffer.byteLength(m.text, 'utf8')
          : m.type === 'file_answered'
            ? Buffer.byteLength(m.content, 'utf8')
            : m.type === 'secret_provided'
              ? Buffer.byteLength(m.value, 'utf8')
              : 0),
      0,
    );
    if (totalBytes > MAX_BATCH_BYTES) {
      throw new BadRequestException('message content exceeds size limit');
    }

    if (!this.election.isLeader()) {
      throw new ServiceUnavailableException('Atlas is handing off — retry momentarily.');
    }
    const thread = await this.requireThread(jobId, org.id);
    this.assertJobMutable(thread);
    if (thread.status === 'blocked') {
      throw new BadRequestException(
        'This job is blocked on another job; unblock it (or wait for its blocker to merge) before interacting.',
      );
    }

    const userItems = inputs.filter(
      (m): m is Extract<MessageInput, { type: 'user' }> => m.type === 'user',
    );
    if (userItems.length > 1) {
      throw new BadRequestException('at most one user message per submit');
    }
    const userItem = userItems[0];
    const cardItems = inputs.filter((m) => m.type !== 'user');

    const needsOwner = cardItems.some(
      (m) => m.type === 'file_answered' || m.type === 'secret_provided',
    );
    if (needsOwner && org.role !== 'owner') {
      throw new ForbiddenException('providing files/secrets requires an org owner');
    }

    const applied: Array<{
      id: string;
      notice: AgentMessage;
      kind: 'question' | 'file' | 'secret';
    }> = [];
    const results: Array<{ id: string; status: string }> = [];
    let wroteToStore = false;
    for (const item of cardItems) {
      const kind =
        item.type === 'answer_question'
          ? 'question'
          : item.type === 'file_answered'
            ? 'file'
            : 'secret';
      const id = item.type === 'answer_question' ? item.questionId : item.requestId;
      const r =
        item.type === 'answer_question'
          ? await this.applyQuestionAnswer(
              jobId,
              org.id,
              thread.repo_id,
              item.questionId,
              item.answer,
            )
          : item.type === 'file_answered'
            ? await this.applyFileUpload(
                jobId,
                org.id,
                thread.repo_id,
                item.requestId,
                item.filename,
                item.content,
              )
            : await this.applySecretProvide(
                jobId,
                org.id,
                thread.repo_id,
                item.requestId,
                item.value,
              );
      results.push({ id, status: r.status });
      if (r.status === 'applied' && r.seedId && r.notice) {
        applied.push({ id: r.seedId, notice: r.notice, kind });
        if (kind !== 'question') wroteToStore = true;
      }
    }
    if (wroteToStore) {
      await this.threadLifecycle.rehydrateThread(jobId, org.id).catch(() => undefined);
    }

    const resolveAttach = async () =>
      userItem
        ? files?.length
          ? await this.ingestAttachments(org.id, jobId, files)
          : ((await this.draftService?.promoteOnSend(org.id, jobId, user.id)) ?? null)
        : null;

    if (userItem && applied.length === 0) {
      const operatorText = userItem.text ?? '';
      const targetLane = userItem.lane;
      if (targetLane && targetLane !== 'main') {
        if (!this.threadInput) {
          throw new ServiceUnavailableException(
            'thread messaging is unavailable — retry momentarily.',
          );
        }
        if (!this.threadInput.canPost(targetLane)) {
          throw new BadRequestException(
            `thread "${targetLane}" is not accepting messages right now`,
          );
        }
        const attach = await resolveAttach();
        if (!operatorText && !attach) {
          throw new BadRequestException('text or an attachment is required');
        }
        const bodyText = attach ? `${attach.xml}\n\n${operatorText}` : operatorText;
        const author = operatorAuthor(user);
        await this.threadInput.postToThread(
          targetLane,
          {
            jobId,
            orgId: org.id,
            repoId: thread.repo_id,
            author: { id: author.authorId, displayName: author.authorName },
          },
          bodyText,
        );
        await this.clearDraftOnSend(org.id, jobId, user.id, results, {
          clearText: true,
        });
        return { ok: true, ts: new Date().toISOString(), results };
      }
      const attach = await resolveAttach();
      if (!operatorText && !attach) {
        throw new BadRequestException('text or an attachment is required');
      }
      const bodyText = attach ? `${attach.xml}\n\n${operatorText}` : operatorText;
      const ts = this.surface.receiveFromClient(thread.repo_id, bodyText, {
        orgId: org.id,
        threadTs: jobId,
        ...operatorAuthor(user),
        ...(attach
          ? {
              card: {
                type: 'attachments_card',
                items: attach.items,
                ...(operatorText ? { message: operatorText } : {}),
              },
            }
          : {}),
      });
      await this.clearDraftOnSend(org.id, jobId, user.id, results, {
        clearText: true,
      });
      return { ok: true, ts, results };
    }

    if (applied.length > 0 && !userItem) {
      const seedBody = batchAnswerBody(applied.map((a) => a.notice));
      const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, seedBody, {
        orgId: org.id,
        deliveredQuestionIds: applied.filter((a) => a.kind === 'question').map((a) => a.id),
        deliveredFileIds: applied.filter((a) => a.kind === 'file').map((a) => a.id),
        deliveredSecretIds: applied.filter((a) => a.kind === 'secret').map((a) => a.id),
        seedRow: {
          label: `The operator sent ${applied.length} answer(s)`,
          chunkKey: chunkKey.batch(
            jobId,
            applied.map((a) => a.id),
          ),
        },
      });
      await this.clearDraftOnSend(org.id, jobId, user.id, results, {
        clearText: false,
      });
      return { ok: true, ts, results };
    }

    if (applied.length > 0 && userItem) {
      const operatorText = userItem.text ?? '';
      const attach = await resolveAttach();
      const userBody = attach ? `${attach.xml}\n\n${operatorText}` : operatorText;
      const author = operatorAuthor(user);
      const chunks: TurnChunk[] = [
        ...applied.map((a) => ({
          kind: 'system_notice' as const,
          body: a.notice,
        })),
        {
          kind: 'user' as const,
          body: userBody,
          attrs: { name: author.authorName, at: new Date().toISOString() },
        },
      ];
      await this.intake.intakeComposedSeed(
        {
          orgId: org.id,
          repoId: thread.repo_id,
          jobId,
          body: renderTurn(chunks),
          operatorBubbleText: operatorText,
          ...(attach
            ? {
                card: {
                  type: 'attachments_card',
                  items: attach.items,
                  ...(operatorText ? { message: operatorText } : {}),
                },
              }
            : {}),
          deliveredQuestionIds: applied.filter((a) => a.kind === 'question').map((a) => a.id),
          deliveredFileIds: applied.filter((a) => a.kind === 'file').map((a) => a.id),
          deliveredSecretIds: applied.filter((a) => a.kind === 'secret').map((a) => a.id),
        },
        {
          author: {
            id: SYSTEM_SEED_AUTHOR.id,
            displayName: SYSTEM_SEED_AUTHOR.name,
          },
          bubbleAuthor: { id: author.authorId, displayName: author.authorName },
          replyRoute: { surfaceId: this.surface.name, jobRef: jobId },
        },
      );
      await this.clearDraftOnSend(org.id, jobId, user.id, results, {
        clearText: true,
      });
      return { ok: true, ts: new Date().toISOString(), results };
    }

    throw new BadRequestException('no valid messages to process');
  }

  private async clearDraftOnSend(
    orgId: string,
    jobId: string,
    userId: string,
    results: Array<{ id: string; status: string }>,
    opts: { clearText: boolean },
  ): Promise<void> {
    await this.draftService
      ?.clearOnSend(
        orgId,
        jobId,
        userId,
        results.filter((r) => r.status === 'applied').map((r) => r.id),
        { clearText: opts.clearText, clearComments: false },
      )
      .catch(() => undefined);
  }

  private async ingestAttachments(
    orgId: string,
    jobId: string,
    files: UploadedAttachment[],
  ): Promise<{ xml: string; items: AttachmentCardItem[] }> {
    if (files.length > MAX_ATTACHMENTS) {
      throw new BadRequestException(`at most ${MAX_ATTACHMENTS} attachments`);
    }
    const uploadsDir = join(this.threadLifecycle.contextDirHost(jobId, orgId), 'uploads');
    await mkdir(uploadsDir, { recursive: true });
    const items: AttachmentCardItem[] = [];
    for (const file of files) {
      const ext = extname(file.originalname).toLowerCase();
      if (!ATTACHMENT_EXTS.has(ext)) {
        throw new BadRequestException(`unsupported attachment type: ${ext || file.originalname}`);
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        throw new PayloadTooLargeException(
          `attachment too large (${file.size} bytes; limit ${MAX_ATTACHMENT_BYTES})`,
        );
      }
      const safeName = safeUploadName(file.originalname);
      await writeFile(join(uploadsDir, safeName), file.buffer);
      const mime = MIME_BY_EXT[ext]?.mime ?? '';
      items.push({
        name: basename(file.originalname).slice(0, 100) || safeName,
        path: `uploads/${safeName}`,
        kind: mime.startsWith('image/') ? 'image' : 'file',
        size: file.size,
      });
    }
    return { xml: renderUploadedFilesXml(items), items };
  }

  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/draft')
  @UseGuards(OrgMembershipGuard)
  async getDraft(
    @CurrentOrg() org: CurrentOrgCtx,
    @CurrentUser() user: UserEntity,
    @Param('jobId') jobId: string,
  ): Promise<{
    payload: DraftPayloadWire;
    attachments: DraftAttachmentDto[];
    updatedAt: string | null;
  }> {
    if (!this.draftService) {
      throw new ServiceUnavailableException('draft service unavailable');
    }
    await this.requireThread(jobId, org.id);
    return this.draftService.getDraft(org.id, jobId, user.id);
  }

  @Put('orgs/:orgId/repos/:repoId/jobs/:jobId/draft')
  @UseGuards(OrgMembershipGuard)
  async putDraft(
    @CurrentOrg() org: CurrentOrgCtx,
    @CurrentUser() user: UserEntity,
    @Param('jobId') jobId: string,
    @Body() body: DraftPayloadDto,
  ): Promise<{ ok: boolean }> {
    if (!this.draftService) {
      throw new ServiceUnavailableException('draft service unavailable');
    }
    await this.requireThread(jobId, org.id);
    const totalBytes =
      Buffer.byteLength(body?.text ?? '', 'utf8') +
      (body?.stagedAnswers ?? []).reduce(
        (n, a) =>
          n +
          Buffer.byteLength(
            a.kind === 'question' ? a.answer : a.kind === 'file' ? a.content : a.value,
            'utf8',
          ),
        0,
      );
    if (totalBytes > MAX_BATCH_BYTES) {
      throw new BadRequestException('draft content exceeds size limit');
    }
    await this.draftService.putDraft(org.id, jobId, user.id, {
      text: body?.text ?? '',
      stagedAnswers: body?.stagedAnswers ?? [],
      comments: body?.comments ?? [],
    });
    return { ok: true };
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/draft/attachments')
  @UseGuards(OrgMembershipGuard)
  @UseInterceptors(
    FilesInterceptor('files', MAX_ATTACHMENTS, {
      limits: { fileSize: MAX_ATTACHMENT_BYTES },
    }),
  )
  async addDraftAttachments(
    @CurrentOrg() org: CurrentOrgCtx,
    @CurrentUser() user: UserEntity,
    @Param('jobId') jobId: string,
    @UploadedFiles() files?: UploadedAttachment[],
  ): Promise<{ attachments: DraftAttachmentDto[] }> {
    if (!this.draftService) {
      throw new ServiceUnavailableException('draft service unavailable');
    }
    if (!files?.length) {
      throw new BadRequestException('at least one file is required');
    }
    await this.requireThread(jobId, org.id);
    const attachments: DraftAttachmentDto[] = [];
    for (const file of files) {
      attachments.push(await this.draftService.addAttachment(org.id, jobId, user.id, file));
    }
    return { attachments };
  }

  @Delete('orgs/:orgId/repos/:repoId/jobs/:jobId/draft/attachments/:attachmentId')
  @UseGuards(OrgMembershipGuard)
  async deleteDraftAttachment(
    @CurrentOrg() org: CurrentOrgCtx,
    @CurrentUser() user: UserEntity,
    @Param('jobId') jobId: string,
    @Param('attachmentId') attachmentId: string,
  ): Promise<{ ok: boolean }> {
    if (!this.draftService) {
      throw new ServiceUnavailableException('draft service unavailable');
    }
    await this.requireThread(jobId, org.id);
    await this.draftService.deleteAttachment(org.id, jobId, user.id, attachmentId);
    return { ok: true };
  }

  @Sse('drafts/realtime')
  draftsRealtime(@CurrentUser() user: UserEntity): Observable<MessageEvent> {
    if (!this.realtime.available) return realtimeDisabledStream();
    return defer(async () => {
      const orgs = await this.orgService.listForUser(user.id);
      return this.realtime.openDraftSubscription({
        userId: user.id,
        orgIds: orgs.map((o) => o.id),
      });
    }).pipe(
      switchMap((sub) => subscriptionToObservable(sub)),
      catchError(() => realtimeDisabledStream()),
    );
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/review-comments')
  @UseGuards(OrgMembershipGuard)
  async reviewComments(
    @CurrentOrg() org: CurrentOrgCtx,
    @CurrentUser() user: UserEntity,
    @Param('jobId') jobId: string,
    @Body() body: ReviewCommentsDto,
  ): Promise<{ ts: string }> {
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      throw new BadRequestException('items must be a non-empty array');
    }
    if (!this.election.isLeader()) {
      throw new ServiceUnavailableException('Atlas is handing off — retry momentarily.');
    }
    const thread = await this.requireThread(jobId, org.id);
    this.assertJobMutable(thread);
    const text = formatReviewComments(body.items, body.message);
    const card = {
      type: 'review_comments_card',
      items: body.items,
      ...(body.message?.trim() ? { message: body.message.trim() } : {}),
    };
    const ts = this.surface.receiveFromClient(thread.repo_id, text, {
      orgId: org.id,
      threadTs: jobId,
      ...operatorAuthor(user),
      card,
    });
    await this.draftService
      ?.clearOnSend(org.id, jobId, user.id, [], {
        clearText: true,
        clearComments: true,
      })
      .catch(() => undefined);
    return { ts };
  }

  @Sse('orgs/:orgId/repos/:repoId/events')
  @UseGuards(OrgMembershipGuard)
  events(@Param('orgId') orgId: string, @Param('repoId') repoId: string): Observable<MessageEvent> {
    const messages$ = this.surface.outbound$.pipe(
      filter((msg: WebOutboundMessage) => msg.channel === repoId),
      map((msg): MessageEvent => ({ data: { type: 'message', ...msg } })),
    );
    const snapshot$ = defer(() => from(this.liveTurns.snapshotsForRepo(repoId))).pipe(
      map(
        (s): MessageEvent => ({
          data: {
            type: 'stream',
            jobId: s.jobId,
            lane: s.lane,
            seq: s.seq,
            event: {
              kind: 'snapshot',
              blocks: s.blocks,
              active: s.active,
              startedAt: s.startedAt,
              retrying: s.retrying,
              contextBreakdown: s.contextBreakdown,
              contextTokens: s.contextTokens,
              contextModel: s.contextModel,
              contextLimit: s.contextLimit,
            },
          },
        }),
      ),
    );
    const live$ = this.liveTurns.stream$.pipe(
      filter((f) => f.channel === repoId),
      map(
        (f): MessageEvent => ({
          data: {
            type: 'stream',
            jobId: f.jobId,
            lane: f.lane,
            seq: f.seq,
            event: f.event,
          },
        }),
      ),
    );
    const meta$ = this.surface.threadMeta$.pipe(
      filter((m) => m.channel === repoId),
      map(
        (m): MessageEvent => ({
          data: { type: 'thread_meta', jobId: m.jobId, title: m.title },
        }),
      ),
    );
    const messagesChanged$ = this.surface.messagesChanged$.pipe(
      filter((m) => m.channel === repoId),
      map(
        (m): MessageEvent => ({
          data: { type: 'messages_changed', channel: repoId, jobId: m.jobId },
        }),
      ),
    );
    const usage$ = this.usageBus.stream$.pipe(
      filter((e) => e.orgId === orgId),
      map(
        (e): MessageEvent => ({
          data: { type: 'usage', orgId: e.orgId, usage: e.usage },
        }),
      ),
    );
    return merge(snapshot$, live$, messages$, meta$, messagesChanged$, usage$);
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/approve')
  @UseGuards(OrgMembershipGuard)
  async approve(
    @CurrentOrg() org: CurrentOrgCtx,
    @CurrentUser() user: UserEntity,
    @Param('jobId') jobId: string,
    @Body() body: ApproveDto,
  ): Promise<ApproveResult> {
    const { actionId, value, note } = body;
    if (!actionId || !value) {
      throw new BadRequestException('actionId and value are required');
    }
    if (!VALID_ACTION_IDS.has(actionId)) {
      throw new BadRequestException(`Unknown actionId: ${actionId}`);
    }
    const meta = parseWebApprovalMeta(value);
    if (!meta) throw new BadRequestException('value is not a valid ApprovalActionMeta JSON');
    if (meta.jobId !== jobId) {
      throw new BadRequestException('approval value does not match the route job');
    }
    const thread = await this.requireThread(meta.jobId, org.id);
    this.assertJobMutable(thread);
    if (
      actionId !== SHIP_ACTION_ID &&
      actionId !== RETRACT_SHIP_ACTION_ID &&
      actionId !== AMEND_APPROVE_ACTION_ID &&
      actionId !== AMEND_DISMISS_ACTION_ID &&
      actionId !== MERGE_ACTION_ID &&
      actionId !== DB_WRITE_APPROVE_ACTION_ID &&
      actionId !== DB_WRITE_DENY_ACTION_ID
    ) {
      const mismatch =
        thread.status !== 'awaiting_approval' ||
        !meta.decisionRecordId ||
        thread.decision_record_id !== meta.decisionRecordId;
      if (mismatch) {
        const message =
          'This plan changed or was withdrawn before the approval landed. Refresh and approve the current plan.';
        await this.postSystemOperatorNotice(thread.repo_id, thread.id, org.id, message);
        return { ok: false, jobId: meta.jobId, message };
      }
    }
    if (actionId === MERGE_ACTION_ID) {
      const merged = await this.driverApproval.resolveMerge(meta.jobId, user.id);
      if (!merged) throw new HttpException('Merge did not complete', HttpStatus.CONFLICT);
      return { ok: true, jobId: meta.jobId };
    }
    this.surface.receiveApprovalClick(actionId, value, user.id, note);
    return { ok: true, jobId: meta.jobId };
  }

  private async postSystemOperatorNotice(
    repoId: string,
    jobId: string,
    orgId: string,
    text: string,
  ): Promise<void> {
    const meta = { source: 'system_operator' };
    await this.surface.post(repoId, text, { threadTs: jobId, orgId, meta }).catch((err) => {
      this.logger.warn(`failed to post approval notice: ${err}`);
    });
    await this.store.appendSystemOperatorMessage(jobId, text, meta);
  }

  private async claimManualRetry(jobId: string): Promise<boolean> {
    const res = await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({ retry_last_attempt_at: () => 'now()' })
      .where('id = :jobId', { jobId })
      .andWhere(
        "(retry_last_attempt_at IS NULL OR retry_last_attempt_at < now() - (:cooldownMs || ' milliseconds')::interval)",
        { cooldownMs: WebSurfaceController.MANUAL_RETRY_COOLDOWN_MS },
      )
      .execute();
    return (res.affected ?? 0) > 0;
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/retry')
  @UseGuards(OrgMembershipGuard)
  async retry(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Query('force') force?: string,
  ): Promise<{ ok: boolean; status: string }> {
    const thread = await this.requireThread(jobId, org.id);
    this.assertJobMutable(thread);
    if (!thread.halt) {
      return { ok: false, status: thread.status };
    }
    if (force !== 'true') {
      const claimed = await this.claimManualRetry(jobId);
      if (!claimed) {
        throw new HttpException(
          {
            status: 'cooling_down',
            retryAfterMs: WebSurfaceController.MANUAL_RETRY_COOLDOWN_MS,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    await this.dispatcher.retry(jobId);
    return { ok: true, status: 'running' };
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/ship-without-review')
  @UseGuards(OrgMembershipGuard)
  async shipWithoutReview(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    this.assertJobMutable(await this.requireThread(jobId, org.id));
    return this.dispatcher.operatorShipWithoutReview(jobId);
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/threads/:threadId/retry-verification')
  @UseGuards(OrgMembershipGuard)
  async retryVerification(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('threadId') threadId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    this.assertJobMutable(await this.requireThread(jobId, org.id));
    return this.dispatcher.operatorRetryStuckThread(jobId, threadId);
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/threads/:threadId/accept')
  @UseGuards(OrgMembershipGuard)
  async acceptThread(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('threadId') threadId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    this.assertJobMutable(await this.requireThread(jobId, org.id));
    return this.dispatcher.operatorAcceptStuckThread(jobId, threadId);
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/retry-turn')
  @UseGuards(OrgMembershipGuard)
  async retryTurn(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Query('force') force?: string,
  ): Promise<{ ok: boolean }> {
    const thread = await this.requireThread(jobId, org.id);
    this.assertJobMutable(thread);
    if (force !== 'true') {
      const claimed = await this.claimManualRetry(jobId);
      if (!claimed) {
        throw new HttpException(
          {
            status: 'cooling_down',
            retryAfterMs: WebSurfaceController.MANUAL_RETRY_COOLDOWN_MS,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    await this.intake.intakeChat(
      {
        type: 'retry_resume_nudge',
        trust: 'system',
        id: randomUUID(),
        orgId: org.id,
        repoId: thread.repo_id,
        jobId,
        receivedAt: new Date().toISOString(),
        title: thread.title ?? undefined,
      },
      {
        author: {
          id: SYSTEM_SEED_AUTHOR.id,
          displayName: SYSTEM_SEED_AUTHOR.name,
        },
        replyRoute: { surfaceId: this.surface.name, jobRef: jobId },
      },
    );
    await this.store.setSessionResume(jobId, null, null);
    return { ok: true };
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/stop')
  @UseGuards(OrgMembershipGuard)
  async stop(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<{ stopped: boolean }> {
    this.assertJobMutable(await this.requireThread(jobId, org.id));
    const stopped = await this.brain.stopTurn(jobId);
    return { stopped };
  }

  private async applyQuestionAnswer(
    jobId: string,
    _orgId: string,
    _repoId: string,
    questionId: string,
    answer: string,
  ): Promise<ApplyResult> {
    const card = await this.messages.findOne({
      where: { job_id: jobId, ts: questionId, kind: 'card' },
    });
    const payload = card?.card as WebQuestionCard | undefined;
    if (!card || payload?.type !== 'question_card') return { status: 'notfound' };
    if (payload.deliveredAt) return { status: 'stale' };
    if (payload.withdrawnAt) return { status: 'withdrawn' };
    if (payload.answer != null) return { status: 'noop' };
    const { firstAnswer } = await this.store.markQuestionAnswered(jobId, questionId, answer);
    if (!firstAnswer) return { status: 'noop' };
    if (payload.origin === 'build') return { status: 'noop' };
    const question = (payload.question ?? '').trim();
    return {
      status: 'applied',
      notice: answeredQuestionBody(question, answer),
      seedId: questionId,
      kind: 'question',
    };
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/spin-up-preview')
  @UseGuards(OrgMembershipGuard)
  async spinUpPreview(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<{ ok: boolean; ts: string }> {
    if (!this.election.isLeader()) {
      throw new ServiceUnavailableException('Atlas is handing off — retry momentarily.');
    }
    const thread = await this.requireThread(jobId, org.id);
    this.assertJobMutable(thread);
    if (thread.status !== 'awaiting_ship_review') return { ok: false, ts: '' };
    const firstRequest = await this.driverStore.markPreviewRequested(jobId);
    if (!firstRequest) return { ok: true, ts: '' }; // idempotent double-click — already seeded.
    let previewInstructions: string | null | undefined;
    try {
      previewInstructions = await this.configStore?.getPreviewInstructions(org.id, thread.repo_id);
    } catch {
      previewInstructions = null;
    }
    await this.brainGateway?.seedPreviewOnPostBuild({
      jobId,
      orgId: org.id,
      repoId: thread.repo_id,
      previewInstructions: previewInstructions ?? null,
    });
    const ts = '';
    return { ok: true, ts };
  }

  private async applySecretProvide(
    jobId: string,
    orgId: string,
    repoId: string,
    requestId: string,
    value: string,
  ): Promise<ApplyResult> {
    const card = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const payload = card?.card as WebSecretInputCard | undefined;
    if (!card || payload?.type !== 'secret_input_card') return { status: 'notfound' };
    if (payload.ephemeral) return { status: 'noop' };
    if (payload.withdrawnAt) return { status: 'withdrawn' };
    if (payload.delivered_at) return { status: 'stale' };
    if (payload.provided_at != null) return { status: 'noop' };

    if (payload.mcp) {
      const { server, slot, key } = payload.mcp;
      const target = await this.mcpStore.rawRow(orgId, repoId, server).catch(() => null);
      if (target?.auth_kind === 'oauth') {
        await this.store.withdrawSecretRequest(
          jobId,
          requestId,
          'MCP server uses OAuth — not a fillable secret slot',
        );
        return { status: 'withdrawn', withdrawnReason: 'oauth_refused' };
      }
      const wrote = await this.mcpStore.setSecret(
        orgId,
        repoId,
        server,
        slot === 'header' ? 'headers' : 'env',
        key,
        value,
      );
      if (!wrote) {
        await this.store.withdrawSecretRequest(jobId, requestId, 'MCP server row is gone');
        return { status: 'withdrawn', withdrawnReason: 'store_failed' };
      }
      const row = await this.mcpStore.rawRow(orgId, repoId, server).catch(() => null);
      if (row) {
        const result = await this.mcpProbe.validate(row);
        await this.mcpStore.recordValidation(orgId, repoId, server, result).catch(() => undefined);
      }
      await this.store.markSecretProvidedPerCard(jobId, requestId);
      return {
        status: 'applied',
        notice: mcpSecretStored(key, server, slot),
        seedId: requestId,
        kind: 'secret',
      };
    }

    if (!payload.path) {
      throw new BadRequestException('secret request is missing its destination path');
    }
    await this.secrets.write(orgId, repoId, payload.path, value, payload.name);
    await this.store.markSecretProvidedPerCard(jobId, requestId);
    return {
      status: 'applied',
      notice: secretStored(payload.name, payload.path),
      seedId: requestId,
      kind: 'secret',
      rehydrate: true,
    };
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/provide-secret')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async provideSecret(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Body() body: ProvideSecretDto,
  ): Promise<{ ok: boolean; ts: string }> {
    const value = body?.value;
    if (!body?.requestId || value == null || value === '') {
      throw new BadRequestException('requestId and a non-empty value are required');
    }
    const thread = await this.requireThread(jobId, org.id);
    this.assertJobMutable(thread);
    const card = await this.messages.findOne({
      where: { job_id: jobId, ts: body.requestId, kind: 'card' },
    });
    const payload = card?.card as WebSecretInputCard | undefined;
    if (!card || payload?.type !== 'secret_input_card') {
      throw new BadRequestException('no such secret request on this thread');
    }
    const seedTransport = {
      author: {
        id: SYSTEM_SEED_AUTHOR.id,
        displayName: SYSTEM_SEED_AUTHOR.name,
      },
      replyRoute: { surfaceId: this.surface.name, jobRef: jobId },
    };

    if (payload.ephemeral) {
      if (thread.awaiting_secret_id !== body.requestId || payload.delivered_at) {
        return { ok: false, ts: '' };
      }
      if (payload.provided_at != null) {
        return { ok: true, ts: '' };
      }
      const deliverTo = payload.deliver_to ?? '';
      if (!deliverTo) {
        throw new BadRequestException('ephemeral request has no delivery target');
      }
      const delivered = await this.threadLifecycle.deliverEphemeralSecret({
        jobId,
        path: deliverTo,
        value: `${value.replace(/\r?\n$/, '')}\n`,
      });
      if (!delivered.ok) {
        await this.store.clearAwaitingSecret(jobId, body.requestId);
        await this.intake.intakeChat(
          {
            type: 'secret_provided',
            trust: 'system',
            id: randomUUID(),
            orgId: org.id,
            repoId: thread.repo_id,
            jobId,
            receivedAt: new Date().toISOString(),
            requestId: body.requestId,
            secretKind: 'ephemeral',
            name: payload.name,
            outcome: 'undelivered',
            reason: delivered.reason ?? 'the target process is not reading',
          },
          seedTransport,
        );
        return { ok: false, ts: new Date().toISOString() };
      }
      card.card = {
        ...(card.card ?? {}),
        provided_at: new Date().toISOString(),
      };
      await this.messages.save(card);
      await this.intake.intakeChat(
        {
          type: 'secret_provided',
          trust: 'system',
          id: randomUUID(),
          orgId: org.id,
          repoId: thread.repo_id,
          jobId,
          receivedAt: new Date().toISOString(),
          requestId: body.requestId,
          secretKind: 'ephemeral',
          name: payload.name,
          outcome: 'delivered',
        },
        seedTransport,
      );
      return { ok: true, ts: new Date().toISOString() };
    }

    const r = await this.applySecretProvide(jobId, org.id, thread.repo_id, body.requestId, value);
    if (r.status === 'applied') {
      if (r.rehydrate) {
        await this.threadLifecycle.rehydrateThread(jobId, org.id).catch(() => undefined);
      }
      await this.intake.intakeChat(
        payload.mcp
          ? {
              type: 'secret_provided',
              trust: 'system',
              id: randomUUID(),
              orgId: org.id,
              repoId: thread.repo_id,
              jobId,
              receivedAt: new Date().toISOString(),
              requestId: body.requestId,
              secretKind: 'mcp',
              outcome: 'stored',
              mcp: payload.mcp,
            }
          : {
              type: 'secret_provided',
              trust: 'system',
              id: randomUUID(),
              orgId: org.id,
              repoId: thread.repo_id,
              jobId,
              receivedAt: new Date().toISOString(),
              requestId: body.requestId,
              secretKind: 'durable',
              outcome: 'stored',
              name: payload.name,
              path: payload.path,
            },
        seedTransport,
      );
      return { ok: true, ts: new Date().toISOString() };
    }
    if (r.status === 'withdrawn' && r.withdrawnReason) {
      await this.intake.intakeChat(
        {
          type: 'secret_provided',
          trust: 'system',
          id: randomUUID(),
          orgId: org.id,
          repoId: thread.repo_id,
          jobId,
          receivedAt: new Date().toISOString(),
          requestId: body.requestId,
          secretKind: 'mcp',
          outcome: r.withdrawnReason,
          mcp: payload.mcp,
        },
        seedTransport,
      );
      return { ok: false, ts: new Date().toISOString() };
    }
    return { ok: r.status === 'noop', ts: '' };
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/mcp-proposals/:requestId/approve')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async approveMcpProposal(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('requestId') requestId: string,
  ): Promise<{ ok: boolean; committed: string[]; ts?: string }> {
    const thread = await this.requireThread(jobId, org.id);
    this.assertJobMutable(thread);
    const card = await this.store.getMcpProposalCard(jobId, requestId);
    if (!card) throw new BadRequestException('no such MCP proposal on this thread');
    if (card.approved_at) {
      return { ok: true, committed: card.committed ?? [] };
    }
    const dbScope = card.scope === 'org' ? '*' : thread.repo_id;

    if (card.mode === 'remove') {
      const removed: string[] = [];
      for (const name of card.removeNames ?? []) {
        if (!name || isReservedMcpName(name)) continue;
        await this.mcpStore.delete(org.id, dbScope, name);
        removed.push(name);
      }
      await this.store.markMcpProposalApproved(jobId, requestId, removed);
      await this.intake.intakeChat(
        {
          type: 'mcp_removed',
          trust: 'system',
          id: randomUUID(),
          orgId: org.id,
          repoId: thread.repo_id,
          jobId,
          receivedAt: new Date().toISOString(),
          requestId,
          removed,
          scope: card.scope,
        },
        {
          author: {
            id: SYSTEM_SEED_AUTHOR.id,
            displayName: SYSTEM_SEED_AUTHOR.name,
          },
          replyRoute: { surfaceId: this.surface.name, jobRef: jobId },
        },
      );
      return { ok: true, committed: removed, ts: new Date().toISOString() };
    }

    const committed: string[] = [];
    const needSecrets: string[] = [];
    const needConnect: string[] = [];
    let readyStatic = 0;
    for (const s of card.servers) {
      if (!s.name || isReservedMcpName(s.name)) continue;
      await this.mcpStore.write(org.id, dbScope, s.name, this.mcpProposalToInput(s));
      committed.push(s.name);
      if (s.authKind === 'oauth') {
        needConnect.push(s.name);
        continue;
      }
      const secretSlots = [
        ...(s.headers ?? []).filter((h) => h.secret).map((h) => `${s.name} header:${h.name}`),
        ...(s.env ?? []).filter((e) => e.secret).map((e) => `${s.name} env:${e.name}`),
      ];
      needSecrets.push(...secretSlots);
      if (s.transport !== 'stdio' && secretSlots.length === 0) {
        const row = await this.mcpStore.rawRow(org.id, dbScope, s.name).catch(() => null);
        if (row) {
          const result = await this.mcpProbe.validate(row);
          await this.mcpStore
            .recordValidation(org.id, dbScope, s.name, result)
            .catch(() => undefined);
        }
      }
      if (secretSlots.length === 0) readyStatic += 1;
    }
    await this.store.markMcpProposalApproved(jobId, requestId, committed);
    await this.intake.intakeChat(
      {
        type: 'mcp_approved',
        trust: 'system',
        id: randomUUID(),
        orgId: org.id,
        repoId: thread.repo_id,
        jobId,
        receivedAt: new Date().toISOString(),
        requestId,
        committed,
        scope: card.scope,
        needSecrets,
        needConnect,
        readyStatic,
      },
      {
        author: {
          id: SYSTEM_SEED_AUTHOR.id,
          displayName: SYSTEM_SEED_AUTHOR.name,
        },
        replyRoute: { surfaceId: this.surface.name, jobRef: jobId },
      },
    );
    return { ok: true, committed, ts: new Date().toISOString() };
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/convention-proposals/:requestId/approve')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async approveConventionProposal(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('requestId') requestId: string,
  ): Promise<{ ok: boolean; slug: string; ts?: string }> {
    const thread = await this.requireThread(jobId, org.id);
    this.assertJobMutable(thread);
    const card = await this.store.getConventionProposalCard(jobId, requestId);
    if (!card) throw new BadRequestException('no such convention proposal on this thread');
    if (card.approved_at) {
      return { ok: true, slug: card.slug };
    }
    await this.conventions.attach(org.id, thread.repo_id, card.slug);
    await this.store.markConventionProposalApproved(jobId, requestId);
    await this.intake.intakeChat(
      {
        type: 'convention_attached',
        trust: 'system',
        id: randomUUID(),
        orgId: org.id,
        repoId: thread.repo_id,
        jobId,
        receivedAt: new Date().toISOString(),
        requestId,
        profileName: card.profileName,
      },
      {
        author: {
          id: SYSTEM_SEED_AUTHOR.id,
          displayName: SYSTEM_SEED_AUTHOR.name,
        },
        replyRoute: { surfaceId: this.surface.name, jobRef: jobId },
      },
    );
    return { ok: true, slug: card.slug, ts: new Date().toISOString() };
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/convention-edit-proposals/:requestId/approve')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async approveConventionEditProposal(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('requestId') requestId: string,
  ): Promise<{ ok: boolean; slug: string; ts?: string }> {
    const thread = await this.requireThread(jobId, org.id);
    this.assertJobMutable(thread);
    const card = await this.store.getConventionEditProposalCard(jobId, requestId);
    if (!card) throw new BadRequestException('no such convention-edit proposal on this thread');
    if (card.approved_at) {
      return { ok: true, slug: card.slug };
    }
    await this.conventions.upsertProfile(org.id, card.slug, {
      name: card.name,
      body: card.body,
      detectHint: card.detectHint,
    });
    await this.store.markConventionEditProposalApproved(jobId, requestId);
    await this.intake.intakeChat(
      {
        type: 'convention_edited',
        trust: 'system',
        id: randomUUID(),
        orgId: org.id,
        repoId: thread.repo_id,
        jobId,
        receivedAt: new Date().toISOString(),
        requestId,
        mode: card.mode,
        name: card.name,
      },
      {
        author: {
          id: SYSTEM_SEED_AUTHOR.id,
          displayName: SYSTEM_SEED_AUTHOR.name,
        },
        replyRoute: { surfaceId: this.surface.name, jobRef: jobId },
      },
    );
    return { ok: true, slug: card.slug, ts: new Date().toISOString() };
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/skill-proposals/:requestId/approve')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async approveSkillProposal(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('requestId') requestId: string,
  ): Promise<{ ok: boolean; name: string; ts?: string }> {
    const thread = await this.requireThread(jobId, org.id);
    this.assertJobMutable(thread);
    const card = await this.store.getSkillProposalCard(jobId, requestId);
    if (!card) throw new BadRequestException('no such skill proposal on this thread');
    if (card.approved_at) {
      return { ok: true, name: card.name };
    }
    const dbScope = card.scope === 'org' ? '*' : card.repoId;
    const ALL_SURFACES: McpSurface[] = ['brain', 'build', 'review'];
    if (card.mode === 'remove') {
      await this.skillStore.delete(org.id, dbScope, card.name);
      this.skillFiles.removeSkillDir(org.id, dbScope, card.name);
    } else if (card.mode === 'install') {
      await this.skillInstaller.install({
        orgId: org.id,
        scope: dbScope,
        sourceUrl: card.sourceUrl ?? '',
        ref: card.sourceRef,
        subpath: card.sourceSubpath,
        surfaces: ALL_SURFACES,
      });
    } else {
      const srcDir = card.stagingPath;
      if (!srcDir || !existsSync(join(srcDir, 'SKILL.md'))) {
        throw new BadRequestException(
          'the authored skill draft is missing — ask the brain to propose it again',
        );
      }
      const fm = parseSkillFrontmatter(readFileSync(join(srcDir, 'SKILL.md'), 'utf8'));
      this.skillFiles.vendorDir(srcDir, org.id, dbScope, card.name);
      await this.skillStore.write(org.id, dbScope, card.name, {
        description: card.description,
        provenance: 'custom',
        surfaces: ALL_SURFACES,
        reviewForTypes: fm.reviewForTypes,
        reviewForGlobs: fm.reviewForGlobs,
      });
      this.skillFiles.removeStaging(org.id, requestId);
      rmSync(join(this.threadLifecycle.contextDirHost(jobId, org.id), 'skill-drafts', card.name), {
        recursive: true,
        force: true,
      });
    }
    await this.store.markSkillProposalApproved(jobId, requestId);
    await this.intake.intakeChat(
      {
        type: 'skill_approved',
        trust: 'system',
        id: randomUUID(),
        orgId: org.id,
        repoId: thread.repo_id,
        jobId,
        receivedAt: new Date().toISOString(),
        requestId,
        mode: card.mode,
        name: card.name,
        scope: card.scope,
      },
      {
        author: {
          id: SYSTEM_SEED_AUTHOR.id,
          displayName: SYSTEM_SEED_AUTHOR.name,
        },
        replyRoute: { surfaceId: this.surface.name, jobRef: jobId },
      },
    );
    return { ok: true, name: card.name, ts: new Date().toISOString() };
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/skill-edit-access/:requestId/approve')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async approveSkillEditAccess(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('requestId') requestId: string,
  ): Promise<{ ok: boolean; name: string; grantedAs?: string; ts?: string }> {
    const thread = await this.requireThread(jobId, org.id);
    this.assertJobMutable(thread);
    const card = await this.store.getSkillEditAccessCard(jobId, requestId);
    if (!card) throw new BadRequestException('no such skill edit-access request on this thread');
    if (card.approved_at) {
      return {
        ok: true,
        name: card.name,
        ...(card.forkedTo ? { grantedAs: card.forkedTo } : {}),
      };
    }
    const dbScope = card.scope === 'org' ? '*' : card.repoId;
    const row = await this.skillStore.get(org.id, dbScope, card.name);
    if (!row) {
      await this.store.markSkillEditAccessApproved(jobId, requestId);
      await this.intake.intakeChat(
        {
          type: 'skill_edit_gone',
          trust: 'system',
          id: randomUUID(),
          orgId: org.id,
          repoId: thread.repo_id,
          jobId,
          receivedAt: new Date().toISOString(),
          requestId,
          name: card.name,
        },
        {
          author: {
            id: SYSTEM_SEED_AUTHOR.id,
            displayName: SYSTEM_SEED_AUTHOR.name,
          },
          replyRoute: { surfaceId: this.surface.name, jobRef: jobId },
        },
      );
      return { ok: true, name: card.name, ts: new Date().toISOString() };
    }
    const forkedTo =
      row.provenance === 'git'
        ? await this.forkSkillToCustom(org.id, dbScope, card.name)
        : undefined;
    const grantName = forkedTo ?? card.name;
    this.brain.grantSkillEditAccess(jobId, grantName);
    await this.store.markSkillEditAccessApproved(jobId, requestId, forkedTo);
    await this.intake.intakeChat(
      {
        type: 'skill_edit_approved',
        trust: 'system',
        id: randomUUID(),
        orgId: org.id,
        repoId: thread.repo_id,
        jobId,
        receivedAt: new Date().toISOString(),
        requestId,
        name: card.name,
        ...(forkedTo ? { forkedTo } : {}),
      },
      {
        author: {
          id: SYSTEM_SEED_AUTHOR.id,
          displayName: SYSTEM_SEED_AUTHOR.name,
        },
        replyRoute: { surfaceId: this.surface.name, jobRef: jobId },
      },
    );
    return {
      ok: true,
      name: card.name,
      ...(forkedTo ? { grantedAs: forkedTo } : {}),
      ts: new Date().toISOString(),
    };
  }

  private async forkSkillToCustom(orgId: string, dbScope: string, name: string): Promise<string> {
    let forkName = `${name}-custom`;
    for (let n = 2; await this.skillStore.get(orgId, dbScope, forkName); n++) {
      forkName = `${name}-custom-${n}`;
    }
    const source = await this.skillStore.get(orgId, dbScope, name);
    this.skillFiles.forkSkillDir(orgId, dbScope, name, forkName);
    await this.skillStore.write(orgId, dbScope, forkName, {
      description: source?.description ?? `Forked from ${name}`,
      provenance: 'custom',
      forked_from: name,
      surfaces: source?.surfaces,
      ...(source?.reviewForTypes ? { reviewForTypes: source.reviewForTypes } : {}),
      ...(source?.reviewForGlobs ? { reviewForGlobs: source.reviewForGlobs } : {}),
      enabled: true,
    });
    return forkName;
  }

  private mcpProposalToInput(s: McpProposalServer): McpServerInput {
    const toPairs = (
      entries: { name: string; secret?: boolean; value?: string }[] | undefined,
    ): McpHeaderInput[] | undefined =>
      entries && entries.length
        ? entries.map((e) =>
            e.secret
              ? { name: e.name, value: '', secret: true }
              : { name: e.name, value: e.value ?? '' },
          )
        : undefined;
    const input: McpServerInput = { transport: s.transport };
    if (s.url) input.url = s.url;
    if (s.command) input.command = s.command;
    if (s.args && s.args.length) input.args = s.args;
    const headers = toPairs(s.headers);
    if (headers) input.headers = headers;
    const env = toPairs(s.env);
    if (env) input.env = env;
    if (s.surfaces && s.surfaces.length) input.surfaces = s.surfaces;
    if (s.authKind === 'oauth') input.authKind = 'oauth';
    if (s.oauth && Object.keys(s.oauth).length) input.oauth = s.oauth;
    return input;
  }

  private async applyFileUpload(
    jobId: string,
    orgId: string,
    repoId: string,
    requestId: string,
    filename: string,
    content: string,
  ): Promise<ApplyResult> {
    const name = filename?.trim() || 'upload';
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_UPLOAD_BYTES) {
      throw new BadRequestException(
        `file exceeds the ${Math.floor(MAX_FILE_UPLOAD_BYTES / 1024)} KB upload limit`,
      );
    }
    const card = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const payload = card?.card as WebFileRequestCard | undefined;
    if (!card || payload?.type !== 'file_request_card') return { status: 'notfound' };
    if (payload.withdrawnAt) return { status: 'withdrawn' };
    if (payload.delivered_at) return { status: 'stale' };
    if (payload.provided_at != null) return { status: 'noop' };
    await this.secrets.write(orgId, repoId, payload.path, content, name);
    card.card = {
      ...(card.card ?? {}),
      provided_at: new Date().toISOString(),
      filename: name,
    };
    await this.messages.save(card);
    return {
      status: 'applied',
      notice: fileUploaded(payload.path),
      seedId: requestId,
      kind: 'file',
      rehydrate: true,
    };
  }

  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/pipeline')
  @UseGuards(OrgMembershipGuard)
  async pipeline(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<unknown> {
    await this.requireThread(jobId, org.id);
    return this.driverStore.getPipelineState(jobId, org.id);
  }

  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/context')
  @UseGuards(OrgMembershipGuard)
  async context(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<{
    specs: ContextFile[];
    generated: ContextFile[];
    artifacts: ContextFile[];
    evidence: ContextFile[];
  }> {
    await this.requireThread(jobId, org.id);
    const root = this.threadLifecycle.contextDirHost(jobId, org.id);
    return {
      specs: listContextBucket(join(root, 'specs')),
      generated: listContextBucket(join(root, 'generated')),
      artifacts: listContextBucket(join(root, 'artifacts')),
      evidence: listContextBucket(join(root, 'evidence')),
    };
  }

  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/context/file')
  @UseGuards(OrgMembershipGuard)
  async contextFile(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Query('path') relPath: string,
  ): Promise<ContextFileContent> {
    await this.requireThread(jobId, org.id);
    if (!relPath) throw new BadRequestException('path is required');
    const root = this.threadLifecycle.contextDirHost(jobId, org.id);
    const abs = resolveContextFilePath(root, relPath);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      throw new NotFoundException('file not found');
    }
    if (!st.isFile()) throw new NotFoundException('not a file');
    if (st.size > MAX_CONTEXT_FILE_BYTES) {
      throw new PayloadTooLargeException(
        `file too large to preview (${st.size} bytes; limit ${MAX_CONTEXT_FILE_BYTES})`,
      );
    }
    const ext = extname(abs).toLowerCase();
    const { mime, binary } = MIME_BY_EXT[ext] ?? {
      mime: 'text/plain',
      binary: false,
    };
    const buf = readFileSync(abs);
    return {
      name: basename(abs),
      path: relative(root, abs).split(sep).join('/'),
      size: st.size,
      mtime: st.mtime.toISOString(),
      encoding: binary ? 'base64' : 'text',
      mime,
      content: binary ? buf.toString('base64') : buf.toString('utf8'),
    };
  }

  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/repo/tree')
  @UseGuards(OrgMembershipGuard)
  async repoTree(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<{ files: string[] }> {
    await this.requireThread(jobId, org.id);
    const sandbox = await this.threadLifecycle.findSandbox(jobId, org.id);
    if (!sandbox) return { files: [] };
    return { files: await this.git.listTrackedFiles(sandbox.worktreePath) };
  }

  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/repo/file')
  @UseGuards(OrgMembershipGuard)
  async repoFile(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Query('path') relPath: string,
  ): Promise<ContextFileContent> {
    await this.requireThread(jobId, org.id);
    if (!relPath) throw new BadRequestException('path is required');
    const sandbox = await this.threadLifecycle.findSandbox(jobId, org.id);
    if (!sandbox) throw new NotFoundException('worktree not available');
    let abs: string;
    try {
      abs = resolveSafeTarget(sandbox.worktreePath, relPath);
    } catch {
      throw new BadRequestException('unsafe path');
    }
    if (!(await this.git.isTracked(sandbox.worktreePath, relPath))) {
      throw new NotFoundException('file not found');
    }
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      throw new NotFoundException('file not found');
    }
    if (!st.isFile()) throw new NotFoundException('not a file');
    if (st.size > MAX_CONTEXT_FILE_BYTES) {
      throw new PayloadTooLargeException(
        `file too large to preview (${st.size} bytes; limit ${MAX_CONTEXT_FILE_BYTES})`,
      );
    }
    const ext = extname(abs).toLowerCase();
    const { mime, binary } = MIME_BY_EXT[ext] ?? {
      mime: 'text/plain',
      binary: false,
    };
    const buf = readFileSync(abs);
    return {
      name: basename(abs),
      path: relative(realpathSync(sandbox.worktreePath), abs).split(sep).join('/'),
      size: st.size,
      mtime: st.mtime.toISOString(),
      encoding: binary ? 'base64' : 'text',
      mime,
      content: binary ? buf.toString('base64') : buf.toString('utf8'),
    };
  }

  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/diff')
  @UseGuards(OrgMembershipGuard)
  async jobDiff(@CurrentOrg() org: CurrentOrgCtx, @Param('jobId') jobId: string): Promise<JobDiff> {
    await this.requireThread(jobId, org.id);
    const sandbox = await this.threadLifecycle.findSandbox(jobId, org.id);
    if (!sandbox) return { files: [], truncated: false };
    const baseRef = `origin/${await this.threadLifecycle.resolveBaseBranch(jobId, org.id)}`;
    const [raw, numstat] = await Promise.all([
      this.git.diffFromMergeBase(sandbox.worktreePath, baseRef),
      this.git.diffNumstatFromMergeBase(sandbox.worktreePath, baseRef),
    ]);
    if (!raw) return { files: [], truncated: false };
    return parseGitDiff(raw, numstat, { maxBytes: MAX_DIFF_BYTES });
  }

  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/diff/summary')
  @UseGuards(OrgMembershipGuard)
  async jobDiffSummary(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<JobDiffSummary> {
    await this.requireThread(jobId, org.id);
    const sandbox = await this.threadLifecycle.findSandbox(jobId, org.id);
    if (!sandbox) return { files: [] };
    const baseRef = `origin/${await this.threadLifecycle.resolveBaseBranch(jobId, org.id)}`;
    const [numstat, nameStatus] = await Promise.all([
      this.git.diffNumstatFromMergeBase(sandbox.worktreePath, baseRef),
      this.git.diffNameStatusFromMergeBase(sandbox.worktreePath, baseRef),
    ]);
    return buildDiffSummary(numstat, nameStatus);
  }

  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/context/file/raw')
  @UseGuards(OrgMembershipGuard)
  async contextFileRaw(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Query('path') relPath: string,
  ): Promise<StreamableFile> {
    await this.requireThread(jobId, org.id);
    if (!relPath) throw new BadRequestException('path is required');
    const root = this.threadLifecycle.contextDirHost(jobId, org.id);
    const abs = resolveUploadFilePath(root, relPath);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      throw new NotFoundException('file not found');
    }
    if (!st.isFile()) throw new NotFoundException('not a file');
    const ext = extname(abs).toLowerCase();
    const mime =
      MIME_BY_EXT[ext]?.mime ?? (ext === '.pdf' ? 'application/pdf' : 'application/octet-stream');
    return new StreamableFile(createReadStream(abs), {
      type: mime,
      length: st.size,
    });
  }

  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/context/raw/*path')
  @Header('Content-Security-Policy', 'sandbox allow-scripts')
  @Header('X-Content-Type-Options', 'nosniff')
  @UseGuards(OrgMembershipGuard)
  async contextRaw(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('path') segments: string[] | string,
  ): Promise<StreamableFile> {
    await this.requireThread(jobId, org.id);
    const relPath = (Array.isArray(segments) ? segments : [segments]).join('/');
    if (!relPath) throw new BadRequestException('path is required');
    const root = this.threadLifecycle.contextDirHost(jobId, org.id);
    const abs = resolveContextFilePath(root, relPath);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      throw new NotFoundException('file not found');
    }
    if (!st.isFile()) throw new NotFoundException('not a file');
    const ext = extname(abs).toLowerCase();
    const mime =
      MIME_BY_EXT[ext]?.mime ?? (ext === '.pdf' ? 'application/pdf' : 'application/octet-stream');
    return new StreamableFile(createReadStream(abs), {
      type: mime,
      length: st.size,
    });
  }

  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/services')
  @UseGuards(OrgMembershipGuard)
  async services(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<{ services: ServiceInfo[] }> {
    await this.requireThread(jobId, org.id);
    const dir = this.threadLifecycle.supervisorDirHost(jobId);
    if (!dir) return { services: [] };
    const markers = readServiceMarkers(dir);
    const byId = new Map(markers.map((m) => [m.id, m] as const));
    const services: ServiceInfo[] = markers
      .map((m) => ({
        id: m.id,
        name: m.name,
        cmd: m.cmd,
        pid: m.pid,
        pgid: m.pgid,
        startedAt: m.startedAt,
        port: m.port,
        url: null,
        logBytes: m.logBytes,
        logUpdatedAt: m.logUpdatedAt,
        status: 'unknown' as ServiceInfo['status'], // overwritten by the liveness probe below
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    const pgids = services.map((s) => s.pgid).filter((p): p is number => p != null);
    const probe = await this.probeLivenessMemoized(jobId, pgids);
    const exposure = this.exposure;
    for (const s of services) {
      s.status = serviceStatus(s, probe);
      const expose = byId.get(s.id)?.expose ?? false;
      const live = s.port != null && expose && s.status === 'running';
      s.url = live ? (exposure?.urlFor(jobId, s.name) ?? null) : null;
    }

    if (exposure) {
      void exposure.reconcile(jobId).catch(() => undefined);
    }

    return { services };
  }

  private readonly livenessMemo = new Map<
    string,
    { at: number; probe: Promise<ServiceLivenessProbe> }
  >();

  private probeLivenessMemoized(jobId: string, pgids: number[]): Promise<ServiceLivenessProbe> {
    const key = `${jobId}|${[...pgids].sort((a, b) => a - b).join(',')}`;
    const now = Date.now();
    const hit = this.livenessMemo.get(key);
    if (hit && now - hit.at < LIVENESS_MEMO_TTL_MS) return hit.probe;
    const probe = this.threadLifecycle.probeLiveness(jobId, pgids);
    this.livenessMemo.set(key, { at: now, probe });
    if (this.livenessMemo.size > 256) {
      for (const [k, v] of this.livenessMemo)
        if (now - v.at >= LIVENESS_MEMO_TTL_MS) this.livenessMemo.delete(k);
    }
    return probe;
  }

  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/services/:id/logs')
  @UseGuards(OrgMembershipGuard)
  async serviceLogs(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('id') id: string,
    @Query('n') n?: string,
  ): Promise<{ id: string; content: string; truncated: boolean }> {
    await this.requireThread(jobId, org.id);
    if (!SERVICE_ID_RE.test(id)) {
      throw new BadRequestException('invalid service id');
    }
    const dir = this.threadLifecycle.supervisorDirHost(jobId);
    const wantLines = Math.min(Math.max(parseInt(n ?? '200', 10) || 200, 1), 2000);
    const { content, truncated } = readServiceLogTail(
      dir,
      id,
      wantLines,
      MAX_SERVICE_LOG_TAIL_BYTES,
    );
    return { id, content, truncated };
  }

  @Sse('orgs/:orgId/repos/:repoId/jobs/:jobId/services/:id/log-events')
  @UseGuards(OrgMembershipGuard)
  serviceLogEvents(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('id') id: string,
  ): Observable<MessageEvent> {
    return defer(() => from(this.requireThread(jobId, org.id))).pipe(
      switchMap(() => {
        if (!SERVICE_ID_RE.test(id)) throw new BadRequestException('invalid service id');
        const dir = this.threadLifecycle.supervisorDirHost(jobId);
        return new Observable<MessageEvent>((subscriber) => {
          const snapshot = readServiceLogTail(dir, id, 200, MAX_SERVICE_LOG_TAIL_BYTES);
          subscriber.next({
            data: {
              type: 'snapshot',
              content: snapshot.content,
              truncated: snapshot.truncated,
            },
          });
          if (!dir || snapshot.size === 0) {
            return undefined;
          }
          const path = join(dir, `${id}.log`);
          let offset = snapshot.size;
          let fd: number;
          try {
            fd = openTailFd(path);
          } catch {
            return undefined; // file vanished between the stat above and opening it — leave snapshot-only
          }
          const timer = setInterval(() => {
            let size: number;
            try {
              size = statSync(path).size;
            } catch {
              return; // transient stat failure — try again next tick
            }
            const result = nextTailFrame(offset, size, fd);
            if (result.kind === 'unchanged') return;
            if (result.kind === 'reset') {
              closeTailFd(fd);
              const fresh = readServiceLogTail(dir, id, 200, MAX_SERVICE_LOG_TAIL_BYTES);
              subscriber.next({
                data: {
                  type: 'snapshot',
                  content: fresh.content,
                  truncated: fresh.truncated,
                },
              });
              offset = fresh.size;
              try {
                fd = openTailFd(path);
              } catch {
                clearInterval(timer);
              }
              return;
            }
            offset = result.nextOffset;
            subscriber.next({ data: { type: 'append', chunk: result.chunk } });
          }, SERVICE_LOG_POLL_MS);
          return () => {
            clearInterval(timer);
            closeTailFd(fd);
          };
        });
      }),
    );
  }

  @Patch('orgs/:orgId/repos/:repoId/jobs/:jobId')
  @UseGuards(OrgMembershipGuard)
  async renameJob(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Body() body: RenameThreadDto,
  ): Promise<{ ok: boolean; title: string }> {
    const title = body?.title?.trim().slice(0, 200);
    if (!title) throw new BadRequestException('title is required');
    this.assertJobMutable(await this.requireThread(jobId, org.id));
    const result = await this.jobs.update({ id: jobId, org_id: org.id }, { title });
    if (!result.affected) throw new NotFoundException('thread not found');
    this.logger.log(`web renamed thread ${jobId} (org ${org.id})`);
    return { ok: true, title };
  }

  @Patch('orgs/:orgId/repos/:repoId/jobs/:jobId/auto-approve')
  @UseGuards(OrgMembershipGuard)
  async setAutoApprove(
    @CurrentOrg() org: CurrentOrgCtx,
    @CurrentUser() user: UserEntity,
    @Param('jobId') jobId: string,
    @Body() body: SetAutoApproveDto,
  ): Promise<{ ok: boolean; autoApproveMode: AutoApproveMode }> {
    if (!isAutoApproveMode(body?.mode)) {
      throw new BadRequestException('mode is required');
    }
    const job = await this.requireThread(jobId, org.id);
    this.assertJobMutable(job);
    const result = await this.jobs.update(
      { id: jobId, org_id: org.id },
      {
        auto_approve_mode: body.mode,
        ...(body.mode !== 'off' ? { auto_approve_by: user.id } : {}),
      },
    );
    if (!result.affected) throw new NotFoundException('thread not found');
    this.logger.log(`web set auto-approve mode=${body.mode} on thread ${jobId} (org ${org.id})`);
    if (job.status === 'awaiting_approval' && modeApprovesPlan(body.mode)) {
      const value = JSON.stringify({
        jobId,
        ...(job.decision_record_id ? { decisionRecordId: job.decision_record_id } : {}),
      });
      this.surface.receiveApprovalClick(APPROVE_ACTION_ID, value, user.id);
    } else if (job.status === 'awaiting_ship_review' && modeApprovesShip(body.mode)) {
      this.surface.receiveApprovalClick(SHIP_ACTION_ID, JSON.stringify({ jobId }), user.id);
    }
    return { ok: true, autoApproveMode: body.mode };
  }

  @Patch('orgs/:orgId/repos/:repoId/jobs/:jobId/auto-merge')
  @UseGuards(OrgMembershipGuard)
  async setAutoMerge(
    @CurrentOrg() org: CurrentOrgCtx,
    @CurrentUser() user: UserEntity,
    @Param('jobId') jobId: string,
    @Body() body: SetAutoMergeDto,
  ): Promise<{ ok: boolean; autoMerge: boolean }> {
    this.assertJobMutable(await this.requireThread(jobId, org.id));
    const enable = coerceBoolean(body.autoMerge) === true;
    const result = await this.jobs.update(
      { id: jobId, org_id: org.id },
      {
        auto_merge: enable,
        ...(enable ? { auto_merge_by: user.id } : {}),
      },
    );
    if (!result.affected) throw new NotFoundException('thread not found');
    this.logger.log(`web set auto-merge=${enable} on thread ${jobId} (org ${org.id})`);
    if (enable) void this.autoMerge.maybeAutoMerge(jobId).catch(() => undefined);
    const fresh = await this.jobs.findOneBy({ id: jobId });
    return {
      ok: true,
      autoMerge: fresh?.auto_merge ?? enable,
    };
  }

  @Delete('orgs/:orgId/repos/:repoId/jobs/:jobId')
  @UseGuards(OrgMembershipGuard)
  async deleteThread(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Query('prAction') prAction?: string,
  ): Promise<{ ok: boolean }> {
    const job = await this.requireThread(jobId, org.id);
    this.assertJobMutable(job);
    if (prAction != null && prAction !== 'close' && prAction !== 'leave') {
      throw new BadRequestException("prAction must be 'close' or 'leave'");
    }
    if (prAction === 'close') {
      try {
        await this.threadLifecycle.closeJobPullRequest(job);
      } catch (err) {
        throw new BadGatewayException(
          err instanceof Error ? err.message : 'Could not close the pull request',
        );
      }
    }
    const claimed = await this.threadLifecycle.claimArchiveJob(jobId, org.id);
    if (claimed) {
      void this.threadLifecycle
        .archiveJobDeep(jobId, org.id)
        .catch((err) =>
          this.logger.warn(`web archive: background reclaim failed for job ${jobId}: ${err}`),
        );
    }
    this.logger.log(`web archiving thread ${jobId} (org ${org.id}); claimed=${claimed}`);
    return { ok: true };
  }

  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/dependencies')
  @UseGuards(OrgMembershipGuard)
  async addJobDependency(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Param('jobId') jobId: string,
    @Body() body: { dependsOnJobId?: string },
  ): Promise<{ ok: boolean; blocked: boolean; blockers: unknown[] }> {
    this.assertJobMutable(await this.requireThread(jobId, org.id));
    const dependsOnJobId = String(body?.dependsOnJobId ?? '').trim();
    if (!dependsOnJobId) throw new BadRequestException('dependsOnJobId is required');
    const { blocked } = await this.jobDeps.addDependency({
      orgId: org.id,
      repoId,
      jobId,
      dependsOnJobId,
    });
    const blockers = await this.jobDeps.blockersOf(jobId);
    this.logger.log(`web blocked job ${jobId} on ${dependsOnJobId} (org ${org.id})`);
    return { ok: true, blocked, blockers };
  }

  @Delete('orgs/:orgId/repos/:repoId/jobs/:jobId/dependencies/:dependsOnJobId')
  @UseGuards(OrgMembershipGuard)
  async removeJobDependency(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Param('jobId') jobId: string,
    @Param('dependsOnJobId') dependsOnJobId: string,
  ): Promise<{ ok: boolean; blockers: unknown[] }> {
    this.assertJobMutable(await this.requireThread(jobId, org.id));
    await this.jobDeps.removeDependency({
      orgId: org.id,
      repoId,
      jobId,
      dependsOnJobId,
    });
    const blockers = await this.jobDeps.blockersOf(jobId);
    this.logger.log(`web unblocked job ${jobId} from ${dependsOnJobId} (org ${org.id})`);
    return { ok: true, blockers };
  }

  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/created')
  @UseGuards(OrgMembershipGuard)
  async createdJobs(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<unknown[]> {
    await this.requireThread(jobId, org.id);
    const rows = await this.jobs.find({
      where: { org_id: org.id, created_by_job_id: jobId },
      order: { created_at: 'DESC' },
    });
    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      kind: t.kind,
      prState: t.pr_state,
      needsYou: deriveNeedsYou({
        status: t.status,
        activity: t.activity,
        openQuestion: t.open_question_count > 0,
        awaitingSecret: t.awaiting_secret_id != null || t.open_secret_count > 0,
        halted: t.halted || t.halt != null,
      }),
      createdAt: t.created_at,
    }));
  }

  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId')
  @UseGuards(OrgMembershipGuard)
  async jobDetail(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<unknown> {
    const t = await this.requireThread(jobId, org.id); // 404s a missing/foreign job
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      kind: t.kind,
      createdBy: t.created_by ?? null,
      pr: t.pr_state
        ? {
            state: t.pr_state,
            number: t.pr_number,
            mergeable: t.pr_mergeable,
            url: t.pr_url,
          }
        : null,
      needsYou: deriveNeedsYou({
        status: t.status,
        activity: t.activity,
        openQuestion: t.open_question_count > 0,
        awaitingSecret: t.awaiting_secret_id != null || t.open_secret_count > 0,
        halted: t.halted || t.halt != null,
      }),
      createdAt: t.created_at,
    };
  }

  private async requireThread(jobId: string, orgId: string): Promise<JobEntity> {
    const thread = await this.jobs.findOne({
      where: { id: jobId, org_id: orgId },
    });
    if (!thread) throw new NotFoundException('thread not found');
    return thread;
  }

  private assertJobMutable(job: JobEntity): void {
    if (job.status === 'archived') {
      throw new ConflictException('job is archived (read-only)');
    }
  }

  private async requireRepo(repoId: string, orgId: string): Promise<RepoEntity> {
    const repo = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    if (!repo) throw new NotFoundException('repo not found');
    return repo;
  }
}
