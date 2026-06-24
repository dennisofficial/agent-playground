import { EnvService } from '@core/config/env/env.service';
import {
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Post,
  Query,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Public } from '@workspace/auth/server';
import { Repository } from 'typeorm';
import {
  AgentChatSurface,
  type OutboundChatMessage,
  parseApprovalMeta,
} from '../agent-surface';
import { DecisionApprovalService } from '../brain';
import { SectionDriver } from '../driver';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  JobEntity,
  MessageEntity,
  RepoEntity,
  ThreadEntity,
  OrganizationEntity,
} from '../persistence/entities';
import type {
  ApproveRequest,
  JobView,
  SayApprovalCard,
  SayReply,
  SayRequest,
  SayResponse,
  SeedRequest,
  SeedResponse,
  ThreadLine,
} from './test-bridge.dto';

/** How long `/test/say` waits for Atlas to post something on the thread before returning. */
const SAY_WAIT_MS = 60_000;
/** Poll cadence for the wait loop (cheap in-memory outbox scan). */
const SAY_POLL_MS = 200;
/** The simulated operator id stamped on injected messages + approvals. */
const TESTER_ID = 'tester';

/**
 * THE HTTP TEST-BRIDGE — a dev/test-only edge that lets an external driver have a REAL conversation with
 * a running Atlas (no Slack): seed a routable team/project/channel, inject a human message and read back
 * Atlas's replies, rule on the plan approval, and inspect the job + thread transcript. Gated behind
 * `TEST_BRIDGE=on` — every handler 404s otherwise (the controller is always registered, the flag
 * is the kill-switch, so it's never live in prod).
 *
 * It drives Atlas through the SAME seam W9 scripts: the in-process `AgentChatSurface` (`sendFromHuman` →
 * Atlas's brain → driver → `post()` captured in the outbox) and `DecisionApprovalService.resolve` (the
 * approval gate). It owns NO orchestration logic — it's thin plumbing over the agent surface, the
 * approval service, and the `app` repos. Zero v1 imports.
 */
@Public() // dev/test-only edge, gated by TEST_BRIDGE; never behind the operator session
@Controller('test')
export class TestBridgeController {
  private readonly logger = new Logger(TestBridgeController.name);

  constructor(
    private readonly env: EnvService,
    private readonly surface: AgentChatSurface,
    private readonly approvals: DecisionApprovalService,
    private readonly driver: SectionDriver,
    @InjectRepository(OrganizationEntity, DB_CONNECTION)
    private readonly orgs: Repository<OrganizationEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(MessageEntity, DB_CONNECTION)
    private readonly messages: Repository<MessageEntity>,
  ) {}

  /** The kill-switch: 404 every handler unless the dev/test flag is explicitly on. */
  private assertEnabled(): void {
    if (this.env.get('TEST_BRIDGE') !== 'on') {
      throw new NotFoundException('Atlas test-bridge disabled (set TEST_BRIDGE=on).');
    }
  }

  /**
   * `POST /test/seed` — idempotently upsert a ready-to-use (`active`) org + connected repo so an injected
   * message routes to a real repo. Re-seeding the same (orgId, repoId) updates the rows in place. The
   * `channel` field of the request maps to the repo coordinate (`repoId`) in the channel-free model.
   */
  @Post('seed')
  async seed(@Body() body: SeedRequest): Promise<SeedResponse> {
    this.assertEnabled();
    const { orgId, repoId, repoUrl } = body;
    await this.orgs.upsert({ id: orgId, name: orgId, slug: orgId, status: 'active' }, ['id']);
    await this.repos.upsert(
      {
        org_id: orgId,
        repo_id: repoId,
        name: repoId,
        git_url: repoUrl,
        default_branch: body.baseBranch ?? 'main',
        token_name: null,
        access_ok: true,
        access_checked_at: new Date(),
      },
      ['org_id', 'repo_id'],
    );
    this.logger.log(`seed org=${orgId} repo=${repoId} url=${repoUrl}`);
    return { channelId: repoId, orgId, repoId };
  }

  /**
   * `POST /test/say` — inject a human message via `AgentChatSurface.sendFromHuman`, then poll the outbox
   * for ~60s and return as soon as Atlas posts something on the thread (and any approval card). The
   * returned `threadTs` is the thread root (a new top-level message's own ts, or the supplied one) — the
   * caller threads its follow-ups onto it.
   */
  @Post('say')
  async say(@Body() body: SayRequest): Promise<SayResponse> {
    this.assertEnabled();
    const { channel, text } = body; // `channel` is the repo coordinate (repo_id)

    // Resolve the repo's org (the surface addresses by repo + real thread id, no channel indirection).
    const repo = await this.repos.findOne({ where: { repo_id: channel } });
    if (!repo) {
      throw new NotFoundException(`No seeded repo ${channel} — POST /test/seed first.`);
    }

    // A reply continues the supplied thread; a new conversation creates a real thread up front so its id
    // is the durable handle (the chat bridge resolves inbound by this id).
    let threadId = body.threadTs;
    if (!threadId) {
      const thread = await this.threads.save(
        this.threads.create({
          org_id: repo.org_id,
          repo_id: repo.repo_id,
          origin: 'chat',
          surface_thread_ref: null,
          title: null,
        }),
      );
      threadId = thread.id;
    }

    // Snapshot the outbox cursor BEFORE sending so we only collect posts triggered by this message.
    const cursor = this.surface.outbox.length;
    this.surface.sendFromHuman(channel, text, {
      orgId: repo.org_id,
      authorId: TESTER_ID,
      authorName: 'Tester',
      threadTs: threadId,
    });

    const { replies, approvalCard } = await this.waitForReplies(cursor, threadId);
    return { threadTs: threadId, replies, ...(approvalCard ? { approvalCard } : {}) };
  }

