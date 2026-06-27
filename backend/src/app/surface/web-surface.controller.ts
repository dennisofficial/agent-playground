import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  PayloadTooLargeException,
  Post,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { Observable, catchError, defer, filter, from, map, merge, switchMap } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { CurrentUser, Public } from '@workspace/auth/server';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
} from './approval-blocks';
import { WebSurface } from './web-surface';
import { LiveTurnStore } from './live-turn-store';
import { ThreadTitleService } from './thread-title.service';
import { parseWebApprovalMeta } from './web-approval-card';
import type { WebQuestionCard } from './web-question-card';
import type { WebOutboundMessage } from './web-surface';
import { DriverStoreService } from '../driver/driver-store.service';
import { ThreadLifecycleService } from '../driver/thread-lifecycle.service';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrganizationService } from '../org/organization.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { MessageEntity, RepoEntity, ThreadEntity, UserEntity } from '../persistence/entities';
import { deriveNeedsYou } from '../domain/thread';
import { RealtimeService, realtimeDisabledStream, subscriptionToObservable } from '../realtime';
import { TicketEventBus } from '../tickets';

const VALID_ACTION_IDS = new Set([APPROVE_ACTION_ID, REQUEST_CHANGES_ACTION_ID, DENY_ACTION_ID]);
const OPERATOR = { authorId: 'U-OPERATOR', authorName: 'Operator' };

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
    throw new BadRequestException('path must be inside specs/, generated/, or artifacts/');
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
}
interface SayDto {
  text: string;
}
interface RenameThreadDto {
  title: string;
}
interface ApproveDto {
  actionId: string;
  value: string;
  ruledBy: string;
  note?: string;
}
interface AnswerQuestionDto {
  /** The question card's id (its message `ts`). */
  questionId: string;
  /** The operator's answer — the picked option's label, or free text. */
  answer: string;
  answeredBy?: string;
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
    private readonly threadLifecycle: ThreadLifecycleService,
    private readonly orgService: OrganizationService,
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(MessageEntity, DB_CONNECTION)
    private readonly messages: Repository<MessageEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    private readonly threadTitle: ThreadTitleService,
    private readonly ticketEvents: TicketEventBus,
    private readonly realtime: RealtimeService,
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
  @Get('threads')
  async allThreads(@CurrentUser() user: UserEntity): Promise<unknown[]> {
    const orgs = await this.orgService.listForUser(user.id);
    if (orgs.length === 0) return [];
    const orgIds = orgs.map((o) => o.id);
    const [threads, repos] = await Promise.all([
      this.threads.find({ where: { org_id: In(orgIds) }, order: { created_at: 'DESC' } }),
      this.repos.find({ where: { org_id: In(orgIds) } }),
    ]);
    const orgById = new Map(orgs.map((o) => [o.id, o]));
    const repoName = new Map(repos.map((r) => [`${r.org_id}:${r.id}`, r.name]));
    return threads.map((t) => {
      const org = orgById.get(t.org_id);
      return {
        threadId: t.id,
        title: t.title,
        origin: t.origin,
        status: t.status,
        turnActive: t.turn_active,
        needsYou: deriveNeedsYou(t.status, t.turn_active),
        createdAt: t.created_at,
        org: { id: t.org_id, slug: org?.slug, name: org?.name },
        repo: { id: t.repo_id, name: repoName.get(`${t.org_id}:${t.repo_id}`) ?? t.repo_id },
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
  @Sse('threads/realtime')
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

  /** `GET …/repos/:repoId/threads` — the repo's threads (newest first). */
  @Get('orgs/:orgId/repos/:repoId/threads')
  @UseGuards(OrgMembershipGuard)
  async listThreads(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
  ): Promise<unknown[]> {
    const rows = await this.threads.find({
      where: { org_id: org.id, repo_id: repoId },
      order: { created_at: 'DESC' },
    });
    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      origin: t.origin,
      status: t.status,
      turnActive: t.turn_active,
      needsYou: deriveNeedsYou(t.status, t.turn_active),
      baseBranch: t.base_branch,
      createdAt: t.created_at,
    }));
  }

  /** `POST …/repos/:repoId/threads` — create a thread + inject its first message. Returns the real id. */
  @Post('orgs/:orgId/repos/:repoId/threads')
  @UseGuards(OrgMembershipGuard)
  async createThread(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Body() body: CreateThreadDto,
  ): Promise<{ threadId: string }> {
    const text = body?.firstMessage?.trim();
    if (!text) throw new BadRequestException('firstMessage is required');
    // Resolve the repo WITHIN the caller's org — the thread's org_id/repo_id derive from this resolved
    // row, never from raw input (so the denormalized tenant keys can't be pointed at another org's repo).
    const repo = await this.requireRepo(repoId, org.id);
    // The frontend-derived first line seeds the row as an INSTANT placeholder; the mini-model upgrades it
    // below (compare-and-set keyed off this exact placeholder, so a fast rename is never clobbered).
    const placeholder = body.title ?? null;
    const thread = await this.threads.save(
      this.threads.create({
        org_id: org.id,
        repo_id: repo.id,
        origin: 'control',
        surface_thread_ref: null,
        title: placeholder,
        base_branch: body.baseBranch ?? null,
      }),
    );
    // Inject the first message — the chat bridge resolves the thread by its real id and triages it.
    this.surface.receiveFromClient(repo.id, text, {
      orgId: org.id,
      threadTs: thread.id,
      ...OPERATOR,
    });
    // Fire-and-forget: generate a concise title from the first message and push it live (see service).
    void this.threadTitle
      .generateAndApply(thread.id, org.id, repo.id, text, placeholder)
      .catch((err) => this.logger.warn(`title gen dispatch failed for ${thread.id}: ${err}`));
    this.logger.log(`web created thread ${thread.id} on ${org.id}/${repo.id}`);
    return { threadId: thread.id };
  }

  /** `GET …/threads/:threadId/messages` — the durable message log (oldest-first). Org-scoped. */
  @Get('orgs/:orgId/repos/:repoId/threads/:threadId/messages')
  @UseGuards(OrgMembershipGuard)
  async messageHistory(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('threadId') threadId: string,
  ): Promise<unknown[]> {
    await this.requireThread(threadId, org.id);
    const rows = await this.messages.find({
      where: { thread_id: threadId },
      order: { created_at: 'ASC' },
    });
    return rows.map((m) => ({
      id: m.id,
      ts: m.ts,
      author: m.author,
      authorId: m.author_id,
      isAtlas: m.author_bot_id != null,
      text: m.text,
      kind: m.kind,
      ...(m.card ? { card: m.card } : {}),
      ...(m.meta ? { meta: m.meta } : {}),
      postedAt: m.created_at,
    }));
  }

  /** `POST …/threads/:threadId/say` — inject a human reply. Returns the synthetic ts. */
  @Post('orgs/:orgId/repos/:repoId/threads/:threadId/say')
  @UseGuards(OrgMembershipGuard)
  async say(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Param('threadId') threadId: string,
    @Body() body: SayDto,
  ): Promise<{ ts: string }> {
    if (!body?.text) throw new BadRequestException('text is required');
    const thread = await this.requireThread(threadId, org.id);
    const ts = this.surface.receiveFromClient(thread.repo_id, body.text, {
      orgId: org.id,
      threadTs: threadId,
      ...OPERATOR,
    });
    return { ts };
  }

  /**
   * `GET …/repos/:repoId/events` — SSE for the repo, carrying frame types discriminated by `type`:
   *  - `{ type: 'message', … }` — a durable post landed (chat / approval card / PR card / status). The
   *    client refetches the authoritative `/messages` + pipeline.
   *  - `{ type: 'stream', threadId, seq, event }` — the live in-sandbox session. `event` is either a
   *    `{ kind: 'snapshot', blocks, active }` (the RESUMABLE catch-up replayed the moment THIS client
   *    connects, for every in-flight turn in the repo), a token/thinking/tool delta, or `{kind:'turn_end'}`.
   *    The client filters by `threadId`, applies the snapshot, then deltas (deduped by `seq`), and
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
    const snapshot$ = defer(() => from(this.liveTurns.snapshotsForRepo(repoId))).pipe(
      map(
        (s): MessageEvent => ({
          data: {
            type: 'stream',
            threadId: s.threadId,
            seq: s.seq,
            event: { kind: 'snapshot', blocks: s.blocks, active: s.active },
          },
        }),
      ),
    );
    const live$ = this.liveTurns.stream$.pipe(
      filter((f) => f.channel === repoId),
      map(
        (f): MessageEvent => ({
          data: { type: 'stream', threadId: f.threadId, seq: f.seq, event: f.event },
        }),
      ),
    );
    // Thread metadata (e.g. an auto-generated title) → a targeted live update the client applies in place.
    const meta$ = this.surface.threadMeta$.pipe(
      filter((m) => m.channel === repoId),
      map(
        (m): MessageEvent => ({
          data: { type: 'thread_meta', threadId: m.threadId, title: m.title },
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

  /** `POST …/threads/:threadId/approve` — submit a plan verdict. */
  @Post('orgs/:orgId/repos/:repoId/threads/:threadId/approve')
  @UseGuards(OrgMembershipGuard)
  async approve(
    @CurrentOrg() org: CurrentOrgCtx,
    @Body() body: ApproveDto,
  ): Promise<{ ok: boolean; jobId?: string }> {
    const { actionId, value, ruledBy, note } = body;
    if (!actionId || !value || !ruledBy) {
      throw new BadRequestException('actionId, value, and ruledBy are required');
    }
    if (!VALID_ACTION_IDS.has(actionId)) {
      throw new BadRequestException(`Unknown actionId: ${actionId}`);
    }
    const meta = parseWebApprovalMeta(value);
    if (!meta) throw new BadRequestException('value is not a valid ApprovalActionMeta JSON');
    // The verdict's target thread (meta.jobId is the thread id) must belong to the caller's org.
    await this.requireThread(meta.jobId, org.id);
    this.surface.receiveApprovalClick(actionId, value, ruledBy, note);
    return { ok: true, jobId: meta.jobId };
  }

  /**
   * `POST …/threads/:threadId/answer-question` — answer a brain `ask_question` card. GATED on the thread's
   * durable human-input gate: only the question the thread is currently awaiting can be answered (a stale
   * or already-delivered card no-ops, so it never mints a second delivery turn). On the first valid answer
   * it stamps the durable answered state onto the card row (renders answered on reload) and injects the
   * answer as a normal operator reply, which fires the next brain turn — its success tail stamps the card
   * delivered + clears the gate, and `log_decision` auto-attaches the Q&A.
   */
  @Post('orgs/:orgId/repos/:repoId/threads/:threadId/answer-question')
  @UseGuards(OrgMembershipGuard)
  async answerQuestion(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('threadId') threadId: string,
    @Body() body: AnswerQuestionDto,
  ): Promise<{ ok: boolean; ts: string }> {
    const answer = body?.answer?.trim();
    if (!body?.questionId || !answer) {
      throw new BadRequestException('questionId and answer are required');
    }
    const thread = await this.requireThread(threadId, org.id);
    const card = await this.messages.findOne({
      where: { thread_id: threadId, ts: body.questionId, kind: 'card' },
    });
    const payload = card?.card as WebQuestionCard | undefined;
    if (!card || payload?.type !== 'question_card') {
      throw new BadRequestException('no such question on this thread');
    }
    // Gate against stale / already-delivered cards: only the thread's currently-open gate question is
    // answerable. A mismatch or an already-delivered card is a no-op (idempotent — e.g. a double click).
    if (thread.awaiting_question_id !== body.questionId || payload.deliveredAt) {
      return { ok: false, ts: '' };
    }
    // Already answered (a delivery turn is in flight / queued): keep the recorded answer, don't fire a
    // second turn.
    if (payload.answer != null) {
      return { ok: true, ts: '' };
    }
    // First valid answer: stamp the durable answered state, then inject it as an operator reply → fires
    // the delivery turn (which stamps `deliveredAt` + clears the gate on success).
    card.card = { ...(card.card ?? {}), answer, answeredAt: new Date().toISOString() };
    await this.messages.save(card);
    const ts = this.surface.receiveFromClient(thread.repo_id, answer, {
      orgId: org.id,
      threadTs: threadId,
      ...OPERATOR,
    });
    return { ok: true, ts };
  }

  /** `GET …/threads/:threadId/pipeline` — current pipeline state (or `{ status: 'no_job' }`). */
  @Get('orgs/:orgId/repos/:repoId/threads/:threadId/pipeline')
  @UseGuards(OrgMembershipGuard)
  async pipeline(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('threadId') threadId: string,
  ): Promise<unknown> {
    await this.requireThread(threadId, org.id);
    return this.driverStore.getPipelineState(threadId, org.id);
  }

  /**
   * `GET …/threads/:threadId/context` — list the thread's `/context` files, grouped into `specs` (the
   * plan: plan.md, decision-record.md, diagrams) and `artifacts` (outputs: preview HTML, screenshots).
   * V1 MVP: just names + size + mtime. The UI's Artifacts panel composes this with the diff/PR (which
   * are not files — they come from `pipeline`/the thread row).
   */
  @Get('orgs/:orgId/repos/:repoId/threads/:threadId/context')
  @UseGuards(OrgMembershipGuard)
  async context(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('threadId') threadId: string,
  ): Promise<{ specs: ContextFile[]; generated: ContextFile[]; artifacts: ContextFile[] }> {
    await this.requireThread(threadId, org.id);
    const root = this.threadLifecycle.contextDirHost(threadId, org.id);
    return {
      specs: listContextBucket(join(root, 'specs')),
      generated: listContextBucket(join(root, 'generated')),
      artifacts: listContextBucket(join(root, 'artifacts')),
    };
  }

  /**
   * `GET …/threads/:threadId/context/file?path=specs/plan.md` — read ONE `/context` file for the viewer.
   * Text files (.md, .json, …) come back utf-8; images come back base64. Capped at 2 MB; the path is
   * guarded to the thread's own specs/ + artifacts/ buckets (no traversal, no cross-thread reads).
   */
  @Get('orgs/:orgId/repos/:repoId/threads/:threadId/context/file')
  @UseGuards(OrgMembershipGuard)
  async contextFile(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('threadId') threadId: string,
    @Query('path') relPath: string,
  ): Promise<ContextFileContent> {
    await this.requireThread(threadId, org.id);
    if (!relPath) throw new BadRequestException('path is required');
    const root = this.threadLifecycle.contextDirHost(threadId, org.id);
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
    const { mime, binary } = MIME_BY_EXT[ext] ?? { mime: 'text/plain', binary: false };
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

  /** `PATCH …/threads/:threadId` — rename a thread (the only thread Update op). Org-scoped. */
  @Patch('orgs/:orgId/repos/:repoId/threads/:threadId')
  @UseGuards(OrgMembershipGuard)
  async renameThread(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('threadId') threadId: string,
    @Body() body: RenameThreadDto,
  ): Promise<{ ok: boolean; title: string }> {
    const title = body?.title?.trim().slice(0, 200);
    if (!title) throw new BadRequestException('title is required');
    // Scope the update to the caller's org (defense in depth beyond the membership guard).
    const result = await this.threads.update({ id: threadId, org_id: org.id }, { title });
    if (!result.affected) throw new NotFoundException('thread not found');
    this.logger.log(`web renamed thread ${threadId} (org ${org.id})`);
    return { ok: true, title };
  }

  /** `DELETE …/threads/:threadId` — tear down the sandbox + remove the thread and its messages. */
  @Delete('orgs/:orgId/repos/:repoId/threads/:threadId')
  @UseGuards(OrgMembershipGuard)
  async deleteThread(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('threadId') threadId: string,
  ): Promise<{ ok: boolean }> {
    // Resolve scoped to the org first — a leaked thread id from another org must NOT be deletable.
    await this.requireThread(threadId, org.id);
    // Full cascade in app code: tear down the sandbox AND sweep messages/tracks/steps/
    // decision_records/stimuli/sandbox before the thread row (the live schema has no FK cascades).
    await this.threadLifecycle.deleteThreadDeep(threadId, org.id);
    this.logger.log(`web deleted thread ${threadId} (org ${org.id})`);
    return { ok: true };
  }

  // ── scoping helpers (cross-tenant isolation: resolve scoped-to-org or 404) ──────────────────────

  /** Resolve a thread scoped to the org, or 404 — the guard for every thread-keyed op. */
  private async requireThread(threadId: string, orgId: string): Promise<ThreadEntity> {
    const thread = await this.threads.findOne({ where: { id: threadId, org_id: orgId } });
    if (!thread) throw new NotFoundException('thread not found');
    return thread;
  }

  /** Resolve a repo (by uuid id) scoped to the org, or 404 — so creation never crosses tenants. */
  private async requireRepo(repoId: string, orgId: string): Promise<RepoEntity> {
    const repo = await this.repos.findOne({ where: { id: repoId, org_id: orgId } });
    if (!repo) throw new NotFoundException('repo not found');
    return repo;
  }
}
