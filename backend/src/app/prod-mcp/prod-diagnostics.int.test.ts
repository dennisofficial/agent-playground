/**
 * ProdDiagnosticsService — the gated prod-recovery WRITE pipeline, against live Postgres + the REAL
 * least-privilege roles (`mcp_reader` SELECT-only, `mcp_writer` DML-only), provisioned on `atlas_test`
 * by `vitest.global-setup.ts` with the same GRANTs `infra/mcp-{reader,writer}-role.sql` apply in prod.
 *
 * Proves the structural invariants that make this path safe (section 02 §Validation):
 *   1. propose → a `pending` ledger row + a durable approval card, and the target row is UNCHANGED
 *      (the `mcp_writer` role is never touched pre-approval, d2/d4/d6).
 *   2. executeApproved → the statement runs on `mcp_writer`, the row CHANGES, the ledger flips to
 *      `executed` with the ACTUAL affected-row count, and the job is notified.
 *   3. a DDL statement reaching executeApproved is REJECTED by the role itself (`mcp_writer` has no
 *      DDL) → ledger `failed`, prod intact — the role is a backstop even past the write-guard.
 *   4. `mcp_writer` cannot tamper with its OWN audit ledger (REVOKEd on `prod_maintenance_write`).
 *
 * Integration: real Postgres, no fakes for the DB layer. Only the ChatSurface is a spy (its delivery is
 * out of scope here; the DB effects are what matter).
 */

