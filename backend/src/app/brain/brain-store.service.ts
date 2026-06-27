import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { Decision, Thread, ThreadKind } from '../domain';
import { renderPlan } from '../driver/render-plan';
import type { PlannedStep } from '../driver/planner-llm';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  MessageEntity,
  StepEntity,
  TrackEntity,
  StimulusEntity,
  ThreadEntity,
} from '../persistence/entities';
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
  thread: Thread;
  decisionRecordId: string;
}

/** Track briefs are gap-numbered (10, 20, 30…) so a re-plan can splice without renumbering. */
const ORDINAL_GAP = 10;

/**
 * W3 — the BRAIN's persistence. The single place the brain reads the thread transcript and writes the
 * locked plan (decision record + track rows) on the 'app' connection. The THREAD is the build unit
 * (the former `jobs` layer is folded into it), so "open a job" / "load a job" here are thread status
 * transitions on the same row. Keeps the conversational brain free of repository wiring — it speaks
 * domain shapes, this maps them to rows.
 *
 * The detailed per-track PHASE plan is W4's job, NOT the brain's: this writes the high-level track
 * BRIEFS (each a `pending` track with no `plan` yet); W4's driver fills `plan` + the step rows
 * just-in-time. Zero v1 imports.
 */
@Injectable()
export class BrainStoreService {
  constructor(
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(MessageEntity, DB_CONNECTION)
    private readonly messages: Repository<MessageEntity>,
    @InjectRepository(DecisionRecordEntity, DB_CONNECTION)
    private readonly records: Repository<DecisionRecordEntity>,
    @InjectRepository(TrackEntity, DB_CONNECTION)
    private readonly tracks: Repository<TrackEntity>,
    @InjectRepository(StepEntity, DB_CONNECTION)
    private readonly steps: Repository<StepEntity>,
    @InjectRepository(StimulusEntity, DB_CONNECTION)
    private readonly stimuli: Repository<StimulusEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Resolve the thread an EVENT stimulus seeded (the intake seam opened it but the in-memory
   * `EventStimulus` doesn't carry the id). Reads the `stimuli` row's `thread_id`. Null if the
   * stimulus isn't persisted (shouldn't happen — intake persists before consuming).
   */
  async eventThreadId(stimulusId: string): Promise<string | null> {
    const row = await this.stimuli.findOne({ where: { id: stimulusId } });
    return row?.thread_id ?? null;
  }

  /** Read a thread's message log, oldest-first — the transcript the grill turn reads. */
  async transcript(threadId: string): Promise<TranscriptLine[]> {
    const rows = await this.messages.find({
      where: { thread_id: threadId },
      order: { created_at: 'ASC' },
    });
    return rows.map((m) => ({
      author: m.author,
      isAtlas: m.author_bot_id != null,
      text: m.text,
    }));
  }

  /** Append Atlas's own message to a thread (so its turns are part of the durable transcript). */
  async appendAtlasMessage(threadId: string, text: string): Promise<void> {
    await this.messages.save(
      this.messages.create({
        thread_id: threadId,
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text,
      }),
    );
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
    threadId: string,
    block: { kind: string; text?: string; meta?: Record<string, unknown> | null; createdAt?: Date },
  ): Promise<void> {
    await this.messages.save(
      this.messages.create({
        thread_id: threadId,
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

  // ── card messages (durable; the surface `post` path does NOT write `messages.card`) ────────────────

  /**
   * Persist a CARD message row (kind='card') so it survives refetch/reload — the surface `post` path
   * only writes the outbox + SSE, never `messages.card`. `ts` is the card's stable key (e.g. a
   * questionId); the card payload renders via `/messages` (which returns `m.card`). Authored by Atlas.
   */
  async appendCardMessage(
    threadId: string,
    input: { ts: string; text?: string; card: Record<string, unknown> },
  ): Promise<void> {
    await this.messages.save(
      this.messages.create({
        thread_id: threadId,
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

  /** Merge a patch into a card row's `card` jsonb (e.g. stamp the answered state / `loggedDecision`). */
  async updateCardMessage(
    threadId: string,
    ts: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const row = await this.messages.findOne({ where: { thread_id: threadId, ts, kind: 'card' } });
    if (!row) return;
    row.card = { ...(row.card ?? {}), ...patch };
    await this.messages.save(row);
  }

  /** Load this thread's card rows, newest-first — small helper for the question-card lookups below. */
  private async questionCards(threadId: string): Promise<MessageEntity[]> {
    const rows = await this.messages.find({
      where: { thread_id: threadId, kind: 'card' },
      order: { created_at: 'DESC' },
    });
    return rows.filter((m) => (m.card as Record<string, unknown> | null)?.type === 'question_card');
  }

  /**
   * The newest ANSWERED question card not yet consumed by a `log_decision` — what `log_decision`
   * auto-attaches (its `question` + `answer`) so the brain need not restate them. Durable (DB-backed),
   * so it survives a host restart between the answer and the log.
   */
  async latestAnsweredQuestionCard(threadId: string): Promise<MessageEntity | null> {
    const cards = await this.questionCards(threadId);
    return (
      cards.find((m) => {
        const c = m.card as Record<string, unknown>;
        return c.answer != null && c.loggedDecision !== true;
      }) ?? null
    );
  }

  /** The newest UNANSWERED question card — the target for the typed-reply fallback (composer answer). */
  async latestUnansweredQuestionCard(threadId: string): Promise<MessageEntity | null> {
    const cards = await this.questionCards(threadId);
    return cards.find((m) => (m.card as Record<string, unknown>).answer == null) ?? null;
  }

  // ── pending decisions (the grilling working set; snapshotted into a record by submit_plan) ──────────

  /** Read a thread's working-set decisions logged so far (the `pending_decisions` jsonb). */
  async pendingDecisions(threadId: string): Promise<Decision[]> {
    const row = await this.threads.findOne({ where: { id: threadId } });
    return row?.pending_decisions ?? [];
  }

  /**
   * Upsert a logged decision into the thread's `pending_decisions` working set, keyed by
   * (decisionClass, title) so re-logging the same decision REVISES its ruling rather than duplicating.
   * Returns the updated array. (The proposal record is created later, by `submit_plan` → `persistPlan`.)
   */
  async appendDecision(threadId: string, decision: Decision): Promise<Decision[]> {
    const row = await this.threads.findOneOrFail({ where: { id: threadId } });
    const current = row.pending_decisions ?? [];
    const idx = current.findIndex(
      (d) => d.decisionClass === decision.decisionClass && d.title === decision.title,
    );
    const next = idx >= 0 ? current.map((d, i) => (i === idx ? decision : d)) : [...current, decision];
    await this.threads.update({ id: threadId }, { pending_decisions: next });
    return next;
  }

  /**
   * Mark whether a live conversational (brain) turn is streaming for this thread. Drives the durable
   * `turn_active` axis of the "needs you" signal (see `deriveNeedsYou`). Best-effort — a write failure
   * here must never break the turn itself (the caller swallows errors).
   */
  async setTurnActive(threadId: string, active: boolean): Promise<void> {
    await this.threads.update({ id: threadId }, { turn_active: active });
  }

  /**
   * Boot reconciliation: no conversational turn can survive a process restart, so clear any `turn_active`
   * left set by a crash mid-turn — otherwise the thread would read as "working" forever and never show
   * the "needs you" dot. Returns the number of rows reset.
   */
  async resetAllTurnActive(): Promise<number> {
    const res = await this.threads.update({ turn_active: true }, { turn_active: false });
    return res.affected ?? 0;
  }

  /** Resolve where to post into a thread: the repo coordinate + the real thread id. The web/agent
   *  surface keys its conversation by these directly — no channel/surface-ref indirection. */
  async route(thread: { orgId: string; repoId: string; threadId: string }): Promise<ThreadRoute> {
    return { channel: thread.repoId, threadTs: thread.threadId };
  }

  /**
   * If this thread is already being scoped (`status='scoping'`), return its id — so a multi-turn grill
   * continues ONE build rather than re-anchoring per message. Null otherwise.
   */
  async openJobOnThread(threadId: string): Promise<string | null> {
    const row = await this.threads.findOne({
      where: { id: threadId, status: 'scoping' },
    });
    return row?.id ?? null;
  }

  /** Anchor the upfront grill: flip the thread into the build lifecycle (`scoping`) + set intent/title. */
  async openJob(input: {
    orgId: string;
    repoId: string;
    threadId: string;
    title: string;
    kind: ThreadKind;
  }): Promise<string> {
    await this.threads.update(
      { id: input.threadId },
      { kind: input.kind, status: 'scoping', title: input.title },
    );
    return input.threadId;
  }

  /**
   * Persist a LOCKED plan: the decision record (draft) + the track rows + flip the thread to
   * `awaiting_approval`. Writes the high-level track BRIEFS (titles); the full plan (plan.md,
   * decisions, diagrams) lives in the thread's `/context/specs` folder, which the build sessions read.
   * Returns the thread (domain shape) + the decision record id.
   */
  async persistPlan(input: {
    orgId: string;
    repoId: string;
    threadId: string;
    title: string;
    kind: ThreadKind;
    overview: string;
    decisions: Decision[];
    trackTitles: string[];
    /**
     * OPTIONAL — the scope type per track (backend/frontend/…), aligned by track index. Selects the
     * review agents. Defaults to `'general'` per track when absent (the autonomous bugfix / direct-build
     * callers pass no types) — matches the DB column default.
     */
    trackTypes?: string[];
    /**
     * OPTIONAL — the steps Atlas authored up front for each track, aligned by track index
     * (`stepsByTrack[i]` = steps for `trackTitles[i]`). When present, the step rows are LOCKED
     * here so the driver finds them already present and skips its just-in-time plan turn; `track.plan`
     * is set from them so the pipeline view shows the plan. ABSENT (direct-build / bugfix dispatch) →
     * no step rows created, exactly as before — the driver JIT-plans those tracks.
     */
    stepsByTrack?: PlannedStep[][];
  }): Promise<PersistedPlan> {
    // The whole persist runs in ONE transaction: delete prior draft tracks (their steps cascade),
    // supersede the prior draft record, write the new record + tracks (+ authored step rows), and
    // flip the thread — so a crash mid-write can never leave a half-proposed plan. A re-propose
    // (request_changes → reopenScoping → propose again) reuses the SAME thread, so prior DRAFT
    // tracks/record are cleared first; idempotent on the first proposal.
    const decisionRecordId = await this.dataSource.transaction(async (m) => {
      const threads = m.getRepository(ThreadEntity);
      const records = m.getRepository(DecisionRecordEntity);
      const tracks = m.getRepository(TrackEntity);
      const steps = m.getRepository(StepEntity);

      // tracks MUST be deleted (new ones re-use ordinals 10/20/30… → UNIQUE(thread_id, ordinal)
      // collision); `steps.track_id ON DELETE CASCADE` clears their step rows too. The prior draft
      // record is marked `superseded` (audit trail, never an approved one).
      await tracks.delete({ thread_id: input.threadId });
      await records.update(
        { thread_id: input.threadId, status: 'draft' },
        { status: 'superseded' },
      );

      const record = await records.save(
        records.create({
          org_id: input.orgId,
          repo_id: input.repoId,
          thread_id: input.threadId,
          status: 'draft',
          overview: input.overview,
          decisions: input.decisions,
          track_titles: input.trackTitles,
          approved_by: null,
          approved_at: null,
        }),
      );

      // Save tracks first (to get ids), setting `plan` from any authored steps so `hasPlan` is true
      // in the pipeline view (the authored path never hits the driver's `setTrackPlan`).
      const savedSections = await tracks.save(
        input.trackTitles.map((brief, i) => {
          const authored = input.stepsByTrack?.[i];
          return tracks.create({
            thread_id: input.threadId,
            org_id: input.orgId,
            ordinal: (i + 1) * ORDINAL_GAP,
            brief,
            // Scope type selects the review agents; default 'general' for arg-less callers (bugfix/direct).
            type: input.trackTypes?.[i] ?? 'general',
            plan: authored?.length ? renderPlan(authored) : null,
            handoff_in: null,
            handoff_out: null,
            status: 'pending',
          });
        }),
      );

      // Lock the authored steps as `steps` rows — same gap-numbered convention as
      // `DriverStoreService.lockSteps` (ordinal (i+1)*GAP, step 'build', status 'pending') so the
      // driver's resume/fast-forward cursor reads them identically. Order of savedSections matches the
      // input order (single save call), so index alignment holds.
      if (input.stepsByTrack?.length) {
        const phaseRows = savedSections.flatMap((track, i) =>
          (input.stepsByTrack?.[i] ?? []).map((p, j) =>
            steps.create({
              track_id: track.id,
              thread_id: input.threadId,
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

      await threads.update(
        { id: input.threadId },
        {
          kind: input.kind,
          title: input.title,
          status: 'awaiting_approval',
          decision_record_id: record.id,
        },
      );

      return record.id;
    });

    const thread = await this.loadJob(input.threadId);
    return { thread, decisionRecordId };
  }

  /** Mark a decision record approved + flip its thread to `running` (the dispatch precondition). */
  async approve(threadId: string, decisionRecordId: string, approvedBy: string): Promise<Thread> {
    const now = new Date();
    await this.records.update(
      { id: decisionRecordId },
      { status: 'approved', approved_by: approvedBy, approved_at: now },
    );
    await this.threads.update({ id: threadId }, { status: 'running' });
    return this.loadJob(threadId);
  }

  /** Flip a thread back to `scoping` (a rejected / change-requested plan returns to the grill). */
  async reopenScoping(threadId: string): Promise<void> {
    await this.threads.update({ id: threadId }, { status: 'scoping' });
  }

  /** Cancel a thread's build (a denied plan). */
  async cancel(threadId: string): Promise<void> {
    await this.threads.update({ id: threadId }, { status: 'cancelled' });
  }

  /** Load a thread row as the domain `Thread` shape. */
  async loadJob(threadId: string): Promise<Thread> {
    const row = await this.threads.findOneOrFail({ where: { id: threadId } });
    return toThread(row);
  }

  // ── create_thread tool ───────────────────────────────────────────────────────────────────────────

  /**
   * Create a follow-up thread (the brain's `create_thread` / `promote_ticket` tools) — a plain `open`
   * thread on the repo that provisions its sandbox lazily on the first turn. Optionally links the ticket
   * it was promoted from (`ticketId`).
   */
  async createFollowUpThread(input: {
    orgId: string;
    repoId: string;
    title: string | null;
    baseBranch: string | null;
    ticketId?: string | null;
  }): Promise<string> {
    const row = await this.threads.save(
      this.threads.create({
        org_id: input.orgId,
        repo_id: input.repoId,
        origin: 'control',
        surface_thread_ref: null,
        title: input.title,
        base_branch: input.baseBranch,
        ticket_id: input.ticketId ?? null,
      }),
    );
    return row.id;
  }
}

/** Map a `ThreadEntity` row to the in-memory `Thread` shape. */
function toThread(row: ThreadEntity): Thread {
  return {
    id: row.id,
    orgId: row.org_id,
    repoId: row.repo_id,
    origin: row.origin as Thread['origin'],
    surfaceThreadRef: row.surface_thread_ref,
    title: row.title,
    baseBranch: row.base_branch,
    kind: row.kind as ThreadKind | null,
    status: row.status as Thread['status'],
    decisionRecordId: row.decision_record_id,
    featureBranch: row.feature_branch,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
