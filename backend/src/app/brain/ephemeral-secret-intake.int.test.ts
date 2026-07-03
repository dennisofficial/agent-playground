import { randomBytes } from 'node:crypto';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { CLASSIFIER_LLM } from '../decision-gate';
import { ENGINE_RUNNER } from '../engine';
import { GithubPrService, LocalGitService } from '../git';
import { AppModule } from '../app.module';
import { WorktreeSecretStore } from '../onboarding';
import { DB_CONNECTION } from '../persistence/database.module';
import { SANDBOX_PROVIDER } from '../sandbox';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../e2e/e2e-stubs';
import { JobTitler } from '../titling';
import { WebSurfaceController } from '../surface/web-surface.controller';
import { webSecretInputCard } from '../surface';
import { BrainStoreService } from './brain-store.service';

/**
 * The EPHEMERAL secret lane's core invariant: a one-time value (an OAuth code) is delivered STRAIGHT into
 * the running sandbox and NEVER persisted — no `org_worktree_secrets` row, no grant, not in the transcript.
 * Drives the real `provide-secret` controller path with a fake SANDBOX_PROVIDER that records the delivered
 * value, against live Postgres. Contrast with `secret-intake.int.test.ts`, which asserts the DURABLE lane
 * DOES write the encrypted store + grant.
 */
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
  // Unused by this test — present so the object is a plausible provider.
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
  let secrets: WorktreeSecretStore;
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
    secrets = app.get(WorktreeSecretStore);
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
  });

  afterAll(async () => {
    if (ds) await ds.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID]).catch(() => undefined);
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

    // The real controller path (guards bypassed by direct call — they gate identity, not this logic).
    const res = await controller.provideSecret(
      { id: ORG_ID } as never,
      jobId,
      { requestId, value: CODE_VALUE },
    );
    expect(res.ok).toBe(true);

    // Delivered into the running container over the delivery lane, normalized to a single trailing newline.
    expect(provider.delivered).toHaveLength(1);
    expect(provider.delivered[0]).toMatchObject({ jobId, path: DELIVER_TO, value: `${CODE_VALUE}\n` });

    // NOTHING durable: no encrypted store row, no grant.
    expect(await secrets.read(ORG_ID, LABEL)).toBeNull();
    expect(await secrets.listGrants(ORG_ID, repoId)).toHaveLength(0);
    const storeRows = await ds.query(
      `SELECT count(*)::int AS n FROM org_worktree_secrets WHERE org_id = $1`,
      [ORG_ID],
    );
    expect(storeRows[0].n).toBe(0);

    // LEAK ASSERTION: the code appears in NO message row (card text, card jsonb, seeded confirmation).
    const rows = await ds.query(
      `SELECT count(*)::int AS n FROM messages WHERE job_id = $1 AND (text LIKE $2 OR card::text LIKE $2)`,
      [jobId, `%${CODE_VALUE}%`],
    );
    expect(rows[0].n).toBe(0);

    // Card stamped provided; the boot sweep marks it ephemeral (no path) and carries no value.
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
    // Gate cleared so the brain can re-run the login; nothing persisted.
    expect(await store.awaitingSecretId(jobId)).toBeNull();
    expect(await secrets.read(ORG_ID, LABEL)).toBeNull();
    const rows = await ds.query(
      `SELECT count(*)::int AS n FROM messages WHERE job_id = $1 AND (text LIKE $2 OR card::text LIKE $2)`,
      [jobId, `%${CODE_VALUE}%`],
    );
    expect(rows[0].n).toBe(0);
  });
});
