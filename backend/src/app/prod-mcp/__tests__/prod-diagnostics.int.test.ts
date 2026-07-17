
import { EnvService } from '@core/config/env/env.service';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import type { Message, TurnEnvelope } from '@shared/domain';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import {
  DB_CONNECTION,
  MCP_READER_CONNECTION,
  MCP_WRITER_CONNECTION,
} from '../../persistence/database.module';
import {
  ENTITIES,
  JobEntity,
  ProdMaintenanceWriteEntity,
  ThreadEntity,
  TranscriptMessageEntity,
} from '../../persistence/entities';
import { CHAT_SURFACE } from '../../surface/chat-surface.port';
import { JobBootstrapService } from '../../job-bootstrap/job-bootstrap.service';
import { ProdDiagnosticsService } from '../prod-diagnostics.service';

const ORG_ID = '31111111-1111-4111-8111-111111111111';
const APPROVER_ID = '41111111-1111-4111-8111-111111111111';
const BASE_BRANCH = 'main';

function baseOpts() {
  return {
    type: 'postgres' as const,
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5433),
    database: process.env.POSTGRES_DB,
    entities: ENTITIES,
    namingStrategy: new CustomNamingStrategy(),
    synchronize: false,
    connectTimeoutMS: 10_000,
    ssl: false as const,
  };
}

function appOpts() {
  return {
    ...baseOpts(),
    name: DB_CONNECTION,
    username: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
  };
}

function readerOpts() {
  return {
    ...baseOpts(),
    name: MCP_READER_CONNECTION,
    username: process.env.MCP_READER_PG_USER ?? 'mcp_reader',
    password: process.env.MCP_READER_PG_PASSWORD ?? 'test',
  };
}

function writerOpts() {
  return {
    ...baseOpts(),
    name: MCP_WRITER_CONNECTION,
    username: process.env.MCP_WRITER_PG_USER ?? 'mcp_writer',
    password: process.env.MCP_WRITER_PG_PASSWORD ?? 'test',
  };
}

