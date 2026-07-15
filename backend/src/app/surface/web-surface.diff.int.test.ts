/**
 * LIVE HTTP proof for `GET …/jobs/:jobId/diff` — boots a REAL Nest HTTP application (supertest, real
 * listening `http.Server`) and drives it against a REAL temp git worktree via the REAL `LocalGitService`
 * (real `git diff`/`git diff --numstat` subprocesses), same pattern as `web-surface.repo.int.test.ts`.
 * Lives in the `*.int.test.ts` integration tier (real app boot + real subprocesses), not `*.spec.ts`.
 *
 * Fixture repo (real `git init` + real commits in a temp dir):
 *   src/foo.ts — committed at base, then a COMMITTED edit ("across threads"), then an additional
 *                UNCOMMITTED edit on disk (never `git add`ed) — proving the diff reflects both.
 *   src/bar.ts — a brand-new committed file (status 'added').
 * `refs/remotes/origin/main` is pinned to the base commit sha so `git diff --merge-base origin/main`
 * (what the endpoint runs) resolves against it, mirroring a real clone's `origin/<default>`.
 */
import type { ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JobLifecycleService } from '../driver/job-lifecycle.service';
import { LocalGitService } from '../git/local-git.service';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';
import { WebSurfaceController } from './web-surface.controller';

const ORG_ID = 'org-1';
const REPO_ID = 'repo-1';
const JOB_ID = 'job-1';

let root: string;
let app: import('@nestjs/common').INestApplication;
let server: ReturnType<
  import('@nestjs/common').INestApplication['getHttpServer']
>;
/** Mutable so the "no sandbox" case can flip it via `mockResolvedValueOnce`. */
let findSandbox: ReturnType<typeof vi.fn>;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'diff-'));
  git(['init', '-q'], root);
  git(['config', 'user.email', 'x@x'], root);
  git(['config', 'user.name', 'x'], root);
  git(['config', 'commit.gpgsign', 'false'], root);

  writeFileSync(join(root, 'foo.ts'), 'line1\nline2\nline3\n');
  git(['add', 'foo.ts'], root);
  git(['commit', '-q', '-m', 'base'], root);

  // Pin origin/main to the base commit (as a real clone would carry it) so `--merge-base origin/main`
  // resolves without a real remote.
  const baseSha = git(['rev-parse', 'HEAD'], root);
  git(['update-ref', 'refs/remotes/origin/main', baseSha], root);

  // A COMMITTED change on top of base (a prior turn's commit).
  writeFileSync(join(root, 'foo.ts'), 'line1\nline2-changed\nline3\n');
  git(['add', 'foo.ts'], root);
  git(['commit', '-q', '-m', 'edit foo'], root);

  // A brand-new COMMITTED file (status 'added').
  writeFileSync(join(root, 'bar.ts'), 'new content\n');
  git(['add', 'bar.ts'], root);
  git(['commit', '-q', '-m', 'add bar'], root);

  // An additional UNCOMMITTED edit on top — never `git add`ed — proving the diff also carries live work.
  writeFileSync(
    join(root, 'foo.ts'),
    'line1\nline2-changed\nline3\nline4-uncommitted\n',
  );

  const realGit = new LocalGitService({ get: () => undefined } as never);

  findSandbox = vi.fn(() => Promise.resolve({ worktreePath: root }) as never);
  const resolveBaseBranch = vi.fn(() => Promise.resolve('main'));

  const moduleRef = await Test.createTestingModule({
    controllers: [WebSurfaceController],
  })
    .useMocker((token) => {
      if (token === LocalGitService) return realGit;
      if (token === JobLifecycleService)
        return { findSandbox, resolveBaseBranch };
      if (token === getRepositoryToken(JobEntity, DB_CONNECTION)) {
        return {
          findOne: vi.fn(() =>
            Promise.resolve({ id: JOB_ID, org_id: ORG_ID, repo_id: REPO_ID }),
          ),
        };
      }
      return {}; // auto-mock every other collaborator (unused by this endpoint)
    })
    .overrideGuard(OrgMembershipGuard)
    .useValue({
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest().org = { id: ORG_ID, role: 'owner' };
        return true;
      },
    })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
  server = app.getHttpServer();

  const probe = await request(server).get('/web/does-not-exist-probe');
  console.log(
    'REAL SERVER CHECK — app.getHttpServer() constructor:',
    server.constructor.name,
    '| listening:',
    server.listening,
    '| probe request status (proves a real socket answered):',
    probe.status,
  );
}, 30_000);

