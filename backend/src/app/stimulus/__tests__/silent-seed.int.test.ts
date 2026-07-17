
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../../persistence/database.module';
import { ENTITIES, JobEntity } from '../../persistence/entities';
import { SYSTEM_SEED_AUTHOR } from '../../surface/chat-surface.port';
import { JobBootstrapService } from '../job-bootstrap';
import { StimulusStoreService } from '../stimulus-store.service';

const ORG_ID = '52222222-2222-4222-8222-222222222222';
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

describe('silent re-drive seed (SeedRow: skip) — live Postgres DB-query proof', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let store: StimulusStoreService;
  let jobs: Repository<JobEntity>;
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dbOpts()), TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION)],
      providers: [JobBootstrapService, StimulusStoreService],
    }).compile();

    store = mod.get(StimulusStoreService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Silent Seed Org', 'silent-seed-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'silent-seed-repo', 'Silent Seed Repo', 'https://github.com/x/y.git', $2, NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, BASE_BRANCH],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await mod?.close();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE inbound_messages, transcript_messages, jobs RESTART IDENTITY CASCADE');
  });

  async function makeThread(title: string): Promise<JobEntity> {
    return jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'chat',
        kind: 'feature',
        title,
      }),
    );
  }

  async function countStimuli(jobId: string): Promise<number> {
    const rows = await ds.query(
      `SELECT count(*)::int AS n FROM inbound_messages WHERE job_id = $1`,
      [jobId],
    );
    return rows[0].n;
  }

  async function countPills(jobId: string): Promise<number> {
    const rows = await ds.query(
      `SELECT count(*)::int AS n FROM transcript_messages WHERE job_id = $1`,
      [jobId],
    );
    return rows[0].n;
  }

  it("systemChunk 'skip' commits the durable stimulus row but writes NO transcript pill", async () => {
    const thread = await makeThread('silent re-drive thread');

    const returned = await store.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: {
        id: SYSTEM_SEED_AUTHOR.id,
        displayName: SYSTEM_SEED_AUTHOR.name,
      },
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: '<system_notice>Please continue with the current task: "Silent Seed".</system_notice>',
      systemChunk: 'skip',
    });

    expect(await countStimuli(thread.id)).toBe(1);
    expect(returned.message.type).toBe('seed');
    expect(await countPills(thread.id)).toBe(0);
  });

  it('a descriptor seedRow (the contrast) DOES write exactly one curated pill', async () => {
    const thread = await makeThread('visible pill thread');

    await store.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: {
        id: SYSTEM_SEED_AUTHOR.id,
        displayName: SYSTEM_SEED_AUTHOR.name,
      },
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: '<system_notice>Auto-resuming after the session limit reset.</system_notice>',
      systemChunk: {
        label: 'Auto-resuming after the session limit reset.',
        chunkKey: `seed:sessionlimit:${thread.id}:1`,
      },
    });

    expect(await countStimuli(thread.id)).toBe(1);
    expect(await countPills(thread.id)).toBe(1);
  });
});
