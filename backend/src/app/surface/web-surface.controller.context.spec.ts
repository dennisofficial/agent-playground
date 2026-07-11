import { BadRequestException, NotFoundException } from '@nestjs/common';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CurrentOrgCtx } from '../org/current-org.decorator';
import { WebSurfaceController } from './web-surface.controller';

/**
 * `GET …/context/file` reads ONE file from the thread's `/context` dir. The security-critical part is the
 * path guard: a caller-supplied `?path=` must resolve INSIDE the thread's own specs/ + artifacts/ buckets,
 * so `..` traversal and out-of-bucket reads are rejected — and the read stays org-scoped (a leaked thread
 * id from another org 404s before any disk access). Uses a real temp `/context` dir so the fs reads run.
 */
const ORG: CurrentOrgCtx = { id: 'orgB', role: 'owner' };

let root: string;

/** Drain a StreamableFile's read stream to a utf-8 string (also closes the fd so the temp dir can be removed). */
async function streamToString(res: {
  getStream(): NodeJS.ReadableStream;
}): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of res.getStream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function makeController(threadOrgId: string) {
  const threads = {
    findOne: vi.fn(async ({ where }: { where: { id: string; org_id: string } }) =>
      where.org_id === threadOrgId ? { id: where.id, org_id: threadOrgId, repo_id: 'repo-1' } : null,
    ),
  };
  // The repo endpoints treat `root` as the job worktree. Only `specs/plan.md` is "tracked" — `secret.txt`
  // sits inside the worktree but is untracked (the gitignored-secret analog), so the content gate must 404 it.
  const trackedFiles = ['specs/plan.md'];
  const threadLifecycle = {
    contextDirHost: vi.fn(() => root),
    findSandbox: vi.fn(async (): Promise<{ worktreePath: string } | null> => ({ worktreePath: root })),
  };
  const git = {
    listTrackedFiles: vi.fn(async () => trackedFiles),
    isTracked: vi.fn(async (_w: string, relPath: string) => trackedFiles.includes(relPath)),
  };
  const controller = new WebSurfaceController(
    {} as never, // surface
    {} as never, // liveTurns
    {} as never, // driverStore
    threadLifecycle as never,
    {} as never, // orgService
    threads as never,
    {} as never, // messages
    {} as never, // repos
    {} as never, // threadTitle
    {} as never, // ticketEvents
    { available: false } as never, // realtime
    { isLeader: () => true, getState: () => 'leader', isDraining: () => false } as never, // election
    { dispatch: async () => undefined } as never, // dispatcher (JOB_DISPATCHER)
    { write: async () => undefined, list: async () => [], listForRepo: async () => [], read: async () => null } as never, // secrets (WorkspaceSecretFileStore)
    {} as never, // store (BrainStoreService)
    { stopTurn: async () => false } as never, // brain (AgentSessionManager)
    {} as never, // mcpStore (McpServerStore)
    {} as never, // mcpProbe (McpProbeService)
    {} as never, // conventions (ConventionProfileResolver)
    {} as never, // skillStore (WorkspaceSkillStore)
    {} as never, // skillFiles (SkillFileWriter)
    {} as never, // skillInstaller (SkillInstallerService)
    git as never,
    {} as never, // jobDeps (JobDependencyService)
  );
  return { controller, threads, threadLifecycle, git };
}

