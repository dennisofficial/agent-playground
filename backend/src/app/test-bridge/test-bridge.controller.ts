import { EnvService } from '@core/config/env/env.service';
import { ENodeEnv } from '@core/config/env/validation';
import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { JobKind } from '@shared/domain';
import { hasAgentPrompt, listAgentPrompts, renderPreview } from '../prompt-kit';
import { InjectRepository } from '@nestjs/typeorm';
import { Public } from '@workspace/auth/server';
import { Repository } from 'typeorm';
import {
  AgentChatSurface,
  type OutboundChatMessage,
  parseApprovalMeta,
} from '../agent-surface';
import { DecisionApprovalService } from '../brain';
import { ThreadDriver, LANE_SEEDER, type LaneSeeder } from '../driver';
import { JobBootstrapService } from '../job-bootstrap';
import { laneFor } from '../surface';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  TranscriptMessageEntity,
  RepoEntity,
  JobEntity,
  OrganizationEntity,
  ThreadEntity,
  ActiveTurnEntity,
  InboundMessageEntity,
} from '../persistence/entities';
import type {
  ApproveRequest,
  JobView,
  SayApprovalCard,
  SayReply,
  SayRequest,
  SayResponse,
  SeedLaneRequest,
  SeedLaneResponse,
  SeedRequest,
  SeedResponse,
  StimulusView,
  ThreadLine,
  ThreadView,
  TurnView,
} from './test-bridge.dto';

/** How long `/test/say` waits for Atlas to post something on the thread before returning. */
const SAY_WAIT_MS = 60_000;
/** Poll cadence for the wait loop (cheap in-memory outbox scan). */
const SAY_POLL_MS = 200;
/** The simulated operator id stamped on injected messages + approvals — a real seeded dev user's uuid
 *  (`decision_records.approved_by` is a uuid FK; the literal `'tester'` fails `QueryFailedError`). */
const TESTER_ID = '1e512337-cd7e-41bb-8485-565eed283139';

