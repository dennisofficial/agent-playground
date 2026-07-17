
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ENGINE_RUNNER } from '@shared/engine';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppOldModule } from '../../app-v1.module';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
} from '../../e2e/e2e-stubs';
import { DB_CONNECTION } from '../../persistence/database.module';
import { ClaudeCredentialStore } from '../claude-credential.store';
import { CredentialKeepAliveService } from '../credential-keepalive.service';
import {
  CredentialNeedsReauthError,
  CredentialRefreshService,
} from '../credential-refresh.service';
import { CredentialResolver } from '../credential-resolver.service';
import { CLASSIFIER_LLM } from '../../decision-gate/classifier-llm';
import { GithubPrService } from '../../git/github-pr.service';
import { LocalGitService } from '../../git/local-git.service';
import { OauthUsageService } from '../oauth-usage.service';

const fakeCreds = {
  anthropicKey: () => Promise.resolve(undefined),
  openaiKey: () => Promise.resolve(undefined),
  githubToken: () => Promise.resolve(undefined),
  hostGithubToken: () => Promise.resolve(undefined),
  engineAuth: () => Promise.resolve(undefined),
};


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type StubHandler = (res: http.ServerResponse) => void | Promise<void>;

let requestCount = 0;
let refreshSeq = 0;

function successHandler(delayMs = 0): StubHandler {
  return async (res) => {
    if (delayMs > 0) await sleep(delayMs); // holds the row lock long enough for a concurrent caller to block on it
    refreshSeq += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        access_token: `stub-access-${refreshSeq}`,
        refresh_token: `stub-refresh-${refreshSeq}`,
        expires_in: 28_800,
      }),
    );
  };
}

function errorHandler(status: number): StubHandler {
  return (res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `stub-${status}` }));
  };
}

let handler: StubHandler = successHandler();

const tokenServer = http.createServer((req, res) => {
  requestCount += 1;
  req.resume(); // drain the body (unused) so the request completes
  req.on('end', () => void handler(res));
});

const ORG = 'c0ffee00-c0ff-4eee-8eee-c0ffee000001';

let app: NestExpressApplication;
let ds: DataSource;
let store: ClaudeCredentialStore;
let credRefresh: CredentialRefreshService;
let keepalive: CredentialKeepAliveService;
let usage: OauthUsageService;
let prevTokenUrl: string | undefined;

async function seedCred(expiresInMs: number, label: string): Promise<string> {
  const credId = await seedCredUnselected(expiresInMs, label);
  await ds.query(`UPDATE organizations SET selected_claude_credential_id = $1 WHERE id = $2`, [
    credId,
    ORG,
  ]);
  return credId;
}

async function seedCredUnselected(expiresInMs: number, label: string): Promise<string> {
  return store.upsertPersonal(ORG, {
    label,
    accessToken: `seed-access-${label}`,
    refreshToken: `seed-refresh-${label}`,
    expiresAt: Date.now() + expiresInMs,
  });
}

async function getRow(credId: string): Promise<{
  status: string;
  expires_at: Date;
  last_refreshed_at: Date | null;
}> {
  const rows = await ds.query(
    `SELECT status, expires_at, last_refreshed_at FROM claude_credentials WHERE id = $1`,
    [credId],
  );
  return rows[0];
}

beforeAll(async () => {
  await new Promise<void>((resolve) => tokenServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (tokenServer.address() as AddressInfo).port;

  const prevSurface = process.env.SURFACE;
  prevTokenUrl = process.env.CLAUDE_OAUTH_TOKEN_URL;
  process.env.SURFACE = 'agent';
  process.env.CLAUDE_OAUTH_TOKEN_URL = `http://127.0.0.1:${port}`;

  const moduleRef = await Test.createTestingModule({ imports: [AppOldModule] })
    .overrideProvider(CLASSIFIER_LLM)
    .useValue(new FakeClassifierLlm())
    .overrideProvider(ENGINE_RUNNER)
    .useValue(new FakeEngineRunner())
    .overrideProvider(LocalGitService)
    .useValue(new FakeLocalGitService())
    .overrideProvider(GithubPrService)
    .useValue(new FakeGithubPrService())
    .overrideProvider(CredentialResolver)
    .useValue(fakeCreds)
    .compile();

  app = moduleRef.createNestApplication<NestExpressApplication>();
  app.enableShutdownHooks();
  await app.init();

  ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));
  store = app.get(ClaudeCredentialStore);
  credRefresh = app.get(CredentialRefreshService);
  keepalive = app.get(CredentialKeepAliveService);
  usage = app.get(OauthUsageService);

  await ds.query(`DELETE FROM organizations WHERE id = $1`, [ORG]); // idempotent — survives a prior failed run
  await ds.query(
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Cred Refresh IT', 'cred-refresh-it', 'active')`,
    [ORG],
  );

  if (prevSurface === undefined) delete process.env.SURFACE;
  else process.env.SURFACE = prevSurface;
}, 60_000);

afterAll(async () => {
  if (ds) await ds.query(`DELETE FROM organizations WHERE id = $1`, [ORG]).catch(() => undefined);
  await app?.close();
  await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
  if (prevTokenUrl === undefined) delete process.env.CLAUDE_OAUTH_TOKEN_URL;
  else process.env.CLAUDE_OAUTH_TOKEN_URL = prevTokenUrl;
});

beforeEach(async () => {
  await ds.query(`DELETE FROM claude_credentials WHERE org_id = $1`, [ORG]);
  requestCount = 0;
  refreshSeq = 0;
  handler = successHandler();
});

