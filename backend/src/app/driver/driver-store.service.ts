import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  Decision,
  DecisionRecord,
  Step,
  StepStatus,
  Track,
  TrackStatus,
  Thread,
  ThreadStatus,
} from '../domain';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  StepEntity,
  TrackEntity,
  ThreadEntity,
} from '../persistence/entities';
import type { PlannedStep } from './planner-llm';

/** Phases are gap-numbered (10, 20, 30…) so a re-plan can splice without renumbering. */
const ORDINAL_GAP = 10;

/**
 * The track shape the driver works with — the domain `Track` plus the denormalized `orgId` the step
 * rows need (steps carry `org_id`). The driver never reaches a repository, so the store carries the one
 * extra field rather than the driver re-querying the thread for it.
 */
export type DriverTrack = Track & { orgId: string };

/** Where to post a thread's chatter — the repo coordinate + the real thread id. */
export interface JobRoute {
  channel: string | null;
  threadTs: string | null;
  /** The tenant to post as (selects the workspace credentials). Always set by `route()`; optional only
   *  so in-memory test fixtures (fake surface ignores it) can omit it. */
  orgId?: string;
}

/**
 * W4 — the DRIVER's persistence. The single place the track driver reads/writes the track + step
 * rows (and resolves the decision record + thread route) on the 'app' connection. The THREAD is the build
 * unit (the former `jobs` layer is folded into it), so the "job" methods here operate on the thread row.
 * Keeps `TrackDriver` a legible pipeline that speaks DOMAIN shapes (`Track`, `Step`) — this maps
 * them to/from rows and owns the explicit, resumable `status`/`step` transitions.
 *
 * The brain (W3) already wrote the high-level track BRIEFS (`pending`, no plan). This fills the
 * just-in-time detail: the track `plan`, its step rows, and the status cursors the driver re-enters
 * at on restart. Zero v1 imports.
 */
@Injectable()
export class DriverStoreService {
  constructor(
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(TrackEntity, DB_CONNECTION)
    private readonly tracks: Repository<TrackEntity>,
    @InjectRepository(StepEntity, DB_CONNECTION)
    private readonly steps: Repository<StepEntity>,
    @InjectRepository(DecisionRecordEntity, DB_CONNECTION)
    private readonly records: Repository<DecisionRecordEntity>,
  ) {}

  // ── thread (the build unit) ────────────────────────────────────────────────────────────────────

  /** Load one thread as the domain shape. */
  async loadJob(threadId: string): Promise<Thread> {
    return toThread(
      await this.threads.findOneOrFail({ where: { id: threadId } }),
    );
  }

  /** Every thread currently in `running` — the boot-reconciliation worklist. */
  async runningJobs(): Promise<Thread[]> {
    const rows = await this.threads.find({ where: { status: 'running' } });
    return rows.map(toThread);
  }

  async setJobStatus(threadId: string, status: ThreadStatus): Promise<void> {
    await this.threads.update({ id: threadId }, { status });
  }

  /** Record the feature branch all tracks stack on (set once, when the sandbox is cut). */
  async setFeatureBranch(threadId: string, branch: string): Promise<void> {
    await this.threads.update({ id: threadId }, { feature_branch: branch });
  }

  /** Record the opened PR (url + number) + flip the thread to its terminal `done`. */
  async setPrReady(
    threadId: string,
    prUrl: string,
    prNumber?: number,
  ): Promise<void> {
    await this.threads.update(
      { id: threadId },
      {
        pr_url: prUrl,
        ...(prNumber != null ? { pr_number: prNumber } : {}),
        status: 'done',
      },
    );
  }

  // ── decision record ────────────────────────────────────────────────────────────────────────────

  /** The locked decision record for a thread — the planner + gate's grounding. Null if none. */
  async decisionRecord(
    decisionRecordId: string | null,
  ): Promise<DecisionRecord | null> {
    if (!decisionRecordId) return null;
    const row = await this.records.findOne({ where: { id: decisionRecordId } });
    return row ? toRecord(row) : null;
  }

  // ── tracks ─────────────────────────────────────────────────────────────────────────────────

  /** The thread's tracks in execution order (ORDER BY ordinal). */
  async tracksForJob(threadId: string): Promise<DriverTrack[]> {
    const rows = await this.tracks.find({
      where: { thread_id: threadId },
      order: { ordinal: 'ASC' },
    });
    return rows.map(toTrack);
  }

