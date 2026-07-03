/**
 * TicketController HTTP-boundary integration test — boots the REAL `AppModule` over HTTP (supertest)
 * against live Postgres, driving the full auth cookie + `OrgMembershipGuard` pipeline (a direct method
 * call never runs guards). Covers what the unit specs structurally can't:
 *   - membership gating: unauthenticated → 401; non-member → 403; any member can CRUD (board is
 *     collaborative — tickets are NOT owner-gated, unlike repo writes)
 *   - per-repo number allocation (independent monotonic counters)
 *   - org + repo scoping (no cross-tenant / cross-repo bleed)
 *   - advisory dependencies: blocked derivation, self/cross-repo/cycle rejection
 *
 * Mirrors `onboarding/repo.controller.int.test.ts` for setup (stubs only external boundaries).
 */

import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLASSIFIER_LLM } from '../decision-gate';
import { ENGINE_RUNNER } from '../engine';
import { GithubPrService, LocalGitService } from '../git';
import { AppModule } from '../app.module';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../e2e/e2e-stubs';
import { JobTitler } from '../titling';
import { CredentialResolver } from '../onboarding/credential-resolver.service';

const fakeCreds = {
  anthropicKey: async () => undefined,
  openaiKey: async () => undefined,
  githubToken: async () => 'fake-token',
  engineAuth: async () => ({ secret: 'test-secret' }),
};

// Fixed ids → distinct from every other int test (which purge by their own ids).
const ORG1 = '66666666-6666-4666-8666-666666666661';
const ORG2 = '66666666-6666-4666-8666-666666666662';
const REPO1 = '66666666-6666-4666-8666-6666666666a1';
const REPO2 = '66666666-6666-4666-8666-6666666666a2'; // a second repo in ORG1 (cross-repo isolation)
const REPO3 = '66666666-6666-4666-8666-6666666666a3'; // a repo in ORG2
const OWNER_EMAIL = 'ticket-it-owner@example.test';
const MEMBER_EMAIL = 'ticket-it-member@example.test';
const OUTSIDER_EMAIL = 'ticket-it-outsider@example.test';
const PASSWORD = 'ticket-it-pw-12345';

const ticketsPath = (orgId: string, repoId: string) => `/web/orgs/${orgId}/repos/${repoId}/tickets`;

let app: NestExpressApplication;
let ds: DataSource;
let server: ReturnType<NestExpressApplication['getHttpServer']>;
let ownerCookie: string;
let memberCookie: string;
let outsiderCookie: string;

async function register(email: string): Promise<{ cookie: string; id: string }> {
  const res = await request(server)
    .post('/auth/register')
    .send({ email, password: PASSWORD, name: email.split('@')[0] });
  expect(res.status).toBe(200);
  const setCookie = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  return { cookie, id: res.body.user.id as string };
}

async function purge(): Promise<void> {
  for (const org of [ORG1, ORG2]) {
    await ds.query(`DELETE FROM jobs WHERE org_id = $1`, [org]).catch(() => undefined);
    await ds.query(`DELETE FROM tickets WHERE org_id = $1`, [org]).catch(() => undefined);
    await ds.query(`DELETE FROM repos WHERE org_id = $1`, [org]).catch(() => undefined);
    await ds.query(`DELETE FROM organization_members WHERE org_id = $1`, [org]).catch(() => undefined);
    await ds.query(`DELETE FROM organizations WHERE id = $1`, [org]).catch(() => undefined);
  }
  await ds
    .query(`DELETE FROM organization_members WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1))`, [
      [OWNER_EMAIL, MEMBER_EMAIL, OUTSIDER_EMAIL],
    ])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM users WHERE email = ANY($1)`, [[OWNER_EMAIL, MEMBER_EMAIL, OUTSIDER_EMAIL]])
    .catch(() => undefined);
}

async function seedRepo(id: string, orgId: string, slug: string): Promise<void> {
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
     VALUES ($1, $2, $3, $4, $5, 'main', true)`,
    [id, orgId, slug, slug, `https://github.com/atlas-it/${slug}.git`],
  );
}