describe('ProdDiagnosticsService — gated write pipeline (live Postgres, real mcp roles)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let svc: ProdDiagnosticsService;
  let ledger: Repository<ProdMaintenanceWriteEntity>;
  let messages: Repository<TranscriptMessageEntity>;
  let jobs: Repository<JobEntity>;
  let threads: Repository<ThreadEntity>;
  const surface = {
    post: vi.fn(async () => 'ts-1'),
    seedSystemNotification: vi.fn(),
  };
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(appOpts()),
        TypeOrmModule.forRoot(readerOpts()),
        TypeOrmModule.forRoot(writerOpts()),
        TypeOrmModule.forFeature(
          [ProdMaintenanceWriteEntity, TranscriptMessageEntity, JobEntity, ThreadEntity],
          DB_CONNECTION,
        ),
      ],
      providers: [
        ProdDiagnosticsService,
        { provide: CHAT_SURFACE, useValue: surface },
        { provide: EnvService, useValue: { get: () => undefined } },
        {
          provide: JobBootstrapService,
          useValue: {
            planningThreadId: async (jobId: string) =>
              (await threads.findOneOrFail({ where: { job_id: jobId } })).id,
          },
        },
      ],
    }).compile();

    svc = mod.get(ProdDiagnosticsService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    ledger = mod.get(getRepositoryToken(ProdMaintenanceWriteEntity, DB_CONNECTION));
    messages = mod.get(getRepositoryToken(TranscriptMessageEntity, DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
    threads = mod.get(getRepositoryToken(ThreadEntity, DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Prod MCP Org', 'prod-mcp-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'prod-mcp-repo', 'Prod MCP Repo', 'https://github.com/x/y.git', $2, NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, BASE_BRANCH],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await mod?.close();
  });

  beforeEach(async () => {
    surface.post.mockClear();
    surface.seedSystemNotification.mockClear();
    await ds.query(
      'TRUNCATE prod_maintenance_write, transcript_messages, tasks, threads, thread_groups, jobs RESTART IDENTITY CASCADE',
    );
  });

  async function seedDeadlockedThread(): Promise<{
    jobId: string;
    threadId: string;
  }> {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'judge_unavailable deadlock',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
    const [threadGroup] = await ds.query(
      `INSERT INTO thread_groups (job_id, org_id, ordinal, kind) VALUES ($1, $2, 10, 'build') RETURNING id`,
      [job.id, ORG_ID],
    );
    const thread = await threads.save(
      threads.create({
        thread_group_id: threadGroup.id,
        role: 'builder',
        job_id: job.id,
        org_id: ORG_ID,
        ordinal: 3,
        brief: 'Backend — deadlocked at the fix cap',
        status: 'executing',
      }),
    );
    return { jobId: job.id, threadId: thread.id };
  }

  function stimulusFor(jobId: string): TurnEnvelope {
    return {
      message: {
        id: 'sess-propose-1',
        orgId: ORG_ID,
        repoId,
        jobId,
        receivedAt: new Date().toISOString(),
        type: 'user',
      } as unknown as Message,
      id: 'sess-propose-1',
      orgId: ORG_ID,
      repoId,
      jobId,
      body: 'rearm the deadlocked thread',
      receivedAt: new Date(),
      author: { id: 'atlas', displayName: 'Atlas' },
      replyRoute: { surfaceId: 'web', jobRef: jobId },
    };
  }

  it('propose → pending ledger row + durable card, target row UNCHANGED (writer untouched pre-approval)', async () => {
    const { jobId, threadId } = await seedDeadlockedThread();
    const sql = `UPDATE threads SET ordinal = 0 WHERE id = '${threadId}'`;

    const res = await svc.proposeWrite(stimulusFor(jobId), sql);
    expect(res.ok).toBe(true);
    expect(res.writeId).toBeTruthy();

    const row = await ledger.findOne({ where: { id: res.writeId } });
    expect(row).toBeTruthy();
    expect(row?.status).toBe('pending');
    expect(row?.sql).toBe(sql);
    expect(row?.org_id).toBe(ORG_ID);
    expect(row?.job_id).toBe(jobId);
    expect(row?.result).toBeNull();
    expect(row?.dry_run).toBeDefined();
    expect(row?.dry_run.error).toBeUndefined();

    const card = await messages.findOne({
      where: {
        job_id: jobId,
        ts: `db-write:${jobId}:${res.writeId}`,
        kind: 'card',
      },
    });
    expect(card).toBeTruthy();
    expect((card?.card as Record<string, unknown> | undefined)?.kind).toBe('db_write');

    expect(surface.post).toHaveBeenCalledTimes(1);
    const after = await threads.findOne({ where: { id: threadId } });
    expect(after?.ordinal).toBe(3);
  });

  it('executeApproved → runs on mcp_writer, row CHANGES, ledger executed w/ affectedRows, job notified', async () => {
    const { jobId, threadId } = await seedDeadlockedThread();
    const sql = `UPDATE threads SET ordinal = 0 WHERE id = '${threadId}'`;
    const { writeId } = await svc.proposeWrite(stimulusFor(jobId), sql);

    await svc.executeApproved(writeId, APPROVER_ID, jobId);

    const row = await ledger.findOne({ where: { id: writeId } });
    expect(row?.status).toBe('executed');
    expect(row?.result?.affectedRows).toBe(1);
    expect(row?.result?.error).toBeUndefined();
    expect(row?.approved_by).toBe(APPROVER_ID);
    expect(row?.approved_at).toBeInstanceOf(Date);
    expect(row?.executed_at).toBeInstanceOf(Date);

    const after = await threads.findOne({ where: { id: threadId } });
    expect(after?.ordinal).toBe(0);

    expect(surface.seedSystemNotification).toHaveBeenCalledTimes(1);

    const card = await messages.findOne({
      where: {
        job_id: jobId,
        ts: `db-write:${jobId}:${writeId}`,
        kind: 'card',
      },
    });
    expect((card?.card as Record<string, unknown> | undefined)?.type).toBe('verdict_card');
    expect((card?.card as Record<string, unknown> | undefined)?.verdict).toBe('approve');

    surface.seedSystemNotification.mockClear();
    await svc.executeApproved(writeId, APPROVER_ID, jobId);
    expect(surface.seedSystemNotification).not.toHaveBeenCalled();
  });

  it('denyWrite → rejected, no mutation', async () => {
    const { jobId, threadId } = await seedDeadlockedThread();
    const sql = `UPDATE threads SET ordinal = 0 WHERE id = '${threadId}'`;
    const { writeId } = await svc.proposeWrite(stimulusFor(jobId), sql);

    await svc.denyWrite(writeId, APPROVER_ID, jobId);

    const row = await ledger.findOne({ where: { id: writeId } });
    expect(row?.status).toBe('rejected');
    expect(row?.approved_by).toBe(APPROVER_ID);
    const after = await threads.findOne({ where: { id: threadId } });
    expect(after?.ordinal).toBe(3); // untouched
    const card = await messages.findOne({
      where: {
        job_id: jobId,
        ts: `db-write:${jobId}:${writeId}`,
        kind: 'card',
      },
    });
    expect((card?.card as Record<string, unknown> | undefined)?.type).toBe('verdict_card');
    expect((card?.card as Record<string, unknown> | undefined)?.verdict).toBe('deny');

    surface.seedSystemNotification.mockClear();
    await svc.denyWrite(writeId, APPROVER_ID, jobId);
    expect(surface.seedSystemNotification).not.toHaveBeenCalled();
  });

  it('executeApproved rejects DDL at the ROLE level (mcp_writer has no DDL) → failed, table intact', async () => {
    const { jobId } = await seedDeadlockedThread();
    const saved = await ledger.save(
      ledger.create({
        org_id: ORG_ID,
        repo_id: repoId,
        job_id: jobId,
        proposed_by_session: 'sess-ddl',
        sql: 'DROP TABLE threads',
        status: 'pending',
        dry_run: {},
      }),
    );

    await svc.executeApproved(saved.id, APPROVER_ID, jobId);

    const row = await ledger.findOne({ where: { id: saved.id } });
    expect(row?.status).toBe('failed');
    expect(row?.result?.error).toBeTruthy();

    const [{ count }] = await ds.query(
      `SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name = 'threads'`,
    );
    expect(count).toBe(1);
  });

  it('mcp_writer cannot tamper with its own audit ledger (REVOKEd on prod_maintenance_write) → failed', async () => {
    const { jobId } = await seedDeadlockedThread();
    const saved = await ledger.save(
      ledger.create({
        org_id: ORG_ID,
        repo_id: repoId,
        job_id: jobId,
        proposed_by_session: 'sess-tamper',
        sql: `UPDATE prod_maintenance_write SET status = 'executed'`,
        status: 'pending',
        dry_run: {},
      }),
    );

    await svc.executeApproved(saved.id, APPROVER_ID, jobId);

    const row = await ledger.findOne({ where: { id: saved.id } });
    expect(row?.status).toBe('failed');
    expect(row?.result?.error).toBeTruthy();
  });
});
