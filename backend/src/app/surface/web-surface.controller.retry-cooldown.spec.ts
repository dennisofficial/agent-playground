import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentOrgCtx } from '../org/current-org.decorator';
import { WebSurfaceController } from './web-surface.controller';

/**
 * Mirrors the `createQueryBuilder` mock pattern in `brain-store.service.spec.ts` — a fluent stub where every
 * chained builder method returns itself, and `execute` is a per-test-controlled `vi.fn()` standing in for the
 * `claimManualRetry` CAS update.
 */
function fakeJobsRepo(row: { id: string; org_id: string; repo_id: string; halt: string | null; status: string; title: string | null }) {
  const execute = vi.fn(async () => ({ affected: 1 }));
  const qb: Record<string, unknown> = {};
  for (const m of ['update', 'set', 'where', 'andWhere']) qb[m] = () => qb;
  qb.execute = execute;
  return {
    findOne: vi.fn(async ({ where }: { where: { id: string; org_id: string } }) =>
      where.id === row.id && where.org_id === row.org_id ? row : null,
    ),
    createQueryBuilder: vi.fn(() => qb),
    execute,
  };
}

const ORG: CurrentOrgCtx = { id: 'org-1', role: 'member' };

function makeController(opts: {
  jobs: ReturnType<typeof fakeJobsRepo>;
  dispatcherRetry: ReturnType<typeof vi.fn>;
  seedSystemNotification: ReturnType<typeof vi.fn>;
  setSessionResume: ReturnType<typeof vi.fn>;
}) {
  return new WebSurfaceController(
    { seedSystemNotification: opts.seedSystemNotification } as never, // surface
    {} as never, // liveTurns
    {} as never, // driverStore
    {} as never, // threadLifecycle
    {} as never, // autoMerge
    {} as never, // orgService
    opts.jobs as never, // jobs
    {} as never, // messages
    {} as never, // repos
    {} as never, // threadTitle
    {} as never, // usageBus
    {} as never, // realtime
    {} as never, // election
    { retry: opts.dispatcherRetry } as never, // dispatcher
    {} as never, // secrets
    { setSessionResume: opts.setSessionResume } as never, // store
    {} as never, // brain
    {} as never, // mcpStore
    {} as never, // mcpProbe
    {} as never, // conventions
    {} as never, // skillStore
    {} as never, // skillFiles
    {} as never, // skillInstaller
    {} as never, // git
    {} as never, // jobDeps
    {} as never, // moduleRef
    {} as never, // intake (StimulusIntake)
  );
}

