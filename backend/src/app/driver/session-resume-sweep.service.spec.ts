import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import { SessionResumeSweep } from './session-resume-sweep.service';
import type { ThreadDriver } from './thread-driver.service';
import type { DriverStoreService } from './driver-store.service';
import type { ChatSurface } from '../surface/chat-surface.port';
import type { JobEntity } from '../persistence/entities';
import {
  retryResumeNudge,
  sessionLimitResetNudge,
} from '../prompt-kit/harness';

/**
 * The sweep un-parks a due `session_resume_at` clock. Two park KINDS now share the clock: the existing
 * `session_limit` park and the new host-backstop `retry` park. They diverge on lane:
 *   build → `retry` re-drives with NO halt (`resumeRetry`), `session_limit` uses `resumePaused`.
 *   main  → `retry` seeds the "Reconnecting…" nudge, `session_limit` seeds the reset nudge.
 */
describe('SessionResumeSweep — retry vs session-limit park routing', () => {
  let driver: {
    resumePaused: ReturnType<typeof vi.fn>;
    resumeRetry: ReturnType<typeof vi.fn>;
  };
  let surface: { seedSystemNotification: ReturnType<typeof vi.fn> };
  let driverStore: { setSessionResume: ReturnType<typeof vi.fn> };
  let due: JobEntity[];
  let sweep: SessionResumeSweep;

  function job(overrides: Partial<JobEntity>): JobEntity {
    return {
      id: 'job-1',
      org_id: 'org-1',
      repo_id: 'repo-1',
      title: 'Add retries',
      ...overrides,
    } as JobEntity;
  }

  beforeEach(() => {
    driver = {
      resumePaused: vi.fn().mockResolvedValue(undefined),
      resumeRetry: vi.fn().mockResolvedValue(undefined),
    };
    surface = { seedSystemNotification: vi.fn() };
    driverStore = { setSessionResume: vi.fn().mockResolvedValue(undefined) };
    due = [];
    const jobs = {
      find: vi.fn(() => Promise.resolve(due)),
    } as unknown as Repository<JobEntity>;
    sweep = new SessionResumeSweep(
      jobs,
      driver as unknown as ThreadDriver,
      surface as unknown as ChatSurface,
      driverStore as unknown as DriverStoreService,
    );
  });

  it('build + retry park → resumeRetry (no-halt re-drive), never resumePaused', async () => {
    due = [
      job({
        session_resume: {
          lane: 'build',
          reason: 'retry',
          resetSource: 'usage_api',
          kind: 'retry',
        },
      }),
    ];
    const resumed = await sweep.tick();
    expect(resumed).toBe(1);
    expect(driver.resumeRetry).toHaveBeenCalledWith('job-1');
    expect(driver.resumePaused).not.toHaveBeenCalled();
  });

  it('build + session-limit park → resumePaused (unchanged), never resumeRetry', async () => {
    due = [
      job({
        session_resume: {
          lane: 'build',
          reason: 'limit',
          resetSource: 'parsed_string',
          kind: 'session_limit',
        },
      }),
    ];
    await sweep.tick();
    expect(driver.resumePaused).toHaveBeenCalledWith('job-1');
    expect(driver.resumeRetry).not.toHaveBeenCalled();
  });

  it('main + retry park → seeds the SILENT re-drive nudge + clears the clock, NOT the session-limit copy', async () => {
    due = [
      job({
        session_resume: {
          lane: 'main',
          reason: 'retry',
          resetSource: 'usage_api',
          kind: 'retry',
        },
      }),
    ];
    await sweep.tick();
    expect(surface.seedSystemNotification).toHaveBeenCalledTimes(1);
    const [repoId, jobId, nudge, opts] =
      surface.seedSystemNotification.mock.calls[0];
    expect(repoId).toBe('repo-1');
    expect(jobId).toBe('job-1');
    expect(nudge).toEqual(retryResumeNudge('Add retries'));
    // The retry re-drive renders NO operator-facing pill — it still drives the turn, silently.
    expect(opts.seedRow).toBe('skip');
    // Main lane has no halt — the clock is the park marker, so the sweep clears it.
    expect(driverStore.setSessionResume).toHaveBeenCalledWith(
      'job-1',
      null,
      null,
    );
  });

  it('main + session-limit park → seeds the reset nudge (unchanged behavior)', async () => {
    due = [
      job({
        session_resume: {
          lane: 'main',
          reason: 'limit',
          resetSource: 'parsed_string',
          kind: 'session_limit',
        },
      }),
    ];
    await sweep.tick();
    const [, , nudge, opts] = surface.seedSystemNotification.mock.calls[0];
    expect(nudge).toEqual(sessionLimitResetNudge('Add retries'));
    expect(opts.seedRow.label).toBe(
      'Auto-resuming after the session limit reset.',
    );
    expect(opts.seedRow.chunkKey).toMatch(/^seed:sessionlimit:/);
    expect(driverStore.setSessionResume).toHaveBeenCalledWith(
      'job-1',
      null,
      null,
    );
  });
});
