import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BrainGateway } from '../brain-gateway';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobDependencyEntity, JobEntity } from '../persistence/entities';

// A job can be BLOCKED only from a pre-build conversational state; 'blocked' is included so a
// multi-blocker create_job can add its edges one at a time (the first live blocker parks it; adding
// the next blocker to an already-blocked job just adds an edge and it stays blocked).
const BLOCKABLE_STATUSES = new Set(['open', 'planning', 'plan_review', 'awaiting_approval', 'blocked']);

/** How a resolved blocker actually resolved — fed into {@link JobDependencyService.onBlockerResolved}. */
export type BlockerResolution = 'merged' | 'closed_unmerged' | 'cancelled' | 'deleted';

/** A non-terminal-safe classification of a blocker (excludes the in-flight `merged` case). */
type NonLandedResolution = Exclude<BlockerResolution, 'merged'>;

const HUMAN_RESOLUTION: Record<NonLandedResolution, string> = {
  closed_unmerged: 'PR closed without merging',
  cancelled: 'job cancelled',
  deleted: 'job deleted',
};

/** A blocker row of a job — the compact projection `blockersOf` returns. */
export interface JobBlockerRow {
  jobId: string;
  title: string | null;
  prState: string | null;
  status: string;
}

/** A dependent (blocked) job row — the compact projection `dependentsOf` returns. */
export interface DependentJobRow {
  id: string;
  org_id: string;
  repo_id: string;
  status: string;
  blocked_seed_message: string | null;
}

/**
 * JOB DEPENDENCY SERVICE — the single source of truth for job-to-job "blocked by" edges and the wake
 * funnel that fires when a blocker resolves. Three surfaces feed edges here (manual link, `create_job`
 * dependsOn, ticket-derived job links); all three share the same guard/park/wake semantics, so the rule
 * lives ONCE.
 *
 * A dependency is a LIVE block only while its blocker hasn't reached a terminal outcome
 * (`isTerminalBlocker`). Once every blocker on a `blocked` job is terminal, the job is unparked and its
 * brain is woken — either replaying its stored born-blocked seed, or resuming its existing session with
 * a synthetic wake stimulus. See `onBlockerResolved` for the funnel and `addDependency`/`removeDependency`
 * for the two ways an edge's live-block state changes.
 */
@Injectable()
export class JobDependencyService {
  private readonly logger = new Logger(JobDependencyService.name);

  constructor(
    @InjectRepository(JobDependencyEntity, DB_CONNECTION)
    private readonly deps: Repository<JobDependencyEntity>,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
    private readonly brainGateway: BrainGateway,
  ) {}

  /**
   * Is this blocker DONE for dependency purposes, decided purely from its PERSISTED state (never from a
   * transient resolution arg passed by a caller)? True when the blocker is absent/deleted, its PR merged
   * or closed (a closed-unmerged PR is still terminal — the dependent must not strand waiting for a merge
   * that will never come), or the job itself was cancelled. A blocker that reached build-`done` but whose
   * PR is still open/unopened is NOT terminal — it must actually merge (or close) first.
   */
  isTerminalBlocker(job: JobEntity | null): boolean {
    if (!job) return true;
    return this.isTerminalState(job.pr_state, job.status);
  }

  private isTerminalState(prState: string | null, status: string): boolean {
    return prState === 'merged' || prState === 'closed' || status === 'cancelled';
  }

