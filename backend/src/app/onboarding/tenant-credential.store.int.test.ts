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
import { DB_CONNECTION } from '../persistence/database.module';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../e2e/e2e-stubs';
import { JobTitler } from '../titling';
import { TenantCredentialStore } from './tenant-credential.store';

/**
 * LIVE round-trip of the NEW `github_identity_mode` preference through the REAL {@link
 * TenantCredentialStore} against live Postgres — the genuine runtime surface of the data-store thread:
 * the TypeORM entity ↔ the actual nullable column, `write`/`read`/`presence`/`decryptRow`, the
 * explicit-null-clears vs undefined-leaves-unchanged patch semantics, and the DB CHECK constraint. The
 * resolver (`githubWriteIdentity`) and settings UI are later threads and are intentionally NOT exercised
 * here. Boots the REAL AppModule with only external boundaries faked.
 */
const ORG_ID = '55555555-5555-4555-8555-555555555555';

describe('TenantCredentialStore — github_identity_mode (live Postgres)', () => {
  let app: NestExpressApplication;
  let store: TenantCredentialStore;
  let ds: DataSource;

  const prevKey = process.env.SECRETS_ENCRYPTION_KEY;

  beforeAll(async () => {
    // A real 32-byte key so the store's encrypt-on-write / decrypt-on-read path actually runs.
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

    store = app.get(TenantCredentialStore);
    ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));

    await ds.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID]);
    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Identity Org', 'identity-org', 'active')`,
      [ORG_ID],
    );
  });

  afterAll(async () => {
    if (ds) await ds.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID]).catch(() => undefined);
    await app?.close();
    if (prevKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = prevKey;
  });

  it('defaults to null when never set, on read and presence', async () => {
    await store.write(ORG_ID, { githubPat: 'ghp_live' });
    expect((await store.read(ORG_ID))?.githubIdentityMode).toBeNull();
    expect((await store.presence(ORG_ID)).githubIdentityMode).toBeNull();
  });

  it("persists a 'pat' / 'app' preference and reads it back", async () => {
    await store.write(ORG_ID, { githubIdentityMode: 'app' });
    expect((await store.read(ORG_ID))?.githubIdentityMode).toBe('app');
    expect((await store.presence(ORG_ID)).githubIdentityMode).toBe('app');

    await store.write(ORG_ID, { githubIdentityMode: 'pat' });
    expect((await store.read(ORG_ID))?.githubIdentityMode).toBe('pat');
    expect((await store.presence(ORG_ID)).githubIdentityMode).toBe('pat');
  });

  it('undefined leaves the preference unchanged; explicit null clears it', async () => {
    await store.write(ORG_ID, { githubIdentityMode: 'app' });
    // An unrelated patch (field absent) must not touch the stored preference.
    await store.write(ORG_ID, { anthropicApiKey: 'sk-ant-live' });
    expect((await store.read(ORG_ID))?.githubIdentityMode).toBe('app');
    // Explicit null clears back to the default (null → resolves as 'pat').
    await store.write(ORG_ID, { githubIdentityMode: null });
    expect((await store.read(ORG_ID))?.githubIdentityMode).toBeNull();
  });

  it('the DB CHECK constraint rejects a value outside (pat, app)', async () => {
    await expect(
      ds.query(`UPDATE org_credentials SET github_identity_mode = 'bogus' WHERE org_id = $1`, [ORG_ID]),
    ).rejects.toThrow(/CHK_org_credentials_github_identity_mode|check constraint/i);
  });
});
