import { describe, expect, it, vi } from 'vitest';
import type { Job } from '../domain';
import type { EngineRunnerPort } from '../engine';
import type { FeatureSandbox, GithubPrService, LocalGitService } from '../git';
import type { TurnHarnessFactory } from '../surface/turn-harness.service';
import { BuildShipService } from './build-ship.service';
import type { DriverStoreService } from './driver-store.service';
import type { ResolvedRepo } from './repo-resolver';

/**
 * ATLAS OWNS PR-OPEN. `ship` no longer pushes the branch or opens the PR host-side — Atlas does that
 * itself in-sandbox (git+gh) via the `openPrInSandbox` turn `ship` kicks (open-then-review). This guards
 * that the host push/open path stays removed (a regression here would double-open or race Atlas).
 */
describe('BuildShipService — host no longer pushes/opens the PR', () => {
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

  it('does NOT push or open a PR host-side — Atlas opens it in-sandbox (ship reports opened:true)', async () => {
    const push = vi.fn(async (_sandbox: FeatureSandbox) => undefined);
    const git = {
      push,
      commitAll: vi.fn(async () => 'sha'),
      scanBranchForForbidden: vi.fn(async () => []),
    } as unknown as LocalGitService;
    const openPullRequest = vi.fn(async () => ({
      url: 'https://github.com/acme/widget/pull/1',
      number: 1,
      existing: false,
    }));
    // The open turn threw (mocked engine), so the just-opened PR isn't discoverable → null.
    const pr = {
      openPullRequest,
      findOpenPullByHead: vi.fn(async () => null),
    } as unknown as GithubPrService;
    const harness = {
      onEvent: vi.fn(),
      finish: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const turnHarness = { create: vi.fn(() => harness) } as unknown as TurnHarnessFactory;
    const store = {
      setPrReady: vi.fn(async () => undefined),
      setJobStatus: vi.fn(async () => undefined),
    } as unknown as DriverStoreService;
    // PR Review is best-effort; a throwing engine is caught and shipping proceeds regardless.
    const engine = {
      run: vi.fn(async () => {
        throw new Error('skip pr review in this unit test');
      }),
    } as unknown as EngineRunnerPort;

    const svc = new BuildShipService(git, pr, store, turnHarness, engine);
    const result = await svc.ship({ job, record: null, repo, sandbox });

    // The host no longer pushes or opens the PR — Atlas owns that, in-sandbox (open turn + master review).
    expect(push).not.toHaveBeenCalled();
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(store.setPrReady).not.toHaveBeenCalled();
    // Token present → ship ran the in-sandbox open turn (best-effort; the mocked engine throws and is
    // caught → no url reported), and the branch-lookup fallback also missed (findOpenPullByHead → null).
    // So the PR url is UNCONFIRMED: report opened but prConfirmed:false.
    expect(result).toEqual({ opened: true, prConfirmed: false });
    // CRITICAL: an unconfirmed PR must NOT blind-flip the job `done` with a null pr_url — that stranded the
    // completion signal and made boot-recovery re-ship the job forever (the flaky-loop bug). Left `running`.
    expect(store.setJobStatus).not.toHaveBeenCalled();
  });

  it('targeted PR discovery after open: records pr_url/pr_number via setPrReady the moment Atlas opens it', async () => {
    const git = { push: vi.fn(), commitAll: vi.fn(async () => 'sha'), scanBranchForForbidden: vi.fn(async () => []) } as unknown as LocalGitService;
    // The host still never OPENS a PR — it only DISCOVERS the one Atlas opened in-sandbox, by head branch.
    const openPullRequest = vi.fn();
    const findOpenPullByHead = vi.fn(async () => ({
      url: 'https://github.com/acme/widget/pull/7',
      number: 7,
    }));
    const pr = { openPullRequest, findOpenPullByHead } as unknown as GithubPrService;
    const harness = { onEvent: vi.fn(), finish: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    const turnHarness = { create: vi.fn(() => harness) } as unknown as TurnHarnessFactory;
    const store = {
      setPrReady: vi.fn(async () => undefined),
      setJobStatus: vi.fn(async () => undefined),
    } as unknown as DriverStoreService;
    const engine = { run: vi.fn(async () => { throw new Error('skip in-sandbox turns in this unit test'); }) } as unknown as EngineRunnerPort;

    const svc = new BuildShipService(git, pr, store, turnHarness, engine);
    const result = await svc.ship({ job, record: null, repo, sandbox });

    // Discovered the PR Atlas opened on this branch → recorded url+number (setPrReady also flips `done`),
    // WITHOUT opening it host-side and WITHOUT waiting for the reconcile poll.
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(findOpenPullByHead).toHaveBeenCalledWith('ptok-xyz', {
      owner: 'acme',
      repo: 'widget',
      head: 'atlas/thread-abcd',
    });
    expect(store.setPrReady).toHaveBeenCalledWith('j1', 'https://github.com/acme/widget/pull/7', 7);
    // Found → we do NOT also blind-flip via setJobStatus (setPrReady already set done + url + number).
    expect(store.setJobStatus).not.toHaveBeenCalled();
    expect(result).toEqual({
      opened: true,
      prConfirmed: true,
      url: 'https://github.com/acme/widget/pull/7',
      number: 7,
    });
  });

  it('falls back to the report_pr_opened url when the branch lookup misses (GitHub indexing lag)', async () => {
    const git = { push: vi.fn(), commitAll: vi.fn(async () => 'sha'), scanBranchForForbidden: vi.fn(async () => []) } as unknown as LocalGitService;
    // Branch lookup misses (a just-created PR GitHub hasn't indexed) → the tool's reported url rescues it,
    // but ONLY after getPullDetail confirms the reported PR's head really is this sandbox's branch.
    const findOpenPullByHead = vi.fn(async () => null);
    const getPullDetail = vi.fn(async (_t: string, a: { number: number }) => ({
      number: a.number,
      url: `https://github.com/acme/widget/pull/${a.number}`,
      state: 'open' as const,
      mergeableState: null,
      headSha: null,
      headRef: 'atlas/thread-abcd', // matches sandbox.branch
    }));
    const pr = { openPullRequest: vi.fn(), findOpenPullByHead, getPullDetail } as unknown as GithubPrService;
    const harness = { onEvent: vi.fn(), finish: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    const turnHarness = { create: vi.fn(() => harness) } as unknown as TurnHarnessFactory;
    const store = {
      setPrReady: vi.fn(async () => undefined),
      setJobStatus: vi.fn(async () => undefined),
    } as unknown as DriverStoreService;
    // The open-PR turn: invoke the `report_pr_opened` bridge tool as Atlas would, then return.
    const reportCalls: unknown[] = [];
    const engine = {
      run: vi.fn(async (args: { toolBridge?: { tools: Record<string, (a: Record<string, unknown>) => Promise<unknown>> } }) => {
        const report = args.toolBridge?.tools?.report_pr_opened;
        if (report) reportCalls.push(await report({ url: 'https://github.com/acme/widget/pull/42' }));
        return { result: 'PR opened at https://github.com/acme/widget/pull/42' };
      }),
    } as unknown as EngineRunnerPort;

    const svc = new BuildShipService(git, pr, store, turnHarness, engine);
    const result = await svc.ship({ job, record: null, repo, sandbox });

    // Branch lookup was attempted (authoritative) but missed; the reported PR's head was verified via
    // getPullDetail and matched → the tool's url latched.
    expect(reportCalls).toEqual([{ ok: true, recorded: { url: 'https://github.com/acme/widget/pull/42', number: 42 } }]);
    expect(findOpenPullByHead).toHaveBeenCalled();
    expect(getPullDetail).toHaveBeenCalledWith('ptok-xyz', { owner: 'acme', repo: 'widget', number: 42 });
    expect(store.setPrReady).toHaveBeenCalledWith('j1', 'https://github.com/acme/widget/pull/42', 42);
    expect(result).toEqual({
      opened: true,
      prConfirmed: true,
      url: 'https://github.com/acme/widget/pull/42',
      number: 42,
    });
  });

  it('does NOT latch a reported PR whose head is a different branch (branch-lookup miss + wrong PR)', async () => {
    const git = { push: vi.fn(), commitAll: vi.fn(async () => 'sha'), scanBranchForForbidden: vi.fn(async () => []) } as unknown as LocalGitService;
    const findOpenPullByHead = vi.fn(async () => null); // branch lookup misses
    // The reported PR is on this repo but its head is a DIFFERENT branch → must be rejected, not latched.
    const getPullDetail = vi.fn(async (_t: string, a: { number: number }) => ({
      number: a.number,
      url: `https://github.com/acme/widget/pull/${a.number}`,
      state: 'open' as const,
      mergeableState: null,
      headSha: null,
      headRef: 'some-other-branch',
    }));
    const pr = { openPullRequest: vi.fn(), findOpenPullByHead, getPullDetail } as unknown as GithubPrService;
    const harness = { onEvent: vi.fn(), finish: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    const turnHarness = { create: vi.fn(() => harness) } as unknown as TurnHarnessFactory;
    const store = {
      setPrReady: vi.fn(async () => undefined),
      setJobStatus: vi.fn(async () => undefined),
    } as unknown as DriverStoreService;
    const engine = {
      run: vi.fn(async (args: { toolBridge?: { tools: Record<string, (a: Record<string, unknown>) => Promise<unknown>> } }) => {
        const report = args.toolBridge?.tools?.report_pr_opened;
        if (report) await report({ url: 'https://github.com/acme/widget/pull/99' });
        return { result: 'reported a wrong PR' };
      }),
    } as unknown as EngineRunnerPort;

    const svc = new BuildShipService(git, pr, store, turnHarness, engine);
    const result = await svc.ship({ job, record: null, repo, sandbox });

    // Head mismatch → not latched; job left `running` (unconfirmed), not falsely marked against a wrong PR.
    expect(store.setPrReady).not.toHaveBeenCalled();
    expect(store.setJobStatus).not.toHaveBeenCalled();
    expect(result).toEqual({ opened: true, prConfirmed: false });
  });

  it('report_pr_opened rejects a url that is not a PR on this repo (no false latch)', async () => {
    const git = { push: vi.fn(), commitAll: vi.fn(async () => 'sha'), scanBranchForForbidden: vi.fn(async () => []) } as unknown as LocalGitService;
    const findOpenPullByHead = vi.fn(async () => null);
    const pr = { openPullRequest: vi.fn(), findOpenPullByHead } as unknown as GithubPrService;
    const harness = { onEvent: vi.fn(), finish: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    const turnHarness = { create: vi.fn(() => harness) } as unknown as TurnHarnessFactory;
    const store = {
      setPrReady: vi.fn(async () => undefined),
      setJobStatus: vi.fn(async () => undefined),
    } as unknown as DriverStoreService;
    let rejection: unknown;
    const engine = {
      run: vi.fn(async (args: { toolBridge?: { tools: Record<string, (a: Record<string, unknown>) => Promise<unknown>> } }) => {
        const report = args.toolBridge?.tools?.report_pr_opened;
        if (report) rejection = await report({ url: 'https://github.com/evil/other/pull/1' });
        return { result: 'no valid url' };
      }),
    } as unknown as EngineRunnerPort;

    const svc = new BuildShipService(git, pr, store, turnHarness, engine);
    const result = await svc.ship({ job, record: null, repo, sandbox });

    // Wrong-repo url → tool refused it; nothing latched; branch lookup also missed → unconfirmed, not done.
    expect(rejection).toMatchObject({ ok: false });
    expect(store.setPrReady).not.toHaveBeenCalled();
    expect(store.setJobStatus).not.toHaveBeenCalled();
    expect(result).toEqual({ opened: true, prConfirmed: false });
  });

  it('HARD-BLOCKS the PR when the pre-ship leak-scan finds a committed hydrated secret', async () => {
    // The pre-ship scan (host-side, reads the host-only sidecar) found a forbidden path committed on the
    // branch → the ship is blocked BEFORE any open-PR turn runs. No engine turn, no push, no PR latched.
    const scanBranchForForbidden = vi.fn(async () => ['.env.keys']);
    const git = {
      push: vi.fn(),
      commitAll: vi.fn(async () => 'sha'),
      scanBranchForForbidden,
    } as unknown as LocalGitService;
    const pr = { openPullRequest: vi.fn(), findOpenPullByHead: vi.fn() } as unknown as GithubPrService;
    const harness = { onEvent: vi.fn(), finish: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    const turnHarness = { create: vi.fn(() => harness) } as unknown as TurnHarnessFactory;
    const store = {
      setPrReady: vi.fn(async () => undefined),
      setJobStatus: vi.fn(async () => undefined),
    } as unknown as DriverStoreService;
    const engineRun = vi.fn(async () => ({ result: 'should never run' }));
    const engine = { run: engineRun } as unknown as EngineRunnerPort;

    const svc = new BuildShipService(git, pr, store, turnHarness, engine);
    const result = await svc.ship({ job, record: null, repo, sandbox });

    expect(scanBranchForForbidden).toHaveBeenCalledWith('/wt/feat', 'origin/main');
    // Blocked before the open turn — no engine turn, no PR, nothing latched.
    expect(engineRun).not.toHaveBeenCalled();
    expect(store.setPrReady).not.toHaveBeenCalled();
    expect(result).toEqual({ opened: false, reason: 'leak-scan', leaked: ['.env.keys'] });
  });

  it('FAILS CLOSED — a scan error blocks the ship rather than opening the PR', async () => {
    const scanBranchForForbidden = vi.fn(async () => {
      throw new Error('rev-list exploded');
    });
    const git = {
      push: vi.fn(),
      commitAll: vi.fn(async () => 'sha'),
      scanBranchForForbidden,
    } as unknown as LocalGitService;
    const pr = { openPullRequest: vi.fn(), findOpenPullByHead: vi.fn() } as unknown as GithubPrService;
    const harness = { onEvent: vi.fn(), finish: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    const turnHarness = { create: vi.fn(() => harness) } as unknown as TurnHarnessFactory;
    const store = {
      setPrReady: vi.fn(async () => undefined),
      setJobStatus: vi.fn(async () => undefined),
    } as unknown as DriverStoreService;
    const engineRun = vi.fn(async () => ({ result: 'should never run' }));
    const engine = { run: engineRun } as unknown as EngineRunnerPort;

    const svc = new BuildShipService(git, pr, store, turnHarness, engine);
    const result = await svc.ship({ job, record: null, repo, sandbox });

    expect(engineRun).not.toHaveBeenCalled();
    expect(store.setPrReady).not.toHaveBeenCalled();
    expect(result).toEqual({ opened: false, reason: 'leak-scan', leaked: [] });
  });
});
