/**
 * WorkspaceProfileController HTTP-boundary integration test — boots the real `AppModule` over HTTP
 * (supertest) against live Postgres, mirroring `repo.controller.int.test.ts`'s harness exactly (same
 * external-boundary stubs, same cookie-based auth, same fixed-UUID sentinel tenant pattern — kept
 * distinct from every other int test's ids so they never collide when run together).
 *
 * Proves the composed GET shape, the extracted `normalizeMounts` guard rejecting a bad mount over
 * HTTP (400), owner-only writes (`OrgOwnerGuard` → 403 for a member), and the repo-in-org 404 guard
 * (`assertRepo`) — none of which the pure stores/helpers can prove on their own.
 */

import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLASSIFIER_LLM } from '../decision-gate';
import { ENGINE_RUNNER } from '@shared/engine';
import { GithubPrService, LocalGitService } from '../git';
import { AppModule } from '../app.module';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeLocalGitService,
} from '../e2e/e2e-stubs';
import { CredentialResolver } from './credential-resolver.service';

// ── External boundary stubs (mirrors repo.controller.int.test.ts) ──────────────────────────────────

class StubGithubPrService {
  async getRepo(_token: string, owner: string, repo: string): Promise<unknown> {
    return { fullName: `${owner}/${repo}`, defaultBranch: 'main' };
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

// ── Sentinel tenant (fixed ids → kept distinct from every other int test) ────────────────────────────

const ORG = '66666666-6666-4666-8666-666666666661';
const OTHER_ORG = '66666666-6666-4666-8666-666666666662';
const OTHER_REPO = '66666666-6666-4666-8666-666666666663';
const OWNER_EMAIL = 'workspace-profile-it-owner@example.test';
const MEMBER_EMAIL = 'workspace-profile-it-member@example.test';
const PASSWORD = 'workspace-profile-it-pw-12345';

const reposPath = (orgId: string) => `/web/orgs/${orgId}/repos`;
const profilePath = (orgId: string, repoId: string) =>
  `/web/orgs/${orgId}/repos/${repoId}/workspace-profile`;

let app: NestExpressApplication;
let ds: DataSource;
let server: ReturnType<NestExpressApplication['getHttpServer']>;
let ownerCookie: string;
let memberCookie: string;
let repoId: string;

async function register(
  email: string,
): Promise<{ cookie: string; id: string }> {
  const res = await request(server)
    .post('/auth/register')
    .send({ email, password: PASSWORD, name: email.split('@')[0] });
  expect(res.status).toBe(200);
  const setCookie =
    (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  return { cookie, id: res.body.user.id as string };
}

async function purge(): Promise<void> {
  await ds
    .query(`DELETE FROM jobs WHERE org_id = ANY($1)`, [[ORG, OTHER_ORG]])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM repos WHERE org_id = ANY($1)`, [[ORG, OTHER_ORG]])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM organization_members WHERE org_id = ANY($1)`, [
      [ORG, OTHER_ORG],
    ])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM organizations WHERE id = ANY($1)`, [[ORG, OTHER_ORG]])
    .catch(() => undefined);
  await ds
    .query(
      `DELETE FROM organization_members WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1))`,
      [[OWNER_EMAIL, MEMBER_EMAIL]],
    )
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM users WHERE email = ANY($1)`, [
      [OWNER_EMAIL, MEMBER_EMAIL],
    ])
    .catch(() => undefined);
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
    .useValue(new StubGithubPrService())
    .overrideProvider(CredentialResolver)
    .useValue(fakeCreds)
    .compile();

  app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  app.use(cookieParser());
  app.enableShutdownHooks();
  await app.init();

  server = app.getHttpServer();
  ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));

  await purge();
  const owner = await register(OWNER_EMAIL);
  const member = await register(MEMBER_EMAIL);
  ownerCookie = owner.cookie;
  memberCookie = member.cookie;

  await ds.query(
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')`,
    [ORG, 'Org workspace-profile-it', 'workspace-profile-it'],
  );
  await ds.query(
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')`,
    [OTHER_ORG, 'Other workspace-profile-it', 'workspace-profile-it-other'],
  );
  await ds.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [ORG, owner.id],
  );
  await ds.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'member')`,
    [ORG, member.id],
  );
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url) VALUES ($1, $2, $3, $4, $5)`,
    [
      OTHER_REPO,
      OTHER_ORG,
      'other-workspace-profile-repo',
      'other-workspace-profile-repo',
      'https://github.com/atlas-it/other-workspace-profile-repo.git',
    ],
  );

  if (prevSurface === undefined) delete process.env.SURFACE;
  else process.env.SURFACE = prevSurface;
}, 60_000);

