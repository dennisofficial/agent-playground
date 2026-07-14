import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Delete,
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
  Query,
  ServiceUnavailableException,
  Sse,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { FilesInterceptor } from '@nestjs/platform-express';
import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import {
  Observable,
  catchError,
  defer,
  filter,
  from,
  map,
  merge,
  switchMap,
} from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { CurrentUser, Public } from '@workspace/auth/server';
import {
  type AutoApproveMode,
  isAutoApproveMode,
  modeApprovesPlan,
  modeApprovesShip,
} from '@workspace/shared';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
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
import { LeaderElectionService } from '../cluster';
import {
  closeTailFd,
  nextTailFrame,
  openTailFd,
  readServiceLogTail,
} from './service-log-tail';
import { JOB_DISPATCHER, type JobDispatcher } from '../brain/job-dispatcher';
import { BrainStoreService } from '../brain/brain-store.service';
import { AgentSessionManager } from '../brain/agent-session-manager.service';
import { JitHostExecutor } from '../brain/jit-host-executor';
import { WebSurface } from './web-surface';
import { LiveTurnStore } from './live-turn-store';
import { ThreadInputService } from './thread-input.service';
import { JobTitleService } from './job-title.service';
import { parseWebApprovalMeta } from './web-approval-card';
import { resolveMergeApproval } from './resolve-merge-approval';
import type { WebQuestionCard } from './web-question-card';
import type { WebSecretInputCard } from './web-secret-input-card';
import type { WebFileRequestCard } from './web-file-request-card';
import type { McpProposalServer } from './web-mcp-proposal-card';
import type { WebOutboundMessage } from './web-surface';
import { DriverStoreService } from '../driver/driver-store.service';
import { JobLifecycleService } from '../driver/job-lifecycle.service';
import { AutoMergeService } from '../driver/auto-merge.service';
import { resolveSafeTarget } from '../driver/worktree-path-guard';
import { LocalGitService } from '../git/local-git.service';
import { parseGitDiff, type JobDiff } from './job-diff';
import { JobBootstrapService } from '../job-bootstrap';
import { JobDependencyService } from '../job-deps';
import type { ServiceLivenessProbe } from '../sandbox';
import { ExposureService } from '../exposure/exposure.service';
import { readServiceMarkers, serviceStatus } from '../exposure/service-markers';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { OrganizationService } from '../org/organization.service';
import { WorkspaceSecretFileStore } from '../onboarding';
import { McpServerStore } from '../mcp/mcp-server.store';
import { isReservedMcpName } from '../sandbox/image/reserved-mcp-names';
import { ConventionProfileResolver } from '../conventions';
import { SkillFileWriter, SkillInstallerService, WorkspaceSkillStore } from '../skills';
import { parseSkillFrontmatter } from '../skills/skill-frontmatter';
import { McpProbeService } from '../mcp/mcp-probe.service';
import type { McpHeaderInput, McpServerInput } from '../mcp/mcp-server.store';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  MessageEntity,
  RepoEntity,
  JobEntity,
  UserEntity,
} from '../persistence/entities';
import { deriveNeedsYou } from '../domain/job';
import type { JobKind } from '../domain/job';
import type { McpSurface } from '../persistence/entities';
import {
  RealtimeService,
  realtimeDisabledStream,
  subscriptionToObservable,
} from '../realtime';
import {
  renderReviewSeedXml,
  renderUploadedFilesXml,
  type AttachmentCardItem,
} from '../prompt-kit';
import {
  answeredQuestionBody,
  chunkKey,
  conventionAttached,
  conventionEdited,
  fileUploaded,
  mcpApproved,
  mcpRemoved,
  mcpSecretOauthRefused,
  mcpSecretStored,
  mcpSecretStoreFailed,
  retryResumeNudge,
  secretEphemeralDelivered,
  secretEphemeralUndelivered,
  secretStored,
  skillApproved,
  skillEditApproved,
  skillEditGone,
} from '../prompt-kit/harness';
import { UsageEventBus } from '../onboarding/usage-event-bus';
import { WorkspaceConfigStore } from '../onboarding/workspace-config.store';

const VALID_ACTION_IDS = new Set([
  APPROVE_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
  DENY_ACTION_ID,
  // The ship-review gate's "Ship it" button — same endpoint, but the `approval$` bridge routes it to the
  // driver's ship-resume instead of a plan verdict (see WebSurfaceModule).
  SHIP_ACTION_ID,
  // The ship-review gate's "Back to building" button — the sibling retract of SHIP_ACTION_ID, routed to
  // the driver's ship-retract instead of a plan verdict (see WebSurfaceModule).
  RETRACT_SHIP_ACTION_ID,
  // The brain's "Amend build?" proposal buttons — Approve runs the operator retract + wakes the brain;
  // Dismiss just neutralizes the card. Same endpoint, routed by the `approval$` bridge (see WebSurfaceModule).
  AMEND_APPROVE_ACTION_ID,
  AMEND_DISMISS_ACTION_ID,
  // The "Merge PR" gate button — same endpoint, but the `approval$` bridge routes it to the driver's merge
  // resolution instead of a plan verdict (see WebSurfaceModule).
  MERGE_ACTION_ID,
  // The atlas-prod gated DB-write card buttons — Execute runs the approved statement on the `mcp_writer`
  // role; Deny rejects it. Same endpoint, routed by the `approval$` bridge (see WebSurfaceModule). These
  // are NOT plan verdicts, so they skip the `awaiting_approval` + decisionRecordId invariant below.
  DB_WRITE_APPROVE_ACTION_ID,
  DB_WRITE_DENY_ACTION_ID,
]);
/** Author fields for an operator-authored web message — the REAL signed-in user (display name falls back
 *  to email), so the brain's `<user name=…>` attribution names the actual person, not a generic "Operator".
 *  Multiple people can chat with one job; this is how Atlas knows who it's talking to. */
function operatorAuthor(user: UserEntity): {
  authorId: string;
  authorName: string;
} {
  return { authorId: user.id, authorName: user.name?.trim() || user.email };
}

/** One file in a `/context` bucket (specs, generated, artifacts, or evidence). */
export interface ContextFile {
  name: string;
  size: number;
  /** ISO timestamp of last modification. */
  mtime: string;
}

/** One `/context` file's content for the viewer (`…/context/file?path=…`). */
export interface ContextFileContent {
  name: string;
  /** Path relative to the `/context` root, forward-slashed (e.g. `specs/plan.md`). */
  path: string;
  size: number;
  /** ISO timestamp of last modification. */
  mtime: string;
  /** `text` → utf-8 in `content`; `base64` → binary (images) in `content`. */
  encoding: 'text' | 'base64';
  /** Best-effort mime by extension (e.g. `text/markdown`, `image/png`). */
  mime: string;
  content: string;
}

/** Preview cap — text is tiny, screenshots a few hundred KB; refuse anything pathological. */
const MAX_CONTEXT_FILE_BYTES = 2 * 1024 * 1024;

/** Diff size cap — beyond this a raw patch is parsed for headers/counts only (hunks dropped, truncated:true). */
const MAX_DIFF_BYTES = 2_000_000;

/**
 * One supervised process, its durable `atlas-svc` marker (see `backend/sandbox/atlas-svc`) joined with
 * a LIVE liveness check: the endpoint execs a `kill -0` probe into the container (gated on the current
 * container generation) so `status` reflects reality, not just "a marker exists". The marker fields
 * (pid/startedAt/log*) remain the durable snapshot; `status` is the freshly-probed truth.
 */
export interface ServiceInfo {
  id: string;
  name: string;
  cmd: string;
  pid: number | null;
  pgid: number | null;
  startedAt: string | null;
  /** The dev-server port the process advertised via `atlas-svc --port`; null when unmarked. */
  port: number | null;
  /**
   * The public https preview URL when the service is exposed (`expose !== false`), currently `running`,
   * and the preview feature is on; otherwise null.
   */
  url: string | null;
  /** Size of the paired `<id>.log`, 0 if none yet. */
  logBytes: number;
  /** Last-modified time of the log file — a recency signal, not a liveness guarantee. */
  logUpdatedAt: string | null;
  /**
   * Live liveness from the in-container probe: `running` (its process-group answered `kill -0` in the
   * current container generation), `stopped` (marker present but the process is gone — crashed,
   * `atlas-svc stop`, or a previous container), `unknown` (couldn't probe: no running container yet, a
   * null pgid/startedAt, or a transient exec failure).
   */
  status: 'running' | 'stopped' | 'unknown';
}

/** Matches `atlas-svc`'s own `--name` validation — also doubles as the path-safety guard below. */
const SERVICE_ID_RE = /^[a-z0-9_-]+$/;
/** Reuse-window for the in-container liveness probe (see `probeLivenessMemoized`). Comfortably shorter
 *  than the ~5s status poll so a genuine state change still surfaces on the next tick. */
const LIVENESS_MEMO_TTL_MS = 2_500;
/** Tail cap for the logs endpoint — a long-running dev server's log can grow large. */
const MAX_SERVICE_LOG_TAIL_BYTES = 512 * 1024;
/** How often the SSE log tail polls the file for new bytes — see `serviceLogEvents` doc comment. */
const SERVICE_LOG_POLL_MS = 750;

/** Best-effort mime + text/binary split by extension. Unknown → text/plain (we still cap the size). */
const MIME_BY_EXT: Record<string, { mime: string; binary: boolean }> = {
  '.md': { mime: 'text/markdown', binary: false },
  '.markdown': { mime: 'text/markdown', binary: false },
  '.txt': { mime: 'text/plain', binary: false },
  '.log': { mime: 'text/plain', binary: false },
  '.json': { mime: 'application/json', binary: false },
  '.html': { mime: 'text/html', binary: false },
  '.htm': { mime: 'text/html', binary: false },
  '.css': { mime: 'text/css', binary: false },
  '.js': { mime: 'text/javascript', binary: false },
  '.ts': { mime: 'text/plain', binary: false },
  '.tsx': { mime: 'text/plain', binary: false },
  '.yaml': { mime: 'text/plain', binary: false },
  '.yml': { mime: 'text/plain', binary: false },
  '.csv': { mime: 'text/csv', binary: false },
  '.xml': { mime: 'application/xml', binary: false },
  '.svg': { mime: 'image/svg+xml', binary: false }, // text content, rendered as an image
  '.png': { mime: 'image/png', binary: true },
  '.jpg': { mime: 'image/jpeg', binary: true },
  '.jpeg': { mime: 'image/jpeg', binary: true },
  '.gif': { mime: 'image/gif', binary: true },
  '.webp': { mime: 'image/webp', binary: true },
  '.avif': { mime: 'image/avif', binary: true },
};

/**
 * Resolve a caller-supplied relative path WITHIN the thread's `/context` root, restricted to the
 * exposed buckets (specs/ + generated/ + artifacts/ + evidence/). Rejects absolute paths and any `..`
 * traversal that escapes the root — the only files readable are the ones the listing endpoint already
 * exposes.
 */
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

