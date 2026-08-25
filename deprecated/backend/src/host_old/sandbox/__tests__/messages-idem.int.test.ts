import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ENGINE_RUNNER, type EngineEvent } from '@shared/engine';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppOldModule } from '../../app-v1.module';
import { CLASSIFIER_LLM } from '../../decision-gate/classifier-llm';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../../e2e/e2e-stubs';
import { GithubPrService } from '../../git/github-pr.service';
import { LocalGitService } from '../../git/local-git.service';
import { JobBootstrapService } from '../../job-bootstrap/job-bootstrap.service';
import { DB_CONNECTION } from '../../persistence/database.module';
import {
  BLOCK_SINK,
  MessageBlockSink,
  TurnHarnessFactory,
} from '../../surface/turn-harness.service';
import { JobTitler } from '../../titling/job-titler.service';

const TEAM_ID = '66666666-6666-4666-8666-666666666666'; // sentinel org uuid (distinct from sibling tests)

describe('keyed-upsert dedupe on messages (live Postgres ON CONFLICT DO NOTHING)', () => {
  let app: NestExpressApplication;
  let sink: MessageBlockSink;
  let harness: TurnHarnessFactory;
  let dataSource: DataSource;
  let jobA = '';
  let threadA = '';

  const prevSurface = process.env.SURFACE;

  beforeAll(async () => {
    process.env.SURFACE = 'agent';
    const moduleRef = await Test.createTestingModule({ imports: [AppOldModule] })
      .overrideProvider(CLASSIFIER_LLM)
      .useValue(new FakeClassifierLlm())
      .overrideProvider(ENGINE_RUNNER)
      .useValue(new FakeEngineRunner())
      .overrideProvider(LocalGitService)
      .useValue(new FakeLocalGitService())
      .overrideProvider(GithubPrService)
      .useValue(new FakeGithubPrService())
      .overrideProvider(JobTitler)
      .useValue(new FakeThreadTitler())
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    app.enableShutdownHooks();
    await app.init();

    sink = app.get<MessageBlockSink>(BLOCK_SINK);
    harness = app.get(TurnHarnessFactory);
    dataSource = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));

    await dataSource.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID, 'idem-org', 'idem-org'],
    );
    const [repo] = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url) VALUES ($1,$2,$3,$4) RETURNING id`,
      [
        TEAM_ID,
        `idem-repo-${randomUUID().slice(0, 8)}`,
        'idem-repo',
        'https://example.invalid/r.git',
      ],
    );
    const [job] = await dataSource.query(
      `INSERT INTO jobs (org_id, repo_id, origin) VALUES ($1,$2,$3) RETURNING id`,
      [TEAM_ID, repo.id, 'chat'],
    );
    jobA = job.id as string;
    const bootstrap = app.get(JobBootstrapService);
    await bootstrap.ensurePlanningThreadGroup(jobA, TEAM_ID);
    threadA = await bootstrap.planningThreadId(jobA);
  }, 60_000);

  afterAll(async () => {
    if (dataSource) {
      await dataSource.query(
        `DELETE FROM transcript_messages WHERE job_id IN (SELECT id FROM jobs WHERE org_id = $1)`,
        [TEAM_ID],
      );
      await dataSource.query(`DELETE FROM jobs WHERE org_id = $1`, [TEAM_ID]);
      await dataSource.query(`DELETE FROM repos WHERE org_id = $1`, [TEAM_ID]);
      await dataSource.query(`DELETE FROM organizations WHERE id = $1`, [TEAM_ID]);
    }
    await app?.close();
    if (prevSurface === undefined) delete process.env.SURFACE;
    else process.env.SURFACE = prevSurface;
  });

  it('same idem_key twice ⇒ ONE row; a different key with the same text ⇒ BOTH survive', async () => {
    const key = `${randomUUID()}:0`;
    const text = `idem-${randomUUID()}`;

    await sink.appendBlock(jobA, {
      kind: 'chat',
      threadId: threadA,
      text,
      idemKey: key,
    });
    await sink.appendBlock(jobA, {
      kind: 'chat',
      threadId: threadA,
      text,
      idemKey: key,
    }); // repeat write ⇒ no-op

    const rows = await dataSource.query(
      `SELECT count(*)::int AS n FROM transcript_messages WHERE job_id = $1 AND idem_key = $2`,
      [jobA, key],
    );
    expect(rows[0].n).toBe(1);

    const key2 = `${randomUUID()}:0`;
    await sink.appendBlock(jobA, {
      kind: 'chat',
      threadId: threadA,
      text,
      idemKey: key2,
    });

    const row2 = await dataSource.query(
      `SELECT count(*)::int AS n FROM transcript_messages WHERE job_id = $1 AND idem_key = $2`,
      [jobA, key2],
    );
    expect(row2[0].n).toBe(1);

    const totalByText = await dataSource.query(
      `SELECT count(*)::int AS n FROM transcript_messages WHERE job_id = $1 AND kind = 'chat' AND text = $2`,
      [jobA, text],
    );
    expect(totalByText[0].n).toBe(2);
  });

  it('two streamers bound to the SAME turnId, fed the SAME block, both finish() ⇒ exactly ONE persisted row', async () => {
    const turnId = randomUUID();
    const text = `dup-${randomUUID()}`;
    const ev: EngineEvent = { kind: 'text', text };

    const a = harness.create({
      jobId: jobA,
      orgId: TEAM_ID,
      threadId: threadA,
      channel: 'repo-guard',
      lane: 'main',
      turnId,
    });
    const b = harness.create({
      jobId: jobA,
      orgId: TEAM_ID,
      threadId: threadA,
      channel: 'repo-guard',
      lane: 'main',
      turnId,
    });
    a.onEvent(ev);
    b.onEvent(ev);

    await a.finish();
    await b.finish();

    const rows = await dataSource.query(
      `SELECT count(*)::int AS n FROM transcript_messages WHERE job_id = $1 AND kind = 'chat' AND text = $2`,
      [jobA, text],
    );
    expect(rows[0].n).toBe(1);

    const keyRows = await dataSource.query(
      `SELECT count(*)::int AS n FROM transcript_messages WHERE job_id = $1 AND idem_key = $2`,
      [jobA, `${turnId}:0`],
    );
    expect(keyRows[0].n).toBe(1);
  });
});