afterAll(async () => {
  if (ds) await purge().catch(() => undefined);
  await app?.close();
});

/** Wipe jobs/repos between tests, then reconnect a fresh repo for the test to operate on. */
beforeEach(async () => {
  await ds.query(`DELETE FROM jobs WHERE org_id = $1`, [ORG]);
  await ds.query(`DELETE FROM repos WHERE org_id = $1`, [ORG]);

  const created = await request(server)
    .post(reposPath(ORG))
    .set('Cookie', ownerCookie)
    .send({
      repoUrl: 'https://github.com/atlas-it/workspace-profile-repo.git',
    });
  expect(created.status).toBe(201);
  repoId = created.body.id as string;
});

describe('WorkspaceProfileController HTTP (auth + owner/membership guards, live Postgres)', () => {
  it('member: GET returns the composed shape, and secretFiles never leaks a value', async () => {
    // Seed a secret file via the existing WorkspaceSecretsController route.
    const setFile = await request(server)
      .put(`/web/orgs/${ORG}/workspace-secrets/files`)
      .set('Cookie', ownerCookie)
      .send({
        repoId,
        path: '.env.secret',
        value: 'super-secret-value',
        label: 'Env secret',
      });
    expect(setFile.status).toBe(200);

    const res = await request(server)
      .get(profilePath(ORG, repoId))
      .set('Cookie', memberCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mounts: [],
      setupScript: null,
      previewRecipe: null,
      seenManifests: null,
    });
    expect(res.body.secretFiles).toEqual([
      { path: '.env.secret', label: 'Env secret' },
    ]);

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('super-secret-value');
    expect(raw).not.toContain('"value"');
  });

  it('owner: secret file writes reject unsafe destination paths', async () => {
    const res = await request(server)
      .put(`/web/orgs/${ORG}/workspace-secrets/files`)
      .set('Cookie', ownerCookie)
      .send({
        repoId,
        path: '../evil',
        value: 'super-secret-value',
        label: 'Bad path',
      });
    expect(res.status).toBe(400);

    const get = await request(server)
      .get(profilePath(ORG, repoId))
      .set('Cookie', ownerCookie);
    expect(get.body.secretFiles).toEqual([]);
  });

  it('owner: secret file writes/deletes require the repo to belong to the current org', async () => {
    const put = await request(server)
      .put(`/web/orgs/${ORG}/workspace-secrets/files`)
      .set('Cookie', ownerCookie)
      .send({
        repoId: OTHER_REPO,
        path: '.env.secret',
        value: 'super-secret-value',
        label: 'Wrong org',
      });
    expect(put.status).toBe(404);

    const del = await request(server)
      .delete(`/web/orgs/${ORG}/workspace-secrets/files`)
      .set('Cookie', ownerCookie)
      .send({ repoId: OTHER_REPO, path: '.env.secret' });
    expect(del.status).toBe(404);

    const rows = await ds.query(
      `SELECT 1 FROM org_workspace_secret_files WHERE org_id = $1 AND repo_id = $2`,
      [ORG, OTHER_REPO],
    );
    expect(rows).toHaveLength(0);
  });

  it('owner: PUT mounts with a valid mount persists and is reflected by a follow-up GET', async () => {
    const put = await request(server)
      .put(`${profilePath(ORG, repoId)}/mounts`)
      .set('Cookie', ownerCookie)
      .send({ path: 'some/cache', mode: 'shared-ro' });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true, restartsSandbox: true });

    const get = await request(server)
      .get(profilePath(ORG, repoId))
      .set('Cookie', ownerCookie);
    expect(get.body.mounts).toEqual([
      { path: 'some/cache', mode: 'shared-ro' },
    ]);
  });

  it('owner: PUT mounts with an invalid ".." path is rejected with 400', async () => {
    const res = await request(server)
      .put(`${profilePath(ORG, repoId)}/mounts`)
      .set('Cookie', ownerCookie)
      .send({ path: '../evil' });
    expect(res.status).toBe(400);
  });

  it('owner: PUT mounts with an invalid mode is rejected with 400', async () => {
    const res = await request(server)
      .put(`${profilePath(ORG, repoId)}/mounts`)
      .set('Cookie', ownerCookie)
      .send({ path: 'some/cache', mode: 'world-writable' });
    expect(res.status).toBe(400);
  });

  it('owner: DELETE mounts removes a previously-set mount', async () => {
    await request(server)
      .put(`${profilePath(ORG, repoId)}/mounts`)
      .set('Cookie', ownerCookie)
      .send({ path: 'some/cache' });

    const del = await request(server)
      .delete(`${profilePath(ORG, repoId)}/mounts`)
      .set('Cookie', ownerCookie)
      .send({ path: 'some/cache' });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, restartsSandbox: true });

    const get = await request(server)
      .get(profilePath(ORG, repoId))
      .set('Cookie', ownerCookie);
    expect(get.body.mounts).toEqual([]);
  });

  it('owner: PUT setup-script persists, and an empty script clears it to null', async () => {
    const put = await request(server)
      .put(`${profilePath(ORG, repoId)}/setup-script`)
      .set('Cookie', ownerCookie)
      .send({ script: 'npm install' });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true });

    let get = await request(server)
      .get(profilePath(ORG, repoId))
      .set('Cookie', ownerCookie);
    expect(get.body.setupScript).toBe('npm install');

    const clear = await request(server)
      .put(`${profilePath(ORG, repoId)}/setup-script`)
      .set('Cookie', ownerCookie)
      .send({ script: '' });
    expect(clear.status).toBe(200);

    get = await request(server)
      .get(profilePath(ORG, repoId))
      .set('Cookie', ownerCookie);
    expect(get.body.setupScript).toBeNull();
  });

  it('owner: PUT preview-recipe persists', async () => {
    const put = await request(server)
      .put(`${profilePath(ORG, repoId)}/preview-recipe`)
      .set('Cookie', ownerCookie)
      .send({ instructions: 'npm run preview' });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true });

    const get = await request(server)
      .get(profilePath(ORG, repoId))
      .set('Cookie', ownerCookie);
    expect(get.body.previewRecipe).toBe('npm run preview');
  });

  it('every write is owner-gated (403) for a non-owner member', async () => {
    expect(
      (
        await request(server)
          .put(`${profilePath(ORG, repoId)}/mounts`)
          .set('Cookie', memberCookie)
          .send({ path: 'some/cache' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server)
          .delete(`${profilePath(ORG, repoId)}/mounts`)
          .set('Cookie', memberCookie)
          .send({ path: 'some/cache' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server)
          .put(`${profilePath(ORG, repoId)}/setup-script`)
          .set('Cookie', memberCookie)
          .send({ script: 'echo hi' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server)
          .put(`${profilePath(ORG, repoId)}/preview-recipe`)
          .set('Cookie', memberCookie)
          .send({ instructions: 'echo hi' })
      ).status,
    ).toBe(403);
  });

  it('GET/PUT for a repoId that does not belong to the org 404s', async () => {
    const bogusRepoId = '00000000-0000-4000-8000-000000000000';
    expect(
      (
        await request(server)
          .get(profilePath(ORG, bogusRepoId))
          .set('Cookie', ownerCookie)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(server)
          .put(`${profilePath(ORG, bogusRepoId)}/mounts`)
          .set('Cookie', ownerCookie)
          .send({ path: 'some/cache' })
      ).status,
    ).toBe(404);
  });
});