/**
 * List the files in one `/context` bucket dir RECURSIVELY (missing dir → empty), name-sorted. Files
 * only; `name` is the bucket-relative path (e.g. `sections/01-backend.md`) so multi-file specs (the
 * `sections/` subfolder) surface. The read endpoint (`resolveContextFilePath`) already accepts nested
 * paths. Bounded depth so a stray deep tree can't blow up the listing.
 */
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
    } catch {
      /* skip unreadable entry */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

interface CreateThreadDto {
  firstMessage: string;
  title?: string;
  baseBranch?: string;
  /** Operator-chosen job kind. Only the operator-selectable kinds are honored (see `OPERATOR_JOB_KINDS`). */
  kind?: string;
  /** For `kind: 'review'` — the PR number to review; seeds a `<review>` framing block on turn 1. */
  prNumber?: string | number;
  /** Operator-chosen auto-approve mode to arm at creation; unknown/absent leaves the DB default 'off'. */
  autoApproveMode?: string;
  /** Operator-chosen auto-merge toggle to arm at creation; absent/false leaves the DB default. */
  autoMerge?: boolean;
}

/**
 * The job kinds an operator may pick at creation. `event`/`onboarding` are system-assigned (stimulus
 * intake / repo onboarding), never operator-set, so they are deliberately excluded — an unknown or
 * excluded value is ignored (kind stays null and the brain scopes it as before).
 */
const OPERATOR_JOB_KINDS: ReadonlySet<JobKind> = new Set<JobKind>(['feature', 'bugfix', 'review']);

function coerceOperatorKind(raw: string | undefined): JobKind | null {
  if (raw && OPERATOR_JOB_KINDS.has(raw as JobKind)) return raw as JobKind;
  return null;
}

interface SayDto {
  text: string;
  /** Target thread coordinate (`thread:<threadId>`). Absent or `'main'` targets the job's planning thread
   *  (today's behavior, unchanged); a `thread:<id>` lane targets that builder thread — steering it mid-turn or
   *  re-driving it if halted. */
  lane?: string;
}
/** One highlighted-and-annotated selection in a review-comments batch. */
interface ReviewCommentItemDto {
  /** A label for the file/doc the selection was made in (e.g. "plan.md"). */
  file: string;
  /** The selected/quoted text. */
  quote: string;
  note?: string;
  /** Optional GitHub-style line anchor into a diff file (omitted for markdown/plan/decision comments):
   *  the old-file and/or new-file spans the selection covered (both when it straddles deletions and
   *  additions) plus the signed diff `fragment` the operator selected. */
  lines?: {
    path: string;
    oldStart?: number;
    oldEnd?: number;
    newStart?: number;
    newEnd?: number;
    fragment: string;
  };
}
interface ReviewCommentsDto {
  items: ReviewCommentItemDto[];
  /** Optional operator prose accompanying the batch — rendered underneath the card. */
  message?: string;
}
interface RenameThreadDto {
  title: string;
}
interface SetAutoApproveDto {
  mode: AutoApproveMode;
}
interface SetAutoMergeDto {
  autoMerge: boolean;
}
function coerceBoolean(raw: unknown): boolean | undefined {
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  return undefined;
}
interface ApproveDto {
  actionId: string;
  value: string;
  note?: string;
}
interface ApproveResult {
  ok: boolean;
  jobId?: string;
  message?: string;
}
interface AnswerQuestionDto {
  /** The question card's id (its message `ts`). */
  questionId: string;
  /** The operator's answer — the picked option's label, or free text. */
  answer: string;
  answeredBy?: string;
}
interface ProvideSecretDto {
  /** The secret card's id (its message `ts`). */
  requestId: string;
  /** The plaintext secret value — written to the encrypted store + granted, NEVER persisted in the card. */
  value: string;
}
/** Upload cap for `request_file` — file secrets are small config/key files (JSON, .pem, .env.keys), not blobs. */
const MAX_FILE_UPLOAD_BYTES = 512 * 1024;

// ── Composer attachments (`say`/`createJob` multipart) ───────────────────────────────────────────────
/** Per-file cap for composer attachments (images can be large screenshots). Enforced by multer + here. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Max attachments per message. */
const MAX_ATTACHMENTS = 10;
/**
 * The extensions an operator may attach in the composer. Images (Read renders them visually) + a
 * conservative set of text/doc types the brain's Read tool can parse. Anything else is rejected — we don't
 * want the brain fed opaque binaries it can't use. `.pdf` isn't in `MIME_BY_EXT` (added just here).
 */
const ATTACHMENT_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', // images
  '.txt', '.md', '.markdown', '.log', '.json', '.csv', '.xml', '.yaml', '.yml', // text
  '.html', '.htm', '.css', '.js', '.ts', '.tsx', '.pdf', // code + pdf
]);

/** The multipart file shape multer hands us (subset we use — avoids depending on global Express.Multer types). */
interface UploadedAttachment {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/**
 * Sanitize an operator-supplied filename into a flat, collision-resistant name safe as BOTH a disk path
 * and an XML attribute value: basename only (no dirs), `[A-Za-z0-9._-]` only (so no `../` traversal and no
 * forged `</user>`/`<uploaded-files>` tags), a short random prefix to de-collide, length-capped.
 */
function safeUploadName(original: string): string {
  const base =
    basename(original)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 100) || 'file';
  return `${randomBytes(4).toString('hex')}-${base}`;
}

/**
 * Resolve a caller-supplied path WITHIN the thread's `/context/uploads/` bucket only (rejects absolute
 * paths and `..` traversal, and any bucket other than `uploads/`). Kept separate from
 * `resolveContextFilePath` so the base64 `contextFile` endpoint can NEVER be pointed at an upload (uploads
 * are served ONLY by the streaming raw endpoint — no synchronous base64 of large images on the host loop).
 */
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
interface ProvideFileDto {
  /** The file-request card's id (its message `ts`). */
  requestId: string;
  /** The operator-chosen filename (metadata only — display/provenance, never the store key). */
  filename: string;
  /** The file's text contents — written to the encrypted store + granted, NEVER persisted in the card. */
  content: string;
}

/** Operator-visible message provenance, by AUDIENCE. See the `/messages` mapping for the full rationale. */
export type WebMessageSource =
  | 'operator'
  | 'atlas'
  | 'system_operator'
  | 'system_shared'
  | 'system_event'
  // Harness-injected chunk rows (chunk-vocabulary): `system_notice` = a durable state change (sandbox
  // reset, secret/file confirmation); `system_reminder` = context that rode alongside a turn (pipeline
  // awareness, open-questions). Rendered distinctly from operator/atlas prose.
  | 'system_notice'
  | 'system_reminder'
  // Untrusted external data folded into a turn (an event/webhook body, a halted build thread's own record).
  // Rendered as a distinct "untrusted" pill so it reads as DATA, not operator/atlas prose.
  | 'untrusted';

/** Map a row's stored `meta.source` to the web renderer's audience-explicit source. Only the `system_*`
 *  kinds are stamped on the row; ordinary operator/atlas messages carry no `source` and derive from isAtlas. */
export function mapMessageSource(
  stored: unknown,
  isAtlas: boolean,
): WebMessageSource {
  if (stored === 'system_operator') return 'system_operator';
  if (stored === 'system_shared') return 'system_shared';
  if (stored === 'system_event') return 'system_event';
  if (stored === 'system_notice') return 'system_notice';
  if (stored === 'system_reminder') return 'system_reminder';
  if (stored === 'untrusted') return 'untrusted';
  return isAtlas ? 'atlas' : 'operator';
}

/**
 * Render a batch of inline review comments (selection + optional note, grouped by file) into the
 * markdown Atlas reads as the operator's chat turn. Companion to the `review_comments_card` payload
 * persisted alongside it — that card is render-only; this text is what actually drives the brain.
 */
/** Escape the five XML-significant characters for safe use in element text / attribute values. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render a batch of inline review comments into the XML the brain reads as the operator's chat turn.
 * One <comment> element per item (clear, unambiguous boundaries); a diff line-comment carries the
 * old-file/new-file line spans it covers as attributes AND the signed diff fragment the operator selected
 * inside a ```diff fence — so Atlas sees exactly what was highlighted (old + new) with no extra file Read.
 * A free-text (markdown/plan/decision) comment carries the quoted selection instead. The operator's typed
 * message rides in a trailing <message>. Companion to the render-only `review_comments_card`.
 */
