import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, MoreThan, Not, Repository } from 'typeorm';
import type { Decision, Job, JobKind, JobStatus } from '../domain';
import { nextDecisionId } from '../domain';
import type {
  WebConventionEditProposalCard,
  WebConventionProposalCard,
  WebFileRequestCard,
  WebMcpProposalCard,
  WebQuestionCard,
  WebSecretInputCard,
  WebSkillProposalCard,
} from '../surface';
// Direct leaf import (not the '../surface' barrel): brain-store otherwise only TYPE-imports from surface,
// and a runtime value import of the whole barrel would add a surface→brain→brain-store→surface cycle.
import { webTicketCard } from '../surface/web-ticket-card';
import { nextQuestionId } from '../surface/web-question-card';
import { renderPlan } from '../driver/render-plan';
import type { PlannedStep } from '../driver/render-plan';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  MessageEntity,
  StepEntity,
  ThreadEntity,
  StimulusEntity,
  JobEntity,
  TicketEntity,
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
  constructor(
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(MessageEntity, DB_CONNECTION)
    private readonly messages: Repository<MessageEntity>,
    @InjectRepository(DecisionRecordEntity, DB_CONNECTION)
    private readonly records: Repository<DecisionRecordEntity>,
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(StepEntity, DB_CONNECTION)
    private readonly steps: Repository<StepEntity>,
    @InjectRepository(StimulusEntity, DB_CONNECTION)
    private readonly stimuli: Repository<StimulusEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
    private readonly titler: JobTitler,
  ) {}

  /**
   * Resolve the thread an EVENT stimulus seeded (the intake seam opened it but the in-memory
   * `EventStimulus` doesn't carry the id). Reads the `stimuli` row's `job_id`. Null if the
   * stimulus isn't persisted (shouldn't happen — intake persists before consuming).
   */
  async eventThreadId(stimulusId: string): Promise<string | null> {
    const row = await this.stimuli.findOne({ where: { id: stimulusId } });
    return row?.job_id ?? null;
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
        author: 'System',
        author_id: 'system',
        author_bot_id: null,
        text,
        kind: 'chat',
        meta: { source: 'system_operator', ...extraMeta },
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
      where: { job_id: jobId, author_id: 'system', text, created_at: MoreThan(since) },
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
    text: string;
    chunkKey: string;
    reminderKind?: string;
    /** `<untrusted>` provenance/severity — surfaced on the web's untrusted pill. */
    untrustedSource?: string;
    severity?: string;
    createdAt?: Date;
  }): Promise<void> {
    const dup = await this.messages
      .createQueryBuilder('m')
      .where('m.job_id = :jobId', { jobId: input.jobId })
      .andWhere('m.meta @> :key::jsonb', {
        key: JSON.stringify({ chunkKey: input.chunkKey }),
      })
      .getCount();
    if (dup > 0) return;
    await this.messages.save(
      this.messages.create({
        job_id: input.jobId,
        author: 'System',
        author_id: 'U-SYSTEM',
        author_bot_id: null,
        text: input.text,
        kind: 'chat',
        meta: {
          source: input.kind,
          chunkKey: input.chunkKey,
          ...(input.reminderKind ? { reminderKind: input.reminderKind } : {}),
          ...(input.untrustedSource
            ? { untrustedSource: input.untrustedSource }
            : {}),
          ...(input.severity ? { severity: input.severity } : {}),
        },
        ...(input.createdAt ? { created_at: input.createdAt } : {}),
      }),
    );
  }

  /**
   * The BRAIN's most-recent context-window occupancy, read from the latest `turn_meta` block. Build turns
   * also emit `turn_meta`, but tagged with `meta.phaseId` (the brain's `main`-lane turn_meta carries no
   * metaTag), so `phaseId IS NULL` isolates the brain's own occupancy. Used to gate compaction — skip the
   * summary turn when the session is still lean. Null when no brain turn has recorded usage yet (or the SDK
   * didn't surface per-call usage), in which case the caller compacts rather than risk leaving a fat session.
   */
  async latestBrainOccupancy(
    jobId: string,
  ): Promise<{ contextTokens: number | null; contextLimit: number | null } | null> {
    const rows: Array<{
      meta: { contextTokens?: number | null; contextLimit?: number | null } | null;
    }> = await this.dataSource.query(
      `SELECT meta FROM messages
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
   * Relay a ticket the brain just captured (`create_ticket`) as a durable callout card on the job's
   * conversation — so the operator SEES out-of-scope work being raised, live, instead of it being silent
   * (the tool otherwise only writes the row + a board-refresh event). Insert-once on the stable `ts`
   * (`ticket:<id>`): a resumed brain turn that re-drives the tool must not double-post the same card
   * (`appendCardMessage` does not dedup, unlike `recordSystemChunk`). Best-effort — the caller swallows
   * failures so a transcript-write hiccup never fails the tool.
   */
  async appendTicketCard(jobId: string, ticket: TicketEntity): Promise<void> {
    const ts = `ticket:${ticket.id}`;
    const dup = await this.messages.count({
      where: { job_id: jobId, ts, kind: 'card' },
    });
    if (dup > 0) return;
    await this.appendCardMessage(jobId, {
      ts,
      text: `Raised ticket #${ticket.number}: ${ticket.title}`,
      // A named-interface card has no index signature; the store's card is `Record<string, unknown>` — the
      // house-style cast (mirrors the approval-card persist path in agent-session-manager).
      card: webTicketCard(ticket) as unknown as Record<string, unknown>,
    });
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
    input: { threadId: string; gen: number; reason: string; evidence: string; text: string },
  ): Promise<void> {
    const ts = `cleared:${input.threadId}:${input.gen}`;
    const dup = await this.messages.count({ where: { job_id: jobId, ts, kind: 'card' } });
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
  ): Promise<{ threadId: string; reason: string; evidence: string; at: Date }[]> {
    const rows = await this.messages.find({
      where: { job_id: jobId, kind: 'card' },
      order: { created_at: 'ASC' },
    });
    return rows
      .filter((m) => (m.card as Record<string, unknown> | null)?.type === 'cleared_block_card')
      .map((m) => {
        const c = (m.card ?? {}) as Record<string, unknown>;
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
  private async questionCards(jobId: string): Promise<MessageEntity[]> {
    const rows = await this.messages.find({
      where: { job_id: jobId, kind: 'card' },
      order: { created_at: 'DESC' },
    });
    return rows.filter(
      (m) =>
        (m.card as Record<string, unknown> | null)?.type === 'question_card',
    );
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
  ): Promise<MessageEntity | null> {
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
      const messages = m.getRepository(MessageEntity);
      const thread = await threads.findOne({ where: { id: jobId } });
      if (!thread) return { ok: false };
      await messages.save(
        messages.create({
          job_id: jobId,
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
        .update(MessageEntity)
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
      .filter((c) => c.answer == null && c.withdrawnAt == null && c.origin !== 'build');
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
        .update(MessageEntity)
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
   * Open the secure-secret gate ATOMICALLY: persist the value-free secret card row AND point the thread's
   * `awaiting_secret_id` at it in ONE transaction. Refuses (`alreadyOpen`) if an un-provided secret request
   * is already open, so the brain can't stack requests.
   */
  async openSecretRequest(
    jobId: string,
    input: { requestId: string; card: WebSecretInputCard },
  ): Promise<{ ok: boolean; alreadyOpen?: boolean }> {
    return this.dataSource.transaction(async (m) => {
      const threads = m.getRepository(JobEntity);
      const messages = m.getRepository(MessageEntity);
      const thread = await threads.findOne({ where: { id: jobId } });
      if (!thread) return { ok: false };
      if (thread.awaiting_secret_id) {
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
          author: 'Atlas',
          author_id: 'atlas',
          author_bot_id: 'atlas',
          text: input.card.ephemeral
            ? `Requested a one-time value \`${input.card.name}\` (delivered to the running session, not stored)`
            : input.card.mcp
              ? `Requested secret \`${input.card.mcp.key}\` for MCP server \`${input.card.mcp.server}\``
              : `Requested secret \`${input.card.name}\` → \`${input.card.path}\``,
          kind: 'card',
          ts: input.requestId,
          card: input.card as unknown as Record<string, unknown>,
        }),
      );
      await threads.update(
        { id: jobId },
        { awaiting_secret_id: input.requestId },
      );
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
  async markSecretDelivered(
    jobId: string,
    requestId: string,
  ): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      delivered_at: new Date().toISOString(),
    });
  }

  /** Clear the secret gate iff it still equals `requestId` (compare-and-clear; ignores a superseded gate). */
  async clearAwaitingSecret(
    jobId: string,
    requestId: string,
  ): Promise<void> {
    await this.jobs.update(
      { id: jobId, awaiting_secret_id: requestId },
      { awaiting_secret_id: null },
    );
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
    const rows = await this.jobs.find({
      where: { awaiting_secret_id: Not(IsNull()) },
    });
    const out: {
      jobId: string;
      orgId: string;
      repoId: string;
      requestId: string;
      name: string;
      path?: string;
      ephemeral?: boolean;
      mcp?: { server: string; slot: 'header' | 'env'; key: string };
    }[] = [];
    for (const t of rows) {
      const card = await this.getSecretCard(t.id, t.awaiting_secret_id!);
      if (card?.provided_at != null && card.delivered_at == null) {
        out.push({
          jobId: t.id,
          orgId: t.org_id,
          repoId: t.repo_id,
          requestId: t.awaiting_secret_id!,
          name: card.name,
          ...(card.path ? { path: card.path } : {}),
          ...(card.ephemeral ? { ephemeral: true } : {}),
          ...(card.mcp ? { mcp: card.mcp } : {}),
        });
      }
    }
    return out;
  }

  // ── file-request gate (request_file lifecycle: requested → provided → delivered) ─────────────────────
  // Like ask_question (PER-CARD, no single-slot thread pointer → several file requests may be open at
  // once), but the value is an UPLOAD stored as a file-valued secret + grant (never on the card / in the
  // transcript). No migration: all state lives on the card in the `messages` jsonb.

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
      .update(MessageEntity)
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
    const rows = (await this.dataSource.query(
      `SELECT m.job_id AS "jobId", t.org_id AS "orgId", t.repo_id AS "repoId",
              m.ts AS "requestId", m.card ->> 'path' AS "path"
         FROM ${messagesTable} m
         JOIN ${threadsTable} t ON t.id = m.job_id
        WHERE m.kind = 'card'
          AND m.card ->> 'type' = 'file_request_card'
          AND m.card ->> 'provided_at' IS NOT NULL
          AND m.card ->> 'delivered_at' IS NULL`,
    )) as {
      jobId: string;
      orgId: string;
      repoId: string;
      requestId: string;
      path: string;
    }[];
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
  async markConventionProposalApproved(jobId: string, requestId: string): Promise<void> {
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
    const verb = input.card.mode === 'create' ? 'Proposed a new' : 'Proposed changes to the';
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
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
  async markConventionEditProposalApproved(jobId: string, requestId: string): Promise<void> {
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
  async markSkillProposalApproved(jobId: string, requestId: string): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      approved_at: new Date().toISOString(),
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
   * Mark whether a live conversational (brain) turn is streaming for this thread. Drives the durable
   * `turn_active` axis of the "needs you" signal (see `deriveNeedsYou`). Best-effort — a write failure
   * here must never break the turn itself (the caller swallows errors).
   */
  async setTurnActive(jobId: string, active: boolean): Promise<void> {
    await this.jobs.update({ id: jobId }, { turn_active: active });
  }

  /**
   * The threads with a `turn_active` flag still set — i.e. a conversational turn was streaming when the
   * process died. Captured on boot BEFORE {@link resetAllTurnActive} clears the flags, so crash recovery
   * knows which threads have a possibly-orphaned engine still finishing in the container (to watch them to
   * completion). Returns thread ids.
   */
  async threadsWithActiveTurn(): Promise<string[]> {
    const rows = await this.jobs.find({
      where: { turn_active: true },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Boot reconciliation: no conversational turn can survive a process restart, so clear any `turn_active`
   * left set by a crash mid-turn — otherwise the thread would read as "working" forever and never show
   * the "needs you" dot. Returns the number of rows reset.
   */
  async resetAllTurnActive(): Promise<number> {
    const res = await this.jobs.update(
      { turn_active: true },
      { turn_active: false },
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
   * If this thread is already being scoped (`status='planning'`), return its id — so a multi-turn grill
   * continues ONE build rather than re-anchoring per message. Null otherwise.
   */
  async openJobOnThread(jobId: string): Promise<string | null> {
    const row = await this.jobs.findOne({
      where: { id: jobId, status: 'planning' },
    });
    return row?.id ?? null;
  }

  /** The job's current kind (null until scoped, or if the operator picked one at creation). */
  async jobKind(jobId: string): Promise<JobKind | null> {
    const row = await this.jobs.findOne({ where: { id: jobId }, select: { id: true, kind: true } });
    return (row?.kind as JobKind | null | undefined) ?? null;
  }

  /** The job's short title (used to give a bare "continue" nudge some task context). */
  async jobTitle(jobId: string): Promise<string | null> {
    const row = await this.jobs.findOne({ where: { id: jobId }, select: { id: true, title: true } });
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
  }): Promise<PersistedPlan> {
    // Route the incoming title (the plan `goal` / build summary) through the shared titler so the
    // thread's sidebar label is a short, scannable title — NOT the raw full-sentence goal. Done before
    // the transaction (one network call, fail-soft to a trimmed first line) so the txn stays fast.
    const title = await this.titler.titleFor(input.title, input.orgId);

    // The whole persist runs in ONE transaction: delete prior draft threads (their steps cascade),
    // supersede the prior draft record, write the new record + threads (+ authored step rows), and
    // flip the thread — so a crash mid-write can never leave a half-proposed plan. A re-propose
    // (request_changes → reopenPlanning → propose again) reuses the SAME thread, so prior DRAFT
    // threads/record are cleared first; idempotent on the first proposal.
    const decisionRecordId = await this.dataSource.transaction(async (m) => {
      const jobs = m.getRepository(JobEntity);
      const records = m.getRepository(DecisionRecordEntity);
      const threads = m.getRepository(ThreadEntity);
      const steps = m.getRepository(StepEntity);

      // threads MUST be deleted (new ones re-use ordinals 10/20/30… → UNIQUE(job_id, ordinal)
      // collision); `steps.thread_id ON DELETE CASCADE` clears their step rows too. The prior draft
      // record is marked `superseded` (audit trail, never an approved one).
      await threads.delete({ job_id: input.jobId });
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

      // Save threads first (to get ids), setting `plan` from any authored steps so `hasPlan` is true
      // in the pipeline view (the authored path never hits the driver's `setThreadPlan`).
      const featureThreads = input.threadTitles.map((brief, i) => {
        const authored = input.stepsByThread?.[i];
        return threads.create({
          job_id: input.jobId,
          org_id: input.orgId,
          ordinal: (i + 1) * ORDINAL_GAP,
          brief,
          // Scope type selects the review agents; default 'general' for arg-less callers (bugfix/direct).
          type: input.threadTypes?.[i] ?? 'general',
          // Feature threads are `builder` kind; the master-review row below is `master_review`. The `kind`
          // column is the first-class differentiator (subsumes `is_master_review`).
          kind: 'builder',
          plan: authored?.length ? renderPlan(authored) : null,
          handoff_in: null,
          handoff_out: null,
          status: 'pending',
        });
      });

      // Append the ONE pre-configured master-review thread — a Codex `execute` thread that reviews the whole
      // merged diff AND applies fixes, running LAST (before ship/PR). GATED to the full thread-driven path:
      // `threadTitles.length > 0` (direct build passes `[]`; onboarding/event never persist a plan) — the one
      // gate that satisfies all three skips. No authored steps (the driver plans its single anchor step).
      if (input.threadTitles.length > 0) {
        featureThreads.push(
          threads.create({
            job_id: input.jobId,
            org_id: input.orgId,
            ordinal: (input.threadTitles.length + 1) * ORDINAL_GAP,
            brief: 'Master review — whole-diff review & fix',
            type: 'general',
            kind: 'master_review',
            plan: null,
            handoff_in: null,
            handoff_out: null,
            status: 'pending',
          }),
        );
      }

      // The MAIN root thread — a first-class, render/identity-only row for the job's brain session (the
      // operator conversation). The driver never executes it (its `main` kind is render-only); it just gives
      // the brain session a place in the thread tree. Appended LAST (after the master review) with ordinal 0
      // so it never disturbs the `savedSections[i]` ↔ `threadTitles[i]` step-locking alignment below
      // (indices ≥ threadTitles.length have no authored steps). Recreated on each re-propose (the prior draft
      // threads were deleted above), which is fine — it carries no durable state (its live state is the
      // AgentSessionManager session + the job's `main_tasks`).
      featureThreads.push(
        threads.create({
          job_id: input.jobId,
          org_id: input.orgId,
          ordinal: 0,
          brief: 'Main',
          type: 'general',
          kind: 'main',
          plan: null,
          handoff_in: null,
          handoff_out: null,
          status: 'pending',
        }),
      );

      const savedSections = await threads.save(featureThreads);

      // Lock the authored steps as `steps` rows — same gap-numbered convention as
      // `DriverStoreService.lockSteps` (ordinal (i+1)*GAP, step 'build', status 'pending') so the
      // driver's resume/fast-forward cursor reads them identically. Order of savedSections matches the
      // input order (single save call), so index alignment holds.
      if (input.stepsByThread?.length) {
        const phaseRows = savedSections.flatMap((thread, i) =>
          (input.stepsByThread?.[i] ?? []).map((p, j) =>
            steps.create({
              thread_id: thread.id,
              job_id: input.jobId,
              org_id: input.orgId,
              ordinal: (j + 1) * ORDINAL_GAP,
              title: p.title,
              brief: p.brief,
              stage: 'build',
              status: 'pending',
            }),
          ),
        );
        if (phaseRows.length) await steps.save(phaseRows);
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

  /** Mark a decision record approved + flip its thread to `running` (the dispatch precondition). */
  async approve(
    jobId: string,
    decisionRecordId: string,
    approvedBy: string,
  ): Promise<Job> {
    const now = new Date();
    await this.records.update(
      { id: decisionRecordId },
      { status: 'approved', approved_by: approvedBy, approved_at: now },
    );
    await this.jobs.update({ id: jobId }, { status: 'running' });
    return this.loadJob(jobId);
  }

  /** Flip a thread back to `planning` (a rejected / change-requested plan returns to the grill). */
  async reopenPlanning(jobId: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { status: 'planning' });
  }

  /** Cancel a thread's build (a denied plan). */
  async cancel(jobId: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { status: 'cancelled' });
  }

  /** The ticket a thread was promoted from / works (`threads.ticket_id`), or null. */
  async threadTicketId(jobId: string): Promise<string | null> {
    const row = await this.jobs.findOne({ where: { id: jobId } });
    return row?.ticket_id ?? null;
  }

  /** Load a thread row as the domain `Thread` shape. */
  async loadJob(jobId: string): Promise<Job> {
    const row = await this.jobs.findOneOrFail({ where: { id: jobId } });
    return toThread(row);
  }

  // ── decision-ledger promotion spine (boot backstop + direct-path stamp) ──────────────────────────

  /** Mark a thread's ledger promotion COMPLETE — stamped only after the promotion turn + commit succeed. */
  async markLedgerPromoted(jobId: string): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      { ledger_promotion_status: 'complete', ledger_promoted_at: new Date() },
    );
  }

  /**
   * Boot backstop: SHIPPED threads (PR opened) whose ledger promotion never reached `complete` — the
   * crash window after ship but before the ledger commit/stamp, plus a direct build whose brain skipped
   * promotion. The startup sweep re-promotes each (idempotent) while its worktree is still live; once the
   * PR merges + the worktree is torn down, there's nothing to write and the sweep skips it.
   */
  async threadsAwaitingLedgerPromotion(): Promise<Job[]> {
    // `status: Not('running')` ENFORCES the backstop⇄driver disjointness invariant at the query level: a
    // `running` job is owned by the driver's `resume()`, so excluding it here guarantees the backstop can
    // never act on a job a live drive is finalizing (even if some future path set `pr_url` on a still-
    // `running` row). Every legitimately-shipped row is `done` (`setPrReady` sets both atomically).
    const rows = await this.jobs.find({
      where: {
        pr_url: Not(IsNull()),
        status: Not('running'),
        ledger_promotion_status: Not('complete'),
      },
    });
    // `Not('complete')` excludes NULLs in SQL, so add the never-started rows explicitly.
    const nullRows = await this.jobs.find({
      where: { pr_url: Not(IsNull()), status: Not('running'), ledger_promotion_status: IsNull() },
    });
    // Onboarding threads never get `promote_decisions` (see `buildTools`) — there is nothing durable
    // for them to promote by design, so they can never legitimately reach `complete`. Excluded here
    // (not just left to `finish_onboarding`'s own stamp) so no future onboarding-ship path can
    // resurrect the impossible `promote_decisions` harness turn against one.
    return [...rows, ...nullRows]
      .filter((row) => row.kind !== 'onboarding')
      .map(toThread);
  }

  // ── create_job tool ───────────────────────────────────────────────────────────────────────────

  /**
   * Create a follow-up thread (the brain's `create_job` / `promote_ticket` tools) — a plain `open`
   * thread on the repo that provisions its sandbox lazily on the first turn. Optionally links the ticket
   * it was promoted from (`ticketId`).
   */
  async createFollowUpJob(input: {
    orgId: string;
    repoId: string;
    title: string | null;
    baseBranch: string | null;
    ticketId?: string | null;
    /** Born-with kind — e.g. `'onboarding'` for an Atlas-run repo init thread. Default null. */
    kind?: JobKind | null;
  }): Promise<string> {
    // Route a provided title through the shared titler so the new thread is born with a short, scannable
    // sidebar label (fail-soft). A null title (no seed text) stays null. An onboarding thread keeps its
    // explicit title verbatim (no LLM round-trip).
    const title =
      input.title && input.kind !== 'onboarding'
        ? await this.titler.titleFor(input.title, input.orgId)
        : input.title;
    const row = await this.jobs.save(
      this.jobs.create({
        org_id: input.orgId,
        repo_id: input.repoId,
        origin: 'control',
        surface_thread_ref: null,
        title,
        base_branch: input.baseBranch,
        ticket_id: input.ticketId ?? null,
        ...(input.kind ? { kind: input.kind } : {}),
      }),
    );
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
    status: row.status as Job['status'],
    decisionRecordId: row.decision_record_id,
    featureBranch: row.feature_branch,
    currentBranch: row.current_branch,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    shipReviewApprovedAt: row.ship_review_approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
