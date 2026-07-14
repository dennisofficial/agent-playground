/**
 * ProfileAwarenessService (live Postgres) — the host round-trip that dedups a detected install/remove
 * against the per-repo `profile_seen_tooling` ledger and returns the Stage-1 checklist (or null).
 *
 * Integration: real Postgres (atlas_test schema), no fakes — proves the atomic ledger transitions
 * (`WorkspaceConfigStore.applyToolingTransition`) end-to-end, mirroring `pipeline-awareness.int.test.ts`'s
 * harness (seed an org+repo row directly, drive the real service, read the column back with raw SQL).
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../persistence/database.module';
import { ENTITIES } from '../persistence/entities';
import { WorkspaceConfigStore } from '../onboarding/workspace-config.store';
import { ProfileAwarenessService } from './profile-awareness.service';

const ORG_ID = '3aaaaaaa-1111-4111-8111-111111111111';

function dbOpts() {
  return {
    name: DB_CONNECTION,
    type: 'postgres' as const,
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5433),
    username: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    database: process.env.POSTGRES_DB,
    entities: ENTITIES,
    namingStrategy: new CustomNamingStrategy(),
    synchronize: false,
    connectTimeoutMS: 10_000,
    ssl: false as const,
  };
}

describe('ProfileAwarenessService (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let service: ProfileAwarenessService;
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      providers: [WorkspaceConfigStore, ProfileAwarenessService],
    }).compile();

    service = mod.get(ProfileAwarenessService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Awareness Org', 'install-awareness-org', 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
       VALUES ($1, 'install-awareness-repo', 'Install Awareness Repo', 'https://github.com/x/y.git', 'main', true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await ds
      ?.query(`DELETE FROM repos WHERE org_id = $1`, [ORG_ID])
      .catch(() => undefined);
    await ds
      ?.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID])
      .catch(() => undefined);
    await mod?.close();
  });

  async function ledger(): Promise<
    Array<{ key: string; firstSeenAt: string }>
  > {
    const rows = await ds.query(
      `SELECT profile_seen_tooling AS t FROM repos WHERE id = $1`,
      [repoId],
    );
    return rows[0].t ?? [];
  }

  async function handle(command: string): Promise<string | null> {
    return service.handle({
      orgId: ORG_ID,
      repoId,
      jobId: 'job-1',
      sessionType: 'brain',
      command,
    });
  }

  it('pnpm add eslint: fires an "added" checklist and records pnpm:eslint', async () => {
    const text = await handle('pnpm add eslint');
    expect(text).toContain('[profile-awareness]');
    expect(text).toContain('pnpm:eslint');
    const entries = await ledger();
    expect(entries.map((t) => t.key)).toEqual(['pnpm:eslint']);
    expect(entries[0].firstSeenAt).toEqual(expect.any(String));
  });

  it('same pnpm add eslint again: deduped (null, ledger unchanged)', async () => {
    const before = await ledger();
    const text = await handle('pnpm add eslint');
    expect(text).toBeNull();
    expect(await ledger()).toEqual(before);
  });

  it('apt-get install doctl: fires an "added" checklist and records apt:doctl', async () => {
    const text = await handle('apt-get install doctl');
    expect(text).toContain('apt:doctl');
    expect((await ledger()).map((t) => t.key).sort()).toEqual([
      'apt:doctl',
      'pnpm:eslint',
    ]);
  });

  it('pnpm remove eslint: fires a "retire" checklist and drops pnpm:eslint', async () => {
    const text = await handle('pnpm remove eslint');
    expect(text).toContain('[profile-awareness]');
    expect(text).toContain('removed');
    expect(text).toContain('pnpm:eslint');
    expect((await ledger()).map((t) => t.key)).toEqual(['apt:doctl']);
  });

  it('same pnpm remove eslint again: deduped (null, ledger unchanged)', async () => {
    const before = await ledger();
    const text = await handle('pnpm remove eslint');
    expect(text).toBeNull();
    expect(await ledger()).toEqual(before);
  });

  it.each(['pnpm install', 'npm ci', 'pnpm outdated'])(
    '%j is not a new install: returns null, ledger untouched',
    async (cmd) => {
      const before = await ledger();
      const text = await handle(cmd);
      expect(text).toBeNull();
      expect(await ledger()).toEqual(before);
    },
  );
});
