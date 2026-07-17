import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ENGINE_RUNNER } from '@shared/engine';
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
import { JobTitler } from '../../titling/job-titler.service';
import { TurnHarnessFactory } from '../turn-harness.service';

const TEAM_ID = '77777777-7777-4777-8777-777777777777'; // sentinel org uuid (distinct from sibling tests)

describe('a SendMessage injection persists as a durable `user` block tagged with the subagent id', () => {
  let app: NestExpressApplication;
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

    harness = app.get(TurnHarnessFactory);
    dataSource = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));

    await dataSource.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID, 'user-text-org', 'user-text-org'],
    );
    const [repo] = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url) VALUES ($1,$2,$3,$4) RETURNING id`,
      [
        TEAM_ID,
        `user-text-repo-${randomUUID().slice(0, 8)}`,
        'user-text-repo',
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

  it("persists the injected text as kind=user, tagged with the spawning Task tool_use's tracked subagent id", async () => {
    const turnId = randomUUID();
    const toolUseId = 'tu-sub-1';
    const injectedText = 'injected!';

    const streamer = harness.create({
      jobId: jobA,
      orgId: TEAM_ID,
      threadId: threadA,
      channel: 'repo-guard',
      lane: 'main',
      turnId,
    });

    streamer.onEvent({
      kind: 'tool_use',
      id: toolUseId,
      name: 'Task',
      input: { subagent_type: 'test' },
    });
    streamer.onEvent({
      kind: 'user_text',
      text: injectedText,
      parentToolUseId: toolUseId,
    });

    await streamer.finish();

    const rows = await dataSource.query(
      `SELECT kind, subagent_id FROM transcript_messages WHERE job_id = $1 AND text = $2`,
      [jobA, injectedText],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('user');
    expect(rows[0].subagent_id).toBeTruthy();
    expect(rows[0].subagent_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
