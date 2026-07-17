import type { ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JobLifecycleService } from '../../driver/job-lifecycle.service';
import { LocalGitService } from '../../git/local-git.service';
import { OrgMembershipGuard } from '../../org/org-membership.guard';
import { DB_CONNECTION } from '../../persistence/database.module';
import { JobEntity } from '../../persistence/entities';
import { WebSurfaceController } from '../web-surface.controller';

const ORG_ID = 'org-1';
const REPO_ID = 'repo-1';
const JOB_ID = 'job-1';

const DOCKERFILE_CONTENT = 'FROM node:20\n';
const SECRET_CONTENT = 'ANTHROPIC_API_KEY=sk-live-not-a-real-secret\n';

let root: string;
let app: import('@nestjs/common').INestApplication;
let server: ReturnType<import('@nestjs/common').INestApplication['getHttpServer']>;
let findSandbox: ReturnType<typeof vi.fn>;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'repo-'));
  git(['init', '-q'], root);
  git(['config', 'user.email', 'x@x'], root);
  git(['config', 'user.name', 'x'], root);
  git(['config', 'commit.gpgsign', 'false'], root);

  mkdirSync(join(root, 'backend', 'sandbox'), { recursive: true });
  writeFileSync(join(root, 'backend', 'sandbox', 'Dockerfile'), DOCKERFILE_CONTENT);
  git(['add', 'backend/sandbox/Dockerfile'], root);
  git(['commit', '-q', '-m', 'init'], root);

  writeFileSync(join(root, 'backend', '.gitignore'), '.env.keys\n');
  git(['add', 'backend/.gitignore'], root);
  git(['commit', '-q', '-m', 'gitignore'], root);
  writeFileSync(join(root, 'backend', '.env.keys'), SECRET_CONTENT); // deliberately NEVER `git add`ed

  const realGit = new LocalGitService({ get: () => undefined } as never);

  findSandbox = vi.fn(() => Promise.resolve({ worktreePath: root }) as never);

  const moduleRef = await Test.createTestingModule({
    controllers: [WebSurfaceController],
  })
    .useMocker((token) => {
      if (token === LocalGitService) return realGit;
      if (token === JobLifecycleService) return { findSandbox };
      if (token === getRepositoryToken(JobEntity, DB_CONNECTION)) {
        return {
          findOne: vi.fn(() => Promise.resolve({ id: JOB_ID, org_id: ORG_ID, repo_id: REPO_ID })),
        };
      }
      return {}; // auto-mock every other collaborator (unused by these two endpoints)
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

const treeUrl = `/web/orgs/${ORG_ID}/repos/${REPO_ID}/jobs/${JOB_ID}/repo/tree`;
const fileUrl = (path: string) =>
  `/web/orgs/${ORG_ID}/repos/${REPO_ID}/jobs/${JOB_ID}/repo/file?path=${encodeURIComponent(path)}`;

describe('WebSurfaceController repo endpoints — LIVE HTTP (real Nest app, real git worktree)', () => {
  it('GET .../repo/tree → 200 { files: [tracked files] }, secret ABSENT', async () => {
    const res = await request(server).get(treeUrl);
    console.log(`OBSERVED GET ${treeUrl} →`, res.status, JSON.stringify(res.body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      files: ['backend/.gitignore', 'backend/sandbox/Dockerfile'],
    });
    expect(res.body.files).not.toContain('backend/.env.keys');
  });

  it('GET .../repo/tree with no sandbox → 200 { files: [] }', async () => {
    findSandbox.mockResolvedValueOnce(null);
    const res = await request(server).get(treeUrl);
    console.log(`OBSERVED GET ${treeUrl} (no sandbox) →`, res.status, JSON.stringify(res.body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ files: [] });
  });

  it('GET .../repo/file?path=backend/sandbox/Dockerfile → 200, real content', async () => {
    const url = fileUrl('backend/sandbox/Dockerfile');
    const res = await request(server).get(url);
    console.log(`OBSERVED GET ${url} →`, res.status, JSON.stringify(res.body));
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('backend/sandbox/Dockerfile');
    expect(res.body.content).toBe(DOCKERFILE_CONTENT);
    expect(res.body.encoding).toBe('text');
  });

  it('GET .../repo/file?path=backend/.env.keys (untracked secret) → 404', async () => {
    const url = fileUrl('backend/.env.keys');
    const res = await request(server).get(url);
    console.log(`OBSERVED GET ${url} →`, res.status, JSON.stringify(res.body));
    expect(res.status).toBe(404);
  });

  it('GET .../repo/file?path=../../../etc/passwd (traversal) → 400', async () => {
    const url = fileUrl('../../../etc/passwd');
    const res = await request(server).get(url);
    console.log(`OBSERVED GET ${url} →`, res.status, JSON.stringify(res.body));
    expect(res.status).toBe(400);
  });

  it('GET .../repo/file with no path → 400 "path is required"', async () => {
    const url = `/web/orgs/${ORG_ID}/repos/${REPO_ID}/jobs/${JOB_ID}/repo/file`;
    const res = await request(server).get(url);
    console.log(`OBSERVED GET ${url} →`, res.status, JSON.stringify(res.body));
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('path is required');
  });

  it('GET .../repo/file with no sandbox → 404', async () => {
    findSandbox.mockResolvedValueOnce(null);
    const url = fileUrl('backend/sandbox/Dockerfile');
    const res = await request(server).get(url);
    console.log(`OBSERVED GET ${url} (no sandbox) →`, res.status, JSON.stringify(res.body));
    expect(res.status).toBe(404);
  });
});