  /**
   * `POST /test/approve` — resolve the pending plan approval for a job (default verdict 'approve'),
   * ruled by 'tester'. Returns whether a pending approval was actually resolved.
   */
  @Post('approve')
  async approve(@Body() body: ApproveRequest): Promise<{ ok: boolean }> {
    this.assertEnabled();
    const ok = this.approvals.resolve(body.jobId, body.verdict ?? 'approve', TESTER_ID);
    this.logger.log(`approve job=${body.jobId} verdict=${body.verdict ?? 'approve'} ok=${ok}`);
    return { ok };
  }

  /**
   * `POST /test/resume` — the PING that continues a job paused on a credential/401 error. Re-drives it
   * (`SectionDriver.resumePaused`), which resumes the SAME engine session of the unfinished phase
   * instead of restarting from scratch. A no-op if the job isn't paused.
   */
  @Post('resume')
  async resume(@Body() body: { jobId: string }): Promise<{ ok: boolean }> {
    this.assertEnabled();
    await this.driver.resumePaused(body.jobId);
    this.logger.log(`resume (ping) job=${body.jobId}`);
    return { ok: true };
  }

  /** `GET /test/job?jobId=...` — the `jobs` row (status/title/prUrl/kind) for the driver to poll. */
  @Get('job')
  async job(@Query('jobId') jobId: string): Promise<JobView> {
    this.assertEnabled();
    const row = await this.jobs.findOne({ where: { id: jobId } });
    if (!row) throw new NotFoundException(`No job ${jobId}`);
    return {
      id: row.id,
      status: row.status,
      title: row.title,
      prUrl: row.pr_url,
      kind: row.kind,
    };
  }

  /**
   * `GET /test/thread?threadTs=...` — the full durable transcript for a thread (ordered: author, isAtlas,
   * text). Resolves the `threads` row by its `surface_thread_ref` (the ts `/test/say` returns), then
   * reads its `messages` oldest-first.
   */
  @Get('thread')
  async thread(@Query('threadTs') threadTs: string): Promise<ThreadLine[]> {
    this.assertEnabled();
    // `threadTs` is the real thread id — read its durable message log directly.
    const rows = await this.messages.find({
      where: { thread_id: threadTs },
      order: { created_at: 'ASC' },
    });
    return rows.map((m) => ({
      author: m.author,
      isAtlas: m.author_bot_id != null,
      text: m.text,
    }));
  }

  /**
   * Poll the in-memory outbox from `cursor` for new posts on `threadTs`, up to `SAY_WAIT_MS`. Returns as
   * soon as Atlas has posted at least one message on the thread (so a single grill question returns
   * promptly), capturing any approval card seen in the same window. On timeout returns whatever (if
   * anything) accumulated.
   */
  private async waitForReplies(
    cursor: number,
    threadTs: string,
  ): Promise<{ replies: SayReply[]; approvalCard?: SayApprovalCard }> {
    const deadline = Date.now() + SAY_WAIT_MS;
    for (;;) {
      const fresh = this.surface.outbox.slice(cursor);
      const onThread = fresh.filter((m) => m.threadTs === threadTs);
      if (onThread.length > 0) {
        const replies = onThread.map((m) => ({ text: m.text, ts: m.ts }));
        const approvalCard = findApprovalCard(onThread);
        return { replies, ...(approvalCard ? { approvalCard } : {}) };
      }
      if (Date.now() >= deadline) return { replies: [] };
      await sleep(SAY_POLL_MS);
    }
  }
}

/** Parse the first approval card out of a batch of posts (its blocks carry the jobId). */
function findApprovalCard(posts: OutboundChatMessage[]): SayApprovalCard | undefined {
  for (const post of posts) {
    const meta = parseApprovalMeta(post.blocks);
    if (meta) {
      return {
        jobId: meta.jobId,
        ...(meta.decisionRecordId ? { decisionRecordId: meta.decisionRecordId } : {}),
        // The card's first text is "Plan proposal — <title>"; strip the prefix for a clean title.
        title: post.text.replace(/^Plan proposal\s*—\s*/, '').trim() || post.text,
      };
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
