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

function makeController(threadOrgId: string) {
  const threads = {
    findOne: vi.fn(async ({ where }: { where: { id: string; org_id: string } }) =>
      where.org_id === threadOrgId ? { id: where.id, org_id: threadOrgId, repo_id: 'repo-1' } : null,
    ),
  };
  const threadLifecycle = { contextDirHost: vi.fn(() => root) };
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
    { isLeader: () => true, getState: () => 'leader' } as never, // election
  );
  return { controller, threads, threadLifecycle };
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