describe('WebSurfaceController.contextFile', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ctx-'));
    mkdirSync(join(root, 'specs'), { recursive: true });
    mkdirSync(join(root, 'artifacts'), { recursive: true });
    writeFileSync(join(root, 'specs', 'plan.md'), '# Plan\n\nHello.');
    writeFileSync(join(root, 'artifacts', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, 'secret.txt'), 'not in a bucket');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads a text spec file as utf-8', async () => {
    const { controller } = makeController('orgB');
    const res = await controller.contextFile(ORG, 'thread-1', 'specs/plan.md');
    expect(res).toMatchObject({
      name: 'plan.md',
      path: 'specs/plan.md',
      encoding: 'text',
      mime: 'text/markdown',
      content: '# Plan\n\nHello.',
    });
  });

  it('reads an image artifact as base64', async () => {
    const { controller } = makeController('orgB');
    const res = await controller.contextFile(ORG, 'thread-1', 'artifacts/shot.png');
    expect(res.encoding).toBe('base64');
    expect(res.mime).toBe('image/png');
    expect(Buffer.from(res.content, 'base64')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('rejects ".." traversal that escapes the context dir', async () => {
    const { controller } = makeController('orgB');
    await expect(
      controller.contextFile(ORG, 'thread-1', '../../../../etc/passwd'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a path outside the specs/ + artifacts/ buckets', async () => {
    const { controller } = makeController('orgB');
    await expect(controller.contextFile(ORG, 'thread-1', 'secret.txt')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('404s a missing file (inside a valid bucket)', async () => {
    const { controller } = makeController('orgB');
    await expect(
      controller.contextFile(ORG, 'thread-1', 'specs/nope.md'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s another org's thread before touching the disk", async () => {
    const { controller, threadLifecycle } = makeController('orgA'); // thread belongs to org A
    await expect(
      controller.contextFile(ORG, 'leaked-thread-id', 'specs/plan.md'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(threadLifecycle.contextDirHost).not.toHaveBeenCalled();
  });
});

/**
 * `GET …/context/raw/<path>` streams a bucket file as raw bytes with the right `Content-Type` for direct
 * browser rendering (the HTML `<iframe>` preview + its relative sub-resources). The `*path` wildcard
 * arrives from Express 5 as an array of decoded segments; the same bucket/traversal guard as `contextFile`
 * applies. StreamableFile carries the mime, so we assert on its `options.type`.
 */
describe('WebSurfaceController.contextRaw', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ctxraw-'));
    mkdirSync(join(root, 'artifacts', 'sidebar redesign'), { recursive: true });
    writeFileSync(
      join(root, 'artifacts', 'sidebar redesign', 'index.html'),
      '<!doctype html><link rel="stylesheet" href="style.css"><h1>Hi</h1>',
    );
    writeFileSync(join(root, 'artifacts', 'sidebar redesign', 'style.css'), 'h1{color:red}');
    writeFileSync(join(root, 'secret.txt'), 'not in a bucket');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('streams an HTML artifact with text/html and its bytes', async () => {
    const { controller } = makeController('orgB');
    const res = await controller.contextRaw(ORG, 'thread-1', ['artifacts', 'sidebar redesign', 'index.html']);
    expect(res.options.type).toBe('text/html');
    expect(res.options.length).toBeGreaterThan(0);
    expect(await streamToString(res)).toContain('<h1>Hi</h1>');
  });

  it('streams a relative sibling asset (the CSS the HTML references)', async () => {
    const { controller } = makeController('orgB');
    const res = await controller.contextRaw(ORG, 'thread-1', ['artifacts', 'sidebar redesign', 'style.css']);
    expect(res.options.type).toBe('text/css');
    expect(await streamToString(res)).toBe('h1{color:red}');
  });

  it('rejects ".." traversal that escapes the context dir', async () => {
    const { controller } = makeController('orgB');
    await expect(
      controller.contextRaw(ORG, 'thread-1', ['..', '..', '..', 'etc', 'passwd']),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a path outside the exposed buckets', async () => {
    const { controller } = makeController('orgB');
    await expect(controller.contextRaw(ORG, 'thread-1', ['secret.txt'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('404s a missing file inside a valid bucket', async () => {
    const { controller } = makeController('orgB');
    await expect(
      controller.contextRaw(ORG, 'thread-1', ['artifacts', 'nope.html']),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s another org's thread before touching the disk", async () => {
    const { controller, threadLifecycle } = makeController('orgA');
    await expect(
      controller.contextRaw(ORG, 'leaked-thread-id', ['artifacts', 'sidebar redesign', 'index.html']),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(threadLifecycle.contextDirHost).not.toHaveBeenCalled();
  });
});

/**
 * `GET …/repo/tree` + `…/repo/file` read the LIVE job worktree (via `findSandbox().worktreePath`).
 * `makeController` points `findSandbox` at the temp `root` and mocks the tracked-file set, so these exercise
 * the real path-traversal guard (`resolveSafeTarget`) plus the tracked-file security gate against a file that
 * physically sits inside the worktree but is untracked (the gitignored-secret analog). Own fixture, since the
 * earlier describes tear `root` down in their `afterAll`.
 */
describe('WebSurfaceController repo endpoints', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'repo-'));
    mkdirSync(join(root, 'specs'), { recursive: true });
    writeFileSync(join(root, 'specs', 'plan.md'), '# Plan\n\nHello.');
    writeFileSync(join(root, 'secret.txt'), 'not in a bucket');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  describe('repoTree', () => {
    it('returns the worktree tracked-file manifest', async () => {
      const { controller } = makeController('orgB');
      expect(await controller.repoTree(ORG, 'thread-1')).toEqual({ files: ['specs/plan.md'] });
    });

    it('returns an empty manifest when the worktree is gone (closed/reset)', async () => {
      const { controller, threadLifecycle } = makeController('orgB');
      threadLifecycle.findSandbox.mockResolvedValueOnce(null);
      expect(await controller.repoTree(ORG, 'thread-1')).toEqual({ files: [] });
    });
  });

  describe('repoFile', () => {
    it('reads a tracked file from the worktree', async () => {
      const { controller } = makeController('orgB');
      const res = await controller.repoFile(ORG, 'thread-1', 'specs/plan.md');
      expect(res.path).toBe('specs/plan.md');
      expect(res.encoding).toBe('text');
      expect(res.content).toBe('# Plan\n\nHello.');
    });

    it('rejects ".." traversal that escapes the worktree', async () => {
      const { controller } = makeController('orgB');
      await expect(
        controller.repoFile(ORG, 'thread-1', '../../../etc/passwd'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s an untracked (gitignored/secret) file inside the worktree', async () => {
      const { controller, git } = makeController('orgB');
      await expect(controller.repoFile(ORG, 'thread-1', 'secret.txt')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(git.isTracked).toHaveBeenCalledWith(root, 'secret.txt');
    });

    it('requires a path', async () => {
      const { controller } = makeController('orgB');
      await expect(controller.repoFile(ORG, 'thread-1', '')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('404s when the worktree is gone', async () => {
      const { controller, threadLifecycle } = makeController('orgB');
      threadLifecycle.findSandbox.mockResolvedValueOnce(null);
      await expect(controller.repoFile(ORG, 'thread-1', 'specs/plan.md')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
