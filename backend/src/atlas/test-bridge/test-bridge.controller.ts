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
import { Repository } from 'typeorm';
import {
  AgentChatSurface,
  type OutboundChatMessage,
  parseApprovalMeta,
} from '../agent-surface';
import { DecisionApprovalService } from '../brain';
import { SectionDriver } from '../driver';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import {
  AtlasChannel,
  AtlasJob,
  AtlasMessage,
  AtlasProject,
  AtlasTeam,
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
 * `ATLAS_TEST_BRIDGE=on` — every handler 404s otherwise (the controller is always registered, the flag
 * is the kill-switch, so it's never live in prod).
 *
 * It drives Atlas through the SAME seam W9 scripts: the in-process `AgentChatSurface` (`sendFromHuman` →
 * Atlas's brain → driver → `post()` captured in the outbox) and `DecisionApprovalService.resolve` (the
 * approval gate). It owns NO orchestration logic — it's thin plumbing over the agent surface, the
 * approval service, and the `atlas_*` repos. Zero v1 imports.
 */
@Controller('test')
export class TestBridgeController {
  private readonly logger = new Logger(TestBridgeController.name);

  constructor(
    private readonly env: EnvService,
    private readonly surface: AgentChatSurface,
    private readonly approvals: DecisionApprovalService,
    private readonly driver: SectionDriver,
    @InjectRepository(AtlasTeam, ATLAS_CONNECTION)
    private readonly teams: Repository<AtlasTeam>,
    @InjectRepository(AtlasProject, ATLAS_CONNECTION)
    private readonly projects: Repository<AtlasProject>,
    @InjectRepository(AtlasChannel, ATLAS_CONNECTION)
    private readonly channels: Repository<AtlasChannel>,
    @InjectRepository(AtlasJob, ATLAS_CONNECTION)
    private readonly jobs: Repository<AtlasJob>,
    @InjectRepository(AtlasMessage, ATLAS_CONNECTION)
    private readonly messages: Repository<AtlasMessage>,
  ) {}

  /** The kill-switch: 404 every handler unless the dev/test flag is explicitly on. */
  private assertEnabled(): void {
    if (this.env.get('ATLAS_TEST_BRIDGE') !== 'on') {
      throw new NotFoundException('Atlas test-bridge disabled (set ATLAS_TEST_BRIDGE=on).');
    }
  }

  /**
   * `POST /test/seed` — idempotently upsert an `atlas_teams` + `atlas_projects` (git_url=repoUrl, base) +
   * `atlas_channels` (1:1, `surface_channel_ref`=channel) so an injected message routes to a real repo.
   * Re-seeding the same (teamId, projectId) updates the repo/branch/channel in place. Returns the
   * channel id.
   */
  @Post('seed')
  async seed(@Body() body: SeedRequest): Promise<SeedResponse> {
    this.assertEnabled();
    const { teamId, projectId, repoUrl, channel } = body;
    const baseBranch = body.baseBranch ?? 'main';

    // Team (PK team_id) — upsert.
    await this.teams.upsert(
      { team_id: teamId, team_name: teamId, status: 'active' },
      ['team_id'],
    );

    // Project (PK team_id+project_id) — upsert the repo + base.
    await this.projects.upsert(
      {
        team_id: teamId,
        project_id: projectId,
        display_name: projectId,
        description: null,
        git_url: repoUrl,
        default_branch: baseBranch,
        token_name: null,
      },
      ['team_id', 'project_id'],
    );

    // Channel (1:1 with the project via the unique (team_id, project_id)) — find-or-create, then point
    // its surface ref at the requested channel. Generated-uuid PK, so we can't `upsert` by the unique
    // pair; do an explicit find → update/insert.
    let channelRow = await this.channels.findOne({
      where: { team_id: teamId, project_id: projectId },
    });
    if (channelRow) {
      channelRow.surface_channel_ref = channel;
      channelRow.display_name = channel;
      channelRow = await this.channels.save(channelRow);
    } else {
      channelRow = await this.channels.save(
        this.channels.create({
          team_id: teamId,
          project_id: projectId,
          surface_channel_ref: channel,
          display_name: channel,
        }),
      );
    }

    this.logger.log(
      `seed team=${teamId} project=${projectId} repo=${repoUrl} channel=${channel} → channel ${channelRow.id}`,
    );
    return { channelId: channelRow.id, teamId, projectId };
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
    const { channel, text } = body;

    // Resolve the channel's tenant so the injected message routes (the chat bridge keys on
    // (team_id, surface_channel_ref)). The bridge is self-sufficient from just the channel ref.
    const channelRow = await this.channels.findOne({
      where: { surface_channel_ref: channel },
    });
    if (!channelRow) {
      throw new NotFoundException(
        `No seeded channel with surface_channel_ref=${channel} — POST /test/seed first.`,
      );
    }

    // Snapshot the outbox cursor BEFORE sending so we only collect posts triggered by this message.
    const cursor = this.surface.outbox.length;
    const inboundTs = this.surface.sendFromHuman(channel, text, {
      teamId: channelRow.team_id,
      authorId: TESTER_ID,
      authorName: 'Tester',
      ...(body.threadTs ? { threadTs: body.threadTs } : {}),
    });
    // The thread root: a reply continues the supplied thread; a top-level message seeds a thread keyed
    // by its own inbound ts (mirrors the chat bridge's `surface_thread_ref = threadTs ?? msg.id`).
    const threadTs = body.threadTs ?? inboundTs;

    const { replies, approvalCard } = await this.waitForReplies(cursor, threadTs);
    return { threadTs, replies, ...(approvalCard ? { approvalCard } : {}) };
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

  /** `GET /test/job?jobId=...` — the `atlas_jobs` row (status/title/prUrl/kind) for the driver to poll. */
  @Get('job')
  async job(@Query('jobId') jobId: string): Promise<JobView> {
    this.assertEnabled();
    const row = await this.jobs.findOne({ where: { id: jobId } });
    if (!row) throw new NotFoundException(`No atlas_job ${jobId}`);
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
   * text). Resolves the `atlas_threads` row by its `surface_thread_ref` (the ts `/test/say` returns), then
   * reads its `atlas_messages` oldest-first.
   */
  @Get('thread')
  async thread(@Query('threadTs') threadTs: string): Promise<ThreadLine[]> {
    this.assertEnabled();
    // The thread's surface ref is the ts the caller has; join through to its messages.
    const rows = await this.messages
      .createQueryBuilder('m')
      .innerJoin(
        'atlas_threads',
        't',
        't.id = m.thread_id AND t.surface_thread_ref = :ref',
        { ref: threadTs },
      )
      .orderBy('m.created_at', 'ASC')
      .getMany();
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