beforeAll(async () => {
  const prevSurface = process.env.SURFACE;
  process.env.SURFACE = 'agent';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLASSIFIER_LLM)
    .useValue(new FakeClassifierLlm())
    .overrideProvider(ENGINE_RUNNER)
    .useValue(new FakeEngineRunner())
    .overrideProvider(LocalGitService)
    .useValue(new FakeLocalGitService())
    .overrideProvider(GithubPrService)
    .useValue({})
    .overrideProvider(CredentialResolver)
    .useValue(fakeCreds)
    .overrideProvider(JobTitler)
    .useValue(new FakeThreadTitler())
    .compile();

  app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
  app.use(cookieParser());
  app.enableShutdownHooks();
  await app.init();

  server = app.getHttpServer();
  ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));

  await purge();
  const owner = await register(OWNER_EMAIL);
  const member = await register(MEMBER_EMAIL);
  const outsider = await register(OUTSIDER_EMAIL);
  ownerCookie = owner.cookie;
  memberCookie = member.cookie;
  outsiderCookie = outsider.cookie;

  for (const [id, slug] of [[ORG1, 'ticket-it-one'], [ORG2, 'ticket-it-two']] as const) {
    await ds.query(`INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')`, [id, `Org ${slug}`, slug]);
    await ds.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, owner.id]);
  }
  await ds.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [ORG1, member.id]);
  await seedRepo(REPO1, ORG1, 'repo-one');
  await seedRepo(REPO2, ORG1, 'repo-two');
  await seedRepo(REPO3, ORG2, 'repo-three');

  if (prevSurface === undefined) delete process.env.SURFACE;
  else process.env.SURFACE = prevSurface;
}, 60_000);

afterAll(async () => {
  if (ds) await purge().catch(() => undefined);
  await app?.close();
});

beforeEach(async () => {
  for (const org of [ORG1, ORG2]) {
    await ds.query(`DELETE FROM jobs WHERE org_id = $1`, [org]);
    await ds.query(`DELETE FROM tickets WHERE org_id = $1`, [org]);
    await ds.query(`DELETE FROM ticket_counters WHERE repo_id IN ($1, $2, $3)`, [REPO1, REPO2, REPO3]);
  }
});

async function createTicket(cookie: string, orgId: string, repoId: string, body: Record<string, unknown>) {
  return request(server).post(ticketsPath(orgId, repoId)).set('Cookie', cookie).send(body);
}

