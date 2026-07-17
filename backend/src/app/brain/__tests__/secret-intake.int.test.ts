import { randomBytes } from 'node:crypto';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { CLASSIFIER_LLM } from '../../decision-gate';
import { ENGINE_RUNNER } from '@shared/engine';
import { GithubPrService, LocalGitService } from '../../git';
import { AppModule } from '../../app.module';
import { WorkspaceSecretFileStore } from '../../onboarding';
import { DB_CONNECTION } from '../../persistence/database.module';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../../e2e/e2e-stubs';
import { JobTitler } from '../../titling';
import { webSecretInputCard } from '../../surface';
import { BrainStoreService } from '../brain-store.service';

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
  let secrets: WorkspaceSecretFileStore;
  let ds: DataSource;
  let jobId: string;
  let repoId: string;

  const prevSurface = process.env.SURFACE;
  const prevKey = process.env.SECRETS_ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.SURFACE = 'agent';
    // A real 32-byte key so the store actually encrypts/decrypts (read back the stored value below).
    process.env.SECRETS_ENCRYPTION_KEY ??= randomBytes(32).toString('hex');

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
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    await app.init();

    store = app.get(BrainStoreService);
    secrets = app.get(WorkspaceSecretFileStore);
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
    jobId = thread.id;
    await store.ensurePlanningThreadGroup(jobId, ORG_ID);
  });

  afterAll(async () => {
    if (ds)
      await ds
        .query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID])
        .catch(() => undefined);
    await app?.close();
    if (prevSurface === undefined) delete process.env.SURFACE;
    else process.env.SURFACE = prevSurface;
    if (prevKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = prevKey;
  });

  it('routes the value to the encrypted store + grant, never the transcript', async () => {
    const requestId = 's-leak-test-1';
    // (1) The brain's request_secret tool opens a value-FREE card + bumps the per-card open counter (this
    // request is DURABLE, not ephemeral — no single-slot `awaiting_secret_id` pointer is touched).
    const card = webSecretInputCard({
      jobId,
      requestId,
      name: SECRET_NAME,
      path: SECRET_PATH,
      description: 'DB connection string',
    });
    const opened = await store.openSecretRequest(jobId, { requestId, card });
    expect(opened.ok).toBe(true);
    expect(await store.awaitingSecretId(jobId)).toBeNull();
    expect(
      (await store.getSecretCard(jobId, requestId))?.provided_at,
    ).toBeUndefined();

    // (2) The `provide-secret` endpoint's work: value → encrypted secret file at (repo, path) + stamp
    // provided_at (per-card — also decrements `open_secret_count`). The name rides along as the display label.
    await secrets.write(ORG_ID, repoId, SECRET_PATH, SECRET_VALUE, SECRET_NAME);
    await store.markSecretProvidedPerCard(jobId, requestId);
    expect(
      (await store.getSecretCard(jobId, requestId))?.provided_at,
    ).toBeDefined();

    // (3) THE LEAK ASSERTION — the plaintext value is in NO message row (card text, card jsonb, anything).
    const rows = await ds.query(
      `SELECT count(*)::int AS n FROM transcript_messages WHERE job_id = $1 AND (text LIKE $2 OR card::text LIKE $2)`,
      [jobId, `%${SECRET_VALUE}%`],
    );
    expect(rows[0].n).toBe(0);

    // …but the value IS recoverable (encrypted) from the store, and the file ref exists.
    expect(await secrets.read(ORG_ID, repoId, SECRET_PATH)).toBe(SECRET_VALUE);
    const files = await secrets.list(ORG_ID, repoId);
    expect(files).toContainEqual({
      repoId,
      path: SECRET_PATH,
      label: SECRET_NAME,
    });

    // The encrypted column never contains the plaintext either.
    const enc = await ds.query(
      `SELECT value_enc FROM org_workspace_secret_files WHERE org_id = $1 AND repo_id = $2 AND path = $3`,
      [ORG_ID, repoId, SECRET_PATH],
    );
    expect(enc[0].value_enc).not.toContain(SECRET_VALUE);

    // (4) Crash-safe lifecycle: provided-but-undelivered surfaces for boot re-delivery (name/path only).
    const pending = await store.findUndeliveredProvidedSecrets();
    const mine = pending.find((p) => p.requestId === requestId);
    expect(mine).toMatchObject({
      jobId,
      orgId: ORG_ID,
      repoId,
      name: SECRET_NAME,
      path: SECRET_PATH,
    });
    expect(JSON.stringify(mine)).not.toContain(SECRET_VALUE);

    // (5) Delivery success-tail: stamp delivered + clear gate → no longer pending.
    await store.markSecretDelivered(jobId, requestId);
    await store.clearAwaitingSecret(jobId, requestId);
    expect(await store.awaitingSecretId(jobId)).toBeNull();
    expect(
      (await store.findUndeliveredProvidedSecrets()).some(
        (p) => p.requestId === requestId,
      ),
    ).toBe(false);
  });

  /** A fresh thread on the same org/repo — isolates the per-card lifecycle tests below from each other. */
  async function makeThread(): Promise<string> {
    const [thread] = await ds.query(
      `INSERT INTO jobs (org_id, repo_id, origin, kind) VALUES ($1, $2, 'control', 'onboarding') RETURNING id`,
      [ORG_ID, repoId],
    );
    await store.ensurePlanningThreadGroup(thread.id, ORG_ID);
    return thread.id;
  }

  /** The live `jobs.open_secret_count` counter for a thread. */
  async function openSecretCount(id: string): Promise<number> {
    const rows = await ds.query(
      `SELECT open_secret_count FROM jobs WHERE id = $1`,
      [id],
    );
    return rows[0].open_secret_count;
  }

  it('(a) two durable request_secret opens succeed concurrently — no alreadyOpen, both stay open', async () => {
    const thread = await makeThread();
    const cardA = webSecretInputCard({
      jobId: thread,
      requestId: 's-concurrent-a',
      name: 'API_KEY_A',
      path: '.env.a',
      description: 'first durable secret',
    });
    const cardB = webSecretInputCard({
      jobId: thread,
      requestId: 's-concurrent-b',
      name: 'API_KEY_B',
      path: '.env.b',
      description: 'second durable secret',
    });

    const [openedA, openedB] = await Promise.all([
      store.openSecretRequest(thread, {
        requestId: 's-concurrent-a',
        card: cardA,
      }),
      store.openSecretRequest(thread, {
        requestId: 's-concurrent-b',
        card: cardB,
      }),
    ]);

    expect(openedA).toEqual({ ok: true });
    expect(openedB).toEqual({ ok: true });
    expect(openedA.alreadyOpen).toBeUndefined();
    expect(openedB.alreadyOpen).toBeUndefined();

    const open = await store.openSecretCards(thread);
    expect(open.map((c) => c.requestId).sort()).toEqual([
      's-concurrent-a',
      's-concurrent-b',
    ]);
  });

  it('(b) an ephemeral open and a durable open on the same thread never block each other, either order', async () => {
    // Durable first, then ephemeral.
    const threadA = await makeThread();
    const durableCard = webSecretInputCard({
      jobId: threadA,
      requestId: 's-order-durable',
      name: 'DURABLE_FIRST',
      path: '.env',
      description: 'durable opened first',
    });
    const openedDurable = await store.openSecretRequest(threadA, {
      requestId: 's-order-durable',
      card: durableCard,
    });
    expect(openedDurable).toEqual({ ok: true });

    const ephemeralCard = webSecretInputCard({
      jobId: threadA,
      requestId: 's-order-ephemeral',
      name: 'EPHEMERAL_SECOND',
      description: 'ephemeral opened second',
      ephemeral: true,
      deliver_to: '/tmp/atlas-order-a',
    });
    const openedEphemeral = await store.openSecretRequest(threadA, {
      requestId: 's-order-ephemeral',
      card: ephemeralCard,
    });
    expect(openedEphemeral).toEqual({ ok: true });
    expect(await store.awaitingSecretId(threadA)).toBe('s-order-ephemeral');

    // Ephemeral first, then durable — the durable open must NOT be blocked by the ephemeral pointer.
    const threadB = await makeThread();
    const ephemeralFirst = webSecretInputCard({
      jobId: threadB,
      requestId: 's-order-ephemeral-2',
      name: 'EPHEMERAL_FIRST',
      description: 'ephemeral opened first',
      ephemeral: true,
      deliver_to: '/tmp/atlas-order-b',
    });
    const openedEphemeralFirst = await store.openSecretRequest(threadB, {
      requestId: 's-order-ephemeral-2',
      card: ephemeralFirst,
    });
    expect(openedEphemeralFirst).toEqual({ ok: true });
    expect(await store.awaitingSecretId(threadB)).toBe('s-order-ephemeral-2');

    const durableSecond = webSecretInputCard({
      jobId: threadB,
      requestId: 's-order-durable-2',
      name: 'DURABLE_SECOND',
      path: '.env',
      description:
        'durable opened second, must not be blocked by the ephemeral pointer',
    });
    const openedDurableSecond = await store.openSecretRequest(threadB, {
      requestId: 's-order-durable-2',
      card: durableSecond,
    });
    expect(openedDurableSecond).toEqual({ ok: true });
    expect(openedDurableSecond.alreadyOpen).toBeUndefined();
    // The ephemeral pointer is untouched by the durable open.
    expect(await store.awaitingSecretId(threadB)).toBe('s-order-ephemeral-2');
  });

  it('(c) withdraw_secret_request stamps withdrawnAt, blocks a later provide, and is idempotent', async () => {
    const thread = await makeThread();
    const requestId = 's-withdraw-1';
    const card = webSecretInputCard({
      jobId: thread,
      requestId,
      name: 'TO_BE_WITHDRAWN',
      path: '.env',
      description: 'will be withdrawn before it is ever provided',
    });
    await store.openSecretRequest(thread, { requestId, card });
    expect(await openSecretCount(thread)).toBe(1);

    const withdrawn = await store.withdrawSecretRequest(
      thread,
      requestId,
      'no longer needed',
    );
    expect(withdrawn).toEqual({ withdrawn: true });
    expect(await openSecretCount(thread)).toBe(0);
    const afterWithdraw = await store.getSecretCard(thread, requestId);
    expect(afterWithdraw?.withdrawnAt).toBeDefined();
    expect(afterWithdraw?.withdrawnReason).toBe('no longer needed');

    // A subsequent provide attempt against the withdrawn card is refused: markSecretProvidedPerCard's
    // conditional update only fires on an open card, so it's a no-op here and provided_at stays unset.
    await store.markSecretProvidedPerCard(thread, requestId);
    expect(
      (await store.getSecretCard(thread, requestId))?.provided_at,
    ).toBeUndefined();

    // Double-withdraw is idempotent — the second call is not the winner and does not double-decrement.
    const secondWithdraw = await store.withdrawSecretRequest(
      thread,
      requestId,
      'again',
    );
    expect(secondWithdraw).toEqual({ withdrawn: false });
    expect(await openSecretCount(thread)).toBe(0);
  });

  it('(d) boot sweep recovers TWO stuck durable secrets on the same thread', async () => {
    const thread = await makeThread();
    const cardOne = webSecretInputCard({
      jobId: thread,
      requestId: 's-stuck-1',
      name: 'STUCK_ONE',
      path: '.env.one',
      description: 'stuck secret one',
    });
    const cardTwo = webSecretInputCard({
      jobId: thread,
      requestId: 's-stuck-2',
      name: 'STUCK_TWO',
      path: '.env.two',
      description: 'stuck secret two',
    });
    await store.openSecretRequest(thread, {
      requestId: 's-stuck-1',
      card: cardOne,
    });
    await store.openSecretRequest(thread, {
      requestId: 's-stuck-2',
      card: cardTwo,
    });

    // Simulate the crash window: the operator provided both values (stamped provided_at) but the host died
    // before either delivery turn ran (delivered_at stays null).
    await store.markSecretProvidedPerCard(thread, 's-stuck-1');
    await store.markSecretProvidedPerCard(thread, 's-stuck-2');

    const pending = await store.findUndeliveredProvidedSecrets();
    const mine = pending.filter((p) => p.jobId === thread);
    expect(mine.map((p) => p.requestId).sort()).toEqual([
      's-stuck-1',
      's-stuck-2',
    ]);
  });

  it('(e) open_secret_count lifecycle: bumped on open, decremented on provide/withdraw, healed by reconcileOpenSecretCounts, unaffected by ephemeral opens', async () => {
    const thread = await makeThread();
    expect(await openSecretCount(thread)).toBe(0);

    const providedCard = webSecretInputCard({
      jobId: thread,
      requestId: 's-lifecycle-provided',
      name: 'LIFECYCLE_PROVIDED',
      path: '.env',
      description: 'opened then provided',
    });
    await store.openSecretRequest(thread, {
      requestId: 's-lifecycle-provided',
      card: providedCard,
    });
    expect(await openSecretCount(thread)).toBe(1);

    await store.markSecretProvidedPerCard(thread, 's-lifecycle-provided');
    expect(await openSecretCount(thread)).toBe(0);

    const withdrawnCard = webSecretInputCard({
      jobId: thread,
      requestId: 's-lifecycle-withdrawn',
      name: 'LIFECYCLE_WITHDRAWN',
      path: '.env',
      description: 'opened then withdrawn',
    });
    await store.openSecretRequest(thread, {
      requestId: 's-lifecycle-withdrawn',
      card: withdrawnCard,
    });
    expect(await openSecretCount(thread)).toBe(1);
    await store.withdrawSecretRequest(thread, 's-lifecycle-withdrawn');
    expect(await openSecretCount(thread)).toBe(0);

    // An EPHEMERAL open never touches the counter (it uses the single-slot pointer instead).
    const ephemeralCard = webSecretInputCard({
      jobId: thread,
      requestId: 's-lifecycle-ephemeral',
      name: 'LIFECYCLE_EPHEMERAL',
      description: 'ephemeral open must not bump open_secret_count',
      ephemeral: true,
      deliver_to: '/tmp/atlas-lifecycle',
    });
    await store.openSecretRequest(thread, {
      requestId: 's-lifecycle-ephemeral',
      card: ephemeralCard,
    });
    expect(await openSecretCount(thread)).toBe(0);

    // Boot heal: one genuinely-open durable card, but the counter is corrupted — reconcile must restore it.
    const openCard = webSecretInputCard({
      jobId: thread,
      requestId: 's-lifecycle-open',
      name: 'LIFECYCLE_OPEN',
      path: '.env',
      description: 'still open when the counter gets corrupted',
    });
    await store.openSecretRequest(thread, {
      requestId: 's-lifecycle-open',
      card: openCard,
    });
    expect(await openSecretCount(thread)).toBe(1);
    await ds.query(`UPDATE jobs SET open_secret_count = 99 WHERE id = $1`, [
      thread,
    ]);
    expect(await openSecretCount(thread)).toBe(99);

    await store.reconcileOpenSecretCounts();
    expect(await openSecretCount(thread)).toBe(1);

    // `open_secret_count > 0` is exactly the signal `AutoMergeService.brainSettled` gates on (see
    // `auto-merge.service.spec.ts` — "is false when open_secret_count > 0"); not re-asserted here to avoid
    // duplicating that unit coverage.
  });
});
