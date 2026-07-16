import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  In,
  IsNull,
  MoreThan,
  Not,
  type ObjectLiteral,
  Repository,
} from 'typeorm';
import type { Decision, Job, JobActivity, JobKind, JobStatus } from '@shared/domain';
import { nextDecisionId } from '@shared/domain';
import type { AutoApproveMode } from '@workspace/shared';
import type {
  WebConventionEditProposalCard,
  WebConventionProposalCard,
  WebFileRequestCard,
  WebMcpProposalCard,
  WebQuestionCard,
  WebSecretInputCard,
  WebSkillEditAccessCard,
  WebSkillProposalCard,
} from '../surface';
// Direct leaf import (not the '../surface' barrel): brain-store otherwise only TYPE-imports from surface,
// and a runtime value import of the whole barrel would add a surface→brain→brain-store→surface cycle.
import { JobDependencyService } from '../job-deps';
import { nextQuestionId } from '../surface/web-question-card';
import { nextFileRequestId } from '../surface/web-file-request-card';
import { renderPlan } from '../prompt-kit/messages/render-plan';
import type { PlannedStep } from '../prompt-kit/messages/render-plan';
import type { AgentMessage } from '@shared/prompt-kit/message';
import { DB_CONNECTION } from '../persistence/database.module';
import { writeSystemChunk } from '../persistence/system-chunk-writer';
import { coerceThreadType, isDriverExecutableKind } from '../thread-kind';
import { JobBootstrapService } from '../job-bootstrap';
import {
  DecisionRecordEntity,
  TranscriptMessageEntity,
  ThreadGroupEntity,
  ThreadEntity,
  InboundMessageEntity,
  JobEntity,
  OrganizationEntity,
} from '../persistence/entities';
import { JobTitler } from '../titling';
import type { TranscriptLine } from './brain.types';

/** Where a thread lives on the surface — the channel coordinate + the thread root ts to reply into. */
export interface ThreadRoute {
  /** The surface-native channel coordinate (e.g. a Slack channel id); null until the channel is bound. */
  channel: string | null;
  /** The surface-native thread root ts; null until the thread's root is posted. */
  threadTs: string | null;
}

/** The persisted output of a locked plan: the thread (build unit) + its decision record id. */
export interface PersistedPlan {
  thread: Job;
  decisionRecordId: string;
}

/** Thread briefs are gap-numbered (10, 20, 30…) so a re-plan can splice without renumbering. */
const ORDINAL_GAP = 10;

/** The highest `ordinal` among a job's rows in `repo` (0 when none), for append-only gap numbering. The
 *  optional `extraWhere` narrows the pool (e.g. only top-level threads, which share the job-wide unique
 *  ordinal index). Aliased `t`, so `extraWhere` references `t.<column>`. */
async function maxOrdinal<T extends ObjectLiteral>(
  repo: Repository<T>,
  jobId: string,
  extraWhere?: string,
): Promise<number> {
  const qb = repo
    .createQueryBuilder('t')
    .select('MAX(t.ordinal)', 'max')
    .where('t.job_id = :jobId', { jobId });
  if (extraWhere) qb.andWhere(extraWhere);
  const row = await qb.getRawOne<{ max: number | null }>();
  return row?.max ?? 0;
}

/**
 * W3 — the BRAIN's persistence. The single place the brain reads the thread transcript and writes the
 * locked plan (decision record + thread rows) on the 'app' connection. The THREAD is the build unit
 * (the former `jobs` layer is folded into it), so "open a job" / "load a job" here are thread status
 * transitions on the same row. Keeps the conversational brain free of repository wiring — it speaks
 * domain shapes, this maps them to rows.
 *
 * The detailed per-thread PHASE plan is W4's job, NOT the brain's: this writes the high-level thread
 * BRIEFS (each a `pending` thread with no `plan` yet); W4's driver fills `plan` + the step rows
 * just-in-time. Zero v1 imports.
 */
@Injectable()
export class BrainStoreService {
  private readonly logger = new Logger(BrainStoreService.name);

  constructor(
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(TranscriptMessageEntity, DB_CONNECTION)
    private readonly messages: Repository<TranscriptMessageEntity>,
    @InjectRepository(DecisionRecordEntity, DB_CONNECTION)
    private readonly records: Repository<DecisionRecordEntity>,
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(ThreadGroupEntity, DB_CONNECTION)
    private readonly threadGroups: Repository<ThreadGroupEntity>,
    @InjectRepository(InboundMessageEntity, DB_CONNECTION)
    private readonly stimuli: Repository<InboundMessageEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
    private readonly titler: JobTitler,
    private readonly jobDeps: JobDependencyService,
    @InjectRepository(OrganizationEntity, DB_CONNECTION)
    private readonly organizations: Repository<OrganizationEntity>,
    // The planning thread group bootstrap now lives in `JobBootstrapService` (every job-creation seam, not just
    // this brain-module one, needs it — see its module doc for the cycle it avoids). `ensurePlanningThreadGroup`
    // below thin-delegates to it. @Optional (trailing) so the existing direct-construction unit tests
    // (positional args) keep compiling without a trailing argument.
    @Optional() private readonly jobBootstrap?: JobBootstrapService,
  ) {}

  /** The job's planning thread group thread id — the anchor every main-lane message row is stamped onto
   *  (`messages.thread_id` is NOT NULL). Wired in prod via DI; throws loudly if absent at use. */
  private async planningThreadId(jobId: string): Promise<string> {
    if (!this.jobBootstrap)
      throw new Error('brain-store: JobBootstrapService not wired');
    return this.jobBootstrap.planningThreadId(jobId);
  }

  /**
   * Resolve the thread an EVENT stimulus seeded (the intake seam opened it but the in-memory
   * an `EventMessage` doesn’t carry the delivery id). Reads the `stimuli` row's `job_id`. Null if the
   * stimulus isn't persisted (shouldn't happen — intake persists before consuming).
   */
  async eventThreadId(stimulusId: string): Promise<string | null> {
    const row = await this.stimuli.findOne({ where: { id: stimulusId } });
    return row?.job_id ?? null;
  }

  /** The org OWNER's user id (organization_members.role='owner') — the approver-attribution fallback when
   *  a job's auto_approve_by is null (the enabling user was deleted). Null if the org somehow has no owner. */
  async ownerUserId(orgId: string): Promise<string | null> {
    const rows = await this.dataSource.query<{ user_id: string }[]>(
      `SELECT user_id FROM organization_members WHERE org_id = $1 AND role = 'owner' ORDER BY created_at ASC LIMIT 1`,
      [orgId],
    );
    return rows[0]?.user_id ?? null;
  }

  /** Read a thread's message log, oldest-first — the transcript the grill turn reads. */
  async transcript(jobId: string): Promise<TranscriptLine[]> {
    const rows = await this.messages.find({
      where: { job_id: jobId },
      order: { created_at: 'ASC' },
    });
    return rows.map((m) => ({
      author: m.author,
      isAtlas: m.author_bot_id != null,
      text: m.text,
    }));
  }