afterEach(() => {
  handler = successHandler();
});

describe('CredentialRefreshService.ensureFresh (live Postgres + stub OAuth token server)', () => {
  it('a healthy (not-yet-expiring) credential never hits the token endpoint', async () => {
    const credId = await seedCred(6 * 60 * 60_000, 'healthy');
    const before = await store.getDecryptedById(ORG, credId);

    const secret = await credRefresh.ensureFresh(ORG, credId);

    expect(requestCount).toBe(0);
    expect(secret).toBe(before?.secret);
  });

  it('serializes concurrent refreshers of the same expiring credential into exactly ONE token request', async () => {
    const credId = await seedCred(5 * 60_000, 'concurrent');
    handler = successHandler(150); // slow enough that the second caller is guaranteed to block on the row lock

    const [secretA, secretB] = await Promise.all([
      credRefresh.ensureFresh(ORG, credId),
      credRefresh.ensureFresh(ORG, credId),
    ]);

    expect(requestCount).toBe(1);
    expect(secretA).toBe(secretB);
    const accessTokenOf = (secret: string): string =>
      (JSON.parse(secret) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken;
    expect(accessTokenOf(secretA)).toBe('stub-access-1');

    const row = await getRow(credId);
    expect(row.status).toBe('active');
    expect(row.expires_at.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
  });

  it('a hard 400 flips the credential to needs_reauth and throws CredentialNeedsReauthError', async () => {
    const credId = await seedCred(5 * 60_000, 'hard-400');
    handler = errorHandler(400);

    await expect(credRefresh.ensureFresh(ORG, credId)).rejects.toBeInstanceOf(
      CredentialNeedsReauthError,
    );

    const row = await getRow(credId);
    expect(row.status).toBe('needs_reauth');
  });

  it('an already needs_reauth credential is never reused or refreshed', async () => {
    const credId = await seedCred(6 * 60 * 60_000, 'already-needs-reauth');
    await store.markNeedsReauth(ORG, credId, 'test setup');

    await expect(credRefresh.ensureFresh(ORG, credId)).rejects.toBeInstanceOf(
      CredentialNeedsReauthError,
    );
    expect(requestCount).toBe(0);
  });

  it('a transient 503 leaves the credential active and untouched (no needs_reauth, no stored change)', async () => {
    const credId = await seedCred(5 * 60_000, 'transient-503');
    const before = await getRow(credId);
    handler = errorHandler(503);

    await expect(credRefresh.ensureFresh(ORG, credId)).rejects.not.toBeInstanceOf(
      CredentialNeedsReauthError,
    );

    const row = await getRow(credId);
    expect(row.status).toBe('active');
    expect(row.expires_at.getTime()).toBe(before.expires_at.getTime());
  });

  it('the keep-alive sweep refreshes a selected credential nearing expiry', async () => {
    const credId = await seedCred(10 * 60_000, 'keepalive'); // inside the 35-min sweep window
    const before = await getRow(credId);
    expect(before.last_refreshed_at).toBeNull();

    await keepalive.tick();

    expect(requestCount).toBe(1);
    const row = await getRow(credId);
    expect(row.status).toBe('active');
    expect(row.last_refreshed_at).not.toBeNull();
  });

  it('the keep-alive sweep refreshes a NON-selected personal credential nearing expiry', async () => {
    const credId = await seedCredUnselected(10 * 60_000, 'keepalive-unselected'); // inside the 35-min sweep window
    const before = await getRow(credId);
    expect(before.last_refreshed_at).toBeNull();

    await keepalive.tick();

    expect(requestCount).toBe(1);
    const row = await getRow(credId);
    expect(row.status).toBe('active');
    expect(row.last_refreshed_at).not.toBeNull();
  });

  it('credentialHealthSnapshot reports expired active + needs_reauth counts', async () => {
    const expiredCredId = await seedCred(-60_000, 'already-expired'); // PAST expiry before any tick

    const before = await store.credentialHealthSnapshot();
    expect(before.expiredActivePersonal).toBeGreaterThanOrEqual(1);

    handler = errorHandler(503); // refresh fails, so the expired cred stays expired

    await keepalive.tick();

    const after = await store.credentialHealthSnapshot();
    expect(after.expiredActivePersonal).toBeGreaterThanOrEqual(1);
    const expiredRow = await getRow(expiredCredId);
    expect(expiredRow.status).toBe('active');

    const reauthCredId = await seedCred(6 * 60 * 60_000, 'needs-reauth-setup');
    await store.markNeedsReauth(ORG, reauthCredId, 'test setup');

    const withReauth = await store.credentialHealthSnapshot();
    expect(withReauth.needsReauth).toBeGreaterThanOrEqual(1);
  });

  it('the Settings usage path shares the SAME serialized core — concurrent with a direct ensureFresh yields ONE request', async () => {
    const credId = await seedCred(5 * 60_000, 'usage-concurrent');
    handler = successHandler(150);

    await Promise.all([usage.getForCredential(ORG, credId), credRefresh.ensureFresh(ORG, credId)]);

    expect(requestCount).toBe(1);
  });

  it('the usage path degrades on a hard refresh failure but still leaves the row needs_reauth (not silently swallowed)', async () => {
    const credId = await seedCred(5 * 60_000, 'usage-hard-400');
    handler = errorHandler(400);

    const result = await usage.getForCredential(ORG, credId);

    expect(result.ok).toBe(false);
    const row = await getRow(credId);
    expect(row.status).toBe('needs_reauth');
  });
});
