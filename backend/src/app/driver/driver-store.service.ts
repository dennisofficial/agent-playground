import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  Decision,
  DecisionRecord,
  Phase,
  PhaseStatus,
  Section,
  SectionStatus,
  Thread,
  ThreadStatus,
} from '../domain';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  PhaseEntity,
  SectionEntity,
  ThreadEntity,
} from '../persistence/entities';
import type { PlannedPhase } from './planner-llm';

/** Phases are gap-numbered (10, 20, 30…) so a re-plan can splice without renumbering. */
const ORDINAL_GAP = 10;

/**
 * The section shape the driver works with — the domain `Section` plus the denormalized `orgId` the phase
 * rows need (phases carry `org_id`). The driver never reaches a repository, so the store carries the one
 * extra field rather than the driver re-querying the thread for it.
 */
export type DriverSection = Section & { orgId: string };

/** Where to post a thread's chatter — the repo coordinate + the real thread id. */
export interface JobRoute {
  channel: string | null;
  threadTs: string | null;
  /** The tenant to post as (selects the workspace credentials). Always set by `route()`; optional only
   *  so in-memory test fixtures (fake surface ignores it) can omit it. */
  orgId?: string;
}

/**
 * W4 — the DRIVER's persistence. The single place the section driver reads/writes the section + phase
 * rows (and resolves the decision record + thread route) on the 'app' connection. The THREAD is the build
 * unit (the former `jobs` layer is folded into it), so the "job" methods here operate on the thread row.
 * Keeps `SectionDriver` a legible pipeline that speaks DOMAIN shapes (`Section`, `Phase`) — this maps
 * them to/from rows and owns the explicit, resumable `status`/`step` transitions.
 *
 * The brain (W3) already wrote the high-level section BRIEFS (`pending`, no plan). This fills the
 * just-in-time detail: the section `plan`, its phase rows, and the status cursors the driver re-enters
 * at on restart. Zero v1 imports.
 */
@Injectable()
export class DriverStoreService {
  constructor(
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(SectionEntity, DB_CONNECTION)
    private readonly sections: Repository<SectionEntity>,
    @InjectRepository(PhaseEntity, DB_CONNECTION)
    private readonly phases: Repository<PhaseEntity>,
    @InjectRepository(DecisionRecordEntity, DB_CONNECTION)
    private readonly records: Repository<DecisionRecordEntity>,
  ) {}

  // ── thread (the build unit) ────────────────────────────────────────────────────────────────────

  /** Load one thread as the domain shape. */
  async loadJob(threadId: string): Promise<Thread> {
    return toThread(await this.threads.findOneOrFail({ where: { id: threadId } }));
  }

  /** Every thread currently in `running` — the boot-reconciliation worklist. */
  async runningJobs(): Promise<Thread[]> {
    const rows = await this.threads.find({ where: { status: 'running' } });
    return rows.map(toThread);
  }

  async setJobStatus(threadId: string, status: ThreadStatus): Promise<void> {
    await this.threads.update({ id: threadId }, { status });
  }

  /** Record the feature branch all sections stack on (set once, when the sandbox is cut). */
  async setFeatureBranch(threadId: string, branch: string): Promise<void> {
    await this.threads.update({ id: threadId }, { feature_branch: branch });
  }

  /** Record the opened PR (url + number) + flip the thread to its terminal `done`. */
  async setPrReady(threadId: string, prUrl: string, prNumber?: number): Promise<void> {
    await this.threads.update(
      { id: threadId },
      { pr_url: prUrl, ...(prNumber != null ? { pr_number: prNumber } : {}), status: 'done' },
    );
  }

  // ── decision record ────────────────────────────────────────────────────────────────────────────

  /** The locked decision record for a thread — the planner + gate's grounding. Null if none. */
  async decisionRecord(decisionRecordId: string | null): Promise<DecisionRecord | null> {
    if (!decisionRecordId) return null;
    const row = await this.records.findOne({ where: { id: decisionRecordId } });
    return row ? toRecord(row) : null;
  }

  // ── sections ─────────────────────────────────────────────────────────────────────────────────

  /** The thread's sections in execution order (ORDER BY ordinal). */
  async sectionsForJob(threadId: string): Promise<DriverSection[]> {
    const rows = await this.sections.find({
      where: { thread_id: threadId },
      order: { ordinal: 'ASC' },
    });
    return rows.map(toSection);
  }