  /** Append Atlas's own message to a thread (so its turns are part of the durable transcript). */
  async appendAtlasMessage(jobId: string, text: string): Promise<void> {
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text,
      }),
    );
  }

  /**
   * Append a SYSTEM→OPERATOR message — a runtime/harness notice meant for the OPERATOR ONLY (the brain
   * neither authored it nor sees it; it's never seeded into Atlas's session). e.g. "this thread can't be
   * resumed — start a new one". Distinct provenance: a non-Atlas author (`author_bot_id=null`) +
   * `meta.source='system_operator'`, the seam the web keys its dedicated system-notice box off. Contrast
   * `meta.source='system_shared'`, which BOTH the operator and (via a separate seed) Atlas see.
   */
  async appendSystemOperatorMessage(
    jobId: string,
    text: string,
    extraMeta?: Record<string, unknown>,
  ): Promise<void> {
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'System',
        author_id: 'system',
        author_bot_id: null,
        text,
        kind: 'chat',
        meta: { source: 'system_operator', ...extraMeta },
      }),
    );
  }

  /** Append a calm SYSTEM→OPERATOR notice (meta.source='system_notice'). Benign harness status the
   *  operator sees but Atlas never authored and never sees (its session is resumed separately). Unlike
   *  appendSystemOperatorMessage this carries NO error semantics (no halt, no Resume). */
  async appendSystemNotice(jobId: string, text: string): Promise<void> {
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'System',
        author_id: 'system',
        author_bot_id: null,
        text,
        kind: 'chat',
        meta: { source: 'system_notice' },
      }),
    );
  }

  /**
   * Has an IDENTICAL system→operator notice already landed on this thread within `withinMs`? Guards against
   * a PERSISTENT engine failure (a spend / session / rate limit) stacking byte-identical red error boxes:
   * such a failure hits every queued sibling turn, every event/seed delivery, and every sweep re-drive the
   * same way, so without this the operator sees the same "Resume" panel two, three, four times in a row.
   * Matched on the `system` author (the exclusive marker of {@link appendSystemOperatorMessage}) + exact
   * text — a false miss just falls back to posting (never a wrong suppression of a genuinely different
   * error). Per-thread turns are serialized (the `turnQueues` mutex), so this check-then-write can't race.
   */
  async hasRecentSystemOperatorNotice(
    jobId: string,
    text: string,
    withinMs = 120_000,
  ): Promise<boolean> {
    const since = new Date(Date.now() - withinMs);
    const existing = await this.messages.findOne({
      where: {
        job_id: jobId,
        author_id: 'system',
        text,
        created_at: MoreThan(since),
      },
    });
    return existing != null;
  }

  /**
   * Append a typed transcript BLOCK from a brain turn — the durable record of the in-sandbox session.
   * `kind` is `'chat'` (assistant text), `'thinking'` (a thinking block), or `'tool'` (a tool call;
   * `meta` carries `{ name, input, result, isError }`). Authored by Atlas so it renders on the agent side.
   *
   * `createdAt` overrides the row's timestamp with the block's EMISSION time. This matters because the
   * turn's blocks are persisted in a batch at turn END, while a follow-up the operator sends mid-turn is
   * persisted immediately (real send time). `messages` is ordered by `created_at`, so without the override
   * the batched blocks would all sort AFTER an interleaved user message that actually came after them — the
   * message would jump to the top of the turn. Stamping each block with when it streamed restores true
   * chronological order. (TypeORM honors an explicit `@CreateDateColumn` value on insert.)
   */
  async appendBlock(
    jobId: string,
    block: {
      kind: string;
      text?: string;
      meta?: Record<string, unknown> | null;
      createdAt?: Date;
    },
  ): Promise<void> {
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: block.text ?? '',
        kind: block.kind,
        meta: block.meta ?? null,
        ...(block.createdAt ? { created_at: block.createdAt } : {}),
      }),
    );
  }

  /**
   * Append a SYSTEM-EVENT line to a thread (kind='build_event') — a calm operator-visible pill, e.g.
   * "🔍 Codex is reviewing the plan…". Authored by Atlas so it renders on the agent side; the web renders
   * `build_event` rows as a tinted pill (tone derived from the text).
   */
  async appendSystemEvent(jobId: string, text: string): Promise<void> {
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text,
        kind: 'build_event',
      }),
    );
  }

  /**
   * Append a COMPACTION-SUMMARY pill (kind='build_event', like {@link appendSystemEvent}) that ALSO carries
   * the full handoff summary in `meta.compactionSummary`. Renders as the same calm pill, but the web makes it
   * EXPANDABLE so the operator can inspect exactly what context was kept when the session was compacted. The
   * summary lives on this durable `messages` row (never cleared, unlike `job_sandboxes.pending_compaction_seed`
   * which is consumed by the next fresh turn), so it stays auditable for the life of the job.
   */
  async appendCompactionSummary(
    jobId: string,
    text: string,
    summary: string,
  ): Promise<void> {
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text,
        kind: 'build_event',
        meta: { compactionSummary: summary },
      }),
    );
  }

  /**
   * Persist a harness-injected chunk (a `system_notice`, `system_reminder`, or `untrusted` from the chunk-vocabulary) as a
   * VISIBLE transcript row — so a sandbox-reset notice, a pipeline-awareness or open-questions reminder, etc.
   * that the brain reads inline is also legible in the web (the classifier keys on `meta.source`). The row's
   * `text` is the CLEAN body (no XML tag — the tag is engine-only). System-authored (`author_bot_id: null`,
   * NOT the operator, NOT Atlas). Insert-once by `meta.chunkKey` so a re-drive/reattach of the same turn
   * doesn't duplicate it. `createdAt` is backdated by the caller so the row sorts BEFORE the message it rode
   * with (history orders by `created_at ASC`, and the operator row is already committed at intake time).
   */
  async recordSystemChunk(input: {
    jobId: string;
    kind: 'system_notice' | 'system_reminder' | 'untrusted';
    text: AgentMessage;
    chunkKey: string;
    reminderKind?: string;
    /** `<untrusted>` provenance/severity — surfaced on the web's untrusted pill. */
    untrustedSource?: string;
    severity?: string;
    /**
     * The full raw payload delivered to the engine, when it differs from the short collapsed `text` label.
     * Stashed in `meta` and revealed on row-expand in the console (mirrors `meta.compactionSummary`), so the
     * operator can inspect the actual context injected into Atlas. Omit when `text` already IS the full body.
     */
    fullBody?: AgentMessage;
    /** The TRUSTED harness framing that rode with this chunk (e.g. the wake preamble), carried
     *  separately from `text` so the web can render it as its own trusted block. */
    framing?: string;
    createdAt?: Date;
    /** The internal-seed `Message` type behind this row (`meta.seedType`) — the frontend's per-seed-type
     *  pill discriminant (mirrors `meta.eventKind`). */
    seedType?: string;
  }): Promise<void> {
    return writeSystemChunk(this.messages, {
      ...input,
      threadId: await this.planningThreadId(input.jobId),
    });
  }

  /**
   * The BRAIN's most-recent context-window occupancy, read from the latest `turn_meta` block. Build turns
   * also emit `turn_meta`, but tagged with `meta.phaseId` (the brain's `main`-lane turn_meta carries no
   * metaTag), so `phaseId IS NULL` isolates the brain's own occupancy. Used to gate compaction — skip the
   * summary turn when the session is still lean. Null when no brain turn has recorded usage yet (or the SDK
   * didn't surface per-call usage), in which case the caller compacts rather than risk leaving a fat session.
   */
  async latestBrainOccupancy(jobId: string): Promise<{
    contextTokens: number | null;
    contextLimit: number | null;
  } | null> {
    const rows: Array<{
      meta: {
        contextTokens?: number | null;
        contextLimit?: number | null;
      } | null;
    }> = await this.dataSource.query(
      `SELECT meta FROM transcript_messages
         WHERE job_id = $1 AND kind = 'turn_meta' AND meta->>'phaseId' IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
      [jobId],
    );
    const meta = rows[0]?.meta;
    if (!meta) return null;
    return {
      contextTokens: meta.contextTokens ?? null,
      contextLimit: meta.contextLimit ?? null,
    };
  }

  // ── card messages (durable; the surface `post` path does NOT write `messages.card`) ────────────────

  /**
   * Persist a CARD message row (kind='card') so it survives refetch/reload — the surface `post` path
   * only writes the outbox + SSE, never `messages.card`. `ts` is the card's stable key (e.g. a
   * questionId); the card payload renders via `/messages` (which returns `m.card`). Authored by Atlas.
   */
  async appendCardMessage(
    jobId: string,
    input: { ts: string; text?: string; card: Record<string, unknown> },
  ): Promise<void> {
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: input.text ?? '',
        kind: 'card',
        ts: input.ts,
        card: input.card,
      }),
    );
  }

  /**
   * Relay a block the brain CLEARED via retrieve-and-resume (its `note_cleared_block` tool) as a durable,
   * NON-BLOCKING FYI card — so the operator SEES that Atlas unblocked a build thread by retrieving an existing
   * answer, without it stalling for them. Deliberately NOT a `question_card` (which bumps the needs-you gate):
   * this is an audit heads-up, not a question. Insert-once on the stable `ts` (`cleared:<threadId>:<gen>`) so a
   * resumed wake turn re-driving the tool doesn't double-post. Best-effort — the caller swallows failures.
   */
  async appendClearedBlockCard(
    jobId: string,
    input: {
      threadId: string;
      gen: number;
      reason: string;
      evidence: string;
      text: string;
    },
  ): Promise<void> {
    const ts = `cleared:${input.threadId}:${input.gen}`;
    const dup = await this.messages.count({
      where: { job_id: jobId, ts, kind: 'card' },
    });
    if (dup > 0) return;
    await this.appendCardMessage(jobId, {
      ts,
      text: input.text,
      card: {
        type: 'cleared_block_card',
        threadId: input.threadId,
        reason: input.reason,
        evidence: input.evidence,
      },
    });
  }

  /** Every cleared-block FYI card on a job, oldest-first — the DURABLE source the `atlas-cleared-blocks.md`
   *  projection re-renders from (the card rows survive sandbox teardown; the file is a pure re-render). */
  async listClearedBlockCards(
    jobId: string,
  ): Promise<
    { threadId: string; reason: string; evidence: string; at: Date }[]
  > {
    const rows = await this.messages.find({
      where: { job_id: jobId, kind: 'card' },
      order: { created_at: 'ASC' },
    });
    return rows
      .filter((m) => m.card?.type === 'cleared_block_card')
      .map((m) => {
        const c = m.card ?? {};
        return {
          threadId: String(c['threadId'] ?? ''),
          reason: String(c['reason'] ?? ''),
          evidence: String(c['evidence'] ?? ''),
          at: m.created_at,
        };
      });
  }

  /** Merge a patch into a card row's `card` jsonb (e.g. stamp the answered state / `loggedDecision`). */
  async updateCardMessage(
    jobId: string,
    ts: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts, kind: 'card' },
    });
    if (!row) return;
    row.card = { ...(row.card ?? {}), ...patch };
    await this.messages.save(row);
  }

  /** Load this thread's card rows, newest-first — small helper for the question-card lookups below. */
  private async questionCards(jobId: string): Promise<TranscriptMessageEntity[]> {
    const rows = await this.messages.find({
      where: { job_id: jobId, kind: 'card' },
      order: { created_at: 'DESC' },
    });
    return rows.filter((m) => m.card?.type === 'question_card');
  }

  /**
   * Allocate the next stable brain question id for this job — `q1`, `q2`, … — over the existing question
   * card ids (see {@link nextQuestionId}). Scans the durable card rows so numbering survives a restart and
   * never reuses a withdrawn id. Race-safe in practice: one brain turn runs at a time and its `ask_question`
   * tool calls are awaited in order, so each `openQuestion` lands before the next id is allocated.
   */
  async nextQuestionId(jobId: string): Promise<string> {
    const cards = await this.questionCards(jobId);
    return nextQuestionId(cards.map((m) => m.ts ?? ''));
  }

  /**
   * The most-recently-ANSWERED question card not yet consumed by a `create_decision` — the fallback
   * `create_decision` auto-attaches (its `question` + `answer`) when no explicit `questionId`/delivery
   * `seedQuestionId` names one. Durable (DB-backed), survives a host restart between answer and lock.
   * Ordered by the card's own `answeredAt` (NOT `created_at`) so that with multiple open questions an
   * out-of-order answer attaches the card the operator just answered, not the oldest-created one.
   */
  async latestAnsweredQuestionCard(
    jobId: string,
  ): Promise<TranscriptMessageEntity | null> {
    const cards = await this.questionCards(jobId);
    const answered = cards.filter((m) => {
      const c = m.card as Record<string, unknown>;
      return c.answer != null && c.loggedDecision !== true;
    });
    answered.sort((a, b) => {
      const aAt = String((a.card as Record<string, unknown>).answeredAt ?? '');
      const bAt = String((b.card as Record<string, unknown>).answeredAt ?? '');
      return bAt.localeCompare(aAt); // newest answeredAt first (ISO strings sort lexically)
    });
    return answered[0] ?? null;
  }

  // ── human-input gate (durable ask_question lifecycle: asked → answered → delivered → loggedDecision) ──
  // Each question card carries its OWN lifecycle state (`answer`/`answeredAt`/`deliveredAt`); there is NO
  // single-slot thread pointer. The brain may have MANY questions open at once, answerable in any order.
  // `threads.open_question_count` is a denormalized "how many cards await the operator" counter (cheap
  // needs-you signal + WAL realtime), maintained transactionally on open/answer and healed on boot.

  /**
   * Open a question card: in ONE transaction persist the card row AND bump `open_question_count`. No
   * single-slot refusal — stacking is allowed. Returns `{ ok:false }` only if the thread doesn't exist.
   */
  async openQuestion(
    jobId: string,
    input: { ts: string; text?: string; card: Record<string, unknown> },
  ): Promise<{ ok: boolean }> {
    return this.dataSource.transaction(async (m) => {
      const threads = m.getRepository(JobEntity);
      const messages = m.getRepository(TranscriptMessageEntity);
      const thread = await threads.findOne({ where: { id: jobId } });
      if (!thread) return { ok: false };
      await messages.save(
        messages.create({
          job_id: jobId,
          thread_id: await this.planningThreadId(jobId),
          author: 'Atlas',
          author_id: 'atlas',
          author_bot_id: 'atlas',
          text: input.text ?? '',
          kind: 'card',
          ts: input.ts,
          card: input.card,
        }),
      );
      await threads
        .createQueryBuilder()
        .update()
        .set({ open_question_count: () => 'open_question_count + 1' })
        .where('id = :jobId', { jobId })
        .execute();
      return { ok: true };
    });
  }

  /**
   * Stamp a question card ANSWERED, ATOMICALLY and IDEMPOTENTLY: a conditional update that only fires
   * `WHERE the card is still unanswered`, so two concurrent answer requests can't both "win". Only the
   * winner decrements `open_question_count`. Returns `{ firstAnswer:true }` for the winner (the caller
   * then seeds the delivery turn) and `{ firstAnswer:false }` for a stale/duplicate/already-answered call.
   */
  async markQuestionAnswered(
    jobId: string,
    questionId: string,
    answer: string,
  ): Promise<{ firstAnswer: boolean }> {
    return this.dataSource.transaction(async (m) => {
      const patch = JSON.stringify({
        answer,
        answeredAt: new Date().toISOString(),
      });
      const res = await m
        .createQueryBuilder()
        .update(TranscriptMessageEntity)
        .set({ card: () => 'card || :patch::jsonb' })
        .where('job_id = :jobId', { jobId })
        .andWhere('ts = :questionId', { questionId })
        .andWhere("kind = 'card'")
        .andWhere("card ->> 'type' = 'question_card'")
        .andWhere("card ->> 'answer' IS NULL")
        .andWhere("card ->> 'deliveredAt' IS NULL")
        // A withdrawn card is terminal — it already decremented the counter, so an answer that races in
        // after withdrawal must NOT fire (else a double-decrement + a phantom delivery turn).
        .andWhere("card ->> 'withdrawnAt' IS NULL")
        .setParameter('patch', patch)
        .execute();
      const firstAnswer = (res.affected ?? 0) === 1;
      if (firstAnswer) {
        await m
          .createQueryBuilder()
          .update(JobEntity)
          .set({
            open_question_count: () => 'GREATEST(0, open_question_count - 1)',
          })
          .where('id = :jobId', { jobId })
          .execute();
      }
      return { firstAnswer };
    });
  }

  /**
   * The thread's currently-OPEN brain question cards — asked, but not yet answered OR withdrawn — newest
   * first. Surfaced back into each turn's context ({@link AgentSessionManager.buildOpenQuestionsPrefix}) so a
   * fresh turn (a new operator message, an event delivery, or a restart-rebuilt session that lost its
   * in-context memory of what it asked) doesn't re-ask something already awaiting the operator. Excludes
   * `origin:'build'` cards — those belong to the driver's `request_operator_input`, not the conversational brain.
   */
  async openQuestionCards(jobId: string): Promise<WebQuestionCard[]> {
    const cards = await this.questionCards(jobId);
    return cards
      .map((m) => m.card as unknown as WebQuestionCard)
      .filter(
        (c) =>
          c.answer == null && c.withdrawnAt == null && c.origin !== 'build',
      );
  }

  /**
   * Withdraw a still-unanswered question card ATOMICALLY and IDEMPOTENTLY — the mirror of
   * {@link markQuestionAnswered}: a conditional update that only fires `WHERE the card is still unanswered
   * AND not already withdrawn`, so it can't race the operator's answer (only one of the two wins). The
   * winner stamps `withdrawnAt` (+ optional `withdrawnReason`) and decrements `open_question_count`.
   * Returns `{ withdrawn:true }` for the winner, `{ withdrawn:false }` when the card is missing, already
   * answered (the operator got there first), or already withdrawn.
   */
  async withdrawQuestion(
    jobId: string,
    questionId: string,
    reason?: string,
  ): Promise<{ withdrawn: boolean }> {
    return this.dataSource.transaction(async (m) => {
      const patch = JSON.stringify({
        withdrawnAt: new Date().toISOString(),
        ...(reason ? { withdrawnReason: reason } : {}),
      });
      const res = await m
        .createQueryBuilder()
        .update(TranscriptMessageEntity)
        .set({ card: () => 'card || :patch::jsonb' })
        .where('job_id = :jobId', { jobId })
        .andWhere('ts = :questionId', { questionId })
        .andWhere("kind = 'card'")
        .andWhere("card ->> 'type' = 'question_card'")
        .andWhere("card ->> 'answer' IS NULL")
        .andWhere("card ->> 'withdrawnAt' IS NULL")
        .setParameter('patch', patch)
        .execute();
      const withdrawn = (res.affected ?? 0) === 1;
      if (withdrawn) {
        await m
          .createQueryBuilder()
          .update(JobEntity)
          .set({
            open_question_count: () => 'GREATEST(0, open_question_count - 1)',
          })
          .where('id = :jobId', { jobId })
          .execute();
      }
      return { withdrawn };
    });
  }

  /** Fetch one thread's question-card payload by id (the card's `ts`); null if absent / not a question. */
  async getQuestionCard(
    jobId: string,
    questionId: string,
  ): Promise<WebQuestionCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: questionId, kind: 'card' },
    });
    const card = row?.card as WebQuestionCard | undefined;
    return card?.type === 'question_card' ? card : null;
  }

  /** Stamp a question card delivered (its answer reached the brain in a turn that actually ran). */
  async markQuestionDelivered(
    jobId: string,
    questionId: string,
  ): Promise<void> {
    await this.updateCardMessage(jobId, questionId, {
      deliveredAt: new Date().toISOString(),
    });
  }

  /**
   * Boot reconciliation: every question card that is ANSWERED-but-UNDELIVERED — the crash window where the
   * operator answered (durably stamped) but the host died before a turn handed it to the brain. Scans the
   * CARD rows (not a thread pointer), so multiple per thread are returned, ORDERED BY each card's own
   * `answeredAt` (oldest first) so the boot sweep re-delivers them in the order they were answered.
   */
  async findUndeliveredAnsweredQuestions(): Promise<
    {
      jobId: string;
      orgId: string;
      repoId: string;
      questionId: string;
      question: string;
      answer: string;
    }[]
  > {
    const raw = await this.messages
      .createQueryBuilder('m')
      .innerJoin(JobEntity, 't', 't.id = m.job_id')
      .where("m.kind = 'card'")
      .andWhere("m.card ->> 'type' = 'question_card'")
      .andWhere("m.card ->> 'answer' IS NOT NULL")
      .andWhere("m.card ->> 'deliveredAt' IS NULL")
      .select('m.job_id', 'jobId')
      .addSelect('m.ts', 'questionId')
      .addSelect("m.card ->> 'question'", 'question')
      .addSelect("m.card ->> 'answer'", 'answer')
      .addSelect('t.org_id', 'orgId')
      .addSelect('t.repo_id', 'repoId')
      .orderBy("m.card ->> 'answeredAt'", 'ASC')
      .getRawMany<{
        jobId: string;
        orgId: string;
        repoId: string;
        questionId: string;
        question: string | null;
        answer: string | null;
      }>();
    return raw.map((r) => ({
      jobId: r.jobId,
      orgId: r.orgId,
      repoId: r.repoId,
      questionId: r.questionId,
      question: r.question ?? '',
      answer: r.answer ?? '',
    }));
  }

  /**
   * Boot heal: recompute every thread's `open_question_count` from its actual unanswered question cards,
   * so the denormalized counter can never wedge the needs-you signal the way the old single slot could.
   */
  async reconcileOpenQuestionCounts(): Promise<void> {
    const messagesTable = this.messages.metadata.tablePath;
    const threadsTable = this.jobs.metadata.tablePath;
    await this.dataSource.query(
      `UPDATE ${threadsTable} t SET open_question_count = (
         SELECT COUNT(*)::int FROM ${messagesTable} m
         WHERE m.job_id = t.id AND m.kind = 'card'
           AND m.card ->> 'type' = 'question_card'
           AND m.card ->> 'answer' IS NULL
           AND m.card ->> 'withdrawnAt' IS NULL
       )`,
    );
  }

  // ── secure secret-request gate (request_secret lifecycle: requested → provided → delivered) ──────────
  // Parallel to the ask_question gate but on its OWN pointer (`awaiting_secret_id`). The VALUE never lands
  // here or in the transcript — only the request metadata + lifecycle timestamps. The `provide-secret`
  // endpoint writes the value to the encrypted store + stamps `provided_at`; the gate clears only once a
  // masked-confirmation delivery turn runs (so a crash mid-delivery re-delivers on boot, at-least-once).

  /**
   * Open the secure-secret gate. Two lanes:
   *
   * - EPHEMERAL (`deliver_to`): single-slot, ATOMIC — persist the value-free card AND point the thread's
   *   `awaiting_secret_id` at it in ONE transaction. Refuses (`alreadyOpen`) if an un-provided ephemeral
   *   request is already open (one blocking one-time value at a time).
   * - DURABLE / MCP: PER-CARD (like {@link openFileRequest}) — a plain card insert, NO `awaiting_secret_id`
   *   pointer and NO one-at-a-time refusal, so several may be open at once. The card insert AND the
   *   `open_secret_count` bump land in ONE transaction (mirrors {@link openQuestion}). Never returns
   *   `alreadyOpen` for these lanes.
   */
  async openSecretRequest(
    jobId: string,
    input: { requestId: string; card: WebSecretInputCard },
  ): Promise<{ ok: boolean; alreadyOpen?: boolean }> {
    const text = input.card.ephemeral
      ? `Requested a one-time value \`${input.card.name}\` (delivered to the running session, not stored)`
      : input.card.mcp
        ? `Requested secret \`${input.card.mcp.key}\` for MCP server \`${input.card.mcp.server}\``
        : `Requested secret \`${input.card.name}\` → \`${input.card.path}\``;
    return this.dataSource.transaction(async (m) => {
      const threads = m.getRepository(JobEntity);
      const messages = m.getRepository(TranscriptMessageEntity);
      const thread = await threads.findOne({ where: { id: jobId } });
      if (!thread) return { ok: false };
      if (input.card.ephemeral && thread.awaiting_secret_id) {
        const open = await messages.findOne({
          where: {
            job_id: jobId,
            ts: thread.awaiting_secret_id,
            kind: 'card',
          },
        });
        const card = open?.card as WebSecretInputCard | undefined;
        if (card && card.provided_at == null)
          return { ok: false, alreadyOpen: true };
      }
      await messages.save(
        messages.create({
          job_id: jobId,
          thread_id: await this.planningThreadId(jobId),
          author: 'Atlas',
          author_id: 'atlas',
          author_bot_id: 'atlas',
          text,
          kind: 'card',
          ts: input.requestId,
          card: input.card as unknown as Record<string, unknown>,
        }),
      );
      if (input.card.ephemeral) {
        await threads.update(
          { id: jobId },
          { awaiting_secret_id: input.requestId },
        );
      } else {
        await threads
          .createQueryBuilder()
          .update()
          .set({ open_secret_count: () => 'open_secret_count + 1' })
          .where('id = :jobId', { jobId })
          .execute();
      }
      return { ok: true };
    });
  }

  /** The requestId this thread is awaiting a secret value for (the gate pointer), or null. */
  async awaitingSecretId(jobId: string): Promise<string | null> {
    const row = await this.jobs.findOne({ where: { id: jobId } });
    return row?.awaiting_secret_id ?? null;
  }

  /** Fetch one thread's secret-input card by id (the card's `ts`); null if absent / not a secret card. */
  async getSecretCard(
    jobId: string,
    requestId: string,
  ): Promise<WebSecretInputCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const card = row?.card as WebSecretInputCard | undefined;
    return card?.type === 'secret_input_card' ? card : null;
  }

  /** Stamp a secret card PROVIDED (the operator submitted the value → encrypted store). No value stored. */
  async markSecretProvided(jobId: string, requestId: string): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      provided_at: new Date().toISOString(),
    });
  }

  /** Stamp a secret card DELIVERED (the masked confirmation reached the brain in a turn that ran). */
  async markSecretDelivered(jobId: string, requestId: string): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      delivered_at: new Date().toISOString(),
    });
  }

  /** Clear the secret gate iff it still equals `requestId` (compare-and-clear; ignores a superseded gate). */
  async clearAwaitingSecret(jobId: string, requestId: string): Promise<void> {
    await this.jobs.update(
      { id: jobId, awaiting_secret_id: requestId },
      { awaiting_secret_id: null },
    );
  }

  /**
   * Stamp a DURABLE/MCP secret card PROVIDED and decrement `open_secret_count`, in ONE transaction. The
   * per-card analog of {@link markSecretProvided} (which only stamps the card, for the ephemeral lane).
   * Unlike files, durable/mcp secrets carry the `open_secret_count` needs-you counter, so the provide
   * success must decrement it alongside the `provided_at` stamp. No value is stored on the card.
   */
  async markSecretProvidedPerCard(
    jobId: string,
    requestId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const patch = JSON.stringify({ provided_at: new Date().toISOString() });
      // Only the transition from open → provided decrements the counter (a racing double-submit finds the
      // card already provided → affected 0 → no double-decrement). Mirrors {@link markQuestionAnswered}.
      const res = await m
        .createQueryBuilder()
        .update(TranscriptMessageEntity)
        .set({ card: () => 'card || :patch::jsonb' })
        .where('job_id = :jobId', { jobId })
        .andWhere('ts = :requestId', { requestId })
        .andWhere("kind = 'card'")
        .andWhere("card ->> 'type' = 'secret_input_card'")
        .andWhere("card ->> 'provided_at' IS NULL")
        .andWhere("card ->> 'withdrawnAt' IS NULL")
        .andWhere("card ->> 'ephemeral' IS DISTINCT FROM 'true'")
        .setParameter('patch', patch)
        .execute();
      if ((res.affected ?? 0) === 1) {
        await m
          .createQueryBuilder()
          .update(JobEntity)
          .set({
            open_secret_count: () => 'GREATEST(0, open_secret_count - 1)',
          })
          .where('id = :jobId', { jobId })
          .execute();
      }
    });
  }

  /**
   * The thread's currently-OPEN durable/mcp secret-request cards — posted, but not yet provided OR
   * withdrawn — so a fresh turn doesn't re-post a duplicate `request_secret`. EPHEMERAL cards are excluded
   * (they're single-slot/immediate, not a standing per-card request). The secret-card analog of
   * {@link openFileCards}; surfaced via {@link AgentSessionManager.buildOpenSecretRequestsPrefix}.
   */
  async openSecretCards(jobId: string): Promise<WebSecretInputCard[]> {
    const rows = await this.messages.find({
      where: { job_id: jobId, kind: 'card' },
      order: { created_at: 'DESC' },
    });
    return rows
      .map((m) => m.card as unknown as WebSecretInputCard)
      .filter(
        (c) =>
          c?.type === 'secret_input_card' &&
          c.provided_at == null &&
          c.withdrawnAt == null &&
          c.ephemeral !== true,
      );
  }

  /**
   * Withdraw a still-open DURABLE/MCP secret request ATOMICALLY and IDEMPOTENTLY — the secret-card mirror
   * of {@link withdrawFileRequest}: a conditional update that only fires `WHERE the request is still open`
   * (not provided, not already withdrawn), so it can't race the operator's submit. The winner stamps
   * `withdrawnAt` (+ optional `withdrawnReason`) AND decrements `open_secret_count`, in ONE transaction.
   * Returns `{ withdrawn:true }` for the winner, `{ withdrawn:false }` when the card is missing, already
   * provided, or already withdrawn.
   */
  async withdrawSecretRequest(
    jobId: string,
    requestId: string,
    reason?: string,
  ): Promise<{ withdrawn: boolean }> {
    return this.dataSource.transaction(async (m) => {
      const patch = JSON.stringify({
        withdrawnAt: new Date().toISOString(),
        ...(reason ? { withdrawnReason: reason } : {}),
      });
      const res = await m
        .createQueryBuilder()
        .update(TranscriptMessageEntity)
        .set({ card: () => 'card || :patch::jsonb' })
        .where('job_id = :jobId', { jobId })
        .andWhere('ts = :requestId', { requestId })
        .andWhere("kind = 'card'")
        .andWhere("card ->> 'type' = 'secret_input_card'")
        .andWhere("card ->> 'provided_at' IS NULL")
        .andWhere("card ->> 'withdrawnAt' IS NULL")
        .andWhere("card ->> 'ephemeral' IS DISTINCT FROM 'true'")
        .setParameter('patch', patch)
        .execute();
      const withdrawn = (res.affected ?? 0) === 1;
      if (withdrawn) {
        await m
          .createQueryBuilder()
          .update(JobEntity)
          .set({
            open_secret_count: () => 'GREATEST(0, open_secret_count - 1)',
          })
          .where('id = :jobId', { jobId })
          .execute();
      }
      return { withdrawn };
    });
  }

  /**
   * Boot reconciliation: threads whose gate points at a PROVIDED-but-UNDELIVERED secret card — the crash
   * window where the operator submitted the value (durably stored + granted) but the host died before a
   * turn handed the masked confirmation to the brain. The startup sweep re-delivers each (at-least-once).
   * The VALUE is not returned (it's not stored on the card) — only the name/path for the masked notice.
   */
  async findUndeliveredProvidedSecrets(): Promise<
    {
      jobId: string;
      orgId: string;
      repoId: string;
      requestId: string;
      name: string;
      path?: string;
      ephemeral?: boolean;
      mcp?: { server: string; slot: 'header' | 'env'; key: string };
    }[]
  > {
    type Row = {
      jobId: string;
      orgId: string;
      repoId: string;
      requestId: string;
      name: string;
      path?: string;
      ephemeral?: boolean;
      mcp?: { server: string; slot: 'header' | 'env'; key: string };
    };
    const out: Row[] = [];
    // (a) EPHEMERAL cards still reachable via the single-slot `awaiting_secret_id` pointer.
    const pointed = await this.jobs.find({
      where: { awaiting_secret_id: Not(IsNull()) },
    });
    for (const t of pointed) {
      const card = await this.getSecretCard(t.id, t.awaiting_secret_id!);
      if (
        card?.ephemeral === true &&
        card.provided_at != null &&
        card.delivered_at == null
      ) {
        out.push({
          jobId: t.id,
          orgId: t.org_id,
          repoId: t.repo_id,
          requestId: t.awaiting_secret_id!,
          name: card.name,
          ...(card.path ? { path: card.path } : {}),
          ephemeral: true,
          ...(card.mcp ? { mcp: card.mcp } : {}),
        });
      }
    }
    // (b) DURABLE / MCP per-card requests found by scanning `messages` jsonb (no pointer).
    const messagesTable = this.messages.metadata.tablePath;
    const threadsTable = this.jobs.metadata.tablePath;
    const rows: {
      jobId: string;
      orgId: string;
      repoId: string;
      requestId: string;
      card: WebSecretInputCard;
    }[] = await this.dataSource.query(
      `SELECT m.job_id AS "jobId", t.org_id AS "orgId", t.repo_id AS "repoId",
              m.ts AS "requestId", m.card AS "card"
         FROM ${messagesTable} m
         JOIN ${threadsTable} t ON t.id = m.job_id
        WHERE m.kind = 'card'
          AND m.card ->> 'type' = 'secret_input_card'
          AND m.card ->> 'provided_at' IS NOT NULL
          AND m.card ->> 'delivered_at' IS NULL
          AND m.card ->> 'withdrawnAt' IS NULL
          AND m.card ->> 'ephemeral' IS DISTINCT FROM 'true'`,
    );
    for (const r of rows) {
      out.push({
        jobId: r.jobId,
        orgId: r.orgId,
        repoId: r.repoId,
        requestId: r.requestId,
        name: r.card.name,
        ...(r.card.path ? { path: r.card.path } : {}),
        ...(r.card.mcp ? { mcp: r.card.mcp } : {}),
      });
    }
    return out;
  }

  /**
   * Boot heal: recompute every thread's `open_secret_count` from its actual open DURABLE/MCP secret cards
   * (provided_at null, withdrawnAt null). EPHEMERAL cards use the single-slot `awaiting_secret_id` pointer,
   * not this counter, so they are excluded (`ephemeral` jsonb boolean stringifies to `'true'` under `->>`).
   */
  async reconcileOpenSecretCounts(): Promise<void> {
    const messagesTable = this.messages.metadata.tablePath;
    const threadsTable = this.jobs.metadata.tablePath;
    await this.dataSource.query(
      `UPDATE ${threadsTable} t SET open_secret_count = (
         SELECT COUNT(*)::int FROM ${messagesTable} m
         WHERE m.job_id = t.id AND m.kind = 'card'
           AND m.card ->> 'type' = 'secret_input_card'
           AND m.card ->> 'provided_at' IS NULL
           AND m.card ->> 'withdrawnAt' IS NULL
           AND m.card ->> 'ephemeral' IS DISTINCT FROM 'true'
       )`,
    );
  }

  // ── file-request gate (request_file lifecycle: requested → provided → delivered) ─────────────────────
  // Like ask_question (PER-CARD, no single-slot thread pointer → several file requests may be open at
  // once), but the value is an UPLOAD stored as a file-valued secret + grant (never on the card / in the
  // transcript). No migration: all state lives on the card in the `messages` jsonb.

  /** Load this job's file-request card rows, newest-first — ALL of them (open, provided, or withdrawn). */
  private async fileRequestCards(jobId: string): Promise<TranscriptMessageEntity[]> {
    const rows = await this.messages.find({
      where: { job_id: jobId, kind: 'card' },
      order: { created_at: 'DESC' },
    });
    return rows.filter((m) => m.card?.type === 'file_request_card');
  }

  /**
   * Allocate the next stable file-request id for this job — `f1`, `f2`, … — over the existing file-request
   * card ids (see {@link nextFileRequestId}). Scans ALL file-request card rows (not just open) so numbering
   * survives a restart and never reuses a withdrawn/provided id. Race-safe in practice: one brain turn runs
   * at a time and its `request_file` tool calls are awaited in order, so each `openFileRequest` lands before
   * the next id is allocated.
   */
  async nextFileRequestId(jobId: string): Promise<string> {
    const cards = await this.fileRequestCards(jobId);
    return nextFileRequestId(cards.map((m) => m.ts ?? ''));
  }

  /** Post a value-free file-request card. No thread pointer + no one-at-a-time gate (multiple may be open). */
  async openFileRequest(
    jobId: string,
    input: { requestId: string; card: WebFileRequestCard },
  ): Promise<{ ok: boolean }> {
    const thread = await this.jobs.findOne({ where: { id: jobId } });
    if (!thread) return { ok: false };
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: `Requested file upload → \`${input.card.path}\``,
        kind: 'card',
        ts: input.requestId,
        card: input.card as unknown as Record<string, unknown>,
      }),
    );
    return { ok: true };
  }

  /** Fetch one thread's file-request card by id (the card's `ts`); null if absent / not a file card. */
  async getFileCard(
    jobId: string,
    requestId: string,
  ): Promise<WebFileRequestCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const card = row?.card as WebFileRequestCard | undefined;
    return card?.type === 'file_request_card' ? card : null;
  }

  /** Stamp a file card PROVIDED (the operator uploaded it → encrypted store + grant). No contents stored. */
  async markFileProvided(
    jobId: string,
    requestId: string,
    filename: string,
  ): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      provided_at: new Date().toISOString(),
      filename,
    });
  }

  /** Stamp a file card DELIVERED (the masked confirmation reached the brain in a turn that ran). */
  async markFileDelivered(jobId: string, requestId: string): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      delivered_at: new Date().toISOString(),
    });
  }

  /**
   * The thread's currently-OPEN file-request cards — posted, but not yet uploaded OR withdrawn — so a fresh
   * turn (a new operator message, an event delivery, or a restart-rebuilt session that lost its in-context
   * memory of what it requested) doesn't re-post a duplicate `request_file`. The file-card analog of
   * {@link openQuestionCards}; surfaced via {@link AgentSessionManager.buildOpenFileRequestsPrefix}.
   */
  async openFileCards(jobId: string): Promise<WebFileRequestCard[]> {
    const rows = await this.messages.find({
      where: { job_id: jobId, kind: 'card' },
      order: { created_at: 'DESC' },
    });
    return rows
      .map((m) => m.card as unknown as WebFileRequestCard)
      .filter(
        (c) =>
          c?.type === 'file_request_card' &&
          c.provided_at == null &&
          c.withdrawnAt == null,
      );
  }

  /**
   * Withdraw a still-open file-upload request ATOMICALLY and IDEMPOTENTLY — the file-card mirror of
   * {@link withdrawQuestion}: a conditional update that only fires `WHERE the request is still open` (not
   * yet uploaded, not already withdrawn), so it can't race the operator's upload — only one of upload /
   * withdraw wins. The winner stamps `withdrawnAt` (+ optional `withdrawnReason`). Unlike questions there is
   * NO counter to decrement (file requests are per-card, ungated). Returns `{ withdrawn:true }` for the
   * winner, `{ withdrawn:false }` when the card is missing, already provided, or already withdrawn.
   */
  async withdrawFileRequest(
    jobId: string,
    requestId: string,
    reason?: string,
  ): Promise<{ withdrawn: boolean }> {
    const patch = JSON.stringify({
      withdrawnAt: new Date().toISOString(),
      ...(reason ? { withdrawnReason: reason } : {}),
    });
    const res = await this.messages
      .createQueryBuilder()
      .update(TranscriptMessageEntity)
      .set({ card: () => 'card || :patch::jsonb' })
      .where('job_id = :jobId', { jobId })
      .andWhere('ts = :requestId', { requestId })
      .andWhere("kind = 'card'")
      .andWhere("card ->> 'type' = 'file_request_card'")
      .andWhere("card ->> 'provided_at' IS NULL")
      .andWhere("card ->> 'withdrawnAt' IS NULL")
      .setParameter('patch', patch)
      .execute();
    return { withdrawn: (res.affected ?? 0) === 1 };
  }

  /**
   * Boot reconciliation: file cards the operator PROVIDED (contents stored + granted) but whose masked
   * confirmation never reached the brain (`delivered_at` null) because the host died mid-delivery. The
   * startup sweep re-delivers each (at-least-once). Contents are not returned (never stored on the card).
   */
  async findUndeliveredProvidedFiles(): Promise<
    {
      jobId: string;
      orgId: string;
      repoId: string;
      requestId: string;
      path: string;
    }[]
  > {
    const messagesTable = this.messages.metadata.tablePath;
    const threadsTable = this.jobs.metadata.tablePath;
    const rows = await this.dataSource.query(
      `SELECT m.job_id AS "jobId", t.org_id AS "orgId", t.repo_id AS "repoId",
              m.ts AS "requestId", m.card ->> 'path' AS "path"
         FROM ${messagesTable} m
         JOIN ${threadsTable} t ON t.id = m.job_id
        WHERE m.kind = 'card'
          AND m.card ->> 'type' = 'file_request_card'
          AND m.card ->> 'provided_at' IS NOT NULL
          AND m.card ->> 'delivered_at' IS NULL`,
    );
    return rows;
  }

  // ── MCP-proposal gate (propose_mcp_servers lifecycle: proposed → approved) ───────────────────────────
  // Like the file-request gate: PER-CARD (no thread pointer — a proposal is a one-shot recommendation the
  // OWNER approves at the owner-gated endpoint). The card carries only the NON-secret definitions; secret
  // header/env VALUES are collected separately via the `request_secret` MCP target after approval. The
  // actual `McpServerStore.write` happens ONLY at the owner-gated approve endpoint, never here.

  /** Post a value-free MCP-proposal card. No thread pointer + no one-at-a-time gate (like file requests). */
  async openMcpProposal(
    jobId: string,
    input: { requestId: string; card: WebMcpProposalCard },
  ): Promise<{ ok: boolean }> {
    const thread = await this.jobs.findOne({ where: { id: jobId } });
    if (!thread) return { ok: false };
    const text =
      input.card.mode === 'remove'
        ? `Proposed removing MCP server(s): ${(input.card.removeNames ?? [])
            .map((n) => `\`${n}\``)
            .join(', ')}`
        : `Proposed ${input.card.servers.length} MCP server(s): ${input.card.servers
            .map((s) => `\`${s.name}\``)
            .join(', ')}`;
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text,
        kind: 'card',
        ts: input.requestId,
        card: input.card as unknown as Record<string, unknown>,
      }),
    );
    return { ok: true };
  }

  /** Fetch one thread's MCP-proposal card by id (the card's `ts`); null if absent / not a proposal card. */
  async getMcpProposalCard(
    jobId: string,
    requestId: string,
  ): Promise<WebMcpProposalCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const card = row?.card as WebMcpProposalCard | undefined;
    return card?.type === 'mcp_proposal_card' ? card : null;
  }

  /** Stamp an MCP-proposal card APPROVED (the owner committed the servers). Records the committed names. */
  async markMcpProposalApproved(
    jobId: string,
    requestId: string,
    committed: string[],
  ): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      approved_at: new Date().toISOString(),
      committed,
    });
  }

  // ── convention-profile proposals (owner-gated house-style attach; mirrors the MCP-proposal flow) ─────

  /** Post an owner-approvable house-style-profile proposal card (no thread pointer, like MCP proposals). */
  async openConventionProposal(
    jobId: string,
    input: { requestId: string; card: WebConventionProposalCard },
  ): Promise<{ ok: boolean }> {
    const thread = await this.jobs.findOne({ where: { id: jobId } });
    if (!thread) return { ok: false };
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: `Proposed the "${input.card.profileName}" house-style profile for this repo`,
        kind: 'card',
        ts: input.requestId,
        card: input.card as unknown as Record<string, unknown>,
      }),
    );
    return { ok: true };
  }

  /** Fetch one thread's convention-proposal card by id (the card's `ts`); null if absent / wrong type. */
  async getConventionProposalCard(
    jobId: string,
    requestId: string,
  ): Promise<WebConventionProposalCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const card = row?.card as WebConventionProposalCard | undefined;
    return card?.type === 'convention_proposal_card' ? card : null;
  }

  /** Stamp a convention-proposal card APPROVED (the owner attached the profile). */
  async markConventionProposalApproved(
    jobId: string,
    requestId: string,
  ): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      approved_at: new Date().toISOString(),
    });
  }

  // ── convention-profile EDIT proposals (owner-gated house-style CHANGE from a build) ─────────────────

  /** Post an owner-approvable house-style CHANGE card (create/edit a profile's content). */
  async openConventionEditProposal(
    jobId: string,
    input: { requestId: string; card: WebConventionEditProposalCard },
  ): Promise<{ ok: boolean }> {
    const thread = await this.jobs.findOne({ where: { id: jobId } });
    if (!thread) return { ok: false };
    const verb =
      input.card.mode === 'create'
        ? 'Proposed a new'
        : 'Proposed changes to the';
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: `${verb} "${input.card.name}" house-style profile`,
        kind: 'card',
        ts: input.requestId,
        card: input.card as unknown as Record<string, unknown>,
      }),
    );
    return { ok: true };
  }

  /** Fetch one thread's convention-EDIT-proposal card by id (the card's `ts`); null if absent / wrong type. */
  async getConventionEditProposalCard(
    jobId: string,
    requestId: string,
  ): Promise<WebConventionEditProposalCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const card = row?.card as WebConventionEditProposalCard | undefined;
    return card?.type === 'convention_edit_proposal_card' ? card : null;
  }

  /** Stamp a convention-EDIT-proposal card APPROVED (the owner upserted the profile). */
  async markConventionEditProposalApproved(
    jobId: string,
    requestId: string,
  ): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      approved_at: new Date().toISOString(),
    });
  }

  // ── skill proposals (owner-gated `propose_skill`; writes a reusable SKILL.md) ────────────────────────

  /** Post an owner-approvable SKILL card (create/edit a skill's content). */
  async openSkillProposal(
    jobId: string,
    input: { requestId: string; card: WebSkillProposalCard },
  ): Promise<{ ok: boolean }> {
    const thread = await this.jobs.findOne({ where: { id: jobId } });
    if (!thread) return { ok: false };
    const verb =
      input.card.mode === 'create'
        ? 'Proposed a new'
        : input.card.mode === 'remove'
          ? 'Proposed removing the'
          : 'Proposed changes to the';
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: `${verb} "${input.card.name}" skill`,
        kind: 'card',
        ts: input.requestId,
        card: input.card as unknown as Record<string, unknown>,
      }),
    );
    return { ok: true };
  }

  /** Fetch one thread's skill-proposal card by id (the card's `ts`); null if absent / wrong type. */
  async getSkillProposalCard(
    jobId: string,
    requestId: string,
  ): Promise<WebSkillProposalCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const card = row?.card as WebSkillProposalCard | undefined;
    return card?.type === 'skill_proposal_card' ? card : null;
  }

  /** Stamp a skill-proposal card APPROVED (the owner wrote the skill). */
  async markSkillProposalApproved(
    jobId: string,
    requestId: string,
  ): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      approved_at: new Date().toISOString(),
    });
  }

  // ── skill edit-access requests (owner-gated `request_skill_edit_access`; grants live Edit/Write) ──────

  /** Post an owner-approvable skill EDIT-ACCESS card. PER-CARD (like `request_file`) — several may be
   *  open at once, no single-slot pointer. */
  async openSkillEditAccessRequest(
    jobId: string,
    input: { requestId: string; card: WebSkillEditAccessCard },
  ): Promise<{ ok: boolean }> {
    const thread = await this.jobs.findOne({ where: { id: jobId } });
    if (!thread) return { ok: false };
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: `Requested edit access to the "${input.card.name}" skill`,
        kind: 'card',
        ts: input.requestId,
        card: input.card as unknown as Record<string, unknown>,
      }),
    );
    return { ok: true };
  }

  /** Fetch one thread's skill-edit-access card by id (the card's `ts`); null if absent / wrong type. */
  async getSkillEditAccessCard(
    jobId: string,
    requestId: string,
  ): Promise<WebSkillEditAccessCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const card = row?.card as WebSkillEditAccessCard | undefined;
    return card?.type === 'skill_edit_access_card' ? card : null;
  }

  /** Stamp a skill-edit-access card APPROVED — `forkedTo` set only when the underlying skill was forked
   *  to a custom copy (the grant target, distinct from the card's original `name`). */
  async markSkillEditAccessApproved(
    jobId: string,
    requestId: string,
    forkedTo?: string,
  ): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      approved_at: new Date().toISOString(),
      ...(forkedTo ? { forkedTo } : {}),
    });
  }

  // ── pending decisions (the grilling working set; snapshotted into a record by submit_plan) ──────────

  /** Read a thread's working-set decisions logged so far (the `pending_decisions` jsonb). */
  async pendingDecisions(jobId: string): Promise<Decision[]> {
    const row = await this.jobs.findOne({ where: { id: jobId } });
    return row?.pending_decisions ?? [];
  }

  /**
   * CREATE a decision in the thread's `pending_decisions` working set. Assigns a stable id
   * ({@link nextDecisionId}) and appends — decisions are id-addressed, so two may share a class/title
   * (e.g. several `cross_cutting` rulings). Returns the resolved decision AND the full updated array
   * (the caller re-renders `decision-record.md` from `all`). (The proposal record is created later, by
   * `submit_plan` → `persistPlan`.)
   */
  async createDecision(
    jobId: string,
    input: Omit<Decision, 'id'>,
  ): Promise<{ decision: Decision; all: Decision[] }> {
    const row = await this.jobs.findOneOrFail({ where: { id: jobId } });
    const current = row.pending_decisions ?? [];
    const decision: Decision = { ...input, id: nextDecisionId(current) };
    const all = [...current, decision];
    await this.jobs.update({ id: jobId }, { pending_decisions: all });
    return { decision, all };
  }

  /**
   * UPDATE a decision by id (revise its ruling/title/class). Returns the updated decision + the full
   * array, or `null` if no decision with that id exists (the caller surfaces `knownIds`).
   */
  async updateDecision(
    jobId: string,
    id: string,
    patch: Partial<
      Pick<
        Decision,
        'ruling' | 'title' | 'decisionClass' | 'confirmedByOperator'
      >
    >,
  ): Promise<{ decision: Decision; all: Decision[] } | null> {
    const row = await this.jobs.findOneOrFail({ where: { id: jobId } });
    const current = row.pending_decisions ?? [];
    const idx = current.findIndex((d) => d.id === id);
    if (idx < 0) return null;
    const decision: Decision = { ...current[idx], ...patch };
    const all = current.map((d, i) => (i === idx ? decision : d));
    await this.jobs.update({ id: jobId }, { pending_decisions: all });
    return { decision, all };
  }

  /**
   * DELETE a decision by id. Returns whether a row was removed + the full remaining array (the caller
   * re-renders from `all`). `removed:false` when the id is unknown.
   */
  async deleteDecision(
    jobId: string,
    id: string,
  ): Promise<{ removed: boolean; all: Decision[] }> {
    const row = await this.jobs.findOneOrFail({ where: { id: jobId } });
    const current = row.pending_decisions ?? [];
    const all = current.filter((d) => d.id !== id);
    if (all.length === current.length) return { removed: false, all };
    await this.jobs.update({ id: jobId }, { pending_decisions: all });
    return { removed: true, all };
  }

  /**
   * Set the job's `activity` axis (see {@link JobActivity} / `deriveNeedsYou`). Best-effort — a write
   * failure here must never break the turn itself (the caller swallows errors).
   */
  async setActivity(jobId: string, activity: JobActivity): Promise<void> {
    await this.jobs.update({ id: jobId }, { activity });
  }

  /**
   * A conversational turn is ending: settle `activity` to `idle` UNLESS a Codex plan review is still
   * running for this job (a `review_plan` review can OUTLIVE the turn it nested inside — the durable
   * `plan_review` thread is the source of truth, its `config.status` folded off the retired `codex_reviews`
   * row), in which case it stays `plan_review` so the dot stays suppressed until the review itself
   * finalizes. Best-effort — the caller swallows errors.
   */
  async endTurnActivity(jobId: string): Promise<void> {
    const reviewing = await this.threads
      .createQueryBuilder('t')
      .where('t.job_id = :jobId', { jobId })
      .andWhere("t.role = 'plan_review'")
      .andWhere("t.config ->> 'status' = 'running'")
      .getExists();
    // A pending host-backstop retry park keeps the indicator alive: settling to `idle` here would flip
    // `deriveNeedsYou` true and hide the live "Reconnecting…" countdown during the 10s backoff wait. Settle
    // to `retrying` instead so the dot stays mounted until the re-drive sets `activity:'turn'` (or the budget
    // is spent and `setHalted` surfaces the box). A running plan review still wins (its own carve-out).
    const job = reviewing
      ? null
      : await this.jobs.findOne({
          where: { id: jobId },
          select: { id: true, session_resume: true },
        });
    const retrying = job?.session_resume?.kind === 'retry';
    await this.jobs.update(
      { id: jobId },
      { activity: reviewing ? 'plan_review' : retrying ? 'retrying' : 'idle' },
    );
  }

  /**
   * Mark whether an unresolved turn-failure operator box is outstanding for this thread — the durable
   * `halted` axis of the "needs you" signal (see `deriveNeedsYou`). Set when `saySystemOperator` posts a
   * turn-failure box, cleared when the next turn starts. A halt means the system STOPPED, so setting it
   * also clears `activity` to `idle` (a stale `turn`/`build` must not mask the halt); clearing it (a fresh
   * turn is starting) leaves `activity` untouched — the caller sets it to `turn`. Best-effort — a write
   * failure must never break the turn (the caller swallows errors). NOT reset on boot (unlike `activity`).
   */
  async setHalted(jobId: string, halted: boolean): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      halted ? { halted: true, activity: 'idle' } : { halted: false },
    );
  }

  /**
   * Set (or clear) the durable auto-resume clock the Main lane parks on when it hits a Claude session/usage
   * limit. `resumeAt=null` (with `meta=null`) clears the clock so the leader sweep never re-fires — called on
   * the force-resume path (`/retry-turn`). See {@link JobEntity.session_resume_at}.
   */
  async setSessionResume(
    jobId: string,
    resumeAt: string | null,
    meta: JobEntity['session_resume'],
  ): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      {
        session_resume_at: resumeAt ? new Date(resumeAt) : null,
        session_resume: meta,
      },
    );
  }

  /** Clear only a host-backstop retry park for this lane; leave session-limit parks untouched. */
  async clearRetrySessionResume(
    jobId: string,
    lane: 'main' | 'build',
  ): Promise<void> {
    await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({ session_resume_at: null, session_resume: null })
      .where('id = :jobId', { jobId })
      .andWhere("session_resume->>'kind' = 'retry'")
      .andWhere("session_resume->>'lane' = :lane", { lane })
      .execute();
  }

  /** CAS-claim one benign-abort auto-resume attempt: atomically increment `benign_abort_redrives` iff still
   *  below `cap`, stamping `retry_last_attempt_at`. Returns `{ok:true, used}` on success, else `{ok:false,
   *  used:cap}` (budget exhausted). Durable so a restart/crash-loop can't re-grant a fresh budget. */
  async claimBenignAbortRedrive(jobId: string, cap: number): Promise<{ ok: boolean; used: number }> {
    const res = await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({ benign_abort_redrives: () => 'benign_abort_redrives + 1', retry_last_attempt_at: () => 'now()' })
      .where('id = :jobId', { jobId })
      .andWhere('benign_abort_redrives < :cap', { cap })
      .returning('benign_abort_redrives')
      .execute();
    const used = res.raw?.[0]?.benign_abort_redrives as number | undefined;
    return used != null ? { ok: true, used } : { ok: false, used: cap };
  }

  /** CAS-claim one host-transport transient-error auto-retry attempt (brain lane). Same shape as
   *  {@link claimBenignAbortRedrive} against `transient_retry_redrives`. */
  async claimTransientRetryRedrive(jobId: string, cap: number): Promise<{ ok: boolean; used: number }> {
    const res = await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({ transient_retry_redrives: () => 'transient_retry_redrives + 1', retry_last_attempt_at: () => 'now()' })
      .where('id = :jobId', { jobId })
      .andWhere('transient_retry_redrives < :cap', { cap })
      .returning('transient_retry_redrives')
      .execute();
    const used = res.raw?.[0]?.transient_retry_redrives as number | undefined;
    return used != null ? { ok: true, used } : { ok: false, used: cap };
  }

  /** CAS-claim one consecutive UNCORROBORATED text-fallback session-limit misfire for the job; refuses at
   *  `cap`. Same shape as {@link claimTransientRetryRedrive}. */
  async claimSessionLimitTextMisfire(jobId: string, cap: number): Promise<{ ok: boolean; used: number }> {
    const res = await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({ session_limit_text_misfires: () => 'session_limit_text_misfires + 1' })
      .where('id = :jobId', { jobId })
      .andWhere('session_limit_text_misfires < :cap', { cap })
      .returning('session_limit_text_misfires')
      .execute();
    const used = res.raw?.[0]?.session_limit_text_misfires as number | undefined;
    return used != null ? { ok: true, used } : { ok: false, used: cap };
  }

  /** Reset the brain's SESSION-scoped retry budgets to 0 on a clean turn (unlike the LIFETIME
   *  `halt_fix_attempts`, these reset every clean turn). Does NOT touch `retry_last_attempt_at` (an
   *  age-only cooldown backstop, never reset) nor the driver's own lane columns. */
  async clearBrainRetryCounters(jobId: string): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      {
        benign_abort_redrives: 0,
        transient_retry_redrives: 0,
        session_limit_text_misfires: 0,
      },
    );
  }

  /**
   * Persist the ADR-0005 live-verification verdict for this job's DIRECT-BUILD ship (the brain's
   * `finalize_build` gate). Written on BOTH the pass and the refusal path so direct-build verdicts are
   * queryable (`jobs.direct_build_verification`) — the observability hook the prod audit needs. Overwrites
   * on retry (the last `finalize_build` attempt wins). Best-effort — a write failure must never break the
   * ship turn (the caller decides how to handle it).
   */
  async recordDirectBuildVerification(
    jobId: string,
    payload: JobEntity['direct_build_verification'],
  ): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      { direct_build_verification: payload },
    );
  }

  /**
   * Stamp the durable "the direct build has STARTED" marker (`jobs.direct_build_started_at`) at the instant
   * `dispatch_build` fires `runDirectBuild`. This is what closes the pre-start base-check window for the
   * DIRECT path in {@link buildNotStarted} — it flips at the START of the implement turn, unlike
   * `direct_build_verification` which is only written at the END (`finalize_build`). Idempotent: a re-fired
   * `dispatch_build` re-stamps harmlessly. Best-effort — the caller owns error handling.
   */
  async markDirectBuildStarted(jobId: string): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      { direct_build_started_at: new Date() },
    );
  }

  /**
   * The threads whose `activity` is still `turn` — i.e. a conversational turn was streaming when the
   * process died. Captured on boot BEFORE {@link resetAllActivity} clears the flags, so crash recovery
   * knows which threads have a possibly-orphaned engine still finishing in the container (to watch them to
   * completion). Returns thread ids.
   */
  async threadsWithActiveTurn(): Promise<string[]> {
    const rows = await this.jobs.find({
      where: { activity: 'turn' },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Boot reconciliation: no in-flight system work can survive a process restart, so reset any non-`idle`
   * `activity` left set by a crash — otherwise the thread would read as "working" forever and never show
   * the "needs you" dot. Returns the number of rows reset.
   */
  async resetAllActivity(): Promise<number> {
    const res = await this.jobs.update(
      { activity: Not('idle') },
      { activity: 'idle' },
    );
    return res.affected ?? 0;
  }

  /** Resolve where to post into a thread: the repo coordinate + the real thread id. The web/agent
   *  surface keys its conversation by these directly — no channel/surface-ref indirection. */
  async route(thread: {
    orgId: string;
    repoId: string;
    jobId: string;
  }): Promise<ThreadRoute> {
    return { channel: thread.repoId, threadTs: thread.jobId };
  }

  /**
   * If this thread is already being SHAPED — `status='planning'` (upfront grill) OR `status='amending'`
   * (post-ship-retract) — return its id, so a multi-turn grill/amendment continues ONE build rather than
   * re-anchoring per message. Null otherwise.
   */
  async openJobOnThread(jobId: string): Promise<string | null> {
    const row = await this.jobs.findOne({
      where: { id: jobId, status: In(['planning', 'amending']) },
    });
    return row?.id ?? null;
  }

  /** The job's current kind (null until scoped, or if the operator picked one at creation). */
  async jobKind(jobId: string): Promise<JobKind | null> {
    const row = await this.jobs.findOne({
      where: { id: jobId },
      select: { id: true, kind: true },
    });
    return (row?.kind as JobKind | null | undefined) ?? null;
  }

  /** The job's short title (used to give a bare "continue" nudge some task context). */
  async jobTitle(jobId: string): Promise<string | null> {
    const row = await this.jobs.findOne({
      where: { id: jobId },
      select: { id: true, title: true },
    });
    return row?.title ?? null;
  }

  /** Set the job's kind (the brain's `set_job_kind` tool). The next brain turn's system prompt reflects it. */
  async setJobKind(jobId: string, kind: JobKind): Promise<void> {
    await this.jobs.update({ id: jobId }, { kind });
  }

  /**
   * Anchor the upfront grill: flip the thread into the build lifecycle (`planning`) + set intent/kind.
   * The `title` is OPTIONAL: an empty/absent title leaves the thread's existing title untouched rather
   * than clobbering it (e.g. `review_plan` anchors the job without a meaningful title — the authoritative
   * rename happens later in `persistPlan` from the plan `goal`, via the titler).
   */
  async openJob(input: {
    orgId: string;
    repoId: string;
    jobId: string;
    title?: string | null;
    kind: JobKind;
  }): Promise<string> {
    const title = input.title?.trim();
    await this.jobs.update(
      { id: input.jobId },
      { kind: input.kind, status: 'planning', ...(title ? { title } : {}) },
    );
    return input.jobId;
  }

  /**
   * Persist a LOCKED plan: the decision record (draft) + the thread rows + flip the thread to
   * `awaiting_approval`. Writes the high-level thread BRIEFS (titles); the full plan (plan.md,
   * decisions, diagrams) lives in the thread's `/context/specs` folder, which the build sessions read.
   * Returns the thread (domain shape) + the decision record id.
   */
  async persistPlan(input: {
    orgId: string;
    repoId: string;
    jobId: string;
    title: string;
    kind: JobKind;
    overview: string;
    decisions: Decision[];
    threadTitles: string[];
    /**
     * OPTIONAL — the scope type per thread (backend/frontend/…), aligned by thread index. Selects the
     * review agents. Defaults to `'general'` per thread when absent (the autonomous bugfix / direct-build
     * callers pass no types) — matches the DB column default.
     */
    threadTypes?: string[];
    /**
     * OPTIONAL — the steps Atlas authored up front for each thread, aligned by thread index
     * (`stepsByThread[i]` = steps for `threadTitles[i]`). When present, the step rows are LOCKED
     * here so the driver finds them already present and skips its just-in-time plan turn; `thread.plan`
     * is set from them so the pipeline view shows the plan. ABSENT (direct-build / bugfix dispatch) →
     * no step rows created, exactly as before — the driver JIT-plans those threads.
     */
    stepsByThread?: PlannedStep[][];
    /**
     * OPTIONAL — the thread status to flip to once the plan is persisted. Decouples plan PERSISTENCE
     * from approval-readiness: the full path now persists with `'plan_review'` (Codex reviews before the
     * operator is asked), while direct-build keeps the default `'awaiting_approval'` (its lightweight card
     * is posted immediately). `finalize_plan` is what later flips a reviewed plan to `awaiting_approval`.
     */
    status?: JobStatus;
    /**
     * OPTIONAL — whether to (re)title the job from `input.title`. Defaults to `true` so every existing
     * caller (direct-build / bugfix dispatch / re-propose) keeps renaming exactly as before. `propose_plan`
     * passes the brain's explicit choice: `false` means "the plan didn't change direction — keep the
     * current sidebar label". A job that has NO title yet is always titled regardless (a fresh job needs a
     * label).
     */
    rename?: boolean;
  }): Promise<PersistedPlan> {
    // Route the incoming title (the plan `goal` / build summary) through the shared titler so the thread's
    // sidebar label is a short, scannable title — NOT the raw full-sentence goal. Done before the
    // transaction (one network call, fail-soft to a trimmed first line) so the txn stays fast. Skip the
    // rename when the caller opted out AND the job already has a title — then we keep the existing label.
    const existingTitle = (await this.jobTitle(input.jobId))?.trim() || null;
    const title =
      (input.rename ?? true) || !existingTitle
        ? await this.titler.titleFor(input.title, input.orgId)
        : existingTitle;

    // The job's ONE planning thread group + thread exists from bootstrap (create-if-absent) — cards posted during
    // planning anchor to it, and it is NOT (re)created here. Idempotent; its own find-or-create, so it runs
    // outside the plan transaction.
    await this.ensurePlanningThreadGroup(input.jobId, input.orgId);

    // The whole persist runs in ONE transaction: clear the current revision's build pipeline thread groups (their
    // threads cascade), supersede the prior draft record, write the new record + `build`/`master_review`
    // thread groups (each owning its threads), and flip the job status — so a crash mid-write can never leave a
    // half-proposed plan. A re-propose (request_changes → reopenPlanning → propose again) reuses the SAME
    // job, so the prior DRAFT revision's build thread groups are cleared first; idempotent on the first proposal.
    const decisionRecordId = await this.dataSource.transaction(async (m) => {
      const jobs = m.getRepository(JobEntity);
      const records = m.getRepository(DecisionRecordEntity);
      const threads = m.getRepository(ThreadEntity);
      const threadGroups = m.getRepository(ThreadGroupEntity);

      // PLAN VERSIONING — decide whether this re-propose forms a NEW immutable revision or overwrites the
      // current (never-built) one. The rule is unchanged: a revision becomes browsable history ONLY if it
      // has at least one `done` builder. Plan-revision scoping moved off the thread onto its THREAD GROUP (d7), so
      // a `done` builder is now found under a build thread group carrying the prior revision's `decision_record_id`.
      const currentJob = await jobs.findOne({ where: { id: input.jobId } });
      const priorRecordId = currentJob?.decision_record_id ?? null;
      const priorHasDone = priorRecordId
        ? await threads
            .createQueryBuilder('t')
            .innerJoin(ThreadGroupEntity, 's', 's.id = t.thread_group_id')
            .where('t.job_id = :jobId', { jobId: input.jobId })
            .andWhere('s.decision_record_id = :priorRecordId', {
              priorRecordId,
            })
            .andWhere("t.role = 'builder'")
            .andWhere("t.status = 'done'")
            .getExists()
        : false;

      if (!priorHasDone) {
        // Common case: no completed work to preserve. Clear the current revision's build pipeline THREAD GROUPS —
        // their threads cascade via `fk_threads_thread_group_id_thread_groups ON DELETE CASCADE` — so the fresh thread groups
        // append cleanly. Mirrors the old thread-level `In(['builder','master_review'])` delete at the thread group
        // level; the `planning`/`plan_review` singletons survive (only build-lifecycle kinds are cut).
        await threadGroups.delete({
          job_id: input.jobId,
          kind: In(['build', 'direct_build', 'master_review']),
        });
      }
      // else (priorHasDone): DELETE NOTHING. The prior revision's thread groups/threads keep their
      // `decision_record_id` and become immutable history the moment `jobs.decision_record_id` is repointed
      // at the new record below (`threadsForJob` scopes to the active revision, so history is never re-driven).

      await records.update(
        { job_id: input.jobId, status: 'draft' },
        { status: 'superseded' },
      );

      const record = await records.save(
        records.create({
          org_id: input.orgId,
          repo_id: input.repoId,
          job_id: input.jobId,
          status: 'draft',
          overview: input.overview,
          decisions: input.decisions,
          thread_titles: input.threadTitles,
          approved_by: null,
          approved_at: null,
        }),
      );

      // Build path only (`threadTitles.length > 0`; direct build passes `[]` and onboarding/event never
      // persist a plan). One `build` THREAD GROUP per plan section — each owning its FIRST builder thread carrying
      // the authored plan — then ONE `master_review` thread group after them. Direct build gets its own
      // `direct_build` thread group at dispatch time (a separate seam), so persistPlan skips thread group creation for it.
      if (input.threadTitles.length > 0) {
        let threadGroupOrdinal =
          (await maxOrdinal(threadGroups, input.jobId)) + ORDINAL_GAP;
        // Top-level threads (parent null) share a job-wide UNIQUE(job_id, parent_thread_id, ordinal) index
        // (d7 dropped decision_record_id from it), so their ordinals must be job-GLOBAL-unique — not
        // thread-group-local. Start after the highest existing top-level ordinal (planning/plan_review, and any
        // preserved prior-revision history) and gap-number from there.
        let threadOrdinal =
          (await maxOrdinal(
            threads,
            input.jobId,
            't.parent_thread_id IS NULL',
          )) + ORDINAL_GAP;

        for (let i = 0; i < input.threadTitles.length; i++) {
          const brief = input.threadTitles[i];
          const authored = input.stepsByThread?.[i];
          const threadGroup = await threadGroups.save(
            threadGroups.create({
              job_id: input.jobId,
              org_id: input.orgId,
              ordinal: threadGroupOrdinal,
              kind: 'build',
              // The slice name labels the thread group (titleRequired:true); its review-selection type moves here.
              title: brief,
              type: input.threadTypes?.[i] ?? null,
              decision_record_id: record.id,
              config: {},
            }),
          );
          threadGroupOrdinal += ORDINAL_GAP;
          await threads.save(
            threads.create({
              thread_group_id: threadGroup.id,
              job_id: input.jobId,
              org_id: input.orgId,
              role: 'builder',
              ordinal: threadOrdinal,
              brief,
              // Scope type selects the review agents; default 'general' for arg-less callers (bugfix/direct).
              type: coerceThreadType(input.threadTypes?.[i]),
              // A thread's single step IS its own row (steps are retired): setting `plan` here LOCKS it, so
              // the driver finds it already planned and skips its just-in-time plan turn.
              plan: authored?.length ? renderPlan(authored) : null,
              handoff_in: null,
              handoff_out: null,
              status: 'pending',
            }),
          );
          threadOrdinal += ORDINAL_GAP;
        }

        // The ONE whole-diff master review — a Codex execute thread group that reviews AND fixes the merged diff,
        // running LAST (before ship/PR). No title (titleRequired:false); the driver plans its single turn.
        const masterThreadGroup = await threadGroups.save(
          threadGroups.create({
            job_id: input.jobId,
            org_id: input.orgId,
            ordinal: threadGroupOrdinal,
            kind: 'master_review',
            title: null,
            type: null,
            decision_record_id: record.id,
            config: {},
          }),
        );
        await threads.save(
          threads.create({
            thread_group_id: masterThreadGroup.id,
            job_id: input.jobId,
            org_id: input.orgId,
            role: 'master_review',
            ordinal: threadOrdinal,
            brief: 'Master review — whole-diff review & fix',
            type: 'general',
            plan: null,
            handoff_in: null,
            handoff_out: null,
            status: 'pending',
          }),
        );
      }

      await jobs.update(
        { id: input.jobId },
        {
          kind: input.kind,
          title,
          status: input.status ?? 'awaiting_approval',
          decision_record_id: record.id,
        },
      );

      return record.id;
    });

    const thread = await this.loadJob(input.jobId);
    return { thread, decisionRecordId };
  }

  /**
   * Ensure the job's ONE `planning` thread group + `planning`-role thread exist (idempotent create-if-absent).
   * Every job owns exactly one planning thread group from bootstrap (d7): the brain's conversation session IS this
   * thread's session, and it anchors the job-level card messages (question/ship/amend/merge) that have no
   * build-lane thread of their own (see {@link DriverStoreService.planningThreadId}). Safe to call
   * repeatedly — a second call with the thread group already present is a no-op. Thin delegate over
   * `JobBootstrapService` (the shared owner of this logic — see its module doc) so `persistPlan` and
   * `createFollowUpJob` keep calling it as `this.ensurePlanningThreadGroup(...)`; every OTHER job-creation seam
   * calls `JobBootstrapService` directly (a `BrainModule` import would cycle back through `StimulusModule`).
   */
  async ensurePlanningThreadGroup(jobId: string, orgId: string): Promise<void> {
    await this.jobBootstrap?.ensurePlanningThreadGroup(jobId, orgId);
  }

  /** Load a draft/approved decision record (overview + decisions + thread titles) for the approval card. */
  async loadDecisionRecord(decisionRecordId: string): Promise<{
    overview: string;
    decisions: Decision[];
    threadTitles: string[];
  } | null> {
    const row = await this.records.findOne({ where: { id: decisionRecordId } });
    if (!row) return null;
    return {
      overview: row.overview,
      decisions: row.decisions ?? [],
      threadTitles: row.thread_titles ?? [],
    };
  }

  /**
   * Approve a decision record ATOMICALLY: a single guarded UPDATE requires the job to still be
   * `awaiting_approval` AND still pointing at the CLICKED record (the version pin), so a withdrawn,
   * re-proposed (superseded), or already-approved job fails the guard — returns `null` rather than
   * approving the wrong plan. On success, stamps the record `approved` and flips the job to `running`
   * in the same transaction.
   */
  async approve(
    jobId: string,
    clickedDecisionRecordId: string,
    approvedBy: string,
    buildPath: 'direct' | 'plan',
  ): Promise<Job | null> {
    return this.dataSource.transaction(async (m) => {
      const now = new Date();
      // A freshly approved plan is an explicit operator action that supersedes any stale halt, so the
      // dispatch that follows isn't refused by the halt-invariant guard (halt is cleared here, at the
      // operator transition, never inside dispatch()). `build_path` is committed in the SAME update so a
      // requested-but-unapproved direct build (still `awaiting_approval`, convertible to a plan) never
      // carries a committed path — only an approval stamps it.
      const jobRes = await m.getRepository(JobEntity).update(
        {
          id: jobId,
          status: 'awaiting_approval',
          decision_record_id: clickedDecisionRecordId,
        },
        { status: 'running', halt: null, build_path: buildPath },
      );
      if ((jobRes.affected ?? 0) !== 1) return null;
      await m
        .getRepository(DecisionRecordEntity)
        .update(
          { id: clickedDecisionRecordId },
          { status: 'approved', approved_by: approvedBy, approved_at: now },
        );
      // Read the flipped row through the TRANSACTION manager (not this.loadJob, which reads on a
      // separate pooled connection and can't see the uncommitted 'running' write) so the returned Job
      // reflects the just-committed status.
      const row = await m
        .getRepository(JobEntity)
        .findOneOrFail({ where: { id: jobId } });
      return toThread(row);
    });
  }

  /**
   * Retract a pending proposal ATOMICALLY: flip awaiting_approval → planning and supersede the draft
   * decision record, but ONLY while the job is still awaiting approval (so it can't race the operator's
   * approve click — exactly one of {withdraw, approve} wins). Returns { withdrawn:false } when there is
   * no pending proposal (job not awaiting_approval).
   */
  async withdrawPlan(
    jobId: string,
    reason?: string,
  ): Promise<{ withdrawn: boolean }> {
    return this.dataSource.transaction(async (m) => {
      const res = await m
        .getRepository(JobEntity)
        .update(
          { id: jobId, status: 'awaiting_approval' },
          { status: 'planning' },
        );
      if ((res.affected ?? 0) !== 1) return { withdrawn: false };
      await m
        .getRepository(DecisionRecordEntity)
        .update({ job_id: jobId, status: 'draft' }, { status: 'superseded' });
      return { withdrawn: true };
    });
  }

  /** Flip a thread back to `planning` (a rejected / change-requested plan returns to the grill). */
  async reopenPlanning(jobId: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { status: 'planning' });
  }

  /**
   * The DURABLE "the approved build has NOT started yet" predicate for the pre-start base-check window
   * (post plan-approval, pre `dispatch_build`). Computed from EXISTING rows — no schema change. Gate
   * `hold_build` (and any restart-recovery awareness) on THIS, never on `activity`: the base-check seed is
   * delivered on the normal brain-turn path, which sets `activity='turn'` for the duration of the turn, so
   * by the time Atlas calls a tool the activity is already `'turn'`, never `'base_check'`.
   *
   * DIRECT path: gated on {@link JobEntity.direct_build_started_at}, stamped when `dispatch_build` fires
   * `runDirectBuild`. NOT on `direct_build_verification` — that is written only at the `finalize_build` gate
   * (the END of the implement turn), so it would keep this predicate `true` for the entire minutes-long
   * implementation, letting `hold_build` reopen planning underneath a live turn.
   */
  async buildNotStarted(jobId: string): Promise<boolean> {
    const row = await this.jobs.findOne({ where: { id: jobId } });
    if (!row) return false;
    if (row.build_path === 'direct') {
      return row.direct_build_started_at == null;
    }
    const threads = await this.threads.find({ where: { job_id: jobId } });
    return threads
      .filter(
        (t) => t.parent_thread_id == null && isDriverExecutableKind(t.role),
      )
      .every((t) => t.status === 'pending');
  }

  /** Cancel a thread's build (a denied plan). */
  async cancel(jobId: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { status: 'cancelled' });
    await this.jobDeps
      .onBlockerResolved(jobId, 'cancelled')
      .catch((err) =>
        this.logger.warn(
          `cancel: wake funnel failed for blocker ${jobId}: ${err}`,
        ),
      );
  }

  /** Load a thread row as the domain `Thread` shape. */
  async loadJob(jobId: string): Promise<Job> {
    const row = await this.jobs.findOneOrFail({ where: { id: jobId } });
    return toThread(row);
  }

  // ── create_job tool ───────────────────────────────────────────────────────────────────────────

  /**
   * Create a follow-up thread (the brain's `create_job` tool) — a plain `open` thread on the repo that
   * provisions its sandbox lazily on the first turn.
   */
  async createFollowUpJob(input: {
    orgId: string;
    repoId: string;
    title: string | null;
    baseBranch: string | null;
    /** Born-with kind — e.g. `'onboarding'` for an Atlas-run repo init thread. Default null. */
    kind?: JobKind | null;
    /** The job whose brain spawned this follow-up (closure-derived, never tool args). */
    createdByJobId?: string | null;
    /** The spawning job's current title, snapshotted immutably. */
    createdByTitle?: string | null;
    /** Agent-facing `create_job` auto-mode override. Present (even `{}`) only when the caller wants to
     *  resolve auto-approve/auto-merge against the org's defaults; undefined (onboarding's call sites)
     *  leaves the auto_* columns at their entity defaults, unchanged from before this option existed. */
    autoMode?: { approveMode?: AutoApproveMode; merge?: boolean };
  }): Promise<string> {
    // Route a provided title through the shared titler so the new thread is born with a short, scannable
    // sidebar label (fail-soft). A null title (no seed text) stays null. An onboarding thread keeps its
    // explicit title verbatim (no LLM round-trip).
    const title =
      input.title && input.kind !== 'onboarding'
        ? await this.titler.titleFor(input.title, input.orgId)
        : input.title;
    // Present-but-empty `{}` still resolves against the org's defaults (the create_job host-tool bug fix):
    // omitted fields fall back to default_auto_approve_mode/default_auto_merge; present fields override.
    let autoCols: Partial<JobEntity> = {};
    if (input.autoMode) {
      const org = await this.organizations.findOne({
        where: { id: input.orgId },
      });
      const approveMode =
        input.autoMode.approveMode ?? org?.default_auto_approve_mode ?? 'off';
      const merge = input.autoMode.merge ?? org?.default_auto_merge ?? false;
      autoCols = {
        auto_approve_mode: approveMode,
        auto_approve_by: null,
        auto_merge: merge,
        auto_merge_by: null,
      };
    }
    const row = await this.jobs.save(
      this.jobs.create({
        org_id: input.orgId,
        repo_id: input.repoId,
        origin: 'control',
        surface_thread_ref: null,
        title,
        base_branch: input.baseBranch,
        ...(input.kind ? { kind: input.kind } : {}),
        created_by_job_id: input.createdByJobId ?? null,
        created_by: input.createdByJobId
          ? { jobId: input.createdByJobId, title: input.createdByTitle ?? null }
          : null,
        ...autoCols,
      }),
    );
    // Bootstrap the job's one planning thread group + thread up front (d7) so its card/message anchor resolves from
    // the first turn — idempotent, so a later persistPlan is a no-op on it.
    await this.ensurePlanningThreadGroup(row.id, input.orgId);
    return row.id;
  }
}

/** Map a `JobEntity` row to the in-memory `Thread` shape. */
function toThread(row: JobEntity): Job {
  return {
    id: row.id,
    orgId: row.org_id,
    repoId: row.repo_id,
    origin: row.origin as Job['origin'],
    surfaceThreadRef: row.surface_thread_ref,
    title: row.title,
    baseBranch: row.base_branch,
    kind: row.kind as JobKind | null,
    buildPath: row.build_path,
    status: row.status as Job['status'],
    activity: row.activity,
    halt: row.halt ?? null,
    decisionRecordId: row.decision_record_id,
    featureBranch: row.feature_branch,
    currentBranch: row.current_branch,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    shipReviewApprovedAt: row.ship_review_approved_at,
    autoApproveMode: row.auto_approve_mode ?? 'off',
    autoApproveBy: row.auto_approve_by ?? null,
    autoMerge: row.auto_merge ?? false,
    autoMergeBy: row.auto_merge_by ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
