import { BadRequestException, NotFoundException } from '@nestjs/common';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CurrentOrgCtx } from '../../org/current-org.decorator';
import { WebSurfaceController } from '../web-surface.controller';

const ORG: CurrentOrgCtx = { id: 'orgB', role: 'owner' };

let root: string;

async function streamToString(res: { getStream(): NodeJS.ReadableStream }): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of res.getStream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function makeController(threadOrgId: string) {
  const threads = {
    findOne: vi.fn(async ({ where }: { where: { id: string; org_id: string } }) =>
      where.org_id === threadOrgId
        ? { id: where.id, org_id: threadOrgId, repo_id: 'repo-1' }
        : null,
    ),
  };
  const trackedFiles = ['specs/plan.md'];
  const threadLifecycle = {
    contextDirHost: vi.fn(() => root),
    findSandbox: vi.fn(
      async (): Promise<{ worktreePath: string } | null> => ({
        worktreePath: root,
      }),
    ),
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
    {} as never, // autoMerge
    {} as never, // orgService
    threads as never,
    {} as never, // messages
    {} as never, // repos
    {} as never, // subagents
    {} as never, // threadTitle
    {} as never, // usageBus
    { available: false } as never, // realtime
    {
      isLeader: () => true,
      getState: () => 'leader',
      isDraining: () => false,
    } as never, // election
    { dispatch: async () => undefined } as never, // dispatcher (JOB_DISPATCHER)
    {
      write: async () => undefined,
      list: async () => [],
      listForRepo: async () => [],
      read: async () => null,
    } as never, // secrets (WorkspaceSecretFileStore)
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
    {} as never, // driverApproval (DriverApprovalGateway)
    {} as never, // intake (StimulusIntake)
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
    mkdirSync(join(root, 'evidence', '010-backend'), { recursive: true });
    writeFileSync(join(root, 'evidence', '010-backend', 'run.log'), 'ok\n');
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

  it('rejects a path outside the exposed context buckets', async () => {
    const { controller } = makeController('orgB');
    await expect(controller.contextFile(ORG, 'thread-1', 'secret.txt')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts an evidence/ path (fourth bucket)', async () => {
    const { controller } = makeController('orgB');
    const res = await controller.contextFile(ORG, 'thread-1', 'evidence/010-backend/run.log');
    expect(res).toMatchObject({
      name: 'run.log',
      path: 'evidence/010-backend/run.log',
      encoding: 'text',
      content: 'ok\n',
    });
  });

  it('404s a missing file (inside a valid bucket)', async () => {
    const { controller } = makeController('orgB');
    await expect(controller.contextFile(ORG, 'thread-1', 'specs/nope.md')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("404s another org's thread before touching the disk", async () => {
    const { controller, threadLifecycle } = makeController('orgA'); // thread belongs to org A
    await expect(
      controller.contextFile(ORG, 'leaked-thread-id', 'specs/plan.md'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(threadLifecycle.contextDirHost).not.toHaveBeenCalled();
  });
});

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
    const res = await controller.contextRaw(ORG, 'thread-1', [
      'artifacts',
      'sidebar redesign',
      'index.html',
    ]);
    expect(res.options.type).toBe('text/html');
    expect(res.options.length).toBeGreaterThan(0);
    expect(await streamToString(res)).toContain('<h1>Hi</h1>');
  });

  it('streams a relative sibling asset (the CSS the HTML references)', async () => {
    const { controller } = makeController('orgB');
    const res = await controller.contextRaw(ORG, 'thread-1', [
      'artifacts',
      'sidebar redesign',
      'style.css',
    ]);
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
      controller.contextRaw(ORG, 'leaked-thread-id', [
        'artifacts',
        'sidebar redesign',
        'index.html',
      ]),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(threadLifecycle.contextDirHost).not.toHaveBeenCalled();
  });
});

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
      expect(await controller.repoTree(ORG, 'thread-1')).toEqual({
        files: ['specs/plan.md'],
      });
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

describe('WebSurfaceController.context', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ctxlist-'));
    mkdirSync(join(root, 'specs'), { recursive: true });
    mkdirSync(join(root, 'generated'), { recursive: true });
    mkdirSync(join(root, 'artifacts'), { recursive: true });
    mkdirSync(join(root, 'evidence', '010-backend'), { recursive: true });
    writeFileSync(join(root, 'specs', 'plan.md'), '# Plan');
    writeFileSync(join(root, 'generated', 'decision-record.md'), '# Decisions');
    writeFileSync(join(root, 'artifacts', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, 'evidence', '010-backend', 'run.log'), 'ok\n');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('returns all four buckets, including the evidence/<thread-leg>/ file', async () => {
    const { controller } = makeController('orgB');
    const res = await controller.context(ORG, 'thread-1');
    expect(Object.keys(res).sort()).toEqual(['artifacts', 'evidence', 'generated', 'specs']);
    expect(res.specs).toEqual([expect.objectContaining({ name: 'plan.md' })]);
    expect(res.generated).toEqual([expect.objectContaining({ name: 'decision-record.md' })]);
    expect(res.artifacts).toEqual([expect.objectContaining({ name: 'shot.png' })]);
    expect(res.evidence).toEqual([expect.objectContaining({ name: '010-backend/run.log' })]);
  });
});