  async setSectionStatus(sectionId: string, status: SectionStatus): Promise<void> {
    await this.sections.update({ id: sectionId }, { status });
  }

  /** Persist the just-in-time plan prose + the prior section's handoff onto the section. */
  async setSectionPlan(sectionId: string, plan: string, handoffIn: string | null): Promise<void> {
    await this.sections.update({ id: sectionId }, { plan, handoff_in: handoffIn });
  }

  /** Record the section's handoff note for the next section (set when the section is done). */
  async setSectionHandoffOut(sectionId: string, handoffOut: string): Promise<void> {
    await this.sections.update({ id: sectionId }, { handoff_out: handoffOut });
  }

  // ── phases ───────────────────────────────────────────────────────────────────────────────────

  /** A section's phases in execution order. */
  async phasesForSection(sectionId: string): Promise<Phase[]> {
    const rows = await this.phases.find({
      where: { section_id: sectionId },
      order: { ordinal: 'ASC' },
    });
    return rows.map(toPhase);
  }

  /**
   * Lock a section's phases: persist the planned phase list as `phases` rows (gap-numbered,
   * `pending`/step `build`). Idempotent across a resume — if rows already exist (the plan locked before
   * the restart) the existing rows are returned untouched, so phases never double-create.
   */
  async lockPhases(
    section: DriverSection,
    planned: PlannedPhase[],
  ): Promise<Phase[]> {
    const existing = await this.phasesForSection(section.id);
    if (existing.length > 0) return existing;
    const rows = planned.map((p, i) =>
      this.phases.create({
        section_id: section.id,
        thread_id: section.threadId,
        org_id: section.orgId,
        ordinal: (i + 1) * ORDINAL_GAP,
        title: p.title,
        brief: p.brief,
        step: 'build',
        status: 'pending',
      }),
    );
    await this.phases.save(rows);
    return rows.map(toPhase);
  }

  /** Advance a phase's explicit cursor (`step` + `status`) — the resumable transition. */
  async setPhaseState(phaseId: string, step: string, status: PhaseStatus): Promise<void> {
    await this.phases.update({ id: phaseId }, { step, status });
  }

  // ── brain read helpers ───────────────────────────────────────────────────────────────────────

  /**
   * R3 — `get_pipeline_state` tool impl. Returns the current build + section state for a thread, or
   * `{ status: 'no_job' }` if the thread hasn't entered the build lifecycle. Used by the in-sandbox
   * AgentSessionManager brain session.
   */
  async getPipelineState(threadId: string, orgId: string): Promise<unknown> {
    const thread = await this.threads.findOne({ where: { id: threadId, org_id: orgId } });
    if (!thread || thread.status === 'open') return { status: 'no_job' };
    const sections = await this.sections.find({
      where: { thread_id: thread.id },
      order: { ordinal: 'ASC' },
    });
    return {
      threadId: thread.id,
      title: thread.title,
      kind: thread.kind,
      status: thread.status,
      decisionRecordId: thread.decision_record_id,
      sections: sections.map((s) => ({
        id: s.id,
        ordinal: s.ordinal,
        brief: s.brief,
        status: s.status,
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
    const record = await this.records.findOne({ where: { id: thread.decision_record_id } });
    if (!record) return null;
    return {
      id: record.id,
      status: record.status,
      overview: record.overview,
      decisions: record.decisions,
      sectionBriefs: record.section_briefs,
    };
  }

  // ── routing ──────────────────────────────────────────────────────────────────────────────────

  /** Resolve where to post a thread's chatter: the repo coordinate + the real thread id. */
  async route(thread: Thread): Promise<JobRoute> {
    return { channel: thread.repoId, threadTs: thread.id, orgId: thread.orgId };
  }
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

function toSection(row: SectionEntity): DriverSection {
  return {
    id: row.id,
    threadId: row.thread_id,
    orgId: row.org_id,
    ordinal: row.ordinal,
    brief: row.brief,
    spec: row.spec,
    plan: row.plan,
    handoffIn: row.handoff_in,
    handoffOut: row.handoff_out,
    status: row.status as SectionStatus,
  };
}

function toPhase(row: PhaseEntity): Phase {
  return {
    id: row.id,
    sectionId: row.section_id,
    threadId: row.thread_id,
    ordinal: row.ordinal,
    title: row.title,
    brief: row.brief,
    step: row.step,
    status: row.status as PhaseStatus,
    sessionId: row.session_id,
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
    sectionBriefs: row.section_briefs,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  };
}
