import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ENGINE_RUNNER } from '@shared/engine';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { CLASSIFIER_LLM } from '../../decision-gate';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../../e2e/e2e-stubs';
import { GithubPrService, LocalGitService } from '../../git';
import { JobBootstrapService } from '../../job-bootstrap';
import { WorkspaceSecretFileStore } from '../../onboarding';
import { DB_CONNECTION } from '../../persistence/database.module';
import { SANDBOX_PROVIDER } from '../../sandbox';
import { webSecretInputCard } from '../../surface';
import { WebSurfaceController } from '../../surface/web-surface.controller';
import { JobTitler } from '../../titling';
import { BrainStoreService } from '../brain-store.service';

const ORG_ID = '55555555-5555-8555-8555-555555555555';
const SLUG = 'ephemeral-it';
const CODE_VALUE = '4/0AVerification-DO-NOT-LEAK-abc123';
const LABEL = 'GCLOUD_AUTH_CODE';
const DELIVER_TO = '/tmp/atlas-login-in';

class FakeSandboxProvider {
  public delivered: { jobId: string; path: string; value: string }[] = [];
  public nextOk = true;
  async writeToJobContainerPath(input: { jobId: string; path: string; value: string }) {
    this.delivered.push(input);
    return this.nextOk ? { ok: true } : { ok: false, reason: 'the target process is not reading' };
  }
  contextDirHost() {
    return '/tmp';
  }
  playgroundDirHost() {
    return '/tmp';
  }
  brainTranscriptProjectsDir() {
    return null;
  }
  supervisorDirHost() {
    return null;
  }
}

describe('ephemeral secret lane — delivered, never persisted (live Postgres)', () => {
  let app: NestExpressApplication;
  let controller: WebSurfaceController;
  let store: BrainStoreService;
  let bootstrap: JobBootstrapService;
  let secrets: WorkspaceSecretFileStore;
  let ds: DataSource;
  let provider: FakeSandboxProvider;
  let jobId: string;
  let repoId: string;

  const prevSurface = process.env.SURFACE;
  const prevKey = process.env.SECRETS_ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.SURFACE = 'agent';
    process.env.SECRETS_ENCRYPTION_KEY ??= randomBytes(32).toString('hex');
    provider = new FakeSandboxProvider();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
      .overrideProvider(SANDBOX_PROVIDER)
      .useValue(provider)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    await app.init();

    controller = app.get(WebSurfaceController);
    store = app.get(BrainStoreService);
    bootstrap = app.get(JobBootstrapService);
    secrets = app.get(WorkspaceSecretFileStore);
    ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));

    await ds.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID]);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Ephemeral Org', 'ephemeral-org', 'active')`,
      [ORG_ID],
    );
    const [repo] = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
       VALUES ($1, $2, 'Ephemeral Repo', 'https://github.com/x/eph.git', 'main', true) RETURNING id`,
      [ORG_ID, SLUG],
    );
    repoId = repo.id;
    const [thread] = await ds.query(
      `INSERT INTO jobs (org_id, repo_id, origin, kind) VALUES ($1, $2, 'control', 'onboarding') RETURNING id`,
      [ORG_ID, repoId],
    );
    jobId = thread.id;
    await bootstrap.ensurePlanningThreadGroup(jobId, ORG_ID);
  });

  afterAll(async () => {
    if (ds)
      await ds.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID]).catch(() => undefined);
    await app?.close();
    if (prevSurface === undefined) delete process.env.SURFACE;
    else process.env.SURFACE = prevSurface;
    if (prevKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = prevKey;
  });

  it('delivers the code to the container and stores NOTHING durable', async () => {
    const requestId = 's-eph-1';
    const card = webSecretInputCard({
      jobId,
      requestId,
      name: LABEL,
      description: 'gcloud verification code',
      ephemeral: true,
      deliver_to: DELIVER_TO,
      url: 'https://accounts.google.com/o/oauth2/auth?x=1',
    });
    const opened = await store.openSecretRequest(jobId, { requestId, card });
    expect(opened.ok).toBe(true);

    const res = await controller.provideSecret({ id: ORG_ID } as never, jobId, {
      requestId,
      value: CODE_VALUE,
    });
    expect(res.ok).toBe(true);

    expect(provider.delivered).toHaveLength(1);
    expect(provider.delivered[0]).toMatchObject({
      jobId,
      path: DELIVER_TO,
      value: `${CODE_VALUE}\n`,
    });

    expect(await secrets.read(ORG_ID, repoId, DELIVER_TO)).toBeNull();
    expect(await secrets.list(ORG_ID, repoId)).toHaveLength(0);
    const storeRows = await ds.query(
      `SELECT count(*)::int AS n FROM org_workspace_secret_files WHERE org_id = $1`,
      [ORG_ID],
    );
    expect(storeRows[0].n).toBe(0);

    const rows = await ds.query(
      `SELECT count(*)::int AS n FROM transcript_messages WHERE job_id = $1 AND (text LIKE $2 OR card::text LIKE $2)`,
      [jobId, `%${CODE_VALUE}%`],
    );
    expect(rows[0].n).toBe(0);

    const pending = await store.findUndeliveredProvidedSecrets();
    const mine = pending.find((p) => p.requestId === requestId);
    expect(mine).toMatchObject({ jobId, orgId: ORG_ID, ephemeral: true });
    expect(mine?.path).toBeUndefined();
    expect(JSON.stringify(mine)).not.toContain(CODE_VALUE);
  });

  it('on a dead reader, clears the gate and does not persist', async () => {
    provider.delivered = [];
    provider.nextOk = false;
    const requestId = 's-eph-2';
    const card = webSecretInputCard({
      jobId,
      requestId,
      name: LABEL,
      description: 'gcloud verification code (retry)',
      ephemeral: true,
      deliver_to: DELIVER_TO,
    });
    expect((await store.openSecretRequest(jobId, { requestId, card })).ok).toBe(true);

    const res = await controller.provideSecret({ id: ORG_ID } as never, jobId, {
      requestId,
      value: CODE_VALUE,
    });

    expect(res.ok).toBe(false);
    expect(await store.awaitingSecretId(jobId)).toBeNull();
    expect(await secrets.read(ORG_ID, repoId, DELIVER_TO)).toBeNull();
    const rows = await ds.query(
      `SELECT count(*)::int AS n FROM transcript_messages WHERE job_id = $1 AND (text LIKE $2 OR card::text LIKE $2)`,
      [jobId, `%${CODE_VALUE}%`],
    );
    expect(rows[0].n).toBe(0);
  });
});
