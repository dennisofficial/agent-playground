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
  Post,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Observable, defer, filter, from, map, merge } from 'rxjs';
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
import { parseWebApprovalMeta } from './web-approval-card';
import type { WebOutboundMessage } from './web-surface';
import { DriverStoreService } from '../driver/driver-store.service';
import { ThreadLifecycleService } from '../driver/thread-lifecycle.service';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrganizationService } from '../org/organization.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { MessageEntity, RepoEntity, ThreadEntity, UserEntity } from '../persistence/entities';

const VALID_ACTION_IDS = new Set([APPROVE_ACTION_ID, REQUEST_CHANGES_ACTION_ID, DENY_ACTION_ID]);
const OPERATOR = { authorId: 'U-OPERATOR', authorName: 'Operator' };

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
        createdAt: t.created_at,
        org: { id: t.org_id, slug: org?.slug, name: org?.name },
        repo: { id: t.repo_id, name: repoName.get(`${t.org_id}:${t.repo_id}`) ?? t.repo_id },
      };
    });
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
    const thread = await this.threads.save(
      this.threads.create({
        org_id: org.id,
        repo_id: repo.id,
        origin: 'control',
        surface_thread_ref: null,
        title: body.title ?? null,
        base_branch: body.baseBranch ?? null,
      }),
    );
    // Inject the first message — the chat bridge resolves the thread by its real id and triages it.
    this.surface.receiveFromClient(repo.id, text, {
      orgId: org.id,
      threadTs: thread.id,
      ...OPERATOR,
    });
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
    return merge(snapshot$, live$, messages$);
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
    // Full cascade in app code: tear down the sandbox AND sweep messages/sections/phases/
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
