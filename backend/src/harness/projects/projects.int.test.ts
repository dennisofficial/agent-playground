import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { Test, TestingModule } from '@nestjs/testing';
import { EnvModule } from '@workspace/nestjs-core';
import { GithubToken, Project } from '@workspace/shared/schemas';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { DatabaseModule } from '../../_lib/database/database.module';
import { GithubTokenStore } from './github-token-store';
import { ProjectStore } from './project-store';
import { ProjectsModule } from './projects.module';

/**
 * Proves the registry's contracts against live Postgres: project CRUD, encrypted-at-rest tokens
 * (write-only reads), the single-default invariant, and the token-delete refusal.
 */
describe('ProjectsModule stores (live Postgres)', () => {
  // Per-run prefix so parallel/aborted runs can't collide; cleaned by prefix in afterAll.
  const P = `int-${Date.now().toString(36)}`;
  // A per-run tenant — every store call is workspace-scoped now; a fresh team starts empty.
  const T = `team-${P}`;
  let moduleRef: TestingModule;
  let projects: ProjectStore;
  let tokens: GithubTokenStore;
  /** A real default token may exist in the dev DB — the default-swap tests displace it, so it's
   * captured here and restored in afterAll. */
  let priorDefault: string | undefined;

  beforeAll(async () => {
    process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    moduleRef = await Test.createTestingModule({
      imports: [
        EnvModule.forRoot({
          envService: EnvService,
          validationSchema: envConfigValidation,
        }),
        DatabaseModule,
        ProjectsModule,
      ],
    }).compile();
    await moduleRef.init();
    projects = moduleRef.get(ProjectStore);
    tokens = moduleRef.get(GithubTokenStore);
    priorDefault = (await tokens.listMeta(T)).find((m) => m.isDefault)?.name;
  });

  afterAll(async () => {
    if (priorDefault) await tokens.setDefault(T, priorDefault).catch(() => {});
    const ds = moduleRef.get(DataSource);
    await ds
      .getRepository(Project)
      .createQueryBuilder()
      .delete()
      .where('project_id LIKE :p', { p: `${P}%` })
      .execute();
    await ds
      .getRepository(GithubToken)
      .createQueryBuilder()
      .delete()
      .where('name LIKE :p', { p: `${P}%` })
      .execute();
    await moduleRef.close();
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it('creates, lists, gets, and patches projects; duplicate ids conflict', async () => {
    const rec = await projects.create({
      teamId: T, projectId: `${P}-app`,
      displayName: 'The App',
      gitUrl: 'https://github.com/dennis/app',
    });
    expect(rec.defaultBranch).toBe('main');
    expect(rec.tokenName).toBeNull();

    await expect(
      projects.create({ teamId: T, projectId: `${P}-app`, displayName: 'dup', gitUrl: 'https://github.com/x/y' }),
    ).rejects.toThrow(/already exists/);

    const patched = await projects.update(T, `${P}-app`, {
      defaultBranch: 'develop',
      displayName: 'The App v2',
    });
    expect(patched?.defaultBranch).toBe('develop');
    expect(patched?.displayName).toBe('The App v2');
    expect(patched?.gitUrl).toBe('https://github.com/dennis/app'); // untouched

    expect((await projects.get(T, `${P}-app`))?.displayName).toBe('The App v2');
    expect((await projects.list(T)).some((p) => p.projectId === `${P}-app`)).toBe(true);
  });

  it('stores tokens encrypted at rest, write-only; the first token in an empty store becomes default', async () => {
    // The dev DB may already hold real tokens — only assert auto-default on a genuinely empty store.
    const wasEmpty = (await tokens.listMeta(T)).length === 0;
    const meta = await tokens.put(T, `${P}-tok-a`, 'ghp_plaintext_a');
    if (wasEmpty) expect(meta.isDefault).toBe(true);

    // Encrypted at rest: the raw row never contains the plaintext.
    const ds = moduleRef.get(DataSource);
    const raw = (await ds.query(`SELECT token_ciphertext FROM github_tokens WHERE name = $1`, [
      `${P}-tok-a`,
    ])) as Array<{ token_ciphertext: string }>;
    expect(raw[0].token_ciphertext).not.toContain('ghp_plaintext_a');
    expect(raw[0].token_ciphertext.startsWith('v1:')).toBe(true);

    // Write-only metadata reads.
    const metas = await tokens.listMeta(T);
    expect(metas.find((m) => m.name === `${P}-tok-a`)).toBeDefined();
    expect(JSON.stringify(metas)).not.toContain('ghp_plaintext_a');
    expect(JSON.stringify(metas)).not.toContain('v1:');

    // resolve() is the single decrypt path.
    expect((await tokens.resolve(T, `${P}-tok-a`))?.token).toBe('ghp_plaintext_a');
  });

  it('swaps the default atomically and resolves named vs default correctly', async () => {
    await tokens.put(T, `${P}-tok-b`, 'ghp_plaintext_b', true);
    const metas = await tokens.listMeta(T);
    const defaults = metas.filter((m) => m.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe(`${P}-tok-b`);

    expect((await tokens.resolve(T))?.name).toBe(`${P}-tok-b`); // default
    expect((await tokens.resolve(T, `${P}-tok-a`))?.name).toBe(`${P}-tok-a`); // named override
    expect(await tokens.resolve(T, `${P}-tok-missing`)).toBeUndefined();

    await tokens.setDefault(T, `${P}-tok-a`);
    expect((await tokens.resolve(T))?.name).toBe(`${P}-tok-a`);
    await expect(tokens.setDefault(T, `${P}-nope`)).rejects.toThrow(/No token named/);
  });

  it('refuses deleting a token a project references; deletes freely otherwise', async () => {
    await projects.create({
      teamId: T, projectId: `${P}-app2`,
      displayName: 'App 2',
      gitUrl: 'https://github.com/dennis/app2',
      tokenName: `${P}-tok-b`,
    });
    await expect(tokens.delete(T, `${P}-tok-b`)).rejects.toThrow(/referenced by 1 project/);
    await projects.update(T, `${P}-app2`, { tokenName: null });
    await expect(tokens.delete(T, `${P}-tok-b`)).resolves.toBeUndefined();
    expect((await tokens.listMeta(T)).some((m) => m.name === `${P}-tok-b`)).toBe(false);
  });

  it('updates a token value in place via put (upsert keeps default flag)', async () => {
    await tokens.put(T, `${P}-tok-a`, 'ghp_rotated');
    expect((await tokens.resolve(T, `${P}-tok-a`))?.token).toBe('ghp_rotated');
    expect((await tokens.listMeta(T)).filter((m) => m.isDefault)).toHaveLength(1);
  });
});
