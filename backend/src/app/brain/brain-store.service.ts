import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Decision, Thread, ThreadKind } from '../domain';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  MessageEntity,
  SectionEntity,
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

/** Section briefs are gap-numbered (10, 20, 30…) so a re-plan can splice without renumbering. */
const ORDINAL_GAP = 10;

/**
 * W3 — the BRAIN's persistence. The single place the brain reads the thread transcript and writes the
 * locked plan (decision record + section rows) on the 'app' connection. The THREAD is the build unit
 * (the former `jobs` layer is folded into it), so "open a job" / "load a job" here are thread status
 * transitions on the same row. Keeps the conversational brain free of repository wiring — it speaks
 * domain shapes, this maps them to rows.
 *
 * The detailed per-section PHASE plan is W4's job, NOT the brain's: this writes the high-level section
 * BRIEFS (each a `pending` section with no `plan` yet); W4's driver fills `plan` + the phase rows
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
    @InjectRepository(SectionEntity, DB_CONNECTION)
    private readonly sections: Repository<SectionEntity>,
    @InjectRepository(StimulusEntity, DB_CONNECTION)
    private readonly stimuli: Repository<StimulusEntity>,
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
   * Persist a LOCKED plan: the decision record (draft) + the section rows + flip the thread to
   * `awaiting_approval`. Writes the high-level section BRIEFS only (gap-numbered, no `plan` yet — W4
   * fills the detailed phase plan). Returns the thread (domain shape) + the decision record id.
   */
  async persistPlan(input: {
    orgId: string;
    repoId: string;
    threadId: string;
    title: string;
    kind: ThreadKind;
    overview: string;
    decisions: Decision[];
    sectionBriefs: string[];
  }): Promise<PersistedPlan> {
    // A re-propose (request_changes → reopenScoping → the grill proposes again) reuses the SAME thread,
    // so any prior DRAFT sections/record from the earlier proposal are still here. Clear them first:
    // sections MUST be deleted (new ones re-use ordinals 10/20/30… → UNIQUE(thread_id, ordinal)
    // collision), and the prior draft record is marked `superseded` (audit trail, never an approved
    // one). Idempotent on the first proposal (nothing to clear).
    await this.sections.delete({ thread_id: input.threadId });
    await this.records.update(
      { thread_id: input.threadId, status: 'draft' },
      { status: 'superseded' },
    );

    const record = await this.records.save(
      this.records.create({
        org_id: input.orgId,
        repo_id: input.repoId,
        thread_id: input.threadId,
        status: 'draft',
        overview: input.overview,
        decisions: input.decisions,
        section_briefs: input.sectionBriefs,
        approved_by: null,
        approved_at: null,
      }),
    );

    await this.sections.save(
      input.sectionBriefs.map((brief, i) =>
        this.sections.create({
          thread_id: input.threadId,
          org_id: input.orgId,
          ordinal: (i + 1) * ORDINAL_GAP,
          brief,
          plan: null,
          handoff_in: null,
          handoff_out: null,
          status: 'pending',
        }),
      ),
    );

    await this.threads.update(
      { id: input.threadId },
      {
        kind: input.kind,
        title: input.title,
        status: 'awaiting_approval',
        decision_record_id: record.id,
      },
    );

    const thread = await this.loadJob(input.threadId);
    return { thread, decisionRecordId: record.id };
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

  /** Create a follow-up thread (the brain's `create_thread` tool) — a plain `open` thread on the repo. */
  async createFollowUpThread(input: {
    orgId: string;
    repoId: string;
    title: string | null;
    baseBranch: string | null;
  }): Promise<string> {
    const row = await this.threads.save(
      this.threads.create({
        org_id: input.orgId,
        repo_id: input.repoId,
        origin: 'control',
        surface_thread_ref: null,
        title: input.title,
        base_branch: input.baseBranch,
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