/**
 * THE HTTP TEST-BRIDGE — a dev/test-only edge that lets an external driver have a REAL conversation with
 * a running Atlas (no Slack): seed a routable team/project/channel, inject a human message and read back
 * Atlas's replies, rule on the plan approval, and inspect the job + thread transcript. This edge is
 * `@Public()` (bypasses AuthGuard), so gating is a hard floor, not a flag: auto-enabled whenever
 * NODE_ENV !== 'production' (no flag to remember in dev/CI), and NEVER live when NODE_ENV === 'production'
 * regardless of any env var — see {@link assertEnabled}.
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
    private readonly driver: ThreadDriver,
    @Inject(LANE_SEEDER)
    private readonly laneSeeder: LaneSeeder,
    @InjectRepository(OrganizationEntity, DB_CONNECTION)
    private readonly orgs: Repository<OrganizationEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(TranscriptMessageEntity, DB_CONNECTION)
    private readonly messages: Repository<TranscriptMessageEntity>,
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(ActiveTurnEntity, DB_CONNECTION)
    private readonly turns: Repository<ActiveTurnEntity>,
    @InjectRepository(InboundMessageEntity, DB_CONNECTION)
    private readonly stimuli: Repository<InboundMessageEntity>,
    // Bootstraps a freshly-created job's ONE planning thread group + thread (d7: `thread_group_id` is never null). From
    // the @Global JobBootstrapModule. @Optional (trailing), same reason as the other ambient deps here.
    @Optional() private readonly jobBootstrap?: JobBootstrapService,
  ) {}

  /**
   * The kill-switch. This edge is `@Public()` — it bypasses AuthGuard entirely — so the gate has two
   * layers: a HARD floor (never enabled in production, full stop, regardless of any env var an operator
   * might leave set) and, below that, an automatic default (on whenever the process isn't running in
   * production — local dev, hot-reload, CI/test — no flag to remember). `TEST_BRIDGE=off` is still
   * honored as an explicit escape hatch for a non-prod environment that must not expose it.
   */
  private assertEnabled(): void {
    const nodeEnv = this.env.get('NODE_ENV');
    const flag = this.env.get('TEST_BRIDGE');
    const enabled = nodeEnv !== ENodeEnv.PROD && flag !== 'off';
    if (!enabled) {
      throw new NotFoundException(
        'Atlas test-bridge disabled (set TEST_BRIDGE=on, or run outside production).',
      );
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
    await this.orgs.upsert(
      { id: orgId, name: orgId, slug: orgId, status: 'active' },
      ['id'],
    );
    await this.repos.upsert(
      {
        org_id: orgId,
        slug: repoId,
        name: repoId,
        git_url: repoUrl,
        default_branch: body.baseBranch ?? 'main',
        token_name: null,
        access_ok: true,
        access_checked_at: new Date(),
      },
      ['org_id', 'slug'],
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

    // Resolve the repo by its slug (the test-bridge addresses repos by their human slug).
    const repo = await this.repos.findOne({ where: { slug: channel } });
    if (!repo) {
      throw new NotFoundException(
        `No seeded repo ${channel} — POST /test/seed first.`,
      );
    }

    // A reply continues the supplied thread; a new conversation creates a real thread up front so its id
    // is the durable handle (the chat bridge resolves inbound by this id).
    let jobId = body.threadTs;
    if (!jobId) {
      const thread = await this.jobs.save(
        this.jobs.create({
          org_id: repo.org_id,
          repo_id: repo.id,
          origin: 'chat',
          surface_thread_ref: null,
          title: null,
        }),
      );
      jobId = thread.id;
      // Bootstrap the new job's ONE planning thread group + thread — d7: `thread_group_id` is never null, even for a
      // job that never gets a plan proposed (mirrors every other job-creation seam).
      await this.jobBootstrap?.ensurePlanningThreadGroup(thread.id, repo.org_id);
    }

    // Snapshot the outbox cursor BEFORE sending so we only collect posts triggered by this message.
    const cursor = this.surface.outbox.length;
    this.surface.sendFromHuman(channel, text, {
      orgId: repo.org_id,
      authorId: TESTER_ID,
      authorName: 'Tester',
      threadTs: jobId,
    });

    const { replies, approvalCard } = await this.waitForReplies(cursor, jobId);
    return {
      threadTs: jobId,
      replies,
      ...(approvalCard ? { approvalCard } : {}),
    };
  }

  /**
   * `POST /test/approve` — resolve the pending plan approval for a job (default verdict 'approve'),
   * ruled by 'tester'. Returns whether a pending approval was actually resolved.
   */
  @Post('approve')
  async approve(@Body() body: ApproveRequest): Promise<{ ok: boolean }> {
    this.assertEnabled();
    const ok = this.approvals.resolve(
      body.jobId,
      body.verdict ?? 'approve',
      TESTER_ID,
    );
    this.logger.log(
      `approve job=${body.jobId} verdict=${body.verdict ?? 'approve'} ok=${ok}`,
    );
    return { ok };
  }

  /**
   * `POST /test/resume` — the PING that continues a job paused on a credential/401 error. Re-drives it
   * (`ThreadDriver.resumePaused`), which resumes the SAME engine session of the unfinished step
   * instead of restarting from scratch. A no-op if the job isn't paused.
   */
  @Post('resume')
  async resume(@Body() body: { jobId: string }): Promise<{ ok: boolean }> {
    this.assertEnabled();
    await this.driver.resumePaused(body.jobId);
    this.logger.log(`resume (ping) job=${body.jobId}`);
    return { ok: true };
  }

  /**
   * `POST /test/seed-lane` — inject a HOST SEED directly into a build lane, the ONLY way content reaches an
   * operator-read-only builder (d1). Drives `LANE_SEEDER.seedLane` exactly as production host-seed producers
   * do: `now` steers a live steerable Leg, `queue`/`later` fold into the next Leg. This is the entry point the
   * live-validation gate exercises against a running builder (there is no operator route to a build lane).
   */
  @Post('seed-lane')
  async seedLane(@Body() body: SeedLaneRequest): Promise<SeedLaneResponse> {
    this.assertEnabled();
    const job = await this.jobs.findOne({ where: { id: body.jobId } });
    if (!job) throw new NotFoundException(`No job ${body.jobId}`);

    const threadId =
      body.threadId ?? (await this.resolveBuilderThreadId(body.jobId));
    if (!threadId) {
      throw new NotFoundException(
        `No builder thread for job ${body.jobId} — dispatch a build first.`,
      );
    }

    await this.laneSeeder.seedLane(
      { jobId: job.id, orgId: job.org_id, repoId: job.repo_id, threadId },
      body.message,
      body.priority,
    );
    const lane = laneFor('builder', threadId);
    this.logger.log(
      `seed-lane job=${job.id} thread=${threadId} priority=${body.priority ?? 'default'}`,
    );
    return { ok: true, threadId, lane };
  }

  /** `GET /test/turns?jobId=...` — the job's `active_turns` rows, so a driver can see when a builder Leg is
   *  live + `steerable` (the window a `now` seed steers). */
  @Get('turns')
  async turnsFor(@Query('jobId') jobId: string): Promise<TurnView[]> {
    this.assertEnabled();
    const rows = await this.turns.find({ where: { job_id: jobId } });
    return rows.map((t) => ({
      turnId: t.turn_id,
      lane: t.lane,
      kind: t.kind,
      status: t.status,
      steerable: t.steerable,
    }));
  }

  /** `GET /test/threads?jobId=...` — the job's `threads` rows, so a driver can discover the build lane's
   *  `threadId` (and its kind/status/ordinal). */
  @Get('threads')
  async threadsFor(@Query('jobId') jobId: string): Promise<ThreadView[]> {
    this.assertEnabled();
    const rows = await this.threads.find({
      where: { job_id: jobId },
      order: { ordinal: 'ASC' },
    });
    return rows.map((t) => ({
      id: t.id,
      kind: t.role,
      status: t.status,
      ordinal: t.ordinal,
    }));
  }

  /** `GET /test/stimuli?jobId=...` — the job's `stimuli` delivery ledger (lane/priority/body + the
   *  `delivered_at`/`attempted_at` stamps), so a driver can watch a host seed drain. */
  @Get('stimuli')
  async stimuliFor(@Query('jobId') jobId: string): Promise<StimulusView[]> {
    this.assertEnabled();
    const rows = await this.stimuli.find({
      where: { job_id: jobId },
      order: { created_at: 'ASC' },
    });
    return rows.map((s) => ({
      id: s.id,
      lane: s.lane,
      priority: s.reply_route?.priority ?? null,
      body: s.body,
      deliveredAt: s.delivered_at ? s.delivered_at.toISOString() : null,
      attemptedAt: s.attempted_at ? s.attempted_at.toISOString() : null,
    }));
  }

  /** Resolve a job's sole/first `builder` thread (the build lane a bare `/test/seed-lane` targets). */
  private async resolveBuilderThreadId(jobId: string): Promise<string | null> {
    const builders = await this.threads.find({
      where: { job_id: jobId, role: 'builder' },
      order: { ordinal: 'ASC' },
    });
    return builders[0]?.id ?? null;
  }

  /** `GET /test/job?jobId=...` — the thread (build unit) row (status/title/prUrl/kind) for the driver to poll. */
  @Get('job')
  async job(@Query('jobId') jobId: string): Promise<JobView> {
    this.assertEnabled();
    const row = await this.jobs.findOne({ where: { id: jobId } });
    if (!row) throw new NotFoundException(`No thread ${jobId}`);
    return {
      id: row.id,
      status: row.status,
      title: row.title ?? '',
      prUrl: row.pr_url,
      kind: row.kind ?? '',
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
    const rows = await this.messages
      .createQueryBuilder('m')
      .where('m.job_id = :jobId', { jobId: threadTs })
      .orderBy('COALESCE(m.order_at, m.delivered_at, m.created_at)', 'ASC')
      .addOrderBy('m.created_at', 'ASC')
      .addOrderBy('m.id', 'ASC')
      .getMany();
    return rows.map((m) => ({
      author: m.author,
      isAtlas: m.author_bot_id != null,
      text: m.text,
    }));
  }

  /**
   * `GET /test/prompts` — list every previewable system prompt id (from the prompt-kit registry), with the
   * audience it composes as + where production sends it. Lets an agent (or an operator) discover what can be
   * rendered via `GET /test/prompts/:id`.
   */
  @Get('prompts')
  listPrompts(): Array<{ id: string; agent: string; note: string }> {
    this.assertEnabled();
    return listAgentPrompts();
  }

  /**
   * `GET /test/prompts/:id?jobKind=feature` — render a system prompt EXACTLY as production composes it
   * (global + audience layers + the job-kind block + the relocated body), for the given job kind. Returns
   * `text/plain` so it's readable straight from `curl`. `jobKind` is optional (omit → no job-kind block).
   * This is the faithful window into "how did this prompt assemble itself?".
   */
  @Get('prompts/:id')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  previewPrompt(
    @Param('id') id: string,
    @Query('jobKind') jobKind?: string,
  ): string {
    this.assertEnabled();
    if (!hasAgentPrompt(id)) {
      throw new NotFoundException(
        `Unknown prompt id '${id}'. GET /test/prompts lists the valid ids.`,
      );
    }
    // `jobKind` query overrides the id's representative kind (only affects the job-kind-composed personas).
    return renderPreview(id, jobKind ? (jobKind as JobKind) : undefined) ?? '';
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
function findApprovalCard(
  posts: OutboundChatMessage[],
): SayApprovalCard | undefined {
  for (const post of posts) {
    const meta = parseApprovalMeta(post.blocks);
    if (meta) {
      return {
        jobId: meta.jobId,
        ...(meta.decisionRecordId
          ? { decisionRecordId: meta.decisionRecordId }
          : {}),
        // The card's first text is "Plan proposal — <title>"; strip the prefix for a clean title.
        title:
          post.text.replace(/^Plan proposal\s*—\s*/, '').trim() || post.text,
      };
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