  async setTrackStatus(
    trackId: string,
    status: TrackStatus,
  ): Promise<void> {
    await this.tracks.update({ id: trackId }, { status });
  }

  /** Persist the just-in-time plan prose + the prior track's handoff onto the track. */
  async setTrackPlan(
    trackId: string,
    plan: string,
    handoffIn: string | null,
  ): Promise<void> {
    await this.tracks.update(
      { id: trackId },
      { plan, handoff_in: handoffIn },
    );
  }

  /** Record the track's handoff note for the next track (set when the track is done). */
  async setTrackHandoffOut(
    trackId: string,
    handoffOut: string,
  ): Promise<void> {
    await this.tracks.update({ id: trackId }, { handoff_out: handoffOut });
  }

  // ── steps ───────────────────────────────────────────────────────────────────────────────────

  /** A track's steps in execution order. */
  async stepsForTrack(trackId: string): Promise<Step[]> {
    const rows = await this.steps.find({
      where: { track_id: trackId },
      order: { ordinal: 'ASC' },
    });
    return rows.map(toStep);
  }

  /**
   * Lock a track's steps: persist the planned step list as `steps` rows (gap-numbered,
   * `pending`/step `build`). Idempotent across a resume — if rows already exist (the plan locked before
   * the restart) the existing rows are returned untouched, so steps never double-create.
   */
  async lockSteps(
    track: DriverTrack,
    planned: PlannedStep[],
  ): Promise<Step[]> {
    const existing = await this.stepsForTrack(track.id);
    if (existing.length > 0) return existing;
    const rows = planned.map((p, i) =>
      this.steps.create({
        track_id: track.id,
        thread_id: track.threadId,
        org_id: track.orgId,
        ordinal: (i + 1) * ORDINAL_GAP,
        title: p.title,
        brief: p.brief,
        stage: 'build',
        status: 'pending',
      }),
    );
    await this.steps.save(rows);
    return rows.map(toStep);
  }

  /** Advance a step's explicit cursor (`step` + `status`) — the resumable transition. */
  async setStepState(
    stepId: string,
    stage: string,
    status: StepStatus,
  ): Promise<void> {
    await this.steps.update({ id: stepId }, { stage, status });
  }

  /**
   * Persist the batch grouping for a track's steps — the resumable batching cursor. Assigned ONCE,
   * the first time a track executes (all its steps have null `batch_ordinal`); after this a restart
   * reads the stored ordinals and re-groups identically, so a resumed engine session keeps the SAME
   * batch membership (no second `batchSteps` call, no drift). Each tuple is `[stepId, batchOrdinal]`.
   */
  async setBatchOrdinals(assignments: Array<[string, number]>): Promise<void> {
    for (const [stepId, batchOrdinal] of assignments) {
      await this.steps.update({ id: stepId }, { batch_ordinal: batchOrdinal });
    }
  }

  // ── brain read helpers ───────────────────────────────────────────────────────────────────────

  /**
   * R3 — `get_pipeline_state` tool impl. Returns the current build + track state for a thread, or
   * `{ status: 'no_job' }` if the thread hasn't entered the build lifecycle. Used by the in-sandbox
   * AgentSessionManager brain session.
   */
  async getPipelineState(threadId: string, orgId: string): Promise<unknown> {
    const thread = await this.threads.findOne({
      where: { id: threadId, org_id: orgId },
    });
    if (!thread || thread.status === 'open') return { status: 'no_job' };
    const tracks = await this.tracks.find({
      where: { thread_id: thread.id },
      order: { ordinal: 'ASC' },
    });
    // All the thread's steps in one query (avoid N+1), grouped by track for the nav folder tree.
    const steps = await this.steps.find({
      where: { thread_id: thread.id },
      order: { ordinal: 'ASC' },
    });
    const stepsByTrack = new Map<string, StepEntity[]>();
    for (const p of steps) {
      const list = stepsByTrack.get(p.track_id) ?? [];
      list.push(p);
      stepsByTrack.set(p.track_id, list);
    }
    return {
      threadId: thread.id,
      title: thread.title,
      kind: thread.kind,
      status: thread.status,
      decisionRecordId: thread.decision_record_id,
      prUrl: thread.pr_url,
      prNumber: thread.pr_number,
      featureBranch: thread.feature_branch,
      baseBranch: thread.base_branch,
      tracks: tracks.map((s) => ({
        id: s.id,
        ordinal: s.ordinal,
        brief: s.brief,
        type: s.type,
        status: s.status,
        hasPlan: s.plan != null,
        steps: mapBatchedSteps(stepsByTrack.get(s.id) ?? []),
      })),
    };
  }