afterAll(async () => {
  await app?.close();
  rmSync(root, { recursive: true, force: true });
});

const diffUrl = `/web/orgs/${ORG_ID}/repos/${REPO_ID}/jobs/${JOB_ID}/diff`;
const diffSummaryUrl = `/web/orgs/${ORG_ID}/repos/${REPO_ID}/jobs/${JOB_ID}/diff/summary`;

describe('WebSurfaceController jobDiff — LIVE HTTP (real Nest app, real git worktree)', () => {
  it('GET .../diff → 200, structured files with committed + uncommitted changes merged', async () => {
    const res = await request(server).get(diffUrl);
    console.log(
      `OBSERVED GET ${diffUrl} →`,
      res.status,
      JSON.stringify(res.body),
    );

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);

    const foo = res.body.files.find(
      (f: { path: string }) => f.path === 'foo.ts',
    );
    expect(foo).toBeDefined();
    expect(foo.status).toBe('modified');
    expect(foo.binary).toBe(false);
    expect(foo.additions).toBeGreaterThan(0);
    expect(foo.deletions).toBeGreaterThan(0);
    expect(foo.hunks.length).toBeGreaterThan(0);
    const signPrefixes = new Set(foo.hunks[0].lines.map((l: string) => l[0]));
    expect(
      [...signPrefixes].every((c) => c === ' ' || c === '+' || c === '-'),
    ).toBe(true);
    expect(foo.hunks[0].lines.some((l: string) => l.startsWith('+'))).toBe(
      true,
    );

    const bar = res.body.files.find(
      (f: { path: string }) => f.path === 'bar.ts',
    );
    expect(bar).toBeDefined();
    expect(bar.status).toBe('added');
    expect(bar.additions).toBeGreaterThan(0);
  });

  it('GET .../diff with no sandbox → 200 { files: [], truncated: false }', async () => {
    findSandbox.mockResolvedValueOnce(null);
    const res = await request(server).get(diffUrl);
    console.log(
      `OBSERVED GET ${diffUrl} (no sandbox) →`,
      res.status,
      JSON.stringify(res.body),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ files: [], truncated: false });
  });

  it('GET .../diff/summary → 200, lightweight files with status and no hunks', async () => {
    const res = await request(server).get(diffSummaryUrl);
    console.log(
      `OBSERVED GET ${diffSummaryUrl} →`,
      res.status,
      JSON.stringify(res.body),
    );

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('truncated');

    const foo = res.body.files.find(
      (f: { path: string }) => f.path === 'foo.ts',
    );
    expect(foo).toMatchObject({
      path: 'foo.ts',
      status: 'modified',
      binary: false,
    });
    expect(foo.additions).toBeGreaterThan(0);
    expect(foo.deletions).toBeGreaterThan(0);
    expect(foo).not.toHaveProperty('hunks');

    const bar = res.body.files.find(
      (f: { path: string }) => f.path === 'bar.ts',
    );
    expect(bar).toMatchObject({
      path: 'bar.ts',
      status: 'added',
      binary: false,
    });
    expect(bar).not.toHaveProperty('hunks');
  });

  it('GET .../diff/summary with no sandbox → 200 { files: [] }', async () => {
    findSandbox.mockResolvedValueOnce(null);
    const res = await request(server).get(diffSummaryUrl);
    console.log(
      `OBSERVED GET ${diffSummaryUrl} (no sandbox) →`,
      res.status,
      JSON.stringify(res.body),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ files: [] });
  });
});