import { Test, type TestingModule } from '@nestjs/testing';
import {
  TypeOrmModule,
  getDataSourceToken,
  getRepositoryToken,
} from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvService } from '@core/config/env/env.service';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import {
  DB_CONNECTION,
  MCP_READER_CONNECTION,
  MCP_WRITER_CONNECTION,
} from '../persistence/database.module';
import {
  ENTITIES,
  JobEntity,
  MessageEntity,
  ProdMaintenanceWriteEntity,
  ThreadEntity,
} from '../persistence/entities';
import { CHAT_SURFACE } from '../surface/chat-surface.port';
import type { ChatStimulus } from '../domain/stimulus';
import { ProdDiagnosticsService } from './prod-diagnostics.service';

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
  let messages: Repository<MessageEntity>;
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
          [ProdMaintenanceWriteEntity, MessageEntity, JobEntity, ThreadEntity],
          DB_CONNECTION,
        ),
      ],
      providers: [
        ProdDiagnosticsService,
        { provide: CHAT_SURFACE, useValue: surface },
        { provide: EnvService, useValue: { get: () => undefined } },
      ],
    }).compile();

    svc = mod.get(ProdDiagnosticsService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    ledger = mod.get(getRepositoryToken(ProdMaintenanceWriteEntity, DB_CONNECTION));
    messages = mod.get(getRepositoryToken(MessageEntity, DB_CONNECTION));
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
      'TRUNCATE prod_maintenance_write, messages, steps, threads, jobs RESTART IDENTITY CASCADE',
    );
  });

  async function seedDeadlockedThread(): Promise<{ jobId: string; threadId: string }> {
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
    const thread = await threads.save(
      threads.create({
        kind: 'builder',
        job_id: job.id,
        org_id: ORG_ID,
        ordinal: 10,
        brief: 'Backend — deadlocked at the fix cap',
        status: 'executing',
        halt_fix_attempts: 3,
      }),
    );
    return { jobId: job.id, threadId: thread.id };
  }

  function stimulusFor(jobId: string): ChatStimulus {
    return {
      id: 'sess-propose-1',
      kind: 'chat',
      trust: 'trusted',
      orgId: ORG_ID,
      repoId,
      jobId,
      body: 'rearm the deadlocked thread',
      receivedAt: new Date(),
      author: { id: 'atlas', displayName: 'Atlas' },
      replyRoute: { surfaceId: 'web', jobRef: jobId },
    } as ChatStimulus;
  }

  it('propose → pending ledger row + durable card, target row UNCHANGED (writer untouched pre-approval)', async () => {
    const { jobId, threadId } = await seedDeadlockedThread();
    const sql = `UPDATE threads SET halt_fix_attempts = 0 WHERE id = '${threadId}'`;

    const res = await svc.proposeWrite(stimulusFor(jobId), sql);
    expect(res.ok).toBe(true);
    expect(res.writeId).toBeTruthy();

    // Ledger: a durable `pending` row carrying the EXACT approved statement + the dry-run preview.
    const row = await ledger.findOne({ where: { id: res.writeId } });
    expect(row).toBeTruthy();
    expect(row?.status).toBe('pending');
    expect(row?.sql).toBe(sql);
    expect(row?.org_id).toBe(ORG_ID);
    expect(row?.job_id).toBe(jobId);
    expect(row?.result).toBeNull();
    // The preview is a planner ESTIMATE on the SELECT-only role; on this Postgres an UPDATE EXPLAIN is
    // permission-denied for `mcp_reader` (d6 spike) → dry_run captured as `{}` (estimate unavailable),
    // never an error.
    expect(row?.dry_run).toBeDefined();
    expect(row?.dry_run.error).toBeUndefined();

    // A durable approval card row was persisted for the operator, keyed to this write.
    const card = await messages.findOne({
      where: { job_id: jobId, ts: `db-write:${jobId}:${res.writeId}`, kind: 'card' },
    });
    expect(card).toBeTruthy();
    expect((card?.card as Record<string, unknown> | undefined)?.kind).toBe('db_write');

    // A live SSE nudge was posted — but NO write ran: the target row is untouched.
    expect(surface.post).toHaveBeenCalledTimes(1);
    const after = await threads.findOne({ where: { id: threadId } });
    expect(after?.halt_fix_attempts).toBe(3);
  });

  it('executeApproved → runs on mcp_writer, row CHANGES, ledger executed w/ affectedRows, job notified', async () => {
    const { jobId, threadId } = await seedDeadlockedThread();
    const sql = `UPDATE threads SET halt_fix_attempts = 0 WHERE id = '${threadId}'`;
    const { writeId } = await svc.proposeWrite(stimulusFor(jobId), sql);

    await svc.executeApproved(writeId, APPROVER_ID, jobId);

    const row = await ledger.findOne({ where: { id: writeId } });
    expect(row?.status).toBe('executed');
    expect(row?.result?.affectedRows).toBe(1);
    expect(row?.result?.error).toBeUndefined();
    expect(row?.approved_by).toBe(APPROVER_ID);
    expect(row?.approved_at).toBeInstanceOf(Date);
    expect(row?.executed_at).toBeInstanceOf(Date);

    // The real mutation landed via the DML-only role.
    const after = await threads.findOne({ where: { id: threadId } });
    expect(after?.halt_fix_attempts).toBe(0);

    // The job was notified of the outcome.
    expect(surface.seedSystemNotification).toHaveBeenCalledTimes(1);

    // The durable operator card was neutralized/replaced with a verdict, so the transcript no longer shows
    // an actionable "Execute write" button after execution.
    const card = await messages.findOne({
      where: { job_id: jobId, ts: `db-write:${jobId}:${writeId}`, kind: 'card' },
    });
    expect((card?.card as Record<string, unknown> | undefined)?.type).toBe('verdict_card');
    expect((card?.card as Record<string, unknown> | undefined)?.verdict).toBe('approve');

    // Idempotent: a duplicate approval click is a no-op (row is no longer `pending`).
    surface.seedSystemNotification.mockClear();
    await svc.executeApproved(writeId, APPROVER_ID, jobId);
    expect(surface.seedSystemNotification).not.toHaveBeenCalled();
  });

  it('denyWrite → rejected, no mutation', async () => {
    const { jobId, threadId } = await seedDeadlockedThread();
    const sql = `UPDATE threads SET halt_fix_attempts = 0 WHERE id = '${threadId}'`;
    const { writeId } = await svc.proposeWrite(stimulusFor(jobId), sql);

    await svc.denyWrite(writeId, APPROVER_ID, jobId);

    const row = await ledger.findOne({ where: { id: writeId } });
    expect(row?.status).toBe('rejected');
    expect(row?.approved_by).toBe(APPROVER_ID);
    const after = await threads.findOne({ where: { id: threadId } });
    expect(after?.halt_fix_attempts).toBe(3); // untouched
    const card = await messages.findOne({
      where: { job_id: jobId, ts: `db-write:${jobId}:${writeId}`, kind: 'card' },
    });
    expect((card?.card as Record<string, unknown> | undefined)?.type).toBe('verdict_card');
    expect((card?.card as Record<string, unknown> | undefined)?.verdict).toBe('deny');

    // Idempotent: a duplicate deny click is a no-op (row is no longer `pending`).
    surface.seedSystemNotification.mockClear();
    await svc.denyWrite(writeId, APPROVER_ID, jobId);
    expect(surface.seedSystemNotification).not.toHaveBeenCalled();
  });

  it('executeApproved rejects DDL at the ROLE level (mcp_writer has no DDL) → failed, table intact', async () => {
    const { jobId } = await seedDeadlockedThread();
    // The write-guard blocks DDL at propose; here we insert a pending ledger row DIRECTLY to prove the
    // DB role is a backstop even if a DDL statement somehow reached executeApproved.
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

    // The table still exists (the DDL never ran).
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