describe('TicketController HTTP (membership guard + scoping + dependencies, live Postgres)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    expect((await request(server).get(ticketsPath(ORG1, REPO1))).status).toBe(401);
  });

  it('a non-member is denied (403) on an org they do not belong to', async () => {
    expect((await request(server).get(ticketsPath(ORG2, REPO3)).set('Cookie', memberCookie)).status).toBe(403);
    expect((await createTicket(memberCookie, ORG2, REPO3, { title: 'nope' })).status).toBe(403);
    expect((await request(server).get(ticketsPath(ORG1, REPO1)).set('Cookie', outsiderCookie)).status).toBe(403);
  });

  it('a member can create/read/update/delete tickets (board is collaborative, not owner-gated)', async () => {
    const created = await createTicket(memberCookie, ORG1, REPO1, {
      title: 'Member ticket',
      body: 'captured by a member',
      priority: 'high',
      kind: 'feature',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ number: 1, title: 'Member ticket', status: 'backlog', priority: 'high' });
    const id = created.body.id as string;

    const got = await request(server).get(`${ticketsPath(ORG1, REPO1)}/${id}`).set('Cookie', memberCookie);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id, blocked: false, dependsOn: [], blocks: [] });

    const patched = await request(server)
      .patch(`${ticketsPath(ORG1, REPO1)}/${id}`)
      .set('Cookie', memberCookie)
      .send({ status: 'todo', title: 'Member ticket (moved)' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ status: 'todo', title: 'Member ticket (moved)' });

    const del = await request(server).delete(`${ticketsPath(ORG1, REPO1)}/${id}`).set('Cookie', memberCookie);
    expect(del.status).toBe(200);
    expect((await request(server).get(`${ticketsPath(ORG1, REPO1)}/${id}`).set('Cookie', memberCookie)).status).toBe(404);
  });

  it('rejects an invalid status with 400', async () => {
    const res = await createTicket(ownerCookie, ORG1, REPO1, { title: 'x', status: 'doing' });
    expect(res.status).toBe(400);
  });

  it('allocates monotonic per-repo numbers (independent counters per repo)', async () => {
    const a = await createTicket(ownerCookie, ORG1, REPO1, { title: 'r1-a' });
    const b = await createTicket(ownerCookie, ORG1, REPO1, { title: 'r1-b' });
    const c = await createTicket(ownerCookie, ORG1, REPO2, { title: 'r2-a' });
    expect(a.body.number).toBe(1);
    expect(b.body.number).toBe(2);
    expect(c.body.number).toBe(1); // REPO2 has its own counter
  });

  it('scopes tickets to org+repo (no cross-repo bleed)', async () => {
    const onRepo1 = await createTicket(ownerCookie, ORG1, REPO1, { title: 'lives on repo1' });
    const id = onRepo1.body.id as string;
    // Same org, different repo → not found.
    expect((await request(server).get(`${ticketsPath(ORG1, REPO2)}/${id}`).set('Cookie', ownerCookie)).status).toBe(404);
    // REPO2's list does not include it.
    const list2 = await request(server).get(ticketsPath(ORG1, REPO2)).set('Cookie', ownerCookie);
    expect((list2.body as Array<{ id: string }>).some((t) => t.id === id)).toBe(false);
  });

  it('derives blocked from advisory dependencies and clears it when the blocker is done', async () => {
    const a = await createTicket(ownerCookie, ORG1, REPO1, { title: 'A (blocked)' });
    const b = await createTicket(ownerCookie, ORG1, REPO1, { title: 'B (blocker)' });
    const aId = a.body.id as string;
    const bId = b.body.id as string;

    const addDep = await request(server)
      .post(`${ticketsPath(ORG1, REPO1)}/${aId}/dependencies`)
      .set('Cookie', ownerCookie)
      .send({ dependsOnTicketId: bId });
    expect(addDep.status).toBe(201);

    let aDetail = await request(server).get(`${ticketsPath(ORG1, REPO1)}/${aId}`).set('Cookie', ownerCookie);
    expect(aDetail.body.blocked).toBe(true);
    expect((aDetail.body.dependsOn as Array<{ id: string }>).map((t) => t.id)).toEqual([bId]);

    // B's detail shows it blocks A.
    const bDetail = await request(server).get(`${ticketsPath(ORG1, REPO1)}/${bId}`).set('Cookie', ownerCookie);
    expect((bDetail.body.blocks as Array<{ id: string }>).map((t) => t.id)).toEqual([aId]);

    // Resolve B → A is no longer blocked.
    await request(server).patch(`${ticketsPath(ORG1, REPO1)}/${bId}`).set('Cookie', ownerCookie).send({ status: 'done' });
    aDetail = await request(server).get(`${ticketsPath(ORG1, REPO1)}/${aId}`).set('Cookie', ownerCookie);
    expect(aDetail.body.blocked).toBe(false);
  });

  it('rejects self-dependencies and dependency cycles (400)', async () => {
    const a = await createTicket(ownerCookie, ORG1, REPO1, { title: 'A' });
    const b = await createTicket(ownerCookie, ORG1, REPO1, { title: 'B' });
    const aId = a.body.id as string;
    const bId = b.body.id as string;

    // self
    expect(
      (await request(server).post(`${ticketsPath(ORG1, REPO1)}/${aId}/dependencies`).set('Cookie', ownerCookie).send({ dependsOnTicketId: aId })).status,
    ).toBe(400);

    // A depends on B, then B depends on A → cycle
    await request(server).post(`${ticketsPath(ORG1, REPO1)}/${aId}/dependencies`).set('Cookie', ownerCookie).send({ dependsOnTicketId: bId });
    expect(
      (await request(server).post(`${ticketsPath(ORG1, REPO1)}/${bId}/dependencies`).set('Cookie', ownerCookie).send({ dependsOnTicketId: aId })).status,
    ).toBe(400);
  });

  it('rejects a cross-repo dependency edge (404 — the blocker is not in this repo)', async () => {
    const a = await createTicket(ownerCookie, ORG1, REPO1, { title: 'A on repo1' });
    const c = await createTicket(ownerCookie, ORG1, REPO2, { title: 'C on repo2' });
    const res = await request(server)
      .post(`${ticketsPath(ORG1, REPO1)}/${a.body.id}/dependencies`)
      .set('Cookie', ownerCookie)
      .send({ dependsOnTicketId: c.body.id });
    expect(res.status).toBe(404);
  });

  it('promotes a ticket to a linked thread, flips status to in_progress, and is idempotent', async () => {
    const created = await createTicket(ownerCookie, ORG1, REPO1, { title: 'Editable rename (later)', body: 'do this next' });
    const ticketId = created.body.id as string;

    const promoted = await request(server).post(`${ticketsPath(ORG1, REPO1)}/${ticketId}/promote`).set('Cookie', ownerCookie);
    expect(promoted.status).toBe(201);
    expect(promoted.body.created).toBe(true);
    const jobId = promoted.body.jobId as string;
    expect(jobId).toBeTruthy();

    // The thread row carries the link, and the ticket advanced onto the board.
    const [thread] = await ds.query(`SELECT ticket_id FROM jobs WHERE id = $1`, [jobId]);
    expect(thread.ticket_id).toBe(ticketId);
    const detail = await request(server).get(`${ticketsPath(ORG1, REPO1)}/${ticketId}`).set('Cookie', ownerCookie);
    expect(detail.body).toMatchObject({ status: 'in_progress', linkedThreadId: jobId });

    // Idempotent: a second promote returns the SAME thread, creates nothing new.
    const again = await request(server).post(`${ticketsPath(ORG1, REPO1)}/${ticketId}/promote`).set('Cookie', ownerCookie);
    expect(again.body).toMatchObject({ jobId, created: false });
    const count = await ds.query(`SELECT count(*)::int AS n FROM jobs WHERE ticket_id = $1`, [ticketId]);
    expect(count[0].n).toBe(1);
  });

  it('enforces thread↔ticket 1:1 at the database (partial unique index)', async () => {
    const created = await createTicket(ownerCookie, ORG1, REPO1, { title: 'one-thread-only' });
    const ticketId = created.body.id as string;
    await request(server).post(`${ticketsPath(ORG1, REPO1)}/${ticketId}/promote`).set('Cookie', ownerCookie);
    // A second thread pointing at the same ticket must be rejected by uq_threads_ticket_id.
    await expect(
      ds.query(
        `INSERT INTO jobs (org_id, repo_id, origin, ticket_id) VALUES ($1, $2, 'control', $3)`,
        [ORG1, REPO1, ticketId],
      ),
    ).rejects.toThrow();
  });

  it('promote is membership-gated (non-member → 403)', async () => {
    const created = await createTicket(ownerCookie, ORG1, REPO1, { title: 'guarded' });
    expect(
      (await request(server).post(`${ticketsPath(ORG1, REPO1)}/${created.body.id}/promote`).set('Cookie', outsiderCookie)).status,
    ).toBe(403);
  });
});
