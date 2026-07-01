import { randomBytes } from 'node:crypto';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { CLASSIFIER_LLM } from '../decision-gate';
import { PLANNER_LLM } from '../driver';
import { ENGINE_RUNNER } from '../engine';
import { GithubPrService, LocalGitService } from '../git';
import { AppModule } from '../app.module';
import { WorktreeSecretStore } from '../onboarding';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
  FakePlannerLlm,
  FakeThreadTitler,
} from '../e2e/e2e-stubs';
import { JobTitler } from '../titling';
import { webSecretInputCard } from '../surface';
import { BrainStoreService } from './brain-store.service';

/**
 * THE security invariant of repo onboarding: a `request_secret` value reaches the ENCRYPTED store + a
 * grant, and NEVER the transcript. This drives the real round-trip — `openSecretRequest` (the brain tool)
 * → the `provide-secret` write+grant+stamp (what the controller does) → delivery — against live Postgres,
 * and asserts the plaintext value appears in NO `messages` row while it IS recoverable (encrypted) from
 * the store. Boots the REAL AppModule with only external boundaries faked.
 */
const ORG_ID = '44444444-4444-4444-8444-444444444444';
const SLUG = 'secret-it';
const SECRET_VALUE = 'postgres://user:sup3rs3cr3t-DO-NOT-LEAK@db:5432/app';
const SECRET_NAME = 'DATABASE_URL';
const SECRET_PATH = '.env';

describe('repo onboarding — secure secret intake (live Postgres, leak assertion)', () => {
  let app: NestExpressApplication;
  let store: BrainStoreService;
  let secrets: WorktreeSecretStore;
  let ds: DataSource;
  let threadId: string;
  let repoId: string;

  const prevSurface = process.env.SURFACE;
  const prevKey = process.env.SECRETS_ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.SURFACE = 'agent';
    // A real 32-byte key so the store actually encrypts/decrypts (read back the stored value below).
    process.env.SECRETS_ENCRYPTION_KEY ??= randomBytes(32).toString('hex');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PLANNER_LLM)
      .useValue(new FakePlannerLlm())
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
    app = moduleRef.createNestApplication<NestExpressApplication>();
    await app.init();

    store = app.get(BrainStoreService);
    secrets = app.get(WorktreeSecretStore);
    ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));

    await ds.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID]);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Secret Org', 'secret-org', 'active')`,
      [ORG_ID],
    );
    const [repo] = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
       VALUES ($1, $2, 'Secret Repo', 'https://github.com/x/secret.git', 'main', true) RETURNING id`,
      [ORG_ID, SLUG],
    );
    repoId = repo.id;
    const [thread] = await ds.query(
      `INSERT INTO jobs (org_id, repo_id, origin, kind) VALUES ($1, $2, 'control', 'onboarding') RETURNING id`,
      [ORG_ID, repoId],
    );
    threadId = thread.id;
  });

  afterAll(async () => {
    if (ds) await ds.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID]).catch(() => undefined);
    await app?.close();
    if (prevSurface === undefined) delete process.env.SURFACE;
    else process.env.SURFACE = prevSurface;
    if (prevKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = prevKey;
  });

  it('routes the value to the encrypted store + grant, never the transcript', async () => {
    const requestId = 's-leak-test-1';
    // (1) The brain's request_secret tool opens a value-FREE card + the durable gate.
    const card = webSecretInputCard({ threadId, requestId, name: SECRET_NAME, path: SECRET_PATH, description: 'DB connection string' });
    const opened = await store.openSecretRequest(threadId, { requestId, card });
    expect(opened.ok).toBe(true);
    expect(await store.awaitingSecretId(threadId)).toBe(requestId);

    // (2) The `provide-secret` endpoint's work: value → encrypted store + grant + stamp provided_at.
    await secrets.write(ORG_ID, SECRET_NAME, SECRET_VALUE);
    await secrets.grant(ORG_ID, repoId, SECRET_NAME, SECRET_PATH);
    await store.markSecretProvided(threadId, requestId);

    // (3) THE LEAK ASSERTION — the plaintext value is in NO message row (card text, card jsonb, anything).
    const rows = await ds.query(
      `SELECT count(*)::int AS n FROM messages WHERE job_id = $1 AND (text LIKE $2 OR card::text LIKE $2)`,
      [threadId, `%${SECRET_VALUE}%`],
    );
    expect(rows[0].n).toBe(0);

    // …but the value IS recoverable (encrypted) from the store, and the grant exists.
    expect(await secrets.read(ORG_ID, SECRET_NAME)).toBe(SECRET_VALUE);
    const grants = await secrets.listGrants(ORG_ID, repoId);
    expect(grants).toContainEqual({ repoId, name: SECRET_NAME, path: SECRET_PATH });

    // The encrypted column never contains the plaintext either.
    const enc = await ds.query(`SELECT value_enc FROM org_worktree_secrets WHERE org_id = $1 AND name = $2`, [ORG_ID, SECRET_NAME]);
    expect(enc[0].value_enc).not.toContain(SECRET_VALUE);

    // (4) Crash-safe lifecycle: provided-but-undelivered surfaces for boot re-delivery (name/path only).
    const pending = await store.findUndeliveredProvidedSecrets();
    const mine = pending.find((p) => p.requestId === requestId);
    expect(mine).toMatchObject({ threadId, orgId: ORG_ID, repoId, name: SECRET_NAME, path: SECRET_PATH });
    expect(JSON.stringify(mine)).not.toContain(SECRET_VALUE);

    // (5) Delivery success-tail: stamp delivered + clear gate → no longer pending.
    await store.markSecretDelivered(threadId, requestId);
    await store.clearAwaitingSecret(threadId, requestId);
    expect(await store.awaitingSecretId(threadId)).toBeNull();
    expect((await store.findUndeliveredProvidedSecrets()).some((p) => p.requestId === requestId)).toBe(false);
  });
});
