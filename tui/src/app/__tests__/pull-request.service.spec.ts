import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaBunSqlite } from 'prisma-adapter-bun-sqlite';
import { EToolTier } from '../../domain/tool-surface.js';
import type { Job, PrismaClient as Client, Thread } from '../../generated/prisma/client.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { EPhaseKind } from '../../generated/prisma/enums.js';
import { JobRepository } from '../../store/job.repository.js';
import { MigratorService } from '../../store/migrator.service.js';
import type { PrismaService } from '../../store/prisma.service.js';
import { ProjectRepository } from '../../store/project.repository.js';
import { PullRequestService } from '../pull-request.service.js';
import type { ToolContext } from '../tools/tool.js';

/**
 * `record_pr` against a real store, and **no git and no `gh` anywhere in this file** — which is the
 * headline, not an omission.
 *
 * Its predecessor's spec built a three-repository git triangle to prove that a rebase landed on a
 * base that had moved and that the second push was accepted after the branch was rewritten. Every
 * one of those claims was about work the harness has stopped doing. What is left to prove is that a
 * number the agent reports reaches the job row, and that reporting the same one twice is calm.
 */
describe('record_pr', () => {
  let dir: string;
  let client: Client;
  let jobRepository: JobRepository;
  let service: PullRequestService;
  let projectId: string;

  beforeEach(async () => {
    // realpath: macOS hands out /var/folders/... behind a /private symlink, and a raw mkdtemp path
    // makes equality checks against anything the OS resolved spuriously fail.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'atlas-pr-')));
    const database = join(dir, 'atlas.db');
    new MigratorService().migrate(database);
    client = new PrismaClient({ adapter: new PrismaBunSqlite({ url: `file:${database}` }) });
    const prismaService = client as unknown as PrismaService;
    jobRepository = new JobRepository(prismaService);
    service = new PullRequestService(jobRepository);
    projectId = (await new ProjectRepository(prismaService).open(dir, 'repo')).id;
  });

  afterEach(async () => {
    await client.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  async function jobContext(): Promise<{ job: Job; ctx: ToolContext }> {
    const job = await jobRepository.create({
      projectId,
      title: 'add avatar upload',
      kind: EPhaseKind.ci,
    });
    return {
      job,
      ctx: {
        job,
        thread: { id: 'thread-1' } as unknown as Thread,
        phase: EPhaseKind.ci,
        cwd: dir,
        tier: EToolTier.thread,
      },
    };
  }

  async function prNumber(jobId: string): Promise<number | null> {
    return (await jobRepository.findById(jobId))?.prNumber ?? null;
  }

  it('writes the number out of the url onto the job', async () => {
    const { job, ctx } = await jobContext();
    const reply = await service.record({ ctx, url: 'https://github.com/d/atlas/pull/42' });

    expect(await prNumber(job.id)).toBe(42);
    expect(reply).toContain('#42');
  });

  it('takes the whole of what `gh pr create` printed', async () => {
    const { job, ctx } = await jobContext();
    await service.record({
      ctx,
      url: 'Creating pull request for atlas/x into main\n\nhttps://github.com/d/atlas/pull/8',
    });
    expect(await prNumber(job.id)).toBe(8);
  });

  /**
   * The re-ship case, which is the common one: `ci` runs again on a red build, pushes to the same
   * pull request and records the same number. It must not read as an error and must not thrash the
   * row.
   */
  it('is calm about recording the same pull request twice', async () => {
    const { job, ctx } = await jobContext();
    const url = 'https://github.com/d/atlas/pull/42';
    await service.record({ ctx, url });
    const reply = await service.record({ ctx, url });

    expect(reply).toContain('Still pull request #42');
    expect(await prNumber(job.id)).toBe(42);
  });

  /**
   * `ToolContext` is built when the THREAD opens and carries a snapshot of the job, so the previous
   * number has to be read through to the store — otherwise a second record in the same thread would
   * compare against a stale null and announce a first ship every time.
   */
  it('reads the previous number from the store, not from the tool context', async () => {
    const { ctx } = await jobContext();
    await service.record({ ctx, url: 'https://github.com/d/atlas/pull/7' });

    // Same `ctx` object, whose `job.prNumber` is still the null it was created with.
    const reply = await service.record({ ctx, url: 'https://github.com/d/atlas/pull/9' });
    expect(reply).toContain('it was #7');
  });

  it('refuses a url that is not a pull request, and writes nothing', async () => {
    const { job, ctx } = await jobContext();

    await expect(service.record({ ctx, url: 'shipped it' })).rejects.toThrow(
      /not a pull request URL/,
    );
    expect(await prNumber(job.id)).toBeNull();
  });
});