describe('WebSurfaceController — manual retry cooldown', () => {
  describe('retry (build "Retry"/force-resume button)', () => {
    it('claims the cooldown slot and dispatches the retry on a first, unforced call', async () => {
      const jobs = fakeJobsRepo({ id: 'job-1', org_id: 'org-1', repo_id: 'repo-1', halt: 'error', status: 'running', title: null });
      const dispatcherRetry = vi.fn(async () => undefined);
      const controller = makeController({
        jobs,
        dispatcherRetry,
        seedSystemNotification: vi.fn(),
        setSessionResume: vi.fn(),
      });

      const result = await controller.retry(ORG, 'job-1');

      expect(jobs.execute).toHaveBeenCalledTimes(1);
      expect(dispatcherRetry).toHaveBeenCalledWith('job-1');
      expect(result).toEqual({ ok: true, status: 'running' });
    });

    it('throws a 429 and does not dispatch when the cooldown claim fails', async () => {
      const jobs = fakeJobsRepo({ id: 'job-1', org_id: 'org-1', repo_id: 'repo-1', halt: 'error', status: 'running', title: null });
      jobs.execute.mockResolvedValue({ affected: 0 });
      const dispatcherRetry = vi.fn(async () => undefined);
      const controller = makeController({
        jobs,
        dispatcherRetry,
        seedSystemNotification: vi.fn(),
        setSessionResume: vi.fn(),
      });

      await expect(controller.retry(ORG, 'job-1')).rejects.toBeInstanceOf(HttpException);
      expect(dispatcherRetry).not.toHaveBeenCalled();
    });

    it('reports the 429 as too-many-requests', async () => {
      const jobs = fakeJobsRepo({ id: 'job-1', org_id: 'org-1', repo_id: 'repo-1', halt: 'error', status: 'running', title: null });
      jobs.execute.mockResolvedValue({ affected: 0 });
      const controller = makeController({
        jobs,
        dispatcherRetry: vi.fn(),
        seedSystemNotification: vi.fn(),
        setSessionResume: vi.fn(),
      });

      await expect(controller.retry(ORG, 'job-1')).rejects.toMatchObject({
        status: 429,
      });
    });

    it('skips the cooldown claim entirely and dispatches when force=true, even if the claim would fail', async () => {
      const jobs = fakeJobsRepo({ id: 'job-1', org_id: 'org-1', repo_id: 'repo-1', halt: 'session_limit', status: 'running', title: null });
      jobs.execute.mockResolvedValue({ affected: 0 });
      const dispatcherRetry = vi.fn(async () => undefined);
      const controller = makeController({
        jobs,
        dispatcherRetry,
        seedSystemNotification: vi.fn(),
        setSessionResume: vi.fn(),
      });

      const result = await controller.retry(ORG, 'job-1', 'true');

      expect(jobs.createQueryBuilder).not.toHaveBeenCalled();
      expect(dispatcherRetry).toHaveBeenCalledWith('job-1');
      expect(result).toEqual({ ok: true, status: 'running' });
    });
  });

  describe('retryTurn ("Resume" button on a retryable turn error)', () => {
    it('claims the cooldown slot and seeds the resume nudge on a first, unforced call', async () => {
      const jobs = fakeJobsRepo({ id: 'job-1', org_id: 'org-1', repo_id: 'repo-1', halt: null, status: 'running', title: 'Fix the flaky test' });
      const seedSystemNotification = vi.fn();
      const setSessionResume = vi.fn(async () => undefined);
      const controller = makeController({
        jobs,
        dispatcherRetry: vi.fn(),
        seedSystemNotification,
        setSessionResume,
      });

      const result = await controller.retryTurn(ORG, 'job-1');

      expect(jobs.execute).toHaveBeenCalledTimes(1);
      expect(seedSystemNotification).toHaveBeenCalledTimes(1);
      expect(setSessionResume).toHaveBeenCalledWith('job-1', null, null);
      expect(result).toEqual({ ok: true });
    });

    it('throws a 429 and does not seed a resume nudge when the cooldown claim fails', async () => {
      const jobs = fakeJobsRepo({ id: 'job-1', org_id: 'org-1', repo_id: 'repo-1', halt: null, status: 'running', title: null });
      jobs.execute.mockResolvedValue({ affected: 0 });
      const seedSystemNotification = vi.fn();
      const setSessionResume = vi.fn();
      const controller = makeController({
        jobs,
        dispatcherRetry: vi.fn(),
        seedSystemNotification,
        setSessionResume,
      });

      await expect(controller.retryTurn(ORG, 'job-1')).rejects.toBeInstanceOf(HttpException);
      expect(seedSystemNotification).not.toHaveBeenCalled();
      expect(setSessionResume).not.toHaveBeenCalled();
    });

    it('skips the cooldown claim entirely and proceeds when force=true, even if the claim would fail', async () => {
      const jobs = fakeJobsRepo({ id: 'job-1', org_id: 'org-1', repo_id: 'repo-1', halt: null, status: 'running', title: null });
      jobs.execute.mockResolvedValue({ affected: 0 });
      const seedSystemNotification = vi.fn();
      const setSessionResume = vi.fn(async () => undefined);
      const controller = makeController({
        jobs,
        dispatcherRetry: vi.fn(),
        seedSystemNotification,
        setSessionResume,
      });

      const result = await controller.retryTurn(ORG, 'job-1', 'true');

      expect(jobs.createQueryBuilder).not.toHaveBeenCalled();
      expect(seedSystemNotification).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true });
    });
  });
});