export function formatReviewComments(
  items: ReviewCommentItemDto[],
  message?: string,
): string {
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

/**
 * WEB SURFACE — org/repo/thread-scoped HTTP + SSE for the web console. All `/web/orgs/:orgId/*` routes
 * are gated by the global `AuthGuard` (cookie) AND `OrgMembershipGuard` (membership). Threads are
 * real `threads` rows (no surface-ref indirection); message history is the durable `messages`
 * log (survives restart); the SSE stream carries live outbound posts for a repo.
 *
 * `GET /web/ping` stays public so the login screen can detect backend reachability.
 */
@Controller('web')
export class WebSurfaceController {
  private readonly logger = new Logger(WebSurfaceController.name);

  constructor(
    private readonly surface: WebSurface,
    private readonly liveTurns: LiveTurnStore,
    private readonly driverStore: DriverStoreService,
    private readonly threadLifecycle: JobLifecycleService,
    // The ONE merge resolution path — `setAutoMerge` immediately evaluates an already-ready PR on enable.
    private readonly autoMerge: AutoMergeService,
    private readonly orgService: OrganizationService,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(MessageEntity, DB_CONNECTION)
    private readonly messages: Repository<MessageEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    private readonly threadTitle: JobTitleService,
    private readonly usageBus: UsageEventBus,
    private readonly realtime: RealtimeService,
    private readonly election: LeaderElectionService,
    @Inject(JOB_DISPATCHER) private readonly dispatcher: JobDispatcher,
    // Repo onboarding: the ONLY place a `request_secret` plaintext value lands — straight to the
    // encrypted store + a grant, never the transcript (owner-gated; see `provideSecret`).
    private readonly secrets: WorkspaceSecretFileStore,
    // The brain's store — used here for the atomic `markQuestionAnswered` gate (resolved ambiently from
    // the @Global BrainModule, same as the approval services this module already depends on).
    private readonly store: BrainStoreService,
    // The chat brain — used here to STOP a live turn (`/stop`). Also from the @Global BrainModule.
    private readonly brain: AgentSessionManager,
    // User-defined MCP servers — the owner-gated `mcp-proposals/:id/approve` endpoint COMMITS a brain
    // proposal here (the only place a brain-originated MCP write lands), and `provide-secret` writes an MCP
    // credential slot via `setSecret`. Both resolved ambiently from the @Global McpModule.
    private readonly mcpStore: McpServerStore,
    private readonly mcpProbe: McpProbeService,
    // House-style profiles — the owner-gated `convention-proposals/:id/approve` endpoint COMMITS a brain
    // `propose_convention_profile` here (the only place a brain-originated attach lands). @Global ConventionsModule.
    private readonly conventions: ConventionProfileResolver,
    // Skills — the owner-gated `skill-proposals/:id/approve` endpoint COMMITS a brain `propose_skill` here
    // (the only place a brain-originated skill write lands); `skill-edit-access/:id/approve` grants live
    // Edit/Write (forking a git skill to custom first, via `forkSkillToCustom`). @Global SkillsModule.
    // `skillStore` writes the registry ROW (metadata only); `skillFiles` writes/removes/copies the actual
    // skill dir on the host store.
    private readonly skillStore: WorkspaceSkillStore,
    private readonly skillFiles: SkillFileWriter,
    // Vendors a maintained skill from git on an `install`-mode proposal approval (provenance:'git'). @Global.
    private readonly skillInstaller: SkillInstallerService,
    // Repo-file endpoints (`/repo/tree`, `/repo/file`) read the job worktree via `git ls-files`. From the
    // (non-@Global) GitModule, imported into WebSurfaceModule for this injection to resolve.
    private readonly git: LocalGitService,
    // Job-to-job "blocked by" edges — the manual block/unblock endpoints call addDependency/removeDependency.
    private readonly jobDeps: JobDependencyService,
    // Resolves `ThreadDriver` lazily for the SYNCHRONOUS manual-merge path (the "Merge PR" approve click
    // awaits `resolveMergeApproval` → `mergeNow`). Placed after the last required dep so the controller's
    // positional-arg unit tests keep their alignment.
    private readonly moduleRef: ModuleRef,
    // Sandbox-preview exposure — renders each service's public URL + triggers a per-poll Caddy reconcile.
    // From the @Global ExposureModule (inert unless PREVIEW_BASE_DOMAIN is set). @Optional so the
    // controller's direct-construction unit tests (positional args) compile without a trailing argument.
    @Optional() private readonly exposure?: ExposureService,
    // The host-side JIT executor — fires the catalog's lifecycle rules (e.g. `spinUpPreview`'s preview-prep
    // seed). Also from the @Global BrainModule. @Optional (trailing), same reason as `exposure` above.
    @Optional() private readonly jit?: JitHostExecutor,
    // DB-backed workspace config (setup script, preview recipe) — `spinUpPreview` reads the repo's stored
    // preview recipe to splice into the seed. From the @Global OnboardingModule. @Optional (trailing),
    // same reason as `exposure`/`jit` above.
    @Optional() private readonly configStore?: WorkspaceConfigStore,
    // Bootstraps the new thread's ONE planning stage + thread right after `createJob` inserts the bare
    // `JobEntity` row (d7: `stage_id` is never null). From the @Global JobBootstrapModule. @Optional
    // (trailing), same reason as `exposure`/`jit`/`configStore` above.
    @Optional() private readonly jobBootstrap?: JobBootstrapService,
    // The shared thread-input send seam — routes a lane-targeted `/say` (`lane=thread:<id>`) into the thread
    // that owns the lane (steer-if-live / re-drive-if-halted), instead of always the planning brain. From the
    // @Global LiveTurnModule. @Optional (trailing), same reason as `exposure`/`jit` above.
    @Optional() private readonly threadInput?: ThreadInputService,
  ) {}

  /** `GET /web/ping` — public liveness probe. */
  @Public()
  @Get('ping')
  ping(): { ok: boolean; surface: string } {
    return { ok: true, surface: this.surface.name };
  }

  // ── cross-org inbox ──────────────────────────────────────────────────────────────────────────────

  /**
   * `GET /web/threads` — every thread across ALL the caller's orgs, newest first. Powers the unified
   * "All threads" inbox (no org switching). Login-gated only (inherently scoped to the user's
   * memberships); each thread carries its org + repo so the UI can label it.
   */
  @Get('jobs')
  async allThreads(@CurrentUser() user: UserEntity): Promise<unknown[]> {
    const orgs = await this.orgService.listForUser(user.id);
    if (orgs.length === 0) return [];
    const orgIds = orgs.map((o) => o.id);
    const [threads, repos] = await Promise.all([
      this.jobs.find({
        where: { org_id: In(orgIds) },
        order: { created_at: 'DESC' },
      }),
      this.repos.find({ where: { org_id: In(orgIds) } }),
    ]);
    const blockedIds = threads.filter((t) => t.status === 'blocked').map((t) => t.id);
    const blockersByJob = await this.jobDeps.blockersOfManyBlocked(blockedIds);
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
        halt: t.halt ?? null,
        activity: t.activity,
        halted: t.halted,
        // True only while the operator's "Ship it" is being finalized (PR opening): the job re-uses the
        // `running` status during shipping, so this distinguishes "opening PR" from "building threads" and
        // keeps the card pinned in "Ready to Ship" instead of "Building".
        shipping: t.status === 'running' && t.ship_review_approved_at != null,
        createdBy: t.created_by ?? null,
        blockedBy: blockersByJob.get(t.id) ?? [],
        blockedSeedMessage: t.status === 'blocked' ? (t.blocked_seed_message ?? null) : null,
        needsYou: deriveNeedsYou({
          status: t.status,
          activity: t.activity,
          openQuestion: t.open_question_count > 0,
          awaitingSecret: t.awaiting_secret_id != null,
          halted: t.halted || t.halt != null,
        }),
        createdAt: t.created_at,
        // The observed PR (null until one exists) — drives the sidebar's PR-status glyph. `mergeable`
        // ('dirty' = conflict) refines the open state; `state` gives merged/closed.
        pr: t.pr_state
          ? {
              state: t.pr_state,
              number: t.pr_number,
              mergeable: t.pr_mergeable,
              url: t.pr_url,
            }
          : null,
        // The observed CI/CD aggregate (`success|failure|pending|skipped|null`) — drives the sidebar row's CI
        // dot on first paint / when realtime is disabled (realtime carries it independently).
        ciStatus: t.ci_status,
        ciCounts: t.ci_counts,
        // Tri-state sidebar port badge, precomputed by ExposureService.reconcile ('exposed'|'internal'|null).
        portState: t.port_state,
        org: { id: t.org_id, slug: org?.slug, name: org?.name },
        repo: {
          id: t.repo_id,
          name: repoName.get(`${t.org_id}:${t.repo_id}`) ?? t.repo_id,
        },
      };
    });
  }

  /**
   * `GET /web/threads/realtime` — a single cross-org SSE stream of the caller's threads, used by the
   * shell to keep every sidebar "needs you" dot + status pie live. Login-gated; the realtime guard scopes
   * rows to the caller's org memberships (resolved here into the principal). Each frame is a pg-realtime
   * `RowDelta` (`data` snapshot, then `add`/`update`/`remove`) carrying the flat thread row. The work is
   * deferred to subscribe-time (per-connection principal + subscription); when realtime is unavailable the
   * subscription factory throws and the stream errors (the client falls back to its polling refetch).
   */
  @Sse('jobs/realtime')
  threadsRealtime(@CurrentUser() user: UserEntity): Observable<MessageEvent> {
    // Never 503 here — an error/503 makes EventSource reconnect-storm. When realtime is unavailable
    // (engine off / wal_level not logical), hand back a `disabled` stream so the client stops trying and
    // falls back to its polling refetch. `catchError` covers a race where the engine drops mid-open.
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

  // ── threads ────────────────────────────────────────────────────────────────────────────────────

  /** `GET …/repos/:repoId/jobs` — the repo's threads (newest first). */
  @Get('orgs/:orgId/repos/:repoId/jobs')
  @UseGuards(OrgMembershipGuard)
  async listThreads(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
  ): Promise<unknown[]> {
    const rows = await this.jobs.find({
      where: { org_id: org.id, repo_id: repoId },
      order: { created_at: 'DESC' },
    });
    const blockedIds = rows.filter((t) => t.status === 'blocked').map((t) => t.id);
    const blockersByJob = await this.jobDeps.blockersOfManyBlocked(blockedIds);
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
      blockedSeedMessage: t.status === 'blocked' ? (t.blocked_seed_message ?? null) : null,
      needsYou: deriveNeedsYou({
        status: t.status,
        activity: t.activity,
        openQuestion: t.open_question_count > 0,
        awaitingSecret: t.awaiting_secret_id != null,
        halted: t.halted || t.halt != null,
      }),
      baseBranch: t.base_branch,
      createdAt: t.created_at,
    }));
  }

  /** `POST …/repos/:repoId/jobs` — create a thread + inject its first message. Returns the real id. */
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
    // Resolve the repo WITHIN the caller's org — the thread's org_id/repo_id derive from this resolved
    // row, never from raw input (so the denormalized tenant keys can't be pointed at another org's repo).
    const repo = await this.requireRepo(repoId, org.id);
    // The frontend-derived first line seeds the row as an INSTANT placeholder; the mini-model upgrades it
    // below (compare-and-set keyed off this exact placeholder, so a fast rename is never clobbered).
    const placeholder = body.title ?? null;
    // Operator-chosen kind is stamped at creation (an unknown/excluded value stays null → brain scopes it,
    // as before). The brain's system prompt reads `kind` fresh each turn, so a review job orients on turn 1.
    const kind = coerceOperatorKind(typeof body.kind === 'string' ? body.kind.trim() : undefined);
    // Operator-chosen auto-approve mode, armed at creation. Same write shape as PATCH /auto-approve: a
    // non-'off' mode also records who armed it; an unknown/absent value leaves the DB default 'off'.
    const autoApproveMode = isAutoApproveMode(body.autoApproveMode) ? body.autoApproveMode : null;
    const autoMerge = coerceBoolean(body.autoMerge) === true;
    const thread = await this.jobs.save(
      this.jobs.create({
        org_id: org.id,
        repo_id: repo.id,
        origin: 'control',
        surface_thread_ref: null,
        title: placeholder,
        base_branch: body.baseBranch ?? null,
        ...(kind ? { kind } : {}),
        ...(autoApproveMode && autoApproveMode !== 'off'
          ? { auto_approve_mode: autoApproveMode, auto_approve_by: user.id }
          : {}),
        // Operator-chosen auto-merge, armed at creation. Same write shape as PATCH /auto-merge: enabling
        // also records who armed it. The merge method + delete-branch are repo-level defaults now.
        ...(autoMerge
          ? {
              auto_merge: true,
              auto_merge_by: user.id,
            }
          : {}),
      }),
    );
    // Bootstrap the thread's ONE planning stage + thread — d7: `stage_id` is never null, even for a job
    // that never gets a plan proposed.
    await this.jobBootstrap?.ensurePlanningStage(thread.id, org.id);
    const operatorText = text ?? '';
    // Write any attachments to the job's /context/uploads (visible in-sandbox) and PREPEND an
    // <uploaded-files> block to the body so the brain reads them; persist a card for the web transcript.
    const attach = files?.length
      ? await this.ingestAttachments(org.id, thread.id, files)
      : null;
    // For a review job with a PR number, PREPEND a <review> block so the brain knows on turn 1 exactly
    // which PR to fetch and review — no reverse-engineering from the title.
    const prNumber = kind === 'review' ? Number(body.prNumber) : NaN;
    const prXml =
      kind === 'review' && Number.isInteger(prNumber) && prNumber > 0
        ? renderReviewSeedXml(prNumber, repo.slug)
        : null;
    const bodyText = [prXml, attach?.xml, operatorText].filter(Boolean).join('\n\n');
    // Inject the first message — the chat bridge resolves the thread by its real id and triages it.
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
    // Fire-and-forget: generate a concise title from the first message and push it live (see service).
    void this.threadTitle
      .generateAndApply(
        thread.id,
        org.id,
        repo.id,
        operatorText || 'Attached files',
        placeholder,
      )
      .catch((err) =>
        this.logger.warn(`title gen dispatch failed for ${thread.id}: ${err}`),
      );
    this.logger.log(`web created thread ${thread.id} on ${org.id}/${repo.id}`);
    return { jobId: thread.id };
  }

  /** `GET …/threads/:jobId/messages` — the durable message log (oldest-first). Org-scoped. */
  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/messages')
  @UseGuards(OrgMembershipGuard)
  async messageHistory(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<unknown[]> {
    await this.requireThread(jobId, org.id);
    const rows = await this.messages.find({
      where: { job_id: jobId },
      order: { created_at: 'ASC' },
    });
    return rows.map((m) => ({
      id: m.id,
      // The owning thread (d3) + optional subagent (d4) — the web filters a thread's transcript by
      // `threadId` and joins a spawned subagent's blocks by `subagentId` (replaces the old
      // `meta.phaseId`/`meta.parentToolUseId↔meta.id` peel).
      threadId: m.thread_id,
      subagentId: m.subagent_id,
      ts: m.ts,
      author: m.author,
      authorId: m.author_id,
      isAtlas: m.author_bot_id != null,
      // Provenance for the web renderer, by AUDIENCE:
      //   'system_operator' — system→operator only (e.g. an unresumable-thread error); Atlas didn't author
      //                       it and never sees it. Rendered as a dedicated system-notice box.
      //   'system_shared'   — system→operator AND Atlas (e.g. Codex plan-review findings; Atlas gets a
      //                       separate seed). Rendered as the "Codex review" panel.
      //   'system_event'    — an automated notification that opened this thread (Atlas got a harness
      //                       delivery). Rendered as the "Event" panel; `meta.eventSource`/`severity` head it.
      //   'atlas' | 'operator' — ordinary turns (inferred from author when no explicit source).
      source: mapMessageSource(
        (m.meta as { source?: unknown } | null)?.source,
        m.author_bot_id != null,
      ),
      text: m.text,
      kind: m.kind,
      ...(m.card ? { card: m.card } : {}),
      ...(m.meta ? { meta: m.meta } : {}),
      postedAt: m.created_at,
    }));
  }

  /**
   * `POST …/threads/:jobId/say` — inject a human reply. Returns the synthetic ts.
   *
   * Text-only sends stay pure JSON (the `FilesInterceptor` no-ops on non-multipart requests, so the
   * optimistic-`useSay` hot path is untouched). When the operator attaches files/images the request is
   * multipart: each file is streamed to `/context/uploads/` (visible in-sandbox), an `<uploaded-files>`
   * XML block is PREPENDED to the body so the brain reads them with its Read tool, and an `attachments_card`
   * rides `messages.card` for the transcript.
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/say')
  @UseGuards(OrgMembershipGuard)
  @UseInterceptors(
    FilesInterceptor('files', MAX_ATTACHMENTS, {
      limits: { fileSize: MAX_ATTACHMENT_BYTES },
    }),
  )
  async say(
    @CurrentOrg() org: CurrentOrgCtx,
    @CurrentUser() user: UserEntity,
    @Param('repoId') repoId: string,
    @Param('jobId') jobId: string,
    @Body() body: SayDto,
    @UploadedFiles() files?: UploadedAttachment[],
  ): Promise<{ ts: string }> {
    const operatorText = body?.text ?? '';
    if (!operatorText && !files?.length) {
      throw new BadRequestException('text or an attachment is required');
    }
    // Only the leader processes turns. During a deploy's drain window this instance is draining (or is a
    // standby), so reject new turns with 503 — the client retries and lands on the freshly-promoted
    // leader within a poll interval. (isLeader() is false while draining or a follower.)
    if (!this.election.isLeader()) {
      throw new ServiceUnavailableException(
        'Atlas is handing off — retry momentarily.',
      );
    }
    const thread = await this.requireThread(jobId, org.id);
    if (thread.status === 'blocked') {
      throw new BadRequestException(
        'This job is blocked on another job; unblock it (or wait for its blocker to merge) before interacting.',
      );
    }
    const attach = files?.length
      ? await this.ingestAttachments(org.id, jobId, files)
      : null;
    const bodyText = attach ? `${attach.xml}\n\n${operatorText}` : operatorText;

    // A lane-targeted message (`thread:<id>`) routes through the shared send seam to the thread that owns the
    // lane — steering a live builder turn, or re-driving a halted one with the text as guidance. Absent or
    // `'main'` keeps the byte-identical planning-brain path below.
    const targetLane = body?.lane;
    if (targetLane && targetLane !== 'main') {
      const seam = this.threadInput;
      if (!seam) {
        throw new ServiceUnavailableException('thread messaging is unavailable — retry momentarily.');
      }
      if (!seam.canPost(targetLane)) {
        throw new BadRequestException(`thread "${targetLane}" is not accepting messages right now`);
      }
      const author = operatorAuthor(user);
      await seam.postToThread(
        targetLane,
        {
          jobId,
          orgId: org.id,
          repoId: thread.repo_id,
          author: { id: author.authorId, displayName: author.authorName },
        },
        bodyText,
      );
      return { ts: new Date().toISOString() };
    }

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
    return { ts };
  }

  /**
   * Persist a batch of composer attachments to the job's durable `/context/uploads/` bucket (host-side of
   * the `/context` bind-mount, so they appear in-sandbox at `/context/uploads/…` with no new bind), and
   * build both the `<uploaded-files>` XML (for the brain body) and the `attachments_card` items (for the
   * web). Streams each buffer to disk — no base64, no synchronous whole-file encode on the host loop.
   */
  private async ingestAttachments(
    orgId: string,
    jobId: string,
    files: UploadedAttachment[],
  ): Promise<{ xml: string; items: AttachmentCardItem[] }> {
    if (files.length > MAX_ATTACHMENTS) {
      throw new BadRequestException(`at most ${MAX_ATTACHMENTS} attachments`);
    }
    const uploadsDir = join(
      this.threadLifecycle.contextDirHost(jobId, orgId),
      'uploads',
    );
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

  /**
   * `POST …/threads/:jobId/review-comments` — send a batch of inline highlight-and-comment review
   * comments (selected quotes + optional notes, from the right-pane file/spec viewer) as ONE durable
   * human message. Routes through the SAME operator-chat intake as `say` (a real `messages`+`stimuli`
   * row, delivery/retry inherited from the existing at-least-once boot sweep) — NOT a non-persisted
   * system seed — so it both drives a brain turn AND renders as a styled `review_comments_card` (the
   * card rides `messages.card`; the brain still reads the formatted markdown body).
   */
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
    // Only the leader processes turns — same rationale as `say`.
    if (!this.election.isLeader()) {
      throw new ServiceUnavailableException(
        'Atlas is handing off — retry momentarily.',
      );
    }
    const thread = await this.requireThread(jobId, org.id);
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
    return { ts };
  }

  /**
   * `GET …/repos/:repoId/events` — SSE for the repo, carrying frame types discriminated by `type`:
   *  - `{ type: 'message', … }` — a durable post landed (chat / approval card / PR card / status). The
   *    client refetches the authoritative `/messages` + pipeline.
   *  - `{ type: 'stream', jobId, seq, event }` — the live in-sandbox session. `event` is either a
   *    `{ kind: 'snapshot', blocks, active, startedAt }` (the RESUMABLE catch-up replayed the moment THIS
   *    client connects, for every in-flight turn in the repo — `startedAt` lets a client that missed the
   *    original `turn_start` still drive an accurate elapsed timer), a token/thinking/tool delta, a
   *    `{kind:'turn_start', startedAt}` (first frame of a turn), or `{kind:'turn_end'}`.
   *    The client filters by `jobId`, applies the snapshot, then deltas (deduped by `seq`), and
   *    reconciles against `/messages` on `turn_end`.
   *
   * The snapshot-on-connect is what makes a long response keep streaming across refresh / navigate-away /
   * network blips: the producing turn runs independent of this connection (driven by chat intake), so a
   * reconnecting client catches up to the current state instead of seeing nothing until the turn ends.
   */
  @Sse('orgs/:orgId/repos/:repoId/events')
  @UseGuards(OrgMembershipGuard)
  events(
    @Param('orgId') orgId: string,
    @Param('repoId') repoId: string,
  ): Observable<MessageEvent> {
    const messages$ = this.surface.outbound$.pipe(
      filter((msg: WebOutboundMessage) => msg.channel === repoId),
      map((msg): MessageEvent => ({ data: { type: 'message', ...msg } })),
    );
    // Replayed once per connection (deferred → read at subscribe time): the current state of every
    // in-flight turn, so a (re)connecting client resumes mid-stream.
    const snapshot$ = defer(() =>
      from(this.liveTurns.snapshotsForRepo(repoId)),
    ).pipe(
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
    // Thread metadata (e.g. an auto-generated title) → a targeted live update the client applies in place.
    const meta$ = this.surface.threadMeta$.pipe(
      filter((m) => m.channel === repoId),
      map(
        (m): MessageEvent => ({
          data: { type: 'thread_meta', jobId: m.jobId, title: m.title },
        }),
      ),
    );
    // Claude-subscription usage ring updates for this org — a harvested-window change during a turn or an
    // account switch (see `OauthUsageService.invalidate`).
    const usage$ = this.usageBus.stream$.pipe(
      filter((e) => e.orgId === orgId),
      map((e): MessageEvent => ({ data: { type: 'usage', orgId: e.orgId, usage: e.usage } })),
    );
    return merge(snapshot$, live$, messages$, meta$, usage$);
  }

  /** `POST …/threads/:jobId/approve` — submit a plan verdict. */
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
    if (!meta)
      throw new BadRequestException(
        'value is not a valid ApprovalActionMeta JSON',
      );
    if (meta.jobId !== jobId) {
      throw new BadRequestException(
        'approval value does not match the route job',
      );
    }
    // The verdict's target thread (meta.jobId is the thread id) must belong to the caller's org.
    const thread = await this.requireThread(meta.jobId, org.id);
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
        await this.postSystemOperatorNotice(
          thread.repo_id,
          thread.id,
          org.id,
          message,
        );
        return { ok: false, jobId: meta.jobId, message };
      }
    }
    // Stamp the AUTHENTICATED operator (a real user uuid, FK-valid for `decision_records.approved_by`) as
    // the approver — never the client-sent `ruledBy` (untrusted, and a label like "U-OPERATOR" is not a
    // uuid, which previously made `store.approve` throw and the verdict silently no-op).
    // The MERGE click resolves SYNCHRONOUSLY: await the merge so the response only returns 2xx once the PR
    // actually merged, and a failed/no-op merge surfaces as a 409 instead of a false success.
    if (actionId === MERGE_ACTION_ID) {
      const merged = await resolveMergeApproval(this.moduleRef, meta.jobId, user.id);
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
    await this.surface
      .post(repoId, text, { threadTs: jobId, orgId, meta })
      .catch((err) => {
        this.logger.warn(`failed to post approval notice: ${err}`);
      });
    await this.store.appendSystemOperatorMessage(jobId, text, meta);
  }

  /**
   * `POST …/threads/:jobId/retry` — the halted-build "Retry" button. Re-drives a HALTED build (a job
   * carrying a `halt`) through the deterministic, resumable driver (`JOB_DISPATCHER.retry` → flips back to
   * `running`, fast-forwards finished work, continues at the first unfinished step). `status` (the build
   * phase) is untouched by the halt, so retry resumes it in place. No-op if the thread isn't halted.
   * Scoped to the caller's org via the membership guard + `requireThread`.
   *
   * Also the build-lane FORCE-resume for a `session_limit` park: `ThreadDriver.retry` un-halts any halt kind
   * (session_limit included) and clears the auto-resume clock, so this same endpoint resumes a parked build early.
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/retry')
  @UseGuards(OrgMembershipGuard)
  async retry(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<{ ok: boolean; status: string }> {
    const thread = await this.requireThread(jobId, org.id);
    if (!thread.halt) {
      // Idempotent / not-applicable: nothing to retry (already running, done, or pre-build).
      return { ok: false, status: thread.status };
    }
    await this.dispatcher.retry(jobId);
    return { ok: true, status: 'running' };
  }

  /**
   * `POST …/jobs/:jobId/threads/:threadId/retry-verification` — the "Retry now" lever on a thread held on a
   * verification-judge outage (`judge_unavailable`). Re-arms the judge-cap re-drive budget and re-drives.
   * Scoped to the caller's org via the membership guard + `requireThread` (job ownership).
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/threads/:threadId/retry-verification')
  @UseGuards(OrgMembershipGuard)
  async retryVerification(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('threadId') threadId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    await this.requireThread(jobId, org.id);
    return this.dispatcher.operatorRetryStuckThread(jobId, threadId);
  }

  /**
   * `POST …/jobs/:jobId/threads/:threadId/accept` — the "Skip & accept" lever on a thread held on a
   * verification-judge outage. Sets a durable accept marker and re-enters the drive, which finalizes the
   * thread `done` with the live sandbox. Safety-gated server-side (judge_unavailable + static checks passed).
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/threads/:threadId/accept')
  @UseGuards(OrgMembershipGuard)
  async acceptThread(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('threadId') threadId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    await this.requireThread(jobId, org.id);
    return this.dispatcher.operatorAcceptStuckThread(jobId, threadId);
  }

  /**
   * `POST …/threads/:jobId/retry-turn` — the "Resume" button on a `retryable` system→operator error box
   * (a brain chat-turn that hit a transient engine failure, e.g. a 529). Distinct from `/retry` (which only
   * re-drives a HALTED build) — a chat-turn failure never touches job status, so that
   * endpoint would no-op here. Seeds a NON-persisted system turn (`seedSystemNotification` — same seam
   * `provide-secret`/`answer-question` already use) that resumes the SAME engine session
   * (`resume: sessionId`, already the default across turns) with a minimal harness-authored nudge — never
   * a new operator-authored chat bubble, and never repeats the original request back to the engine.
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/retry-turn')
  @UseGuards(OrgMembershipGuard)
  async retryTurn(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<{ ok: boolean }> {
    const thread = await this.requireThread(jobId, org.id);
    // Name the task in the resume nudge — a bare "Please continue." on a cold re-attach can leave the brain
    // disoriented (it re-asks what to continue). The title gives the resumed turn its bearings.
    const resumeNudge = retryResumeNudge(thread.title ?? undefined);
    this.surface.seedSystemNotification(thread.repo_id, jobId, resumeNudge, {
      orgId: org.id,
      seedRow: {
        label: 'Resuming the turn after a transient engine error.',
        chunkKey: chunkKey.retry(jobId, Date.now()),
      },
    });
    // Force-resume of a Main-lane session-limit park: clear the durable auto-resume clock so the leader sweep
    // never re-fires the resume it has now been done early. Harmless when the thread wasn't parked (no-op update).
    await this.store.setSessionResume(jobId, null, null);
    return { ok: true };
  }

  /**
   * `POST …/jobs/:jobId/stop` — the operator hit Stop while Atlas was mid-turn. Cooperatively aborts the
   * live brain turn (the in-container SDK query stops; the engine writes a graceful `final`), so the normal
   * completion path persists the partial transcript, finalizes the turn, and clears `turn_active` (dropping
   * the "working" indicator). Idempotent: `stopped:false` when nothing was running. Leader-only (the turn
   * runs on the leader). Scoped to the caller's org via the membership guard + `requireThread`.
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/stop')
  @UseGuards(OrgMembershipGuard)
  async stop(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<{ stopped: boolean }> {
    await this.requireThread(jobId, org.id);
    const stopped = await this.brain.stopTurn(jobId);
    return { stopped };
  }

  /**
   * `POST …/threads/:jobId/answer-question` — answer a brain `ask_question` card. GATED on the CARD's
   * OWN state (there is no single-slot thread pointer; many cards can be open at once): an already-delivered
   * card is stale, an already-answered card is an idempotent no-op (e.g. a double click). The first valid
   * answer is stamped atomically by `markQuestionAnswered` (a conditional update — concurrent double-answers
   * can't both win); only the winner seeds the delivery turn (carrying this card's `questionId`), whose
   * success tail stamps the card `deliveredAt`, and `create_decision` attaches the Q&A.
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/answer-question')
  @UseGuards(OrgMembershipGuard)
  async answerQuestion(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Body() body: AnswerQuestionDto,
  ): Promise<{ ok: boolean; ts: string }> {
    const answer = body?.answer?.trim();
    if (!body?.questionId || !answer) {
      throw new BadRequestException('questionId and answer are required');
    }
    const thread = await this.requireThread(jobId, org.id);
    const card = await this.messages.findOne({
      where: { job_id: jobId, ts: body.questionId, kind: 'card' },
    });
    const payload = card?.card as WebQuestionCard | undefined;
    if (!card || payload?.type !== 'question_card') {
      throw new BadRequestException('no such question on this thread');
    }
    // Stale (already delivered) → no-op. Already answered (delivery in flight) → idempotent ok. These are
    // cheap fast-paths off the snapshot; `markQuestionAnswered` below is the authoritative conditional gate.
    if (payload.deliveredAt) return { ok: false, ts: '' };
    // Withdrawn by the brain (`withdraw_question`) → terminal, no longer answerable. No-op.
    if (payload.withdrawnAt) return { ok: false, ts: '' };
    if (payload.answer != null) return { ok: true, ts: '' };
    // Atomic first-answer: only the txn that flips the still-unanswered card "wins" (decrements the
    // open-question counter); a concurrent loser returns ok without firing a second delivery turn.
    const { firstAnswer } = await this.store.markQuestionAnswered(
      jobId,
      body.questionId,
      answer,
    );
    if (!firstAnswer) return { ok: true, ts: '' };
    // A `request_operator_input` card (origin 'build') is consumed by the DRIVER, not the brain: the paused
    // build turn polls this card for `answer`. `markQuestionAnswered` above already stamped it + decremented
    // the needs-you counter, so there is nothing more to do — do NOT seed a brain turn (there is no brain
    // question to deliver). The driver stamps `deliveredAt` when it reads the answer.
    if (payload.origin === 'build') return { ok: true, ts: '' };
    // Deliver the answer to the brain as a SYSTEM SEED — a `<system_notification>` framed turn that is NOT
    // persisted as a chat bubble (the answer lives on the card). The seed carries `deliveredQuestionId` so
    // its delivery turn stamps exactly THIS card `deliveredAt` on success (at-least-once recovery on boot).
    const question = (payload.question ?? '').trim();
    const notice = answeredQuestionBody(question, answer);
    const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
      orgId: org.id,
      deliveredQuestionId: body.questionId,
      seedRow: { label: notice, chunkKey: chunkKey.qa(jobId, body.questionId) },
    });
    return { ok: true, ts };
  }

  /**
   * `POST …/jobs/:jobId/spin-up-preview` — the operator tapped "Spin up preview" on the ship-review card.
   * Injects the FULL demo-ready preview procedure as a `SYSTEM_SEED_AUTHOR` seed turn (delivered on demand,
   * NOT standing in the build-brain system prompt) and stamps the ship card "requested" so the button hides.
   * Gated SERVER-SIDE on `status === 'awaiting_ship_review'` (defense-in-depth against a stale transcript
   * card) and on the atomic first-click stamp (`markPreviewRequested`) so a double-click seeds exactly once.
   * Membership-guarded — any org member may request a preview.
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/spin-up-preview')
  @UseGuards(OrgMembershipGuard)
  async spinUpPreview(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<{ ok: boolean; ts: string }> {
    if (!this.election.isLeader()) {
      throw new ServiceUnavailableException(
        'Atlas is handing off — retry momentarily.',
      );
    }
    const thread = await this.requireThread(jobId, org.id);
    if (thread.status !== 'awaiting_ship_review') return { ok: false, ts: '' };
    const firstRequest = await this.driverStore.markPreviewRequested(jobId);
    if (!firstRequest) return { ok: true, ts: '' }; // idempotent double-click — already seeded.
    // Best-effort recipe read — a transient DB failure here must NOT lose the seed: `markPreviewRequested`
    // already stamped the card irreversibly, so degrade to 'no recipe' rather than throwing post-stamp.
    let previewInstructions: string | null | undefined;
    try {
      previewInstructions = await this.configStore?.getPreviewInstructions(org.id, thread.repo_id);
    } catch {
      previewInstructions = null;
    }
    const ts =
      this.jit?.fireLifecycle('preview-requested', {
        repoId: thread.repo_id,
        jobId,
        orgId: org.id,
        // Same concrete surface the hand-rolled call used — NOT the ambient `CHAT_SURFACE` (which the
        // 'agent' test surface can rebind to something else entirely).
        surface: this.surface,
        previewInstructions,
      }) ?? '';
    return { ok: true, ts };
  }

  /**
   * `POST …/threads/:jobId/provide-secret` — provide the value for a brain `request_secret` card during
   * repo onboarding. THE ONLY PLACE A SECRET VALUE LIVES: it goes straight to the encrypted
   * `WorkspaceSecretFileStore` as this repo's secret file at (repo, path), and is NEVER written to the
   * card, the transcript, or any brain tool I/O. OWNER-ONLY (`OrgOwnerGuard`) — writing a secret file is
   * an Administer action everywhere
   * else. Gated on the thread's durable `awaiting_secret_id`; stamps the card `provided_at` (not the value)
   * and delivers a MASKED confirmation to the brain, whose success tail stamps delivered + clears the gate.
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/provide-secret')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async provideSecret(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Body() body: ProvideSecretDto,
  ): Promise<{ ok: boolean; ts: string }> {
    const value = body?.value;
    if (!body?.requestId || value == null || value === '') {
      throw new BadRequestException(
        'requestId and a non-empty value are required',
      );
    }
    const thread = await this.requireThread(jobId, org.id);
    const card = await this.messages.findOne({
      where: { job_id: jobId, ts: body.requestId, kind: 'card' },
    });
    const payload = card?.card as WebSecretInputCard | undefined;
    if (!card || payload?.type !== 'secret_input_card') {
      throw new BadRequestException('no such secret request on this thread');
    }
    // Gate against stale / already-handled cards (idempotent — e.g. a double submit): only the thread's
    // currently-open secret request is fillable, and only once.
    if (thread.awaiting_secret_id !== body.requestId || payload.delivered_at) {
      return { ok: false, ts: '' };
    }
    if (payload.provided_at != null) {
      return { ok: true, ts: '' }; // already provided; a delivery turn is in flight / queued
    }

    // EPHEMERAL lane — a one-time value (an OAuth code, a 2FA code) piped STRAIGHT into the running process
    // and NEVER stored: no encrypted store, no grant, no rehydrate. If the target process isn't reading (dead
    // reader → the write times out), clear the gate and tell the brain to restart the login rather than wedge.
    if (payload.ephemeral) {
      const deliverTo = payload.deliver_to ?? '';
      if (!deliverTo) {
        throw new BadRequestException(
          'ephemeral request has no delivery target',
        );
      }
      const delivered = await this.threadLifecycle.deliverEphemeralSecret({
        jobId,
        path: deliverTo,
        // gcloud (and most stdin prompts) read a single line — normalize to exactly one trailing newline.
        value: `${value.replace(/\r?\n$/, '')}\n`,
      });
      if (!delivered.ok) {
        // The reader is gone / not reading — this card is dead. Clear the single-slot gate so the brain can
        // re-run the login, and seed a turn telling it to.
        await this.store.clearAwaitingSecret(jobId, body.requestId);
        const notice = secretEphemeralUndelivered(
          payload.name,
          delivered.reason ?? 'the target process is not reading',
        );
        const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
          orgId: org.id,
          seedRow: { label: notice, chunkKey: chunkKey.secret(jobId, payload.name, { fail: true }) },
        });
        return { ok: false, ts };
      }
      // Delivered — stamp the card provided (no value) + hand the brain a masked confirmation. The gate clears
      // on the delivery turn's success tail (same at-least-once path as a durable secret).
      card.card = {
        ...(card.card ?? {}),
        provided_at: new Date().toISOString(),
      };
      await this.messages.save(card);
      const notice = secretEphemeralDelivered(payload.name);
      const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
        orgId: org.id,
        deliveredSecretId: body.requestId,
        seedRow: { label: notice, chunkKey: chunkKey.secret(jobId, payload.name) },
      });
      return { ok: true, ts };
    }

    // MCP-TARGET lane — the value is a credential slot (header/env) for a repo-scoped MCP server. It writes
    // into `mcp_servers.secrets_enc` (NOT the worktree store), on THIS thread's repo scope (re-derived here,
    // never trusted from the card), and does NOT grant/rehydrate — MCP secrets are resolved per-turn by
    // `McpResolver`. After writing we best-effort re-probe a remote server so the masked confirmation can
    // report whether it now connects. The value's only resting place is the encrypted blob.
    if (payload.mcp) {
      const { server, slot, key } = payload.mcp;
      // Authoritative guard: an OAuth server's Authorization is minted by the console "Connect" flow, never a
      // pasted secret. Refuse a secret write to an `auth_kind='oauth'` row (no setSecret, no probe) even if a
      // stale card slipped past the brain-side check — the row is the source of truth.
      const target = await this.mcpStore.rawRow(org.id, thread.repo_id, server).catch(() => null);
      if (target?.auth_kind === 'oauth') {
        await this.store.clearAwaitingSecret(jobId, body.requestId);
        const notice = mcpSecretOauthRefused(server);
        const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
          orgId: org.id,
          seedRow: { label: notice, chunkKey: chunkKey.mcpSecret(jobId, server, key, 'oauth') },
        });
        return { ok: false, ts };
      }
      const wrote = await this.mcpStore.setSecret(
        org.id,
        thread.repo_id,
        server,
        slot === 'header' ? 'headers' : 'env',
        key,
        value,
      );
      if (!wrote) {
        // The server row is gone (deleted between propose/approve and provide) — clear the gate and tell the
        // brain rather than wedge on a stale card.
        await this.store.clearAwaitingSecret(jobId, body.requestId);
        const notice = mcpSecretStoreFailed(key, server);
        const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
          orgId: org.id,
          seedRow: { label: notice, chunkKey: chunkKey.mcpSecret(jobId, server, key, 'fail') },
        });
        return { ok: false, ts };
      }
      // Best-effort validation so the confirmation says whether it connected (remote only; stdio spawns
      // in-sandbox). Never throws — a failure is persisted as the server's validation state.
      const row = await this.mcpStore.rawRow(org.id, thread.repo_id, server).catch(() => null);
      if (row) {
        const result = await this.mcpProbe.validate(row);
        await this.mcpStore
          .recordValidation(org.id, thread.repo_id, server, result)
          .catch(() => undefined);
      }
      card.card = { ...(card.card ?? {}), provided_at: new Date().toISOString() };
      await this.messages.save(card);
      const notice = mcpSecretStored(key, server, slot);
      const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
        orgId: org.id,
        deliveredSecretId: body.requestId,
        seedRow: { label: notice, chunkKey: chunkKey.mcpSecret(jobId, server, key) },
      });
      return { ok: true, ts };
    }

    if (!payload.path) {
      throw new BadRequestException(
        'secret request is missing its destination path',
      );
    }
    // Write the value to the ENCRYPTED store as this repo's secret file at (repo, path); the row IS the
    // authority. `payload.name` rides along as the display label. This is the value's only resting place;
    // everything downstream is masked.
    await this.secrets.write(org.id, thread.repo_id, payload.path, value, payload.name);
    // Render the newly-written value into the RUNNING sandbox now, so it is on disk before the brain's
    // confirmation turn runs (otherwise it wouldn't appear until the next lazy provision). Best-effort —
    // a failure here still lets the next turn's ensureContainer hydrate it.
    await this.threadLifecycle
      .rehydrateThread(jobId, org.id)
      .catch(() => undefined);
    // Stamp the card PROVIDED (no value), then deliver a MASKED confirmation. The gate clears only on the
    // delivery turn's success tail, so a crash before it re-delivers on boot (at-least-once).
    card.card = { ...(card.card ?? {}), provided_at: new Date().toISOString() };
    await this.messages.save(card);
    const notice = secretStored(payload.name, payload.path);
    const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
      orgId: org.id,
      deliveredSecretId: body.requestId,
      seedRow: { label: notice, chunkKey: chunkKey.secret(jobId, payload.name) },
    });
    return { ok: true, ts };
  }

  /**
   * `POST …/jobs/:jobId/mcp-proposals/:requestId/approve` — the OWNER approves a brain `propose_mcp_servers`
   * card, committing each proposed server to `McpServerStore`. This is the ONLY place a brain-originated MCP
   * write lands: MCP mutations are an owner-only Administer action (same guard as the console
   * `McpServersController`). The scope is the card's (`'org'` → every repo, else this thread's repo) — the
   * brain proposes it, the owner approving here is the trust boundary. Secret header/env slots commit as
   * empty placeholders; the owner fills them afterwards via
   * `request_secret` (mcp target). A remote server needing no secret is probed so its tool list populates
   * immediately. Idempotent (a re-approve of an already-committed card is a no-op).
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/mcp-proposals/:requestId/approve')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async approveMcpProposal(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('requestId') requestId: string,
  ): Promise<{ ok: boolean; committed: string[]; ts?: string }> {
    const thread = await this.requireThread(jobId, org.id);
    const card = await this.store.getMcpProposalCard(jobId, requestId);
    if (!card) throw new BadRequestException('no such MCP proposal on this thread');
    if (card.approved_at) {
      return { ok: true, committed: card.committed ?? [] };
    }
    // Defensive: never let an approval shadow a reserved system server, even if a stale card slipped one in.
    // Registration scope from the card: 'org' → the '*' sentinel (every repo), else this thread's repo.
    // The owner (this endpoint) is the trust boundary — the brain proposes the scope, the owner approves it.
    const dbScope = card.scope === 'org' ? '*' : thread.repo_id;

    // Removal proposal: delete the named servers from `dbScope` instead of registering. Owner-gated like a
    // registration (the brain proposed it; approving here deletes). Idempotent — deleting a gone row is a no-op.
    if (card.mode === 'remove') {
      const removed: string[] = [];
      for (const name of card.removeNames ?? []) {
        if (!name || isReservedMcpName(name)) continue;
        await this.mcpStore.delete(org.id, dbScope, name);
        removed.push(name);
      }
      await this.store.markMcpProposalApproved(jobId, requestId, removed);
      const rmNotice = mcpRemoved(removed, card.scope);
      const rmTs = this.surface.seedSystemNotification(thread.repo_id, jobId, rmNotice, {
        orgId: org.id,
        seedRow: { label: rmNotice, chunkKey: chunkKey.mcpRemove(jobId, requestId) },
      });
      return { ok: true, committed: removed, ts: rmTs };
    }

    const committed: string[] = [];
    const needSecrets: string[] = [];
    const needConnect: string[] = [];
    let readyStatic = 0;
    for (const s of card.servers) {
      if (!s.name || isReservedMcpName(s.name)) continue;
      await this.mcpStore.write(org.id, dbScope, s.name, this.mcpProposalToInput(s));
      committed.push(s.name);
      // OAuth server: lands UNCONNECTED (no token yet). It has no secret slot to fill and MUST NOT be static-
      // probed here — an unconnected OAuth endpoint 401s, which would falsely mark it broken. The owner completes
      // consent via the console "Connect" (McpOAuthService), after which it validates.
      if (s.authKind === 'oauth') {
        needConnect.push(s.name);
        continue;
      }
      const secretSlots = [
        ...(s.headers ?? []).filter((h) => h.secret).map((h) => `${s.name} header:${h.name}`),
        ...(s.env ?? []).filter((e) => e.secret).map((e) => `${s.name} env:${e.name}`),
      ];
      needSecrets.push(...secretSlots);
      // A remote server that needs no secret can be validated now so its tool list is populated.
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
    const notice = mcpApproved({ committed, scope: card.scope, needSecrets, needConnect, readyStatic });
    const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
      orgId: org.id,
      seedRow: { label: notice, chunkKey: chunkKey.mcpApprove(jobId, requestId) },
    });
    return { ok: true, committed, ts };
  }

  /**
   * `POST …/jobs/:jobId/convention-proposals/:requestId/approve` — the OWNER approves a brain
   * `propose_convention_profile` card, attaching the proposed house-style profile to THIS thread's repo. This
   * is the ONLY place a brain-originated house-style attach lands: it is an owner-only action (same guard as
   * the console), and the scope is FORCED to `thread.repo_id` — never trusted from the card. Idempotent (a
   * re-approve of an already-attached card is a no-op).
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/convention-proposals/:requestId/approve')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async approveConventionProposal(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('requestId') requestId: string,
  ): Promise<{ ok: boolean; slug: string; ts?: string }> {
    const thread = await this.requireThread(jobId, org.id);
    const card = await this.store.getConventionProposalCard(jobId, requestId);
    if (!card) throw new BadRequestException('no such convention proposal on this thread');
    if (card.approved_at) {
      return { ok: true, slug: card.slug };
    }
    // Scope FORCED to the thread's repo — the card's repoId is display-only. `attach` validates the slug still
    // exists in the org (throws if the profile was deleted between propose and approve).
    await this.conventions.attach(org.id, thread.repo_id, card.slug);
    await this.store.markConventionProposalApproved(jobId, requestId);
    const notice = conventionAttached(card.profileName);
    const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
      orgId: org.id,
      seedRow: { label: notice, chunkKey: chunkKey.convApprove(jobId, requestId) },
    });
    return { ok: true, slug: card.slug, ts };
  }

  /**
   * `POST …/jobs/:jobId/convention-edit-proposals/:requestId/approve` — the OWNER approves a build brain
   * `propose_convention_profile_change` card, UPSERTING the reusable house-style profile's content. A
   * house-style change is cross-cutting (it affects every repo/job in the org), so it's owner-only. The
   * profile is org-level — the write is keyed on `(org, slug)` from the card, not the repo. Idempotent (a
   * re-approve of an already-applied card is a no-op).
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/convention-edit-proposals/:requestId/approve')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async approveConventionEditProposal(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('requestId') requestId: string,
  ): Promise<{ ok: boolean; slug: string; ts?: string }> {
    const thread = await this.requireThread(jobId, org.id);
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
    const notice = conventionEdited(card.mode, card.name);
    const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
      orgId: org.id,
      seedRow: { label: notice, chunkKey: chunkKey.convEditApprove(jobId, requestId) },
    });
    return { ok: true, slug: card.slug, ts };
  }

  /**
   * `POST …/jobs/:jobId/skill-proposals/:requestId/approve` — the OWNER approves a brain `propose_skill`
   * card, WRITING the reusable SKILL.md via `WorkspaceSkillStore`. A skill shapes how every future build on
   * a matching repo/org behaves, so it's owner-only. The write scope is the card's `scope`: `'org'` → the
   * `'*'` sentinel (every repo), `'repo'` → this repo id. Idempotent (a re-approve is a no-op).
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/skill-proposals/:requestId/approve')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async approveSkillProposal(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('requestId') requestId: string,
  ): Promise<{ ok: boolean; name: string; ts?: string }> {
    const thread = await this.requireThread(jobId, org.id);
    const card = await this.store.getSkillProposalCard(jobId, requestId);
    if (!card) throw new BadRequestException('no such skill proposal on this thread');
    if (card.approved_at) {
      return { ok: true, name: card.name };
    }
    const dbScope = card.scope === 'org' ? '*' : card.repoId;
    // Skills are available to every lane — on-demand description-match already gates loading, so there is no
    // per-lane surface knob on the proposal path.
    const ALL_SURFACES: McpSurface[] = ['brain', 'build', 'review'];
    if (card.mode === 'remove') {
      await this.skillStore.delete(org.id, dbScope, card.name);
      this.skillFiles.removeSkillDir(org.id, dbScope, card.name);
    } else if (card.mode === 'install') {
      // Vendor the maintained skill from git (provenance:'git', auto-updating). The brain's propose is
      // single-skill (a marketplace-root subpath is rejected at propose time), so this lands exactly one row.
      await this.skillInstaller.install({
        orgId: org.id,
        scope: dbScope,
        sourceUrl: card.sourceUrl ?? '',
        ref: card.sourceRef,
        subpath: card.sourceSubpath,
        surfaces: ALL_SURFACES,
      });
    } else {
      // create — vendor the FROZEN staging copy (immutable since propose time), NOT the still-writable
      // /context draft, then remove both. A brain-authored skill is always 'custom' provenance.
      const srcDir = card.stagingPath;
      if (!srcDir || !existsSync(join(srcDir, 'SKILL.md'))) {
        throw new BadRequestException('the authored skill draft is missing — ask the brain to propose it again');
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
      // Drop the now-stale /context draft so the brain edits the durable store copy (via edit-access) instead.
      rmSync(join(this.threadLifecycle.contextDirHost(jobId, org.id), 'skill-drafts', card.name), {
        recursive: true,
        force: true,
      });
    }
    await this.store.markSkillProposalApproved(jobId, requestId);
    const notice = skillApproved(card.mode, card.name, card.scope);
    const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
      orgId: org.id,
      seedRow: { label: notice, chunkKey: chunkKey.skillApprove(jobId, requestId) },
    });
    return { ok: true, name: card.name, ts };
  }

  /**
   * `POST …/jobs/:jobId/skill-edit-access/:requestId/approve` — the OWNER approves a brain
   * `request_skill_edit_access` card, unlocking live `Edit`/`Write` on that skill for the REST of this
   * session. For a `git`-provenance skill this FORKS it to a new `custom` skill first (the original stays
   * untouched — clean and still auto-updatable) and grants the fork instead, so a re-approve after the fork
   * already exists picks the SAME fork rather than minting another. Idempotent (a re-approve on an
   * already-approved card is a no-op). Owner-only — unlocking a skill for live edits is as consequential as
   * creating one.
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/skill-edit-access/:requestId/approve')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async approveSkillEditAccess(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('requestId') requestId: string,
  ): Promise<{ ok: boolean; name: string; grantedAs?: string; ts?: string }> {
    const thread = await this.requireThread(jobId, org.id);
    const card = await this.store.getSkillEditAccessCard(jobId, requestId);
    if (!card) throw new BadRequestException('no such skill edit-access request on this thread');
    if (card.approved_at) {
      return { ok: true, name: card.name, ...(card.forkedTo ? { grantedAs: card.forkedTo } : {}) };
    }
    const dbScope = card.scope === 'org' ? '*' : card.repoId;
    const row = await this.skillStore.get(org.id, dbScope, card.name);
    if (!row) {
      // The skill was deleted/renamed since the request was posted — nothing to grant. Stamp approved
      // (the card is terminal either way) and tell the brain rather than silently wedging the request.
      await this.store.markSkillEditAccessApproved(jobId, requestId);
      const gone = skillEditGone(card.name);
      const goneTs = this.surface.seedSystemNotification(thread.repo_id, jobId, gone, {
        orgId: org.id,
        seedRow: { label: gone, chunkKey: chunkKey.skillEditApprove(jobId, requestId) },
      });
      return { ok: true, name: card.name, ts: goneTs };
    }
    // git → fork-to-custom (§P3): the original stays clean + updatable; the grant applies to the fork.
    const forkedTo = row.provenance === 'git' ? await this.forkSkillToCustom(org.id, dbScope, card.name) : undefined;
    const grantName = forkedTo ?? card.name;
    this.brain.grantSkillEditAccess(jobId, grantName);
    await this.store.markSkillEditAccessApproved(jobId, requestId, forkedTo);
    const notice = skillEditApproved(card.name, forkedTo);
    const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
      orgId: org.id,
      seedRow: { label: notice, chunkKey: chunkKey.skillEditApprove(jobId, requestId) },
    });
    return { ok: true, name: card.name, ...(forkedTo ? { grantedAs: forkedTo } : {}), ts };
  }

  /** Fork a `git`-provenance skill to a fresh `custom` copy in the same scope — `<name>-custom`, or
   *  `<name>-custom-2`/`-3`/… on a name collision (a prior fork, or an unrelated skill of that name). Copies
   *  the dir (full fidelity) then writes the new registry row (`forked_from` the original's name). Returns
   *  the fork's name. */
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

  /** Map a proposal-card server (non-secret defn) to the store's `McpServerInput`: secret slots become empty
   *  `secret:true` placeholders (filled later via `provide-secret`), non-secret entries keep their value. */
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
    // Auth kind + non-secret OAuth knobs pass through to the store (which owns `oauth_enc`); an oauth row lands
    // UNCONNECTED — the owner completes consent via the console "Connect" flow (McpOAuthService.beginAuthorization).
    if (s.authKind === 'oauth') input.authKind = 'oauth';
    if (s.oauth && Object.keys(s.oauth).length) input.oauth = s.oauth;
    return input;
  }

  /**
   * `POST …/threads/:jobId/provide-file` — upload the file for a brain `request_file` card during repo
   * onboarding. Like `provide-secret` (owner-only; contents go straight to the encrypted store as a
   * file-valued secret + an owner grant, NEVER onto the card / transcript / brain tool I/O), but the value
   * arrives as an UPLOAD and the gate is PER-CARD (the card's own state — no single-slot thread pointer),
   * so several file requests can be filled in any order. The store key is repo-scoped (`file:<repoId>:<path>`)
   * so two repos wanting the same relative path don't collide at the org-scoped secret name.
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/provide-file')
  @UseGuards(OrgMembershipGuard, OrgOwnerGuard)
  async provideFile(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Body() body: ProvideFileDto,
  ): Promise<{ ok: boolean; ts: string }> {
    const content = body?.content;
    const filename = body?.filename?.trim() || 'upload';
    if (!body?.requestId || content == null || content === '') {
      throw new BadRequestException(
        'requestId and non-empty file content are required',
      );
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_UPLOAD_BYTES) {
      throw new BadRequestException(
        `file exceeds the ${Math.floor(MAX_FILE_UPLOAD_BYTES / 1024)} KB upload limit`,
      );
    }
    const thread = await this.requireThread(jobId, org.id);
    const card = await this.messages.findOne({
      where: { job_id: jobId, ts: body.requestId, kind: 'card' },
    });
    const payload = card?.card as WebFileRequestCard | undefined;
    if (!card || payload?.type !== 'file_request_card') {
      throw new BadRequestException('no such file request on this thread');
    }
    // Per-card gate (same shape as answer-question): a delivered card is stale; an already-provided card is
    // an idempotent no-op (double submit — a delivery turn is in flight / queued); a withdrawn card was
    // retracted by the brain, so refuse the upload rather than write a secret to a path it abandoned.
    if (payload.withdrawnAt) return { ok: false, ts: '' };
    if (payload.delivered_at) return { ok: false, ts: '' };
    if (payload.provided_at != null) return { ok: true, ts: '' };
    // Write the contents to the ENCRYPTED store as this repo's secret file at (repo, path); the row IS the
    // authority. This is the contents' only resting place; everything downstream is masked.
    await this.secrets.write(org.id, thread.repo_id, payload.path, content, filename);
    // Render the uploaded file into the RUNNING sandbox now (see provide-secret). Best-effort.
    await this.threadLifecycle
      .rehydrateThread(jobId, org.id)
      .catch(() => undefined);
    // Stamp the card PROVIDED (+ filename, no contents), then deliver a MASKED confirmation carrying this
    // card's id so the delivery turn's success tail stamps exactly THIS card delivered (at-least-once).
    card.card = {
      ...(card.card ?? {}),
      provided_at: new Date().toISOString(),
      filename,
    };
    await this.messages.save(card);
    const notice = fileUploaded(payload.path);
    const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
      orgId: org.id,
      deliveredFileId: body.requestId,
      seedRow: { label: notice, chunkKey: chunkKey.file(jobId, payload.path) },
    });
    return { ok: true, ts };
  }

  /** `GET …/threads/:jobId/pipeline` — current pipeline state (or `{ status: 'no_job' }`). */
  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/pipeline')
  @UseGuards(OrgMembershipGuard)
  async pipeline(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<unknown> {
    await this.requireThread(jobId, org.id);
    return this.driverStore.getPipelineState(jobId, org.id);
  }

  /**
   * `GET …/threads/:jobId/context` — list the thread's `/context` files, grouped into `specs` (the
   * plan: plan.md, decision-record.md, diagrams), `artifacts` (human-facing deliverables: preview HTML,
   * mockups, reports), and `evidence` (live-run proof: logs, screenshots, RESULTS.md).
   * V1 MVP: just names + size + mtime. The UI's Artifacts panel composes this with the diff/PR (which
   * are not files — they come from `pipeline`/the thread row).
   */
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

  /**
   * `GET …/threads/:jobId/context/file?path=specs/plan.md` — read ONE `/context` file for the viewer.
   * Text files (.md, .json, …) come back utf-8; images come back base64. Capped at 2 MB; the path is
   * guarded to the thread's own specs/ + generated/ + artifacts/ + evidence/ buckets (no traversal, no
   * cross-thread reads).
   */
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

  /**
   * `GET …/jobs/:jobId/repo/tree` — the job worktree's TRACKED-file manifest (`git ls-files`), so the spec/
   * plan viewer can verify which inline-code spans name a real file before linkifying them. Gitignored files
   * (e.g. the hydrator's secret files) are never tracked, so they never appear here. Empty when the worktree
   * is gone (closed/reset) — the frontend then simply linkifies nothing.
   */
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

  /**
   * `GET …/jobs/:jobId/repo/file?path=backend/sandbox/Dockerfile` — read ONE repo file from the LIVE job
   * worktree (accurate at approval; may drift after a build edits files). Same size-cap/MIME shape as
   * `contextFile`, but rooted at the worktree with `resolveSafeTarget` (rejects traversal/symlink/absolute).
   */
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
    // SECURITY GATE: only serve TRACKED files. The worktree also holds gitignored secret files the hydrator
    // writes into it (e.g. backend/.env.keys, service-account JSON) — resolveSafeTarget keeps us INSIDE the
    // worktree but does not distinguish a secret from source. `isTracked` (git ls-files) excludes gitignored
    // paths, so an untracked/secret path returns 404, matching the tracked-only manifest.
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

  /**
   * `GET …/jobs/:jobId/diff` — the job's ACCUMULATED diff vs its base branch: `merge-base(baseRef, HEAD)`
   * → the CURRENT worktree, so it includes both every commit made across the thread's turns AND any
   * uncommitted edits from the turn in progress (GitHub-PR-like, but live). Empty result when the
   * worktree is gone (closed/reset) or nothing differs.
   */
  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/diff')
  @UseGuards(OrgMembershipGuard)
  async jobDiff(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<JobDiff> {
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

  /**
   * `GET …/threads/:jobId/context/file/raw?path=uploads/xx.png` — STREAM one composer attachment as raw
   * binary (correct `Content-Type`), for `<img>` thumbnails and file downloads in the transcript.
   * Deliberately NOT the base64 `contextFile` endpoint above: a large image would block the host event
   * loop on `readFileSync + toString('base64')` and inflate ~33%. Scoped to the `uploads/` bucket only.
   */
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
      MIME_BY_EXT[ext]?.mime ??
      (ext === '.pdf' ? 'application/pdf' : 'application/octet-stream');
    return new StreamableFile(createReadStream(abs), {
      type: mime,
      length: st.size,
    });
  }

  /**
   * `GET …/jobs/:jobId/context/raw/<bucket-relative-path>` — STREAM one `/context` file (specs/ +
   * generated/ + artifacts/ + evidence/) as raw bytes with the correct `Content-Type`, so a browser can render it
   * directly — e.g. an `<iframe>` HTML preview of an artifact. Deliberately PATH-based (the file path lives
   * in the URL path, not a `?path=` query) so an HTML document's own RELATIVE sub-resource URLs
   * (`style.css`, `chart.png`) resolve against the document URL and get fetched here too. Same bucket +
   * traversal guard as the base64 `contextFile` endpoint (`resolveContextFilePath`); distinct from
   * `contextFileRaw` above, which stays scoped to `uploads/`. Express 5 hands the `*path` wildcard as an
   * array of already-decoded path segments.
   */
  @Get('orgs/:orgId/repos/:repoId/jobs/:jobId/context/raw/*path')
  // Enforce the sandbox SERVER-SIDE, not only via the viewer's <iframe sandbox>: a CSP `sandbox`
  // response header forces this document into an opaque origin (scripts allowed, no same-origin) no
  // matter how it is loaded — including a top-level navigation straight to this URL — so agent-authored
  // HTML can never read the session cookie or call the API as the operator. nosniff pins the type.
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
      MIME_BY_EXT[ext]?.mime ??
      (ext === '.pdf' ? 'application/pdf' : 'application/octet-stream');
    return new StreamableFile(createReadStream(abs), {
      type: mime,
      length: st.size,
    });
  }

  /**
   * `GET …/jobs/:jobId/services` — list processes the agent has started via `atlas-svc run`, read from
   * their durable marker files (the host mirror of `/.atlas/supervisor`). Always-available history,
   * independent of turn lifecycle — NOT a live liveness check (see {@link ServiceInfo}). Empty when the
   * thread has no sandbox home yet or the agent has started nothing.
   */
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
    // Preserve `expose` alongside each marker so URL rendering can honor an opt-out, then project to the
    // wire shape (status/url filled below).
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

    // Join the durable markers with a LIVE liveness probe (exec `kill -0` into the container), gated on
    // the container generation so a recreated container reusing a pgid can't fake `running`. Memoized so
    // overlapping polls / multiple open clients collapse into one docker exec.
    const pgids = services
      .map((s) => s.pgid)
      .filter((p): p is number => p != null);
    const probe = await this.probeLivenessMemoized(jobId, pgids);
    const exposure = this.exposure;
    for (const s of services) {
      s.status = serviceStatus(s, probe);
      const expose = byId.get(s.id)?.expose ?? true;
      const live = s.port != null && expose && s.status === 'running';
      // urlFor already returns null when exposure is disabled, so this is null unless a base domain is set.
      s.url = live ? (exposure?.urlFor(jobId, s.name) ?? null) : null;
    }

    // Fire-and-forget: persist the sidebar port_state and converge Caddy to the freshly-observed live set
    // on every poll (immediacy), never blocking the response. Caddy route mutation remains a no-op when
    // exposure is disabled.
    if (exposure) {
      void exposure.reconcile(jobId).catch(() => undefined);
    }

    return { services };
  }

  /** In-flight/recent liveness probes keyed by job + the exact pgid set (a changed set busts it). */
  private readonly livenessMemo = new Map<
    string,
    { at: number; probe: Promise<ServiceLivenessProbe> }
  >();

  /**
   * Rate-limit the liveness probe: within {@link LIVENESS_MEMO_TTL_MS} the same job + pgid set reuses the
   * one in-flight/resolved probe, so the ~5s status poll (× however many open clients) collapses to a
   * single `docker exec`. Keyed by the pgid SET so a service starting/stopping mid-window isn't masked.
   */
  private probeLivenessMemoized(
    jobId: string,
    pgids: number[],
  ): Promise<ServiceLivenessProbe> {
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

  /**
   * `GET …/jobs/:jobId/services/:id/logs?n=200` — tail a supervised process's captured log (the durable
   * file `atlas-svc run` writes to). Returns the last `n` lines (default/cap below), not the whole file.
   */
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
    const wantLines = Math.min(
      Math.max(parseInt(n ?? '200', 10) || 200, 1),
      2000,
    );
    const { content, truncated } = readServiceLogTail(
      dir,
      id,
      wantLines,
      MAX_SERVICE_LOG_TAIL_BYTES,
    );
    return { id, content, truncated };
  }

  /**
   * `GET …/jobs/:jobId/services/:id/log-events` — SSE live tail of a supervised process's log. First frame
   * is `{ type: 'snapshot', content, truncated }` (same tail the REST endpoint returns); subsequent frames
   * are `{ type: 'append', chunk }` as the file grows. Polls `statSync` every `SERVICE_LOG_POLL_MS` rather
   * than `fs.watch` — `fs.watch` is documented as unreliable (and specifically flaky under Docker bind
   * mounts), so a short poll is the more robust choice here. A restart (`atlas-svc run` truncates the file)
   * re-emits a fresh `snapshot` instead of an `append`.
   */
  @Sse('orgs/:orgId/repos/:repoId/jobs/:jobId/services/:id/log-events')
  @UseGuards(OrgMembershipGuard)
  serviceLogEvents(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Param('id') id: string,
  ): Observable<MessageEvent> {
    return defer(() => from(this.requireThread(jobId, org.id))).pipe(
      switchMap(() => {
        if (!SERVICE_ID_RE.test(id))
          throw new BadRequestException('invalid service id');
        const dir = this.threadLifecycle.supervisorDirHost(jobId);
        return new Observable<MessageEvent>((subscriber) => {
          const snapshot = readServiceLogTail(
            dir,
            id,
            200,
            MAX_SERVICE_LOG_TAIL_BYTES,
          );
          subscriber.next({
            data: {
              type: 'snapshot',
              content: snapshot.content,
              truncated: snapshot.truncated,
            },
          });
          if (!dir || snapshot.size === 0) {
            // No file on disk yet — matches the REST endpoint's empty-content behavior. Nothing to poll
            // until the pane is reopened after the service actually starts writing.
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
              const fresh = readServiceLogTail(
                dir,
                id,
                200,
                MAX_SERVICE_LOG_TAIL_BYTES,
              );
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

  /** `PATCH …/threads/:jobId` — rename a thread (the only thread Update op). Org-scoped. */
  @Patch('orgs/:orgId/repos/:repoId/jobs/:jobId')
  @UseGuards(OrgMembershipGuard)
  async renameJob(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Body() body: RenameThreadDto,
  ): Promise<{ ok: boolean; title: string }> {
    const title = body?.title?.trim().slice(0, 200);
    if (!title) throw new BadRequestException('title is required');
    // Scope the update to the caller's org (defense in depth beyond the membership guard).
    const result = await this.jobs.update(
      { id: jobId, org_id: org.id },
      { title },
    );
    if (!result.affected) throw new NotFoundException('thread not found');
    this.logger.log(`web renamed thread ${jobId} (org ${org.id})`);
    return { ok: true, title };
  }

  /** `PATCH …/jobs/:jobId/auto-approve` — flip the per-job auto-approve toggle. On enable, immediately
   *  resolves a gate the job is already parked on via the exact human-click seam (receiveApprovalClick). */
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
    // Resolve scoped to the org first (defense in depth beyond the guard) — capture the pre-update status so we
    // know whether a gate is already parked.
    const job = await this.requireThread(jobId, org.id);
    const result = await this.jobs.update(
      { id: jobId, org_id: org.id },
      { auto_approve_mode: body.mode, ...(body.mode !== 'off' ? { auto_approve_by: user.id } : {}) },
    );
    if (!result.affected) throw new NotFoundException('thread not found');
    this.logger.log(`web set auto-approve mode=${body.mode} on thread ${jobId} (org ${org.id})`);
    // d2 — enabling a gate the job is ALREADY parked on immediately approves it, through the exact seam a real
    // button click uses (receiveApprovalClick → the module bridge → resolve / resolveShipApprovalDurably, with
    // the durable-restart fallback). Disabling a gate only affects future gates and never un-approves anything.
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

  /** `PATCH …/jobs/:jobId/auto-merge` — flip the per-job auto-merge toggle. On enable, immediately
   *  evaluates an already-ready PR through the exact same evaluator every trigger uses
   *  (`AutoMergeService.maybeAutoMerge`) rather than blocking the request on the merge itself. */
  @Patch('orgs/:orgId/repos/:repoId/jobs/:jobId/auto-merge')
  @UseGuards(OrgMembershipGuard)
  async setAutoMerge(
    @CurrentOrg() org: CurrentOrgCtx,
    @CurrentUser() user: UserEntity,
    @Param('jobId') jobId: string,
    @Body() body: SetAutoMergeDto,
  ): Promise<{ ok: boolean; autoMerge: boolean }> {
    // Resolve scoped to the org first (defense in depth beyond the guard) — 404s a missing/foreign job.
    await this.requireThread(jobId, org.id);
    const enable = coerceBoolean(body.autoMerge) === true;
    const result = await this.jobs.update(
      { id: jobId, org_id: org.id },
      {
        auto_merge: enable,
        // Stamp who enabled it; never clear on disable — the audit trail of the last arm stands.
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

  /** `DELETE …/threads/:jobId` — tear down the sandbox + remove the thread and its messages. */
  @Delete('orgs/:orgId/repos/:repoId/jobs/:jobId')
  @UseGuards(OrgMembershipGuard)
  async deleteThread(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
    @Query('prAction') prAction?: string,
  ): Promise<{ ok: boolean }> {
    // Resolve scoped to the org first — a leaked thread id from another org must NOT be deletable.
    const job = await this.requireThread(jobId, org.id);
    if (prAction != null && prAction !== 'close' && prAction !== 'leave') {
      throw new BadRequestException("prAction must be 'close' or 'leave'");
    }
    if (prAction === 'close') {
      try {
        await this.threadLifecycle.closeJobPullRequest(job);
      } catch (err) {
        // Abort the delete (decision d3: never silently orphan). The job stays in its normal status.
        throw new BadGatewayException(
          err instanceof Error ? err.message : 'Could not close the pull request',
        );
      }
    }
    // Atomically flip the job to `deleting` and COMMIT it before responding, so the durable state is
    // visible to the next thread-list/realtime frame (the sidebar shows "Deleting…" instead of freezing).
    // The claim also serializes concurrent deletes — a second click matches 0 rows and is a no-op.
    const claimed = await this.threadLifecycle.claimDeleteJob(jobId, org.id);
    if (claimed) {
      // Background the slow physical teardown (container + worktree) so the request returns immediately.
      // The row is removed when teardown finishes; a boot/reap reconciler finishes any delete stranded by
      // a crash. Best-effort — never throw out of the fire-and-forget.
      void this.threadLifecycle
        .deleteJobDeep(jobId, org.id)
        .catch((err) =>
          this.logger.warn(
            `web delete: background teardown failed for job ${jobId}: ${err}`,
          ),
        );
    }
    this.logger.log(
      `web deleting thread ${jobId} (org ${org.id}); claimed=${claimed}`,
    );
    return { ok: true };
  }

  /** `POST …/jobs/:jobId/dependencies` — manually block this job on another job in the same repo. */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/dependencies')
  @UseGuards(OrgMembershipGuard)
  async addJobDependency(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Param('jobId') jobId: string,
    @Body() body: { dependsOnJobId?: string },
  ): Promise<{ ok: boolean; blocked: boolean; blockers: unknown[] }> {
    await this.requireThread(jobId, org.id);
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

  /** `DELETE …/jobs/:jobId/dependencies/:dependsOnJobId` — manually remove a block edge (and wake the job if it's now unblocked). */
  @Delete('orgs/:orgId/repos/:repoId/jobs/:jobId/dependencies/:dependsOnJobId')
  @UseGuards(OrgMembershipGuard)
  async removeJobDependency(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Param('jobId') jobId: string,
    @Param('dependsOnJobId') dependsOnJobId: string,
  ): Promise<{ ok: boolean; blockers: unknown[] }> {
    await this.requireThread(jobId, org.id);
    await this.jobDeps.removeDependency({ orgId: org.id, repoId, jobId, dependsOnJobId });
    const blockers = await this.jobDeps.blockersOf(jobId);
    this.logger.log(`web unblocked job ${jobId} from ${dependsOnJobId} (org ${org.id})`);
    return { ok: true, blockers };
  }

  /** `GET …/jobs/:jobId/created` — the jobs this one spawned (newest first), for the "Created jobs" list. */
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
        awaitingSecret: t.awaiting_secret_id != null,
        halted: t.halted || t.halt != null,
      }),
      createdAt: t.created_at,
    }));
  }

  /** `GET …/jobs/:jobId` — a minimal job-DETAIL DTO. The "Created by" click resolves against this;
   *  a 404 (hard-deleted target) tells the web to show the deleted-job toast instead of navigating. */
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
        ? { state: t.pr_state, number: t.pr_number, mergeable: t.pr_mergeable, url: t.pr_url }
        : null,
      needsYou: deriveNeedsYou({
        status: t.status,
        activity: t.activity,
        openQuestion: t.open_question_count > 0,
        awaitingSecret: t.awaiting_secret_id != null,
        halted: t.halted || t.halt != null,
      }),
      createdAt: t.created_at,
    };
  }

  // ── scoping helpers (cross-tenant isolation: resolve scoped-to-org or 404) ──────────────────────

  /** Resolve a thread scoped to the org, or 404 — the guard for every thread-keyed op. */
  private async requireThread(
    jobId: string,
    orgId: string,
  ): Promise<JobEntity> {
    const thread = await this.jobs.findOne({
      where: { id: jobId, org_id: orgId },
    });
    if (!thread) throw new NotFoundException('thread not found');
    return thread;
  }

  /** Resolve a repo (by uuid id) scoped to the org, or 404 — so creation never crosses tenants. */
  private async requireRepo(
    repoId: string,
    orgId: string,
  ): Promise<RepoEntity> {
    const repo = await this.repos.findOne({
      where: { id: repoId, org_id: orgId },
    });
    if (!repo) throw new NotFoundException('repo not found');
    return repo;
  }
}
