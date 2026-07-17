
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ENGINE_RUNNER } from '@shared/engine';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppOldModule } from '../../app-v1.module';
import { FakeClassifierLlm, FakeEngineRunner, FakeLocalGitService } from '../../e2e/e2e-stubs';
import { DB_CONNECTION } from '../../persistence/database.module';
import { CredentialResolver } from '../credential-resolver.service';
import { CLASSIFIER_LLM } from '../../decision-gate/classifier-llm';
import { GithubPrService } from '../../git/github-pr.service';
import { LocalGitService } from '../../git/local-git.service';


class StubGithubPrService {
  async getRepo(_token: string, owner: string, repo: string): Promise<unknown> {
    return repo.includes('ghost') ? null : { fullName: `${owner}/${repo}`, defaultBranch: 'main' };
  }
  async openPullRequest(): Promise<unknown> {
    return { url: '', number: 0, existing: false };
  }
  async markReadyForReview(): Promise<unknown> {
    return { isDraft: false };
  }
  async commentOnPullRequest(): Promise<void> {}
  async getPullState(): Promise<string> {
    return 'open';
  }
}

const fakeCreds = {
  anthropicKey: async () => undefined,
  openaiKey: async () => undefined,
  githubToken: async () => 'fake-token',
  hostGithubToken: async () => 'fake-token',
  engineAuth: async () => ({ secret: 'test-secret' }),
};


const ORG1 = '55555555-5555-4555-8555-555555555551';
const ORG2 = '55555555-5555-4555-8555-555555555552';
const OWNER_EMAIL = 'repo-it-owner@example.test';
const MEMBER_EMAIL = 'repo-it-member@example.test';
const PASSWORD = 'repo-it-pw-12345';

const reposPath = (orgId: string) => `/web/orgs/${orgId}/repos`;

let app: NestExpressApplication;
let ds: DataSource;
let server: ReturnType<NestExpressApplication['getHttpServer']>;
let ownerCookie: string;
let memberCookie: string;

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
    await ds.query(`DELETE FROM repos WHERE org_id = $1`, [org]).catch(() => undefined);
    await ds
      .query(`DELETE FROM organization_members WHERE org_id = $1`, [org])
      .catch(() => undefined);
    await ds.query(`DELETE FROM organizations WHERE id = $1`, [org]).catch(() => undefined);
  }
  await ds
    .query(
      `DELETE FROM organization_members WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1))`,
      [[OWNER_EMAIL, MEMBER_EMAIL]],
    )
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM users WHERE email = ANY($1)`, [[OWNER_EMAIL, MEMBER_EMAIL]])
    .catch(() => undefined);
}

beforeAll(async () => {
  const prevSurface = process.env.SURFACE;
  process.env.SURFACE = 'agent';

  const moduleRef = await Test.createTestingModule({ imports: [AppOldModule] })
    .overrideProvider(CLASSIFIER_LLM)
    .useValue(new FakeClassifierLlm())
    .overrideProvider(ENGINE_RUNNER)
    .useValue(new FakeEngineRunner())
    .overrideProvider(LocalGitService)
    .useValue(new FakeLocalGitService())
    .overrideProvider(GithubPrService)
    .useValue(new StubGithubPrService())
    .overrideProvider(CredentialResolver)
    .useValue(fakeCreds)
    .compile();

  app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  app.use(cookieParser()); // populates req.cookies — the auth guard reads the access_token cookie from it
  app.enableShutdownHooks();
  await app.init();

  server = app.getHttpServer();
  ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));

  await purge();
  const owner = await register(OWNER_EMAIL);
  const member = await register(MEMBER_EMAIL);
  ownerCookie = owner.cookie;
  memberCookie = member.cookie;

  for (const [id, slug] of [
    [ORG1, 'repo-it-one'],
    [ORG2, 'repo-it-two'],
  ] as const) {
    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')`,
      [id, `Org ${slug}`, slug],
    );
    await ds.query(
      `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [id, owner.id],
    );
  }
  await ds.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')`,
    [ORG1, member.id],
  );

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
    await ds.query(`DELETE FROM repos WHERE org_id = $1`, [org]);
  }
});

