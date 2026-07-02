import { describe, expect, it, vi } from 'vitest';
import type { Job } from '../domain';
import type { EngineRunnerPort } from '../engine';
import type { FeatureSandbox, GithubPrService, LocalGitService } from '../git';
import type { BlockSink, TurnHarnessFactory } from '../surface/turn-harness.service';
import { BuildShipService } from './build-ship.service';
import type { DriverStoreService } from './driver-store.service';
import type { ResolvedRepo } from './repo-resolver';

/**
 * The host push must authenticate from the RESOLVED repo, not the sandbox: on the resume path a
 * `FeatureSandbox` is reconstructed from a DB row with an empty `gitUrl`/no token
 * (JobLifecycleService.rowToSandbox), so pushing the sandbox verbatim would run unauthenticated and
 * silently lean on ambient host credentials. This guards the enrichment at the ship boundary.
 */
describe('BuildShipService — host push uses resolved repo auth', () => {
  // Row-sourced sandbox: has a worktree + branch, but NO usable git auth.
  const sandbox: FeatureSandbox = {
    repoId: 'proj',
    branch: 'atlas/thread-abcd',
    worktreePath: '/wt/feat',
    gitUrl: '',
  };

  const repo: ResolvedRepo = {
    projectRepo: {
      repoId: 'proj',
      gitUrl: 'https://github.com/acme/widget.git',
      defaultBranch: 'main',
      repoPath: '/repos/proj',
    },
    owner: 'acme',
    repo: 'widget',
    defaultBranch: 'main',
    token: 'ptok-xyz',
  } as unknown as ResolvedRepo;

  const job = { id: 'j1', title: 'Feature', repoId: 'proj' } as unknown as Job;

  it('enriches the pushed sandbox with the resolved repo url + token', async () => {
    const push = vi.fn(async (_sandbox: FeatureSandbox) => undefined);
    const git = { push, commitAll: vi.fn(async () => 'sha') } as unknown as LocalGitService;
    const pr = {
      openPullRequest: vi.fn(async () => ({
        url: 'https://github.com/acme/widget/pull/1',
        number: 1,
        existing: false,
      })),
    } as unknown as GithubPrService;
    const harness = {
      onEvent: vi.fn(),
      finish: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const turnHarness = { create: vi.fn(() => harness) } as unknown as TurnHarnessFactory;
    const blockSink = { appendBlock: vi.fn(async () => undefined) } as unknown as BlockSink;
    const store = {
      startPrReview: vi.fn(async () => undefined),
      setPrReviewStatus: vi.fn(async () => undefined),
      setPrReady: vi.fn(async () => undefined),
    } as unknown as DriverStoreService;
    // PR Review is best-effort; a throwing engine is caught and shipping proceeds to the push.
    const engine = {
      run: vi.fn(async () => {
        throw new Error('skip pr review in this unit test');
      }),
    } as unknown as EngineRunnerPort;

    const svc = new BuildShipService(git, pr, store, blockSink, turnHarness, engine);
    await svc.ship({ job, record: null, repo, sandbox });

    expect(push).toHaveBeenCalledTimes(1);
    const pushed = push.mock.calls[0][0];
    expect(pushed.gitUrl).toBe('https://github.com/acme/widget.git'); // NOT the sandbox's empty url
    expect(pushed.token).toBe('ptok-xyz');
    expect(pushed.branch).toBe('atlas/thread-abcd'); // rest of the sandbox is preserved
  });
});