  /**
   * R3 — `get_decision_record` tool impl. Returns the current decision record for a thread (via the
   * thread's `decision_record_id`), or null. Used by the in-sandbox brain session.
   */
  async getDecisionRecord(threadId: string): Promise<unknown> {
    const thread = await this.threads.findOne({ where: { id: threadId } });
    if (!thread?.decision_record_id) return null;
    const record = await this.records.findOne({
      where: { id: thread.decision_record_id },
    });
    if (!record) return null;
    return {
      id: record.id,
      status: record.status,
      overview: record.overview,
      decisions: record.decisions,
      trackTitles: record.track_titles,
    };
  }

  // ── routing ──────────────────────────────────────────────────────────────────────────────────

  /** Resolve where to post a thread's chatter: the repo coordinate + the real thread id. */
  async route(thread: Thread): Promise<JobRoute> {
    return { channel: thread.repoId, threadTs: thread.id, orgId: thread.orgId };
  }
}

/**
 * Map a track's step rows for the `/pipeline` read model, resolving each step's BATCH so the web can find
 * the batch's transcript. A batch runs as ONE engine turn whose transcript is tagged with the ANCHOR step
 * id (the first/lowest-ordinal step in the batch), so a non-anchor step page must remap to `anchorStepId`
 * before filtering durable phase blocks / choosing the live `phase:<id>` lane. Steps not yet batched
 * (`batch_ordinal` null) anchor to themselves.
 */
function mapBatchedSteps(list: StepEntity[]): Array<{
  id: string;
  ordinal: number;
  title: string | null;
  brief: string;
  stage: string;
  status: string;
  batchOrdinal: number | null;
  anchorStepId: string;
  batchStepIds: string[];
}> {
  const anchorByBatch = new Map<number, string>();
  const idsByBatch = new Map<number, string[]>();
  for (const p of list) {
    if (p.batch_ordinal == null) continue;
    if (!anchorByBatch.has(p.batch_ordinal)) anchorByBatch.set(p.batch_ordinal, p.id);
    const arr = idsByBatch.get(p.batch_ordinal) ?? [];
    arr.push(p.id);
    idsByBatch.set(p.batch_ordinal, arr);
  }
  return list.map((p) => ({
    id: p.id,
    ordinal: p.ordinal,
    title: p.title,
    brief: p.brief,
    stage: p.stage,
    status: p.status,
    batchOrdinal: p.batch_ordinal ?? null,
    anchorStepId: p.batch_ordinal != null ? (anchorByBatch.get(p.batch_ordinal) ?? p.id) : p.id,
    batchStepIds: p.batch_ordinal != null ? (idsByBatch.get(p.batch_ordinal) ?? [p.id]) : [p.id],
  }));
}

// ── row ⇄ domain mappers ─────────────────────────────────────────────────────────────────────────

function toThread(row: ThreadEntity): Thread {
  return {
    id: row.id,
    orgId: row.org_id,
    repoId: row.repo_id,
    origin: row.origin as Thread['origin'],
    surfaceThreadRef: row.surface_thread_ref,
    title: row.title,
    baseBranch: row.base_branch,
    kind: row.kind as Thread['kind'],
    status: row.status as ThreadStatus,
    decisionRecordId: row.decision_record_id,
    featureBranch: row.feature_branch,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTrack(row: TrackEntity): DriverTrack {
  return {
    id: row.id,
    threadId: row.thread_id,
    orgId: row.org_id,
    ordinal: row.ordinal,
    brief: row.brief,
    plan: row.plan,
    handoffIn: row.handoff_in,
    handoffOut: row.handoff_out,
    status: row.status as TrackStatus,
  };
}

function toStep(row: StepEntity): Step {
  return {
    id: row.id,
    trackId: row.track_id,
    threadId: row.thread_id,
    ordinal: row.ordinal,
    title: row.title,
    brief: row.brief,
    stage: row.stage,
    status: row.status as StepStatus,
    sessionId: row.session_id,
    batchOrdinal: row.batch_ordinal ?? null,
  };
}

function toRecord(row: DecisionRecordEntity): DecisionRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    repoId: row.repo_id,
    threadId: row.thread_id,
    status: row.status as DecisionRecord['status'],
    overview: row.overview,
    decisions: row.decisions as Decision[],
    trackTitles: row.track_titles,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  };
}