  /** Add an advisory "blocked by" edge: `jobId` depends on `dependsOnJobId`. Parks `jobId` if the blocker
   *  is still live. `seed` (born-blocked only) is the first-turn message to replay once unblocked. */
  async addDependency(args: {
    orgId: string;
    repoId: string;
    jobId: string;
    dependsOnJobId: string;
    seed?: string | null;
  }): Promise<{ blocked: boolean }> {
    const { orgId, repoId, jobId, dependsOnJobId } = args;
    if (jobId === dependsOnJobId) {
      throw new BadRequestException('a job cannot depend on itself');
    }

    // Both endpoints must exist in this org+repo (cross-repo edges are rejected).
    const [dependent, blocker] = await Promise.all([
      this.jobs.findOne({ where: { id: jobId, org_id: orgId, repo_id: repoId } }),
      this.jobs.findOne({ where: { id: dependsOnJobId, org_id: orgId, repo_id: repoId } }),
    ]);
    if (!dependent || !blocker) {
      throw new NotFoundException('job not found in this repo');
    }

    if (!BLOCKABLE_STATUSES.has(dependent.status)) {
      throw new BadRequestException(
        `can't block a job that is already building or finished (status: ${dependent.status}); unblock or finish it first`,
      );
    }

    if (await this.wouldCycle(repoId, jobId, dependsOnJobId)) {
      throw new BadRequestException('that dependency would create a cycle');
    }

    // Idempotent: the unique (job_id, depends_on_job_id) makes a repeat insert a conflict.
    await this.deps
      .createQueryBuilder()
      .insert()
      .values({ org_id: orgId, repo_id: repoId, job_id: jobId, depends_on_job_id: dependsOnJobId })
      .orIgnore()
      .execute();

    // The blocker already resolved — the edge is recorded for history, but it adds no LIVE block.
    if (this.isTerminalBlocker(blocker)) {
      return { blocked: dependent.status === 'blocked' };
    }

    const patch: Partial<JobEntity> = { status: 'blocked' };
    // Born-blocked seed: a manual/link block of an already-running job passes no seed, so it resumes
    // its existing session on wake instead of replaying a first message that was never its own.
    if (args.seed != null) patch.blocked_seed_message = args.seed;
    await this.jobs.update({ id: jobId }, patch);
    return { blocked: true };
  }

  /** Remove a "blocked by" edge; re-evaluates the dependent and wakes it if every remaining blocker is
   *  now terminal. Idempotent — removing an absent edge is a no-op, not an error. */
  async removeDependency(args: {
    orgId: string;
    repoId: string;
    jobId: string;
    dependsOnJobId: string;
  }): Promise<void> {
    const { orgId, repoId, jobId, dependsOnJobId } = args;
    await this.deps.delete({
      org_id: orgId,
      repo_id: repoId,
      job_id: jobId,
      depends_on_job_id: dependsOnJobId,
    });

    const blockers = await this.blockersOf(jobId);
    const allTerminal = blockers.every((b) => this.isTerminalState(b.prState, b.status));
    if (allTerminal) {
      await this.unblockAndWake(jobId, null);
    }
  }

  /** The blocker jobs of `jobId` (what it depends on), as a compact row per blocker. */
  async blockersOf(jobId: string): Promise<JobBlockerRow[]> {
    const rows: Array<{ jobId: string; title: string | null; prState: string | null; status: string }> =
      await this.dataSource.query(
        `SELECT j.id AS "jobId", j.title AS title, j.pr_state AS "prState", j.status AS status
           FROM job_dependencies d
           JOIN jobs j ON j.id = d.depends_on_job_id
          WHERE d.job_id = $1`,
        [jobId],
      );
    return rows;
  }

  /** The dependent (blocked) jobs of `blockerJobId` — jobs that depend ON it. */
  async dependentsOf(blockerJobId: string): Promise<DependentJobRow[]> {
    const rows: DependentJobRow[] = await this.dataSource.query(
      `SELECT j.id, j.org_id, j.repo_id, j.status, j.blocked_seed_message
         FROM job_dependencies d
         JOIN jobs j ON j.id = d.job_id
        WHERE d.depends_on_job_id = $1`,
      [blockerJobId],
    );
    return rows;
  }

  /**
   * THE WAKE FUNNEL: called once a blocker job reaches a terminal outcome. Finds every job blocked on it,
   * and for each still-`blocked` dependent whose OTHER blockers (if any) are also terminal, conditionally
   * unparks it and wakes its brain. Fail-soft PER dependent — one bad wake must never block the others.
   */
  async onBlockerResolved(blockerJobId: string, resolution: BlockerResolution): Promise<void> {
    const dependents = await this.dependentsOf(blockerJobId);
    for (const dependent of dependents) {
      if (dependent.status !== 'blocked') continue;
      try {
        await this.wakeDependentIfAllTerminal(dependent, blockerJobId, resolution);
      } catch (err) {
        this.logger.warn(`onBlockerResolved: wake failed for dependent=${dependent.id}: ${err}`);
      }
    }
  }

