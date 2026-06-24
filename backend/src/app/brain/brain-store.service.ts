import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Decision, Job, JobKind } from '../domain';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  JobEntity,
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

/** The persisted output of a locked plan: the job + its decision record + its section rows. */
export interface PersistedPlan {
  job: Job;
  decisionRecordId: string;
}

/** Section briefs are gap-numbered (10, 20, 30…) so a re-plan can splice without renumbering. */
const ORDINAL_GAP = 10;

/**
 * W3 — the BRAIN's persistence. The single place the brain reads the thread transcript and writes the
 * locked plan (decision record + job + section rows) on the 'app' connection. Keeps the
 * conversational brain free of repository wiring — it speaks domain shapes, this maps them to rows.
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
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
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

  /** Resolve where to post into a thread: the repo coordinate + the real thread id. The web/agent
   *  surface keys its conversation by these directly — no channel/surface-ref indirection. */
  async route(thread: { orgId: string; repoId: string; threadId: string }): Promise<ThreadRoute> {
    return { channel: thread.repoId, threadTs: thread.threadId };
  }

  /**
   * Find an open (scoping) job already on this thread, if any — so a multi-turn grill continues ONE job
   * rather than minting a fresh one per message. Returns the job id or null.
   */
  async openJobOnThread(threadId: string): Promise<string | null> {
    const row = await this.jobs.findOne({
      where: { thread_id: threadId, status: 'scoping' },
    });
    return row?.id ?? null;
  }

  /** Open a fresh `scoping` job on a thread (the upfront grill's anchor). */
  async openJob(input: {
    orgId: string;
    repoId: string;
    threadId: string;
    title: string;
    kind: JobKind;
  }): Promise<string> {
    const row = await this.jobs.save(
      this.jobs.create({
        org_id: input.orgId,
        repo_id: input.repoId,
        thread_id: input.threadId,
        kind: input.kind,
        status: 'scoping',
        title: input.title,
        decision_record_id: null,
        feature_branch: null,
        pr_url: null,
      }),
    );
    return row.id;
  }

  /**
   * Persist a LOCKED plan: the decision record (draft) + the section rows + flip the job to
   * `awaiting_approval`. Writes the high-level section BRIEFS only (gap-numbered, no `plan` yet — W4
   * fills the detailed phase plan). Returns the job (domain shape) + the decision record id.
   */
  async persistPlan(input: {
    orgId: string;
    repoId: string;
    jobId: string;
    title: string;
    kind: JobKind;
    overview: string;
    decisions: Decision[];
    sectionBriefs: string[];
  }): Promise<PersistedPlan> {
    // A re-propose (request_changes → reopenScoping → the grill proposes again) reuses the SAME scoping
    // job, so any prior DRAFT sections/record from the earlier proposal are still here. Clear them first:
    // sections MUST be deleted (new ones re-use ordinals 10/20/30… → UNIQUE(job_id, ordinal) collision),
    // and the prior draft record is marked `superseded` (audit trail, never an approved one). Idempotent
    // on the first proposal (nothing to clear).
    await this.sections.delete({ job_id: input.jobId });
    await this.records.update(
      { job_id: input.jobId, status: 'draft' },
      { status: 'superseded' },
    );

    const record = await this.records.save(
      this.records.create({
        org_id: input.orgId,
        repo_id: input.repoId,
        job_id: input.jobId,
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
          job_id: input.jobId,
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

    await this.jobs.update(
      { id: input.jobId },
      {
        kind: input.kind,
        title: input.title,
        status: 'awaiting_approval',
        decision_record_id: record.id,
      },
    );

    const job = await this.loadJob(input.jobId);
    return { job, decisionRecordId: record.id };
  }

  /** Mark a decision record approved + flip its job to `running` (the dispatch precondition). */
  async approve(jobId: string, decisionRecordId: string, approvedBy: string): Promise<Job> {
    const now = new Date();
    await this.records.update(
      { id: decisionRecordId },
      { status: 'approved', approved_by: approvedBy, approved_at: now },
    );
    await this.jobs.update({ id: jobId }, { status: 'running' });
    return this.loadJob(jobId);
  }

  /** Flip a job back to `scoping` (a rejected / change-requested plan returns to the grill). */
  async reopenScoping(jobId: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { status: 'scoping' });
  }

  /** Cancel a job (a denied plan). */
  async cancel(jobId: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { status: 'cancelled' });
  }

  /** Load a job row as the domain `Job` shape. */
  async loadJob(jobId: string): Promise<Job> {
    const row = await this.jobs.findOneOrFail({ where: { id: jobId } });
    return toJob(row);
  }
}

/** Map an `JobEntity` row to the in-memory `Job` shape. */
function toJob(row: JobEntity): Job {
  return {
    id: row.id,
    orgId: row.org_id,
    repoId: row.repo_id,
    threadId: row.thread_id,
    kind: row.kind as JobKind,
    status: row.status as Job['status'],
    title: row.title,
    decisionRecordId: row.decision_record_id,
    featureBranch: row.feature_branch,
    prUrl: row.pr_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
