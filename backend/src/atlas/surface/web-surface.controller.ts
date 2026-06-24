import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Observable, filter, map } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { Public } from '@workspace/auth/server';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
} from './approval-blocks';
import { AtlasWebSurface } from './atlas-web-surface';
import { parseWebApprovalMeta } from './web-approval-card';
import type { WebOutboundMessage } from './atlas-web-surface';
import { DriverStoreService } from '../driver/driver-store.service';
import { ThreadLifecycleService } from '../driver/thread-lifecycle.service';
import { CurrentOrg, type CurrentOrgCtx, OrgMembershipGuard } from '../org';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasMessage, AtlasThread } from '../persistence/entities';

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
interface ApproveDto {
  actionId: string;
  value: string;
  ruledBy: string;
  note?: string;
}

/**
 * WEB SURFACE — org/repo/thread-scoped HTTP + SSE for the web console. All `/web/orgs/:orgId/*` routes
 * are gated by the global `AtlasAuthGuard` (cookie) AND `OrgMembershipGuard` (membership). Threads are
 * real `atlas_threads` rows (no surface-ref indirection); message history is the durable `atlas_messages`
 * log (survives restart); the SSE stream carries live outbound posts for a repo.
 *
 * `GET /web/ping` stays public so the login screen can detect backend reachability.
 */
@Controller('web')
export class WebSurfaceController {
  private readonly logger = new Logger(WebSurfaceController.name);

  constructor(
    private readonly surface: AtlasWebSurface,
    private readonly driverStore: DriverStoreService,
    private readonly threadLifecycle: ThreadLifecycleService,
    @InjectRepository(AtlasThread, ATLAS_CONNECTION)
    private readonly threads: Repository<AtlasThread>,
    @InjectRepository(AtlasMessage, ATLAS_CONNECTION)
    private readonly messages: Repository<AtlasMessage>,
  ) {}

  /** `GET /web/ping` — public liveness probe. */
  @Public()
  @Get('ping')
  ping(): { ok: boolean; surface: string } {
    return { ok: true, surface: this.surface.name };
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
    const thread = await this.threads.save(
      this.threads.create({
        org_id: org.id,
        repo_id: repoId,
        origin: 'control',
        surface_thread_ref: null,
        title: body.title ?? null,
        base_branch: body.baseBranch ?? null,
      }),
    );
    // Inject the first message — the chat bridge resolves the thread by its real id and triages it.
    this.surface.receiveFromClient(repoId, text, {
      orgId: org.id,
      threadTs: thread.id,
      ...OPERATOR,
    });
    this.logger.log(`web created thread ${thread.id} on ${org.id}/${repoId}`);
    return { threadId: thread.id };
  }

  /** `GET …/threads/:threadId/messages` — the durable message log (oldest-first). */
  @Get('orgs/:orgId/repos/:repoId/threads/:threadId/messages')
  @UseGuards(OrgMembershipGuard)
  async messageHistory(@Param('threadId') threadId: string): Promise<unknown[]> {
    const rows = await this.messages.find({
      where: { thread_id: threadId },
      order: { created_at: 'ASC' },
    });
    return rows.map((m) => ({
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
  say(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('repoId') repoId: string,
    @Param('threadId') threadId: string,
    @Body() body: SayDto,
  ): { ts: string } {
    if (!body?.text) throw new BadRequestException('text is required');
    const ts = this.surface.receiveFromClient(repoId, body.text, {
      orgId: org.id,
      threadTs: threadId,
      ...OPERATOR,
    });
    return { ts };
  }

  /** `GET …/repos/:repoId/events` — SSE stream of outbound posts for the repo. */
  @Sse('orgs/:orgId/repos/:repoId/events')
  @UseGuards(OrgMembershipGuard)
  events(@Param('repoId') repoId: string): Observable<MessageEvent> {
    return this.surface.outbound$.pipe(
      filter((msg: WebOutboundMessage) => msg.channel === repoId),
      map((msg): MessageEvent => ({ data: msg })),
    );
  }

  /** `POST …/threads/:threadId/approve` — submit a plan verdict. */
  @Post('orgs/:orgId/repos/:repoId/threads/:threadId/approve')
  @UseGuards(OrgMembershipGuard)
  approve(@Body() body: ApproveDto): { ok: boolean; jobId?: string } {
    const { actionId, value, ruledBy, note } = body;
    if (!actionId || !value || !ruledBy) {
      throw new BadRequestException('actionId, value, and ruledBy are required');
    }
    if (!VALID_ACTION_IDS.has(actionId)) {
      throw new BadRequestException(`Unknown actionId: ${actionId}`);
    }
    const meta = parseWebApprovalMeta(value);
    if (!meta) throw new BadRequestException('value is not a valid ApprovalActionMeta JSON');
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
    return this.driverStore.getPipelineState(threadId, org.id);
  }

  /** `DELETE …/threads/:threadId` — tear down the sandbox + remove the thread and its messages. */
  @Delete('orgs/:orgId/repos/:repoId/threads/:threadId')
  @UseGuards(OrgMembershipGuard)
  async deleteThread(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('threadId') threadId: string,
  ): Promise<{ ok: boolean }> {
    await this.threadLifecycle.closeThread(threadId, org.id);
    await this.messages.delete({ thread_id: threadId });
    await this.threads.delete({ id: threadId });
    this.logger.log(`web deleted thread ${threadId} (org ${org.id})`);
    return { ok: true };
  }
}
