import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type { UnblockBlockerInfo } from '../../_shared/domain/message';
import { DataSource, Repository } from 'typeorm';
import { BrainGateway } from '../brain-gateway/brain-gateway.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobDependencyEntity, JobEntity } from '../persistence/entities';
import { TurnRegistry } from '../sandbox/turn-registry.service';
import { StimulusStoreService } from '../stimulus/stimulus-store.service';

const BLOCKABLE_STATUSES = new Set([
  'open',
  'planning',
  'plan_review',
  'awaiting_approval',
  'blocked',
]);
const TERMINAL_BLOCKER_STATUSES = ['cancelled', 'deleting', 'archived'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new BadRequestException('dependsOn job id must be a UUID');
  }
}

export type BlockerResolution = 'merged' | 'closed_unmerged' | 'cancelled' | 'deleted' | 'archived';

type NonLandedResolution = Exclude<BlockerResolution, 'merged'>;

export type JobBlockerRow = {
  jobId: string;
  title: string | null;
  prState: string | null;
  status: string;
};

export type DependentJobRow = {
  id: string;
  org_id: string;
  repo_id: string;
  status: string;
};

export type JobListRow = {
  id: string;
  title: string | null;
  status: string;
  prState: string | null;
  activity: string;
  kind: string | null;
  buildPath: 'direct' | 'plan' | null;
  prNumber: number | null;
  createdAt: Date;
};

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
    private readonly stimulusStore: StimulusStoreService,
    @Optional()
    private readonly turnRegistry?: TurnRegistry,
  ) {}

  isTerminalBlocker(job: JobEntity | null): boolean {
    if (!job) return true;
    return this.isTerminalState(job.pr_state, job.status);
  }

  private isTerminalState(prState: string | null, status: string): boolean {
    return (
      prState === 'merged' || prState === 'closed' || TERMINAL_BLOCKER_STATUSES.includes(status)
    );
  }

  async listJobs(args: {
    orgId: string;
    repoId: string;
    status?: string;
    query?: string;
    limit?: number;
  }): Promise<JobListRow[]> {
    const limit = Math.min(Math.max(1, Math.trunc(args.limit ?? 30)), 100);
    const qb = this.jobs
      .createQueryBuilder('j')
      .where('j.org_id = :orgId AND j.repo_id = :repoId', {
        orgId: args.orgId,
        repoId: args.repoId,
      });

    const status = args.status?.trim().toLowerCase();
    if (status && status !== 'all') {
      qb.andWhere('j.status = :status', { status }); // exact-status filter (bypasses terminal exclusion)
    } else if (!status) {
      qb.andWhere(`j.pr_state IS DISTINCT FROM 'merged'`)
        .andWhere(`j.pr_state IS DISTINCT FROM 'closed'`)
        .andWhere('j.status NOT IN (:...terminalBlockerStatuses)', {
          terminalBlockerStatuses: TERMINAL_BLOCKER_STATUSES,
        });
    } // status === 'all' → no status/terminal filter

    const q = args.query?.trim();
    if (q) qb.andWhere('j.title ILIKE :q', { q: `%${q}%` });

    const rows = await qb.orderBy('j.created_at', 'DESC').take(limit).getMany();
    return rows.map((j) => ({
      id: j.id,
      title: j.title,
      status: j.status,
      prState: j.pr_state,
      activity: j.activity,
      kind: j.kind,
      buildPath: j.build_path,
      prNumber: j.pr_number,
      createdAt: j.created_at,
    }));
  }

  async assertDependenciesValid(args: {
    orgId: string;
    repoId: string;
    dependsOnJobIds: string[];
  }): Promise<void> {
    for (const dependsOnJobId of args.dependsOnJobIds) {
      assertUuid(dependsOnJobId);
      const blocker = await this.jobs.findOne({
        where: { id: dependsOnJobId, org_id: args.orgId, repo_id: args.repoId },
      });
      if (!blocker) throw new NotFoundException('job not found in this repo');
    }
  }

  async addDependency(args: {
    orgId: string;
    repoId: string;
    jobId: string;
    dependsOnJobId: string;
    seed?: string | null;
  }): Promise<{ blocked: boolean }> {
    const { orgId, repoId, jobId, dependsOnJobId } = args;
    assertUuid(dependsOnJobId);
    if (jobId === dependsOnJobId) {
      throw new BadRequestException('a job cannot depend on itself');
    }

    const [dependent, blocker] = await Promise.all([
      this.jobs.findOne({
        where: { id: jobId, org_id: orgId, repo_id: repoId },
      }),
      this.jobs.findOne({
        where: { id: dependsOnJobId, org_id: orgId, repo_id: repoId },
      }),
    ]);
    if (!dependent || !blocker) {
      throw new NotFoundException('job not found in this repo');
    }

    if (!BLOCKABLE_STATUSES.has(dependent.status)) {
      throw new BadRequestException(
        `can't block a job that is already building or finished (status: ${dependent.status}); unblock or finish it first`,
      );
    }

    if (dependent.activity === 'turn') {
      throw new BadRequestException(
        "can't block a job while its brain is currently running; wait for it to stop before blocking it",
      );
    }

    const liveTurn = await this.turnRegistry?.runningBrainTurn(jobId).catch(() => null);
    if (liveTurn?.turn_id) {
      throw new BadRequestException(
        "can't block a job while its brain is currently running; wait for it to stop before blocking it",
      );
    }

    if (await this.wouldCycle(repoId, jobId, dependsOnJobId)) {
      throw new BadRequestException('that dependency would create a cycle');
    }

    await this.deps
      .createQueryBuilder()
      .insert()
      .values({
        org_id: orgId,
        repo_id: repoId,
        job_id: jobId,
        depends_on_job_id: dependsOnJobId,
      })
      .orIgnore()
      .execute();

    if (this.isTerminalBlocker(blocker)) {
      return { blocked: dependent.status === 'blocked' };
    }

    await this.jobs.update({ id: jobId }, { status: 'blocked' });
    if (args.seed != null) {
      await this.stimulusStore.recordBornBlockedSeedsIfAbsent({
        orgId,
        repoId,
        jobId,
        brief: args.seed,
        createdBy: dependent.created_by,
      });
    } else if (dependent.status !== 'blocked') {
      await this.stimulusStore.recordBlockedNoteIfAbsent({
        orgId,
        repoId,
        jobId,
      });
    }
    return { blocked: true };
  }

  async removeDependency(args: {
    orgId: string;
    repoId: string;
    jobId: string;
    dependsOnJobId: string;
  }): Promise<void> {
    const { orgId, repoId, jobId, dependsOnJobId } = args;
    const removed = await this.jobs.findOne({ where: { id: dependsOnJobId } });
    await this.deps.delete({
      org_id: orgId,
      repo_id: repoId,
      job_id: jobId,
      depends_on_job_id: dependsOnJobId,
    });

    const blockers = await this.blockersOf(jobId);
    const allTerminal = blockers.every((b) => this.isTerminalState(b.prState, b.status));
    if (allTerminal) {
      const infos: UnblockBlockerInfo[] = [
        ...(removed
          ? [
              {
                jobId: removed.id,
                title: removed.title,
                how: 'removed' as const,
              },
            ]
          : []),
        ...this.classifiedBlockerInfos(blockers),
      ];
      await this.unblockAndWake(jobId, infos);
    }
  }

  async reconcileBlockedJob(jobId: string): Promise<boolean> {
    const blockers = await this.blockersOf(jobId);
    const allTerminal = blockers.every((b) => this.isTerminalState(b.prState, b.status));
    if (!allTerminal) return false;
    return this.unblockAndWake(jobId, this.classifiedBlockerInfos(blockers));
  }

  async blockersOf(jobId: string): Promise<JobBlockerRow[]> {
    const rows: Array<{
      jobId: string;
      title: string | null;
      prState: string | null;
      status: string;
    }> = await this.dataSource.query(
      `SELECT j.id AS "jobId", j.title AS title, j.pr_state AS "prState", j.status AS status
           FROM job_dependencies d
           JOIN jobs j ON j.id = d.depends_on_job_id
          WHERE d.job_id = $1`,
      [jobId],
    );
    return rows;
  }

  async blockersOfManyBlocked(jobIds: string[]): Promise<Map<string, JobBlockerRow[]>> {
    const map = new Map<string, JobBlockerRow[]>();
    if (jobIds.length === 0) return map;
    const rows: Array<JobBlockerRow & { dependentId: string }> = await this.dataSource.query(
      `SELECT d.job_id AS "dependentId", j.id AS "jobId", j.title AS title, j.pr_state AS "prState", j.status AS status
         FROM job_dependencies d
         JOIN jobs j ON j.id = d.depends_on_job_id
        WHERE d.job_id = ANY($1)`,
      [jobIds],
    );
    for (const r of rows) {
      const { dependentId, ...blocker } = r;
      const list = map.get(dependentId) ?? [];
      list.push(blocker);
      map.set(dependentId, list);
    }
    return map;
  }

  async dependentsOf(blockerJobId: string): Promise<DependentJobRow[]> {
    const rows: DependentJobRow[] = await this.dataSource.query(
      `SELECT j.id, j.org_id, j.repo_id, j.status
         FROM job_dependencies d
         JOIN jobs j ON j.id = d.job_id
        WHERE d.depends_on_job_id = $1`,
      [blockerJobId],
    );
    return rows;
  }

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
    const allTerminal = blockers.every(
      (b) => b.jobId === blockerJobId || this.isTerminalState(b.prState, b.status),
    );
    if (!allTerminal) return; // a still-open sibling blocker keeps it parked.

    const blockerInfos = this.resolvedBlockerInfos(blockers, blockerJobId, resolution);
    await this.recordUnblockNoteThenPump(
      dependent.id,
      dependent.org_id,
      dependent.repo_id,
      blockerInfos,
    );
  }

  // The blocked→open flip is an ATOMIC compare-and-set — the SOLE serializer: exactly one concurrent
  // caller flips (affected=1) and goes on to record the note + pump; every other observes affected=0 and
  // returns, so no duplicate or post-open stale note can land. Do NOT reintroduce a `SELECT … FOR UPDATE`
  // guard here: holding a row lock on the job across `recordUnblockNote` — which inserts a
  // `transcript_messages` row whose `job_id` FK needs a conflicting `FOR KEY SHARE` on that same row, on a
  // SEPARATE pooled connection — makes the outer txn await the note write while the note write waits on the
  // outer's lock, an unbreakable cross-connection lock-wait that strands every unblock.
  private async recordUnblockNoteThenPump(
    jobId: string,
    orgId: string,
    repoId: string,
    blockers: UnblockBlockerInfo[],
  ): Promise<boolean> {
    const flip = await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({ status: 'open' })
      .where('id = :id AND status = :blocked', { id: jobId, blocked: 'blocked' })
      .execute();
    if ((flip.affected ?? 0) === 0) return false; // not (or no longer) parked, or lost the race.

    // Record the JIT unblock note AFTER the winning flip but BEFORE the pump, so the drain still coalesces
    // it into the same timestamped turn as the held born-blocked/mid-flight backlog. No row lock is held.
    await this.brainGateway.recordUnblockNote(jobId, orgId, repoId, { blockers });

    try {
      await this.brainGateway.pumpUnblockedJob(jobId, orgId, repoId);
      return true;
    } catch (err) {
      this.logger.warn(`pumpUnblockedJob failed for job=${jobId}; re-parking for sweep: ${err}`);
      await this.jobs.update({ id: jobId, status: 'open' }, { status: 'blocked' });
      return false;
    }
  }

  private classifyResolvedBlocker(
    prState: string | null,
    status: string,
  ): NonLandedResolution | 'merged' {
    if (prState === 'merged') return 'merged';
    if (prState === 'closed') return 'closed_unmerged';
    if (status === 'deleting') return 'deleted';
    if (status === 'archived') return 'archived';
    return 'cancelled';
  }

  private resolvedBlockerInfos(
    blockers: JobBlockerRow[],
    blockerJobId: string,
    resolution: BlockerResolution,
  ): UnblockBlockerInfo[] {
    return blockers.map((b) => ({
      jobId: b.jobId,
      title: b.title,
      how:
        b.jobId === blockerJobId ? resolution : this.classifyResolvedBlocker(b.prState, b.status),
    }));
  }

  private classifiedBlockerInfos(blockers: JobBlockerRow[]): UnblockBlockerInfo[] {
    return blockers.map((b) => ({
      jobId: b.jobId,
      title: b.title,
      how: this.classifyResolvedBlocker(b.prState, b.status),
    }));
  }

  private async unblockAndWake(jobId: string, blockers: UnblockBlockerInfo[]): Promise<boolean> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job) return false;
    return this.recordUnblockNoteThenPump(jobId, job.org_id, job.repo_id, blockers);
  }

  private async wouldCycle(
    repoId: string,
    jobId: string,
    dependsOnJobId: string,
  ): Promise<boolean> {
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
