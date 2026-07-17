/**
 * REGRESSION (live Postgres): the job-unblock path must NOT hold a jobs-row lock across the unblock-note
 * write. Unlike the sibling `job-dependency.int.test.ts`, whose `BrainGateway.recordUnblockNote` is a
 * capture double, THIS suite wires the REAL production write — `StimulusStoreService.recordChatStimulus`,
 * which inserts a `transcript_messages` row whose `job_id` FK needs a `FOR KEY SHARE` on the jobs row.
 *
 * The earlier implementation flipped `blocked→open` inside a `dataSource.transaction` that held a
 * `SELECT … FOR UPDATE` on the jobs row and, still inside it, awaited that note write on a SEPARATE pooled
 * connection. `FOR KEY SHARE` conflicts with `FOR UPDATE`, so the outer txn awaited the note write while
 * the note write waited on the outer's lock — an unbreakable cross-connection lock-wait that stranded
 * every unblock (the exact prod incident on job 37654d74). The fix makes the flip an atomic compare-and-set
 * with no row lock held across the note write. This test drives the real wake funnel under a hard timeout
 * and asserts the unblock completes, flips the job open, and lands a real transcript note row — it would
 * hang (or leave the job blocked) against the pre-fix code.
 */

import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import type { UnblockBlockerInfo } from '@shared/domain/message';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { BrainGateway } from '../../brain-gateway/brain-gateway.service';
import { JobBootstrapService } from '../../job-bootstrap/job-bootstrap.service';
import { DB_CONNECTION } from '../../persistence/database.module';
import { ENTITIES, JobEntity } from '../../persistence/entities';
import { renderUnblockedNote } from '../../prompt-kit/harness/seed-catalog';
import { StimulusStoreService } from '../../stimulus/stimulus-store.service';
import { SYSTEM_SEED_AUTHOR } from '../../surface/chat-surface.port';
import { JobDependencyService } from '../job-dependency.service';

const ORG_ID = '2c333333-3333-4333-8333-333333333333';
const BASE_BRANCH = 'main';

function dbOpts() {
  return {
    name: DB_CONNECTION,
    type: 'postgres' as const,
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5433),
    username: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    database: process.env.POSTGRES_DB,
    entities: ENTITIES,
    namingStrategy: new CustomNamingStrategy(),
    synchronize: false,
    connectTimeoutMS: 10_000,
    ssl: false as const,
  };
}

/** Reject if `p` has not settled within `ms` — turns a lock-wait DEADLOCK into a fast, legible failure
 *  instead of a whole-suite hang. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not settle within ${ms}ms (deadlock?)`)),
      ms,
    );
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
}

describe('job-unblock note write holds no jobs-row lock (deadlock regression, live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let service: JobDependencyService;
  let jobs: Repository<JobEntity>;
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dbOpts()), TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION)],
      providers: [
        JobDependencyService,
        StimulusStoreService,
        JobBootstrapService,
        {
          // The REAL production recordUnblockNote body (mirrors AgentSessionManager.recordUnblockNote):
          // it writes an actual `transcript_messages` row via the real stimulus store, so the FK/lock
          // interaction that used to deadlock is genuinely exercised. pumpUnblockedJob is a no-op spy.
          provide: BrainGateway,
          inject: [StimulusStoreService],
          useFactory: (stimulusStore: StimulusStoreService) => ({
            recordUnblockNote: async (
              jobId: string,
              orgId: string,
              repoId: string,
              input: { blockers: UnblockBlockerInfo[] },
            ) => {
              await stimulusStore.recordChatStimulus({
                orgId,
                repoId,
                jobId,
                author: { id: SYSTEM_SEED_AUTHOR.id, displayName: SYSTEM_SEED_AUTHOR.name },
                type: 'unblocked_job_wake',
                body: renderUnblockedNote(input.blockers),
                lane: 'main',
                replyRoute: { surfaceId: 'web', jobRef: jobId },
                unblockNote: true,
                systemChunk: {
                  label: 'All blocking jobs resolved — unblocked.',
                  chunkKey: `unblock:${jobId}`,
                },
              });
            },
            pumpUnblockedJob: async () => {},
          }),
        },
      ],
    }).compile();

    service = mod.get(JobDependencyService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Unblock Deadlock Org', 'unblock-deadlock-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'unblock-deadlock-repo', 'Unblock Deadlock Repo', 'https://github.com/x/y.git', $2, NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, BASE_BRANCH],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await mod?.close();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE job_dependencies, jobs RESTART IDENTITY CASCADE');
  });

  async function makeJob(overrides: Partial<JobEntity> = {}): Promise<JobEntity> {
    return jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'A job',
        kind: 'feature',
        status: 'open',
        base_branch: BASE_BRANCH,
        ...overrides,
      }),
    );
  }

  it('the merge wake funnel flips a born-blocked dependent to open and lands a real note — no deadlock', async () => {
    const blocker = await makeJob({ status: 'running' }); // a live (non-terminal) blocker
    const dependent = await makeJob();

    // Born-blocked edge — parks the dependent and queues its born-blocked seeds (real recordChatStimulus).
    const { blocked } = await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: blocker.id,
      seed: 'the opening brief for the blocked job',
    });
    expect(blocked).toBe(true);
    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('blocked');

    // Blocker merges → the wake funnel records the REAL unblock note (transcript FK write) and flips the
    // dependent open. Pre-fix this held FOR UPDATE across that write and dead-locked; guard with a timeout.
    await withTimeout(
      service.onBlockerResolved(blocker.id, 'merged'),
      5_000,
      'onBlockerResolved(merged)',
    );

    // The flip committed …
    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('open');

    // … the real unblock stimulus landed (proof recordChatStimulus committed, not a mock capture) …
    const stim: Array<{ n: number }> = await ds.query(
      `SELECT count(*)::int AS n FROM inbound_messages WHERE job_id = $1 AND type = 'unblocked_job_wake'`,
      [dependent.id],
    );
    expect(stim[0].n).toBe(1);

    // … and so did its transcript row — the `job_id`-FK INSERT that used to deadlock under the held
    // `FOR UPDATE` (born-blocked provenance + brief + this unblock note = 3 `chat` transcript rows).
    const notes: Array<{ n: number }> = await ds.query(
      `SELECT count(*)::int AS n FROM transcript_messages WHERE job_id = $1 AND kind = 'chat'`,
      [dependent.id],
    );
    expect(notes[0].n).toBeGreaterThanOrEqual(3);
  });

  it('a second concurrent unblock is a no-op (CAS: exactly one caller flips)', async () => {
    const blocker = await makeJob({ status: 'running' });
    const dependent = await makeJob();
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: blocker.id,
      seed: 'brief',
    });

    // Two funnel calls racing the same dependent — one flips, the other observes status≠'blocked'. Neither
    // may hang, and the end state is a single clean unblock.
    await withTimeout(
      Promise.all([
        service.onBlockerResolved(blocker.id, 'merged'),
        service.onBlockerResolved(blocker.id, 'merged'),
      ]),
      5_000,
      'concurrent onBlockerResolved',
    );

    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('open');
  });
});