describe('RepoController HTTP (auth + owner/membership guards, live Postgres)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(server).get(reposPath(ORG1));
    expect(res.status).toBe(401);
  });

  it('owner: full connect → list → update → revalidate → disconnect lifecycle', async () => {
    let res = await request(server)
      .post(reposPath(ORG1))
      .set('Cookie', ownerCookie)
      .send({ repoUrl: 'https://github.com/atlas-it/repo-one.git' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      slug: 'repo-one',
      name: 'repo-one',
      accessOk: true,
    });
    expect(res.body).toMatchObject({
      defaultAutoMergeMethod: 'squash',
      defaultAutoMergeDeleteBranch: true,
    });
    const repoId = res.body.id as string;
    expect(repoId).toBeTruthy();

    res = await request(server).get(reposPath(ORG1)).set('Cookie', ownerCookie);
    expect(res.status).toBe(200);
    const row = (res.body as Array<Record<string, unknown>>).find((r) => r.id === repoId);
    expect(row).toMatchObject({ slug: 'repo-one', threadCount: 0 });
    expect(row?.accessCheckedAt).toBeTruthy();

    res = await request(server)
      .patch(`${reposPath(ORG1)}/${repoId}`)
      .set('Cookie', ownerCookie)
      .send({
        name: 'Renamed by IT',
        defaultBranch: 'develop',
        defaultAutoMergeMethod: 'rebase',
        defaultAutoMergeDeleteBranch: false,
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Renamed by IT',
      defaultBranch: 'develop',
      defaultAutoMergeMethod: 'rebase',
      defaultAutoMergeDeleteBranch: false,
    });

    res = await request(server).get(reposPath(ORG1)).set('Cookie', ownerCookie);
    const updatedRow = (res.body as Array<Record<string, unknown>>).find((r) => r.id === repoId);
    expect(updatedRow?.name).toBe('Renamed by IT');
    expect(updatedRow).toMatchObject({
      defaultAutoMergeMethod: 'rebase',
      defaultAutoMergeDeleteBranch: false,
    });

    res = await request(server)
      .post(`${reposPath(ORG1)}/${repoId}/revalidate`)
      .set('Cookie', ownerCookie);
    expect(res.status).toBe(201);
    expect(res.body.accessOk).toBe(true);

    res = await request(server)
      .delete(`${reposPath(ORG1)}/${repoId}`)
      .set('Cookie', ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, threadsDeleted: 0 });

    res = await request(server).get(reposPath(ORG1)).set('Cookie', ownerCookie);
    expect((res.body as Array<Record<string, unknown>>).some((r) => r.id === repoId)).toBe(false);
  });

  it('records accessOk=false when the repo is unreachable with the org token', async () => {
    const res = await request(server)
      .post(reposPath(ORG1))
      .set('Cookie', ownerCookie)
      .send({ repoUrl: 'https://github.com/atlas-it/ghost-repo.git' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ slug: 'ghost-repo', accessOk: false });
  });

  it('an owner of multiple orgs manages each org independently', async () => {
    const r1 = await request(server)
      .post(reposPath(ORG1))
      .set('Cookie', ownerCookie)
      .send({ repoUrl: 'https://github.com/atlas-it/alpha.git' });
    const r2 = await request(server)
      .post(reposPath(ORG2))
      .set('Cookie', ownerCookie)
      .send({ repoUrl: 'https://github.com/atlas-it/beta.git' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    const l1 = await request(server).get(reposPath(ORG1)).set('Cookie', ownerCookie);
    const l2 = await request(server).get(reposPath(ORG2)).set('Cookie', ownerCookie);
    expect((l1.body as Array<{ slug: string }>).map((r) => r.slug)).toEqual(['alpha']);
    expect((l2.body as Array<{ slug: string }>).map((r) => r.slug)).toEqual(['beta']);
  });

  it('a member can read repos but every write is owner-gated (403)', async () => {
    const created = await request(server)
      .post(reposPath(ORG1))
      .set('Cookie', ownerCookie)
      .send({ repoUrl: 'https://github.com/atlas-it/shared.git' });
    const repoId = created.body.id as string;

    const list = await request(server).get(reposPath(ORG1)).set('Cookie', memberCookie);
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string }>).some((r) => r.id === repoId)).toBe(true);

    expect(
      (
        await request(server)
          .post(reposPath(ORG1))
          .set('Cookie', memberCookie)
          .send({ repoUrl: 'https://github.com/atlas-it/nope.git' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server)
          .patch(`${reposPath(ORG1)}/${repoId}`)
          .set('Cookie', memberCookie)
          .send({ name: 'hax' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server)
          .post(`${reposPath(ORG1)}/${repoId}/revalidate`)
          .set('Cookie', memberCookie)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server)
          .delete(`${reposPath(ORG1)}/${repoId}`)
          .set('Cookie', memberCookie)
      ).status,
    ).toBe(403);

    const after = await request(server).get(reposPath(ORG1)).set('Cookie', ownerCookie);
    expect((after.body as Array<{ id: string }>).some((r) => r.id === repoId)).toBe(true);
  });

  it('a non-member is denied every route on an org they do not belong to (403)', async () => {
    expect((await request(server).get(reposPath(ORG2)).set('Cookie', memberCookie)).status).toBe(
      403,
    );
    expect(
      (
        await request(server)
          .post(reposPath(ORG2))
          .set('Cookie', memberCookie)
          .send({ repoUrl: 'https://github.com/atlas-it/x.git' })
      ).status,
    ).toBe(403);
  });
});
