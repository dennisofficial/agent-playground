import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  Decision,
  DecisionRecord,
  Job,
  JobStatus,
  Phase,
  PhaseStatus,
  Section,
  SectionStatus,
} from '../domain';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import {
  AtlasDecisionRecord,
  AtlasJob,
  AtlasPhase,
  AtlasSection,
  AtlasThread,
} from '../persistence/entities';
import type { PlannedPhase } from './planner-llm';

/** Phases are gap-numbered (10, 20, 30…) so a re-plan can splice without renumbering. */
const ORDINAL_GAP = 10;

/**
 * The section shape the driver works with — the domain `Section` plus the denormalized `orgId` the
 * phase rows need (phases carry `org_id`). The driver never reaches a repository, so the store carries
 * the one extra field rather than the driver re-querying the job for it.
 */
export type DriverSection = Section & { orgId: string };

/** Where to post a job's chatter — the project's channel coordinate + the thread root ts. */
export interface JobRoute {
  channel: string | null;
  threadTs: string | null;
  /** The tenant to post as (selects the workspace credentials). Always set by `route()`; optional only
   *  so in-memory test fixtures (fake surface ignores it) can omit it. */
  orgId?: string;
}

/**
 * W4 — the DRIVER's persistence. The single place the section driver reads/writes the section + phase
 * rows (and resolves the decision record + thread route) on the 'atlas' connection. Keeps `SectionDriver`
 * a legible pipeline that speaks DOMAIN shapes (`Section`, `Phase`) — this maps them to/from rows and
 * owns the explicit, resumable `status`/`step` transitions.
 *
 * The brain (W3) already wrote the high-level section BRIEFS (`pending`, no plan). This fills the
 * just-in-time detail: the section `plan`, its phase rows, and the status cursors the driver re-enters
 * at on restart. Zero v1 imports.
 */
@Injectable()
export class DriverStoreService {
  constructor(
    @InjectRepository(AtlasJob, ATLAS_CONNECTION)
    private readonly jobs: Repository<AtlasJob>,
    @InjectRepository(AtlasSection, ATLAS_CONNECTION)
    private readonly sections: Repository<AtlasSection>,
    @InjectRepository(AtlasPhase, ATLAS_CONNECTION)
    private readonly phases: Repository<AtlasPhase>,
    @InjectRepository(AtlasDecisionRecord, ATLAS_CONNECTION)
    private readonly records: Repository<AtlasDecisionRecord>,
    @InjectRepository(AtlasThread, ATLAS_CONNECTION)
    private readonly threads: Repository<AtlasThread>,
  ) {}

  // ── jobs ─────────────────────────────────────────────────────────────────────────────────────

  /** Load one job as the domain shape. */
  async loadJob(jobId: string): Promise<Job> {
    return toJob(await this.jobs.findOneOrFail({ where: { id: jobId } }));
  }

  /** Every job currently in `running` — the boot-reconciliation worklist. */
  async runningJobs(): Promise<Job[]> {
    const rows = await this.jobs.find({ where: { status: 'running' } });
    return rows.map(toJob);
  }

  async setJobStatus(jobId: string, status: JobStatus): Promise<void> {
    await this.jobs.update({ id: jobId }, { status });
  }

  /** Record the feature branch all sections stack on (set once, when the sandbox is cut). */
  async setFeatureBranch(jobId: string, branch: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { feature_branch: branch });
  }

  /** Record the opened PR url + flip the job to its terminal `pr_ready`-equivalent (`done`). */
  async setPrReady(jobId: string, prUrl: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { pr_url: prUrl, status: 'done' });
  }

  // ── decision record ────────────────────────────────────────────────────────────────────────────

  /** The locked decision record for a job — the planner + gate's grounding. Null if the job has none. */
  async decisionRecord(decisionRecordId: string | null): Promise<DecisionRecord | null> {
    if (!decisionRecordId) return null;
    const row = await this.records.findOne({ where: { id: decisionRecordId } });
    return row ? toRecord(row) : null;
  }

  // ── sections ─────────────────────────────────────────────────────────────────────────────────

  /** The job's sections in execution order (ORDER BY ordinal). */
  async sectionsForJob(jobId: string): Promise<DriverSection[]> {
    const rows = await this.sections.find({
      where: { job_id: jobId },
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
   * Lock a section's phases: persist the planned phase list as `atlas_phases` rows (gap-numbered,
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
        job_id: section.jobId,
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
   * R3 — `get_pipeline_state` tool impl. Returns the current job + section state for a thread, or
   * null if no job is on this thread. Used by the in-sandbox AgentSessionManager brain session.
   */
  async getPipelineState(threadId: string, orgId: string): Promise<unknown> {
    const job = await this.jobs.findOne({
      where: { thread_id: threadId, org_id: orgId },
      order: { created_at: 'DESC' },
    });
    if (!job) return { status: 'no_job' };
    const sections = await this.sections.find({
      where: { job_id: job.id },
      order: { ordinal: 'ASC' },
    });
    return {
      jobId: job.id,
      title: job.title,
      kind: job.kind,
      status: job.status,
      decisionRecordId: job.decision_record_id,
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
   * most recent job's decision_record_id), or null. Used by the in-sandbox brain session.
   */
  async getDecisionRecord(threadId: string): Promise<unknown> {
    const job = await this.jobs.findOne({
      where: { thread_id: threadId },
      order: { created_at: 'DESC' },
    });
    if (!job?.decision_record_id) return null;
    const record = await this.records.findOne({ where: { id: job.decision_record_id } });
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

  /** Resolve where to post a job's chatter: the repo coordinate + the real thread id. */
  async route(job: Job): Promise<JobRoute> {
    return { channel: job.repoId, threadTs: job.threadId, orgId: job.orgId };
  }
}

// ── row ⇄ domain mappers ─────────────────────────────────────────────────────────────────────────

function toJob(row: AtlasJob): Job {
  return {
    id: row.id,
    orgId: row.org_id,
    repoId: row.repo_id,
    threadId: row.thread_id,
    kind: row.kind as Job['kind'],
    status: row.status as JobStatus,
    title: row.title,
    decisionRecordId: row.decision_record_id,
    featureBranch: row.feature_branch,
    prUrl: row.pr_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSection(row: AtlasSection): DriverSection {
  return {
    id: row.id,
    jobId: row.job_id,
    orgId: row.org_id,
    ordinal: row.ordinal,
    brief: row.brief,
    plan: row.plan,
    handoffIn: row.handoff_in,
    handoffOut: row.handoff_out,
    status: row.status as SectionStatus,
  };
}

function toPhase(row: AtlasPhase): Phase {
  return {
    id: row.id,
    sectionId: row.section_id,
    jobId: row.job_id,
    ordinal: row.ordinal,
    title: row.title,
    brief: row.brief,
    step: row.step,
    status: row.status as PhaseStatus,
    sessionId: row.session_id,
  };
}

function toRecord(row: AtlasDecisionRecord): DecisionRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    repoId: row.repo_id,
    jobId: row.job_id,
    status: row.status as DecisionRecord['status'],
    overview: row.overview,
    decisions: row.decisions as Decision[],
    sectionBriefs: row.section_briefs,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  };
}