  private async wakeDependentIfAllTerminal(
    dependent: DependentJobRow,
    blockerJobId: string,
    resolution: BlockerResolution,
  ): Promise<void> {
    const blockers = await this.blockersOf(dependent.id);
    // The blocker resolving RIGHT NOW is treated as terminal unconditionally — required for the
    // `deleted` path, where its row still exists at call time and won't yet look terminal from state.
    const allTerminal = blockers.every(
      (b) => b.jobId === blockerJobId || this.isTerminalState(b.prState, b.status),
    );
    if (!allTerminal) return; // a still-open sibling blocker keeps it parked.

    const upd = await this.jobs
      .createQueryBuilder()
      .update()
      .set({ status: 'open' })
      .where('id = :id AND status = :blocked', { id: dependent.id, blocked: 'blocked' })
      .execute();
    if (!upd.affected) return; // lost the race — already unblocked.

    const note = this.renderDidntLandNote(blockers, blockerJobId, resolution);
    await this.brainGateway
      .wakeUnblockedJob(dependent.id, dependent.org_id, dependent.repo_id, {
        seed: dependent.blocked_seed_message,
        note,
      })
      .catch((err) => this.logger.warn(`wakeUnblockedJob failed for job=${dependent.id}: ${err}`));
    await this.jobs.update({ id: dependent.id }, { blocked_seed_message: null });
  }

  /** How a blocker OTHER than the one resolving right now resolved, from its persisted state. Only
   *  called for blockers already known terminal, so a non-merged/closed PR state means `status === 'cancelled'`. */
  private classifyResolvedBlocker(prState: string | null): NonLandedResolution | 'merged' {
    if (prState === 'merged') return 'merged';
    if (prState === 'closed') return 'closed_unmerged';
    return 'cancelled';
  }

  /** The "didn't land" note (d1) for any blocker that resolved WITHOUT merging, or null if all merged. */
  private renderDidntLandNote(
    blockers: JobBlockerRow[],
    blockerJobId: string,
    resolution: BlockerResolution,
  ): string | null {
    const nonLanded = blockers
      .map((b) => ({
        title: b.title,
        jobId: b.jobId,
        how: b.jobId === blockerJobId ? resolution : this.classifyResolvedBlocker(b.prState),
      }))
      .filter((b): b is { title: string | null; jobId: string; how: NonLandedResolution } => b.how !== 'merged');

    if (nonLanded.length === 0) return null;
    return (
      `Heads up — your work was blocked on ${nonLanded.length} job(s) that did NOT merge:\n` +
      nonLanded.map((b) => `  • "${b.title ?? b.jobId}" (${HUMAN_RESOLUTION[b.how]})`).join('\n') +
      `\nThe base branch may not contain those changes, so re-check your plan's assumptions before building.`
    );
  }

  /** Conditional unblock + wake used by the manual-unblock path (`removeDependency`); `note` is null since
   *  there's no blocker resolution to report. */
  private async unblockAndWake(jobId: string, note: string | null): Promise<void> {
    const upd = await this.jobs
      .createQueryBuilder()
      .update()
      .set({ status: 'open' })
      .where('id = :id AND status = :blocked', { id: jobId, blocked: 'blocked' })
      .execute();
    if (!upd.affected) return;

    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job) return;
    await this.brainGateway
      .wakeUnblockedJob(jobId, job.org_id, job.repo_id, { seed: job.blocked_seed_message, note })
      .catch((err) => this.logger.warn(`wakeUnblockedJob failed for job=${jobId}: ${err}`));
    await this.jobs.update({ id: jobId }, { blocked_seed_message: null });
  }

  /**
   * Would adding "jobId depends on dependsOnJobId" create a cycle? It does iff dependsOnJobId already
   * (transitively) depends on jobId — i.e. jobId is reachable from dependsOnJobId by following depends-on
   * edges. Repo-scoped recursive walk.
   */
  private async wouldCycle(repoId: string, jobId: string, dependsOnJobId: string): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query(
      `WITH RECURSIVE reach(id) AS (
         SELECT depends_on_job_id FROM job_dependencies
           WHERE repo_id = $1 AND job_id = $2
         UNION
         SELECT d.depends_on_job_id FROM job_dependencies d
           JOIN reach r ON d.job_id = r.id
           WHERE d.repo_id = $1
       )
       SELECT 1 FROM reach WHERE id = $3 LIMIT 1`,
      [repoId, dependsOnJobId, jobId],
    );
    return rows.length > 0;
  }
}
