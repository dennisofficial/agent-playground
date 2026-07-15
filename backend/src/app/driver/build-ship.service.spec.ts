import { describe, expect, it, vi } from 'vitest';
import type { Job } from '../domain';
import type { FeatureSandbox, GithubPrService, LocalGitService } from '../git';
import type { BrainGateway } from '../brain-gateway';
import { BuildShipService } from './build-ship.service';
import type { DriverStoreService } from './driver-store.service';
import type { ResolvedRepo } from './repo-resolver';

/**
 * ATLAS OWNS PR-OPEN. `ship` no longer runs a separate `engine.run` session to push/open the PR — it seeds
 * the JOB-BRAIN session (`openPrAtShip`) to reconcile + push + open the PR with its own auth, and the HOST
 * only gates (commit + leak-scan) and latches by branch discovery. These guard that (a) the host never opens
 * the PR itself, (b) the brain open-PR turn is seeded, and (c) latching stays branch-discovery based.
 */
describe('BuildShipService — brain opens the PR; host gates + latches', () => {
  const sandbox: FeatureSandbox = {
    repoId: 'proj',
    branch: 'feature/abcd',
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

  const job = {
    id: 'j1',
    orgId: 'o1',
    repoId: 'proj',
    title: 'Feature',
    currentBranch: null,
  } as unknown as Job;

  /** A stub `BrainGateway` that records the open-PR seed. */
  function makeBrain() {
    const openPrAtShip = vi.fn(async () => undefined);
    const brainGateway = { openPrAtShip } as unknown as BrainGateway;
    return { openPrAtShip, brainGateway };
  }

  function baseGit(
    over: Partial<Record<string, unknown>> = {},
  ): LocalGitService {
    // No `commitAll` — the host has no commit primitive anymore (Atlas owns every commit).
    return {
      scanBranchForForbidden: vi.fn(async () => []),
      currentBranch: vi.fn(async () => null),
      push: vi.fn(),
      ...over,
    } as unknown as LocalGitService;
  }

  function baseStore(
    over: Partial<Record<string, unknown>> = {},
  ): DriverStoreService {
    return {
      setPrReady: vi.fn(async () => undefined),
      setJobStatus: vi.fn(async () => undefined),
      setCurrentBranch: vi.fn(async () => undefined),
      // The ship path ensures a fresh `post_build` thread group thread and runs the open-PR turn on its session.
      ensurePostBuildThread: vi.fn(async () => ({
        threadGroupId: 'tg1',
        threadId: 'pb1',
      })),
      // latchPr ensures the `ci` thread group thread exists once the PR is recorded (post-ship seam, d14).
      ensureCiThread: vi.fn(async () => ({
        threadGroupId: 'tg2',
        threadId: 'ci1',
      })),
      ...over,
    } as unknown as DriverStoreService;
  }

  it('seeds the brain open-PR turn and does NOT open the PR host-side; unconfirmed → left running', async () => {
    const git = baseGit();
    const openPullRequest = vi.fn();
    const findOpenPullByHead = vi.fn(async () => null); // branch not indexed yet
    const pr = {
      openPullRequest,
      findOpenPullByHead,
    } as unknown as GithubPrService;
    const store = baseStore();
    const { openPrAtShip, brainGateway } = makeBrain();

    const svc = new BuildShipService(git, pr, store, brainGateway);
    const result = await svc.ship({
      job,
      record: {
        overview: '',
        decisions: [
          {
            title: 'Public',
            decisionClass: 'scope',
            ruling: 'endpoints are @Public',
          },
        ] as never,
      },
      repo,
      sandbox,
    });

    // The brain was seeded with the open-PR turn (branch/base/title), and the host opened nothing.
    expect(openPrAtShip).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'j1',
        branch: 'feature/abcd',
        defaultBranch: 'main',
        title: 'Feature',
      }),
    );
    expect(openPullRequest).not.toHaveBeenCalled();
    // Branch lookup missed → UNCONFIRMED: do NOT blind-flip `done` with a null pr_url. Left running.
    expect(store.setPrReady).not.toHaveBeenCalled();
    expect(store.setJobStatus).not.toHaveBeenCalled();
    expect(result).toEqual({ opened: true, prConfirmed: false });
  });

  it('latches the PR the brain opened by branch discovery → setPrReady (flips done)', async () => {
    const git = baseGit();
    const findOpenPullByHead = vi.fn(async () => ({
      url: 'https://github.com/acme/widget/pull/7',
      number: 7,
    }));
    const pr = {
      openPullRequest: vi.fn(),
      findOpenPullByHead,
    } as unknown as GithubPrService;
    const store = baseStore();
    const { openPrAtShip, brainGateway } = makeBrain();

    const svc = new BuildShipService(git, pr, store, brainGateway);
    const result = await svc.ship({ job, record: null, repo, sandbox });

    expect(openPrAtShip).toHaveBeenCalled();
    expect(findOpenPullByHead).toHaveBeenCalledWith('ptok-xyz', {
      owner: 'acme',
      repo: 'widget',
      head: 'feature/abcd',
    });
    expect(store.setPrReady).toHaveBeenCalledWith(
      'j1',
      'https://github.com/acme/widget/pull/7',
      7,
    );
    expect(store.ensureCiThread).toHaveBeenCalledWith({
      jobId: 'j1',
      orgId: 'o1',
      decisionRecordId: null,
    });
    expect(
      (store.ensureCiThread as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      (store.setPrReady as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    );
    expect(store.setJobStatus).not.toHaveBeenCalled();
    expect(result).toEqual({
      opened: true,
      prConfirmed: true,
      url: 'https://github.com/acme/widget/pull/7',
      number: 7,
    });
  });

  it('falls back to the ship branch when the stored job title is blank', async () => {
    const git = baseGit();
    const pr = {
      openPullRequest: vi.fn(),
      findOpenPullByHead: vi.fn(async () => null),
    } as unknown as GithubPrService;
    const store = baseStore();
    const { openPrAtShip, brainGateway } = makeBrain();

    const svc = new BuildShipService(git, pr, store, brainGateway);
    await svc.ship({
      job: { ...job, title: '   ' } as unknown as Job,
      record: null,
      repo,
      sandbox,
    });

    expect(openPrAtShip).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'feature/abcd',
        title: 'feature/abcd',
      }),
    );
  });

  it('follows the live branch: ships/discovers against the branch HEAD is actually on', async () => {
    // The agent switched branches mid-build; `current_branch` on the job reflects it.
    const liveJob = {
      ...job,
      currentBranch: 'atlas/renamed',
    } as unknown as Job;
    const git = baseGit();
    const findOpenPullByHead = vi.fn(async () => ({
      url: 'https://github.com/acme/widget/pull/9',
      number: 9,
    }));
    const pr = {
      openPullRequest: vi.fn(),
      findOpenPullByHead,
    } as unknown as GithubPrService;
    const store = baseStore();
    const { openPrAtShip, brainGateway } = makeBrain();

    const svc = new BuildShipService(git, pr, store, brainGateway);
    await svc.ship({ job: liveJob, record: null, repo, sandbox });

    expect(openPrAtShip).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'atlas/renamed' }),
    );
    expect(findOpenPullByHead).toHaveBeenCalledWith('ptok-xyz', {
      owner: 'acme',
      repo: 'widget',
      head: 'atlas/renamed',
    });
  });

  it('no GitHub token → no PR, job left running (opened:false, reason no-token)', async () => {
    const git = baseGit();
    const pr = {
      openPullRequest: vi.fn(),
      findOpenPullByHead: vi.fn(),
    } as unknown as GithubPrService;
    const store = baseStore();
    const { openPrAtShip, brainGateway } = makeBrain();
    const noTokenRepo = {
      ...repo,
      token: undefined,
    } as unknown as ResolvedRepo;

    const svc = new BuildShipService(git, pr, store, brainGateway);
    const result = await svc.ship({
      job,
      record: null,
      repo: noTokenRepo,
      sandbox,
    });

    // Gated before any open-PR turn — the brain was never seeded.
    expect(openPrAtShip).not.toHaveBeenCalled();
    expect(store.setPrReady).not.toHaveBeenCalled();
    expect(result).toEqual({ opened: false, reason: 'no-token' });
  });

  it('HARD-BLOCKS the PR when the pre-ship leak-scan finds a committed hydrated secret', async () => {
    const scanBranchForForbidden = vi.fn(async () => ['.env.keys']);
    const git = baseGit({ scanBranchForForbidden });
    const pr = {
      openPullRequest: vi.fn(),
      findOpenPullByHead: vi.fn(),
    } as unknown as GithubPrService;
    const store = baseStore();
    const { openPrAtShip, brainGateway } = makeBrain();

    const svc = new BuildShipService(git, pr, store, brainGateway);
    const result = await svc.ship({ job, record: null, repo, sandbox });

    expect(scanBranchForForbidden).toHaveBeenCalledWith(
      '/wt/feat',
      'origin/main',
    );
    // Blocked before the open-PR turn — the brain was never seeded, nothing latched.
    expect(openPrAtShip).not.toHaveBeenCalled();
    expect(store.setPrReady).not.toHaveBeenCalled();
    expect(result).toEqual({
      opened: false,
      reason: 'leak-scan',
      leaked: ['.env.keys'],
    });
  });

  it('FAILS CLOSED — a scan error blocks the ship rather than opening the PR', async () => {
    const scanBranchForForbidden = vi.fn(async () => {
      throw new Error('rev-list exploded');
    });
    const git = baseGit({ scanBranchForForbidden });
    const pr = {
      openPullRequest: vi.fn(),
      findOpenPullByHead: vi.fn(),
    } as unknown as GithubPrService;
    const store = baseStore();
    const { openPrAtShip, brainGateway } = makeBrain();

    const svc = new BuildShipService(git, pr, store, brainGateway);
    const result = await svc.ship({ job, record: null, repo, sandbox });

    expect(openPrAtShip).not.toHaveBeenCalled();
    expect(store.setPrReady).not.toHaveBeenCalled();
    expect(result).toEqual({ opened: false, reason: 'leak-scan', leaked: [] });
  });

  it('preShip is the host gate reused by mid-turn callers (finalize_build / finish_onboarding) — NEVER commits', async () => {
    const scanBranchForForbidden = vi.fn(async () => []);
    const git = baseGit({ scanBranchForForbidden });
    const pr = { findOpenPullByHead: vi.fn() } as unknown as GithubPrService;
    const store = baseStore();
    const { brainGateway } = makeBrain();

    const svc = new BuildShipService(git, pr, store, brainGateway);
    const ok = await svc.preShip(job, repo, sandbox);
    // The host NEVER commits — `preShip` only leak-scans the branch (over commits AND the working tree).
    expect(scanBranchForForbidden).toHaveBeenCalledWith(
      '/wt/feat',
      'origin/main',
    );
    expect(ok).toEqual({ ok: true });
  });

  it('preShip HARD-BLOCKS when the leak-scan finds a forbidden path (committed or uncommitted)', async () => {
    const git = baseGit({
      scanBranchForForbidden: vi.fn(async () => ['.env.local']),
    });
    const pr = { findOpenPullByHead: vi.fn() } as unknown as GithubPrService;
    const store = baseStore();
    const { brainGateway } = makeBrain();

    const svc = new BuildShipService(git, pr, store, brainGateway);
    const blocked = await svc.preShip(job, repo, sandbox);
    expect(blocked).toEqual({
      ok: false,
      reason: 'leak-scan',
      leaked: ['.env.local'],
    });
  });
});
