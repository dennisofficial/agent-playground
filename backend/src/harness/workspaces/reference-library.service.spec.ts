import type { EnvService } from '@core/config/env/env.service';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GithubTokenStore } from '../projects/github-token-store';
import type { ProjectStore } from '../projects/project-store';
import type { ProjectRecord } from '../projects/project.types';
import { ReferenceLibraryService } from './reference-library.service';

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]): Promise<string> =>
  exec('git', args, { cwd }).then((r) => r.stdout.trim());

interface RecInput {
  gitUrl: string;
  defaultBranch: string;
  tokenName?: string | null;
}

describe('ReferenceLibraryService (real git)', () => {
  let refsRoot: string;
  const scratch: string[] = [];

  beforeEach(async () => {
    refsRoot = await mkdtemp(join(tmpdir(), 'rl-root-'));
    scratch.push(refsRoot);
  });
  afterEach(async () => {
    await Promise.all(
      scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  /** A bare origin repo on `main` with a README + a top-level src file. */
  async function makeOrigin(readme: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'rl-origin-'));
    scratch.push(dir);
    const bare = join(dir, 'origin.git');
    await mkdir(bare);
    await git(bare, 'init', '--bare', '-b', 'main');
    const work = join(dir, 'work');
    await mkdir(work);
    await git(work, 'init', '-b', 'main');
    await git(work, 'config', 'user.email', 't@t');
    await git(work, 'config', 'user.name', 't');
    await writeFile(join(work, 'README.md'), readme);
    await writeFile(join(work, 'index.ts'), 'export const x = 1;\n');
    await git(work, 'add', '.');
    await git(work, 'commit', '-m', 'init');
    await git(work, 'remote', 'add', 'origin', bare);
    await git(work, 'push', '-u', 'origin', 'main');
    return bare;
  }

  const toRecord = (id: string, r: RecInput): ProjectRecord => ({
    teamId: 'T1',
    projectId: id,
    displayName: id,
    description: null,
    gitUrl: r.gitUrl,
    defaultBranch: r.defaultBranch,
    branchingPolicy: null,
    tokenName: r.tokenName ?? null,
    createdAt: '',
    updatedAt: '',
  });

  /** A service over a MUTABLE record map (so a test can simulate ProjectStore.update changing gitUrl). */
  function makeSvc(recs: Record<string, RecInput>): ReferenceLibraryService {
    const env = {
      get: (k: string) => (k === 'REFS_ROOT' ? refsRoot : undefined),
    } as unknown as EnvService;
    const projects = {
      get: (_team: string, id: string) =>
        Promise.resolve(recs[id] ? toRecord(id, recs[id]) : undefined),
      list: (_team: string) =>
        Promise.resolve(
          Object.entries(recs).map(([id, r]) => toRecord(id, r)),
        ),
      listAll: () =>
        Promise.resolve(
          Object.entries(recs).map(([id, r]) => toRecord(id, r)),
        ),
    } as unknown as ProjectStore;
    const tokens = {
      resolve: () => Promise.resolve(undefined),
    } as unknown as GithubTokenStore;
    return new ReferenceLibraryService(env, projects, tokens);
  }

  it('clones a registered project into the library and orients it', async () => {
    const origin = await makeOrigin('# Cubix\nhello world\n');
    const svc = makeSvc({ 'proj-b': { gitUrl: origin, defaultBranch: 'main' } });

    const r = await svc.ensureReference('T1', { projectId: 'proj-b' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.slug).toBe('proj-b');
      expect(r.mountPath).toBe('/refs/proj-b');
    }
    const cloned = join(refsRoot, 't1', 'proj-b'); // team 'T1' slugified → 't1'
    expect(await readFile(join(cloned, 'README.md'), 'utf8')).toContain(
      'hello world',
    );

    const orient = await svc.orientation('T1', 'proj-b');
    expect(orient).toContain('Top level:');
    expect(orient).toContain('hello world');
  });

  it('is idempotent — a second ensureReference fetches in place', async () => {
    const origin = await makeOrigin('# B\nv1\n');
    const svc = makeSvc({ 'proj-b': { gitUrl: origin, defaultBranch: 'main' } });
    await svc.ensureReference('T1', { projectId: 'proj-b' });
    const r2 = await svc.ensureReference('T1', { projectId: 'proj-b' });
    expect(r2.ok).toBe(true);
  });

  it('re-clones when the project gitUrl drifts (never silently serves the old repo)', async () => {
    const origin1 = await makeOrigin('# B1\nrepo-one\n');
    const origin2 = await makeOrigin('# B2\nrepo-two\n');
    const recs: Record<string, RecInput> = {
      'proj-b': { gitUrl: origin1, defaultBranch: 'main' },
    };
    const svc = makeSvc(recs);
    await svc.ensureReference('T1', { projectId: 'proj-b' });
    // ProjectStore.update repoints the project at a different repo.
    recs['proj-b'].gitUrl = origin2;
    await svc.ensureReference('T1', { projectId: 'proj-b' });
    const cloned = join(refsRoot, 't1', 'proj-b');
    expect(await readFile(join(cloned, 'README.md'), 'utf8')).toContain(
      'repo-two',
    );
  });

  it('returns not-registered for an unknown projectId', async () => {
    const svc = makeSvc({});
    const r = await svc.ensureReference('T1', { projectId: 'nope' });
    expect(r).toEqual({ ok: false, reason: 'not-registered' });
  });

  it('serializes concurrent ensureReference for the same project (no clobber)', async () => {
    const origin = await makeOrigin('# B\nx\n');
    const svc = makeSvc({ 'proj-b': { gitUrl: origin, defaultBranch: 'main' } });
    const [a, b] = await Promise.all([
      svc.ensureReference('T1', { projectId: 'proj-b' }),
      svc.ensureReference('T1', { projectId: 'proj-b' }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });
});
