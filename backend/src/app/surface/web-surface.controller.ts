import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Logger,
  NotFoundException,
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
import { FilesInterceptor } from '@nestjs/platform-express';
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
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
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
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
import { WebSurface } from './web-surface';
import { LiveTurnStore } from './live-turn-store';
import { JobTitleService } from './job-title.service';
import { parseWebApprovalMeta } from './web-approval-card';
import type { WebQuestionCard } from './web-question-card';
import type { WebSecretInputCard } from './web-secret-input-card';
import type { WebFileRequestCard } from './web-file-request-card';
import type { McpProposalServer } from './web-mcp-proposal-card';
import type { WebOutboundMessage } from './web-surface';
import { DriverStoreService } from '../driver/driver-store.service';
import { JobLifecycleService } from '../driver/job-lifecycle.service';
import { CONTAINER_CONTEXT, type ServiceLivenessProbe } from '../sandbox';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { OrganizationService } from '../org/organization.service';
import { WorktreeSecretFileStore } from '../onboarding';
import { McpServerStore } from '../mcp/mcp-server.store';
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
import {
  RealtimeService,
  realtimeDisabledStream,
  subscriptionToObservable,
} from '../realtime';
import { TicketEventBus } from '../tickets';

const VALID_ACTION_IDS = new Set([
  APPROVE_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
  DENY_ACTION_ID,
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

/** One file in a `/context` bucket (specs or artifacts). */
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
/** Slack for the generation gate: `atlas-svc` markers are second-precision (`date +%FT%TZ`) while Docker
 *  `StartedAt` is sub-second, so a service started in the SAME second as container boot can truncate just
 *  below it. Only treat a marker as previous-generation when it predates boot by more than this — genuine
 *  stale markers predate boot by minutes/hours, so the tolerance never lets a reused old pgid through. */
const GENERATION_SKEW_MS = 2_000;

/**
 * Map one supervised process's durable marker + the container-wide liveness probe to its live `status`.
 * The container-GENERATION gate is load-bearing: a marker whose `startedAt` predates the current
 * container boot is from a previous PID namespace and is dead even if its old pgid was reused and now
 * answers `kill -0` — so we must reject it BEFORE consulting `alive`.
 */
export function serviceStatus(
  marker: Pick<ServiceInfo, 'pgid' | 'startedAt'>,
  probe: ServiceLivenessProbe,
): ServiceInfo['status'] {
  if (probe.status === 'unknown') return 'unknown';
  if (probe.status === 'down') return 'stopped'; // no running container ⇒ every marker is dead
  // probe.status === 'up' — verify the marker belongs to THIS container generation before trusting alive.
  if (marker.pgid == null || marker.startedAt == null) return 'unknown';
  const started = Date.parse(marker.startedAt);
  const generation = Date.parse(probe.containerStartedAt);
  if (!Number.isFinite(started) || !Number.isFinite(generation))
    return 'unknown';
  if (started < generation - GENERATION_SKEW_MS) return 'stopped'; // previous container — reused pgid must not read as running
  return probe.alive.includes(marker.pgid) ? 'running' : 'stopped';
}
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
 * exposed buckets (specs/ + generated/ + artifacts/). Rejects absolute paths and any `..` traversal that
 * escapes the root — the only files readable are the ones the listing endpoint already exposes.
 */
function resolveContextFilePath(root: string, relPath: string): string {
  const cleaned = relPath.replace(/^[/\\]+/, '');
  const abs = resolve(root, cleaned);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (!abs.startsWith(rootWithSep)) {
    throw new BadRequestException('path escapes the context directory');
  }
  const bucket = relative(root, abs).split(sep)[0];
  if (bucket !== 'specs' && bucket !== 'generated' && bucket !== 'artifacts') {
    throw new BadRequestException(
      'path must be inside specs/, generated/, or artifacts/',
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

/** The `<review>` block prepended to the first-turn body for a `kind: 'review'` job (brain orientation). */
function renderReviewSeedXml(prNumber: number, repoSlug: string): string {
  return (
    `<review pr="${prNumber}" repo="${xmlEscapeAttr(repoSlug)}" ` +
    `note="Review this EXISTING pull request. Fetch it with \`gh pr view ${prNumber}\` / \`gh pr diff ${prNumber}\`, ` +
    `review the diff, and post findings grouped by severity. Do not build or open a PR of your own." />`
  );
}
interface SayDto {
  text: string;
}
/** One highlighted-and-annotated selection in a review-comments batch. */
interface ReviewCommentItemDto {
  /** A label for the file/doc the selection was made in (e.g. "plan.md"). */
  file: string;
  /** The selected/quoted text. */
  quote: string;
  note?: string;
}
interface ReviewCommentsDto {
  items: ReviewCommentItemDto[];
  /** Optional operator prose accompanying the batch — rendered underneath the card. */
  message?: string;
}
interface RenameThreadDto {
  title: string;
}
interface ApproveDto {
  actionId: string;
  value: string;
  note?: string;
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

/** One persisted composer attachment (rides `messages.card`; the web renders a chip/thumbnail from it). */
interface AttachmentCardItem {
  /** The operator's (sanitized) filename, for display. */
  name: string;
  /** Bucket-relative path under `/context` (`uploads/<safeName>`) — the raw-file endpoint re-roots it. */
  path: string;
  kind: 'image' | 'file';
  size: number;
}
/** The multipart file shape multer hands us (subset we use — avoids depending on global Express.Multer types). */
interface UploadedAttachment {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/** Escape a string for safe inclusion in an XML attribute value (filenames are operator-controlled). */
function xmlEscapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

/** The `<uploaded-files>` block prepended to an operator message that carried attachments (brain body). */
function renderUploadedFilesXml(items: AttachmentCardItem[]): string {
  const rows = items
    .map(
      (it) =>
        `  <file name="${xmlEscapeAttr(it.name)}" kind="${it.kind}" path="${CONTAINER_CONTEXT}/${it.path}" size="${it.size}" />`,
    )
    .join('\n');
  return `<uploaded-files note="The operator attached the file(s) below. Read any you need with your Read tool — images render visually.">\n${rows}\n</uploaded-files>`;
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
export function formatReviewComments(
  items: ReviewCommentItemDto[],
  message?: string,
): string {
  const byFile = new Map<string, ReviewCommentItemDto[]>();
  for (const item of items) {
    const group = byFile.get(item.file) ?? [];
    group.push(item);
    byFile.set(item.file, group);
  }
  const lines: string[] = [
    `The operator left ${items.length} review comment${items.length === 1 ? '' : 's'} on the plan:`,
  ];
  for (const [file, group] of byFile) {
    lines.push('', `**${file}**`);
    for (const item of group) {
      lines.push(`> "${item.quote}"`);
      if (item.note?.trim()) lines.push(`— ${item.note.trim()}`);
    }
  }
  if (message?.trim()) {
    lines.push('', message.trim());
  }
  return lines.join('\n');
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
    private readonly orgService: OrganizationService,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(MessageEntity, DB_CONNECTION)
    private readonly messages: Repository<MessageEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    private readonly threadTitle: JobTitleService,
    private readonly ticketEvents: TicketEventBus,
    private readonly realtime: RealtimeService,
    private readonly election: LeaderElectionService,
    @Inject(JOB_DISPATCHER) private readonly dispatcher: JobDispatcher,
    // Repo onboarding: the ONLY place a `request_secret` plaintext value lands — straight to the
    // encrypted store + a grant, never the transcript (owner-gated; see `provideSecret`).
    private readonly secrets: WorktreeSecretFileStore,
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
        turnActive: t.turn_active,
        needsYou: deriveNeedsYou(
          t.status,
          t.turn_active,
          t.open_question_count > 0,
        ),
        createdAt: t.created_at,
        // The observed PR (null until one exists) — drives the sidebar's PR-status glyph. `mergeable`
        // ('dirty' = conflict) refines the open state; `state` gives merged/closed.
        pr: t.pr_state
          ? { state: t.pr_state, mergeable: t.pr_mergeable, url: t.pr_url }
          : null,
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
    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      origin: t.origin,
      status: t.status,
      turnActive: t.turn_active,
      needsYou: deriveNeedsYou(
        t.status,
        t.turn_active,
        t.open_question_count > 0,
      ),
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
    const thread = await this.jobs.save(
      this.jobs.create({
        org_id: org.id,
        repo_id: repo.id,
        origin: 'control',
        surface_thread_ref: null,
        title: placeholder,
        base_branch: body.baseBranch ?? null,
        ...(kind ? { kind } : {}),
      }),
    );
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
    const attach = files?.length
      ? await this.ingestAttachments(org.id, jobId, files)
      : null;
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
  events(@Param('repoId') repoId: string): Observable<MessageEvent> {
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
    // Board mutations for this repo → a live `ticket_event`; the client invalidates its ticket queries.
    // Carries no payload beyond the ids (the client refetches the authoritative ticket), matching the
    // `message`-frame refetch model — and reaches the board even when the brain mutates tickets.
    const tickets$ = this.ticketEvents.stream$.pipe(
      filter((e) => e.repoId === repoId),
      map(
        (e): MessageEvent => ({
          data: { type: 'ticket_event', ticketId: e.ticketId, kind: e.kind },
        }),
      ),
    );
    return merge(snapshot$, live$, messages$, meta$, tickets$);
  }

  /** `POST …/threads/:jobId/approve` — submit a plan verdict. */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/approve')
  @UseGuards(OrgMembershipGuard)
  async approve(
    @CurrentOrg() org: CurrentOrgCtx,
    @CurrentUser() user: UserEntity,
    @Body() body: ApproveDto,
  ): Promise<{ ok: boolean; jobId?: string }> {
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
    // The verdict's target thread (meta.jobId is the thread id) must belong to the caller's org.
    await this.requireThread(meta.jobId, org.id);
    // Stamp the AUTHENTICATED operator (a real user uuid, FK-valid for `decision_records.approved_by`) as
    // the approver — never the client-sent `ruledBy` (untrusted, and a label like "U-OPERATOR" is not a
    // uuid, which previously made `store.approve` throw and the verdict silently no-op).
    this.surface.receiveApprovalClick(actionId, value, user.id, note);
    return { ok: true, jobId: meta.jobId };
  }

  /**
   * `POST …/threads/:jobId/retry` — the halted-build "Retry" button. Re-drives a `failed`/`paused`
   * build through the deterministic, resumable driver (`JOB_DISPATCHER.retry` → flips back to `running`,
   * fast-forwards finished work, continues at the first unfinished step). No-op if the thread isn't in a
   * retryable state. Scoped to the caller's org via the membership guard + `requireThread`.
   */
  @Post('orgs/:orgId/repos/:repoId/jobs/:jobId/retry')
  @UseGuards(OrgMembershipGuard)
  async retry(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<{ ok: boolean; status: string }> {
    const thread = await this.requireThread(jobId, org.id);
    if (thread.status !== 'failed' && thread.status !== 'paused') {
      // Idempotent / not-applicable: nothing to retry (already running, done, or pre-build).
      return { ok: false, status: thread.status };
    }
    await this.dispatcher.retry(jobId);
    return { ok: true, status: 'running' };
  }

  /**
   * `POST …/threads/:jobId/retry-turn` — the "Resume" button on a `retryable` system→operator error box
   * (a brain chat-turn that hit a transient engine failure, e.g. a 529). Distinct from `/retry` (which only
   * re-drives a `failed`/`paused` BUILD track) — a chat-turn failure never touches job status, so that
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
    const resumeNudge = thread.title
      ? `Please continue with the current task: "${thread.title}".`
      : 'Please continue.';
    this.surface.seedSystemNotification(thread.repo_id, jobId, resumeNudge, {
      orgId: org.id,
      seedRow: {
        label: 'Resuming the turn after a transient engine error.',
        chunkKey: `seed:retry:${jobId}:${Date.now()}`,
      },
    });
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
    const notice = `The operator answered your question ${JSON.stringify(question)}: ${answer}`;
    const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
      orgId: org.id,
      deliveredQuestionId: body.questionId,
      seedRow: { label: notice, chunkKey: `seed:qa:${jobId}:${body.questionId}` },
    });
    return { ok: true, ts };
  }

  /**
   * `POST …/threads/:jobId/provide-secret` — provide the value for a brain `request_secret` card during
   * repo onboarding. THE ONLY PLACE A SECRET VALUE LIVES: it goes straight to the encrypted
   * `WorktreeSecretFileStore` as this repo's secret file at (repo, path), and is NEVER written to the
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
        const notice = `The one-time value \`${payload.name}\` could not be delivered (${delivered.reason ?? 'the target process is not reading'}). Restart the interactive login and request the code again.`;
        const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
          orgId: org.id,
          seedRow: { label: notice, chunkKey: `seed:secret:${jobId}:${payload.name}:fail` },
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
      const notice = `The operator provided the one-time value \`${payload.name}\` (delivered to the running process, not stored). Verify the login completed and continue.`;
      const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
        orgId: org.id,
        seedRow: { label: notice, chunkKey: `seed:secret:${jobId}:${payload.name}` },
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
        const notice = `Could not store the secret \`${key}\` — MCP server \`${server}\` is no longer registered on this repo. Re-propose it if still needed.`;
        const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
          orgId: org.id,
          seedRow: { label: notice, chunkKey: `seed:secret:${jobId}:mcp:${server}:${key}:fail` },
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
      const notice = `The operator provided the secret \`${key}\` for MCP server \`${server}\` (${slot}, stored encrypted). The server is registered but its \`mcp__${server}__*\` tools are NOT loaded into this session yet — once all its secret slots are filled, call reset_sandbox to load it, then invoke one of its tools to verify (see MCP SERVERS).`;
      const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
        orgId: org.id,
        seedRow: { label: notice, chunkKey: `seed:secret:${jobId}:mcp:${server}:${key}` },
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
    const notice = `The operator provided the secret \`${payload.name}\` (stored encrypted, granted to \`${payload.path}\`). Continue onboarding.`;
    const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
      orgId: org.id,
      seedRow: { label: notice, chunkKey: `seed:secret:${jobId}:${payload.name}` },
    });
    return { ok: true, ts };
  }

  /**
   * `POST …/jobs/:jobId/mcp-proposals/:requestId/approve` — the OWNER approves a brain `propose_mcp_servers`
   * card, committing each proposed server to `McpServerStore` on THIS thread's repo scope. This is the ONLY
   * place a brain-originated MCP write lands: MCP mutations are an owner-only Administer action (same guard
   * as the console `McpServersController`), and the scope is FORCED to `thread.repo_id` — never trusted from
   * the card. Secret header/env slots commit as empty placeholders; the owner fills them afterwards via
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
    const RESERVED = new Set([
      'atlas-host-bridge',
      'atlasbridge',
      'atlas-lsp-ts',
      'context7',
      'graphify',
      'cocoindex',
    ]);
    const committed: string[] = [];
    const needSecrets: string[] = [];
    for (const s of card.servers) {
      if (!s.name || RESERVED.has(s.name.toLowerCase())) continue;
      // Scope FORCED to the thread's repo — the card carries no scope; a brain-authored write is repo-only.
      await this.mcpStore.write(org.id, thread.repo_id, s.name, this.mcpProposalToInput(s));
      committed.push(s.name);
      const secretSlots = [
        ...(s.headers ?? []).filter((h) => h.secret).map((h) => `${s.name} header:${h.name}`),
        ...(s.env ?? []).filter((e) => e.secret).map((e) => `${s.name} env:${e.name}`),
      ];
      needSecrets.push(...secretSlots);
      // A remote server that needs no secret can be validated now so its tool list is populated.
      if (s.transport !== 'stdio' && secretSlots.length === 0) {
        const row = await this.mcpStore.rawRow(org.id, thread.repo_id, s.name).catch(() => null);
        if (row) {
          const result = await this.mcpProbe.validate(row);
          await this.mcpStore
            .recordValidation(org.id, thread.repo_id, s.name, result)
            .catch(() => undefined);
        }
      }
    }
    await this.store.markMcpProposalApproved(jobId, requestId, committed);
    const notice = committed.length
      ? `The operator approved the MCP proposal — registered ${committed
          .map((n) => `\`${n}\``)
          .join(', ')} on this repo.` +
        (needSecrets.length
          ? ` Fill each secret slot now via request_secret (mcp target): ${needSecrets.join('; ')}. After every slot is filled, reset_sandbox to load the server(s), then invoke a tool to verify (see MCP SERVERS).`
          : ' No secrets needed — now reset_sandbox to load the server(s) into a fresh session, then invoke one of their tools to verify it works (see MCP SERVERS).')
      : 'The operator approved the MCP proposal, but no servers were committed.';
    const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
      orgId: org.id,
      seedRow: { label: notice, chunkKey: `seed:mcp-approve:${jobId}:${requestId}` },
    });
    return { ok: true, committed, ts };
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
    const notice = `The operator uploaded the file for \`${payload.path}\` (stored encrypted, granted). Continue onboarding.`;
    const ts = this.surface.seedSystemNotification(thread.repo_id, jobId, notice, {
      orgId: org.id,
      deliveredFileId: body.requestId,
      seedRow: { label: notice, chunkKey: `seed:file:${jobId}:${payload.path}` },
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
   * plan: plan.md, decision-record.md, diagrams) and `artifacts` (outputs: preview HTML, screenshots).
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
  }> {
    await this.requireThread(jobId, org.id);
    const root = this.threadLifecycle.contextDirHost(jobId, org.id);
    return {
      specs: listContextBucket(join(root, 'specs')),
      generated: listContextBucket(join(root, 'generated')),
      artifacts: listContextBucket(join(root, 'artifacts')),
    };
  }

  /**
   * `GET …/threads/:jobId/context/file?path=specs/plan.md` — read ONE `/context` file for the viewer.
   * Text files (.md, .json, …) come back utf-8; images come back base64. Capped at 2 MB; the path is
   * guarded to the thread's own specs/ + artifacts/ buckets (no traversal, no cross-thread reads).
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
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return { services: [] };
    }
    const services: ServiceInfo[] = [];
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -'.json'.length);
      if (!SERVICE_ID_RE.test(id)) continue; // defensive — atlas-svc only ever writes validated names
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<
          string,
          unknown
        >;
      } catch {
        continue; // a marker mid-write / corrupt — skip rather than fail the whole list
      }
      let logBytes = 0;
      let logUpdatedAt: string | null = null;
      try {
        const st = statSync(join(dir, `${id}.log`));
        logBytes = st.size;
        logUpdatedAt = st.mtime.toISOString();
      } catch {
        /* no log yet */
      }
      services.push({
        id,
        name: typeof parsed.name === 'string' ? parsed.name : id,
        cmd: typeof parsed.cmd === 'string' ? parsed.cmd : '',
        pid: typeof parsed.pid === 'number' ? parsed.pid : null,
        pgid: typeof parsed.pgid === 'number' ? parsed.pgid : null,
        startedAt:
          typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
        logBytes,
        logUpdatedAt,
        status: 'unknown', // overwritten by the liveness probe below
      });
    }
    services.sort((a, b) => a.id.localeCompare(b.id));

    // Join the durable markers with a LIVE liveness probe (exec `kill -0` into the container), gated on
    // the container generation so a recreated container reusing a pgid can't fake `running`. Memoized so
    // overlapping polls / multiple open clients collapse into one docker exec.
    const pgids = services
      .map((s) => s.pgid)
      .filter((p): p is number => p != null);
    const probe = await this.probeLivenessMemoized(jobId, pgids);
    for (const s of services) s.status = serviceStatus(s, probe);

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

  /** `DELETE …/threads/:jobId` — tear down the sandbox + remove the thread and its messages. */
  @Delete('orgs/:orgId/repos/:repoId/jobs/:jobId')
  @UseGuards(OrgMembershipGuard)
  async deleteThread(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('jobId') jobId: string,
  ): Promise<{ ok: boolean }> {
    // Resolve scoped to the org first — a leaked thread id from another org must NOT be deletable.
    await this.requireThread(jobId, org.id);
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
