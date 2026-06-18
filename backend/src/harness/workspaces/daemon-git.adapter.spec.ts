/**
 * `DaemonGitAdapter` maps each host `WorkspaceGitPort` op to a typed daemon git RPC, applying THE
 * HOST↔DAEMON IDENTITY MAPPING: the RPC dispatch target is the SANDBOX uuid, and the daemon keys
 * per-WORKTREE ops by the WORK AREA id (one sandbox ⊃ many work-area worktrees; the sessions in a work
 * area share its tree). So for every per-worktree method the adapter DROPS the host workspace-id arg and
 * SUBSTITUTES `workAreaId` as the daemon method's leading arg — no session needed, so workspace-id-only
 * ops (publish/pull/refresh/remove) route cleanly too. Verified against a FAKE `DaemonClient`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from './daemon-client';
import { DaemonGitAdapter } from './daemon-git.adapter';

const SANDBOX = 'sandbox-uuid-1';
const WORK_AREA = 'wa-42';

function makeClient(returns: unknown = { ok: true }) {
  const gitCall = vi.fn(async () => returns);
  const daemon = { gitCall } as unknown as DaemonClient;
  return { daemon, gitCall };
}

describe('DaemonGitAdapter — host↔daemon identity mapping', () => {
  it('per-worktree ops: substitute the host workspace-id arg with the workAreaId and dispatch to the sandbox', async () => {
    const returns = { sentinel: true };
    const { daemon, gitCall } = makeClient(returns);
    const adapter = new DaemonGitAdapter(daemon, SANDBOX, WORK_AREA);

    // Each host call → gitCall(SANDBOX, daemonMethod, [WORK_AREA, ...rest]). The host workspace-id arg
    // ('ws-1' below) is DROPPED in favor of the work area id; trailing args (name/startPoint/sinceRef) ride.
    const cases: Array<{
      run: () => Promise<unknown>;
      method: string;
      args: unknown[];
    }> = [
      { run: () => adapter.remove('ws-1'), method: 'removeWorktree', args: [WORK_AREA] },
      {
        run: () => adapter.refreshFromBase('ws-1'),
        method: 'refreshFromBase',
        args: [WORK_AREA],
      },
      {
        run: () => adapter.mergeState('ws-1'),
        method: 'mergeState',
        args: [WORK_AREA],
      },
      {
        run: () => adapter.ensureShared('ws-1', 'feat', 'sha'),
        method: 'ensureShared',
        args: [WORK_AREA, 'feat', 'sha'],
      },
      {
        run: () => adapter.ensureSharedAtBase('ws-1', 'feat'),
        method: 'ensureSharedAtBase',
        args: [WORK_AREA, 'feat'],
      },
      {
        run: () => adapter.sharedRef('ws-1'),
        method: 'sharedRef',
        args: [WORK_AREA],
      },
      {
        run: () => adapter.ownerDiff('ws-1', 'sha'),
        method: 'ownerDiff',
        args: [WORK_AREA, 'sha'],
      },
      { run: () => adapter.publish('ws-1'), method: 'publish', args: [WORK_AREA] },
      { run: () => adapter.pull('ws-1'), method: 'pull', args: [WORK_AREA] },
      {
        run: () => adapter.pushSharedToOrigin('ws-1'),
        method: 'pushSharedToOrigin',
        args: [WORK_AREA],
      },
    ];

    for (const c of cases) {
      gitCall.mockClear();
      const out = await c.run();
      expect(gitCall).toHaveBeenCalledTimes(1);
      expect(gitCall).toHaveBeenCalledWith(SANDBOX, c.method, c.args);
      expect(out).toBe(returns);
    }
  });

  it('ensureReferenceClone drops the host team arg (the daemon resolves its own credential)', async () => {
    const { daemon, gitCall } = makeClient();
    const adapter = new DaemonGitAdapter(daemon, SANDBOX, WORK_AREA);
    const target = { gitUrl: 'https://github.com/d/p' };
    await adapter.ensureReferenceClone('t', target);
    expect(gitCall).toHaveBeenCalledWith(SANDBOX, 'ensureReferenceClone', [
      target,
    ]);
  });

  it('sharedStatus is a per-worktree RPC (keyed off the workAreaId)', async () => {
    const { daemon, gitCall } = makeClient({ published: true, aheadOfOrigin: 0 });
    const adapter = new DaemonGitAdapter(daemon, SANDBOX, WORK_AREA);
    await adapter.sharedStatus('ws-1');
    expect(gitCall).toHaveBeenCalledWith(SANDBOX, 'sharedStatus', [WORK_AREA]);
  });

  it('referenceOrientation is a PATH RPC (no work-area arg — like ensureReferenceClone)', async () => {
    const { daemon, gitCall } = makeClient('Top level: src');
    const adapter = new DaemonGitAdapter(daemon, SANDBOX, WORK_AREA);
    await adapter.referenceOrientation('/refs/p');
    expect(gitCall).toHaveBeenCalledWith(SANDBOX, 'referenceOrientation', [
      '/refs/p',
    ]);
  });

  it('off-port daemon ops: reviewRange (per-worktree), openPr/markReady/commentPr (sandbox-scoped), attachDesign (clone-root)', async () => {
    const { daemon, gitCall } = makeClient({ url: 'http://pr/1', number: 7 });
    const adapter = new DaemonGitAdapter(daemon, SANDBOX, WORK_AREA);

    gitCall.mockClear();
    await adapter.reviewRange();
    expect(gitCall).toHaveBeenCalledWith(SANDBOX, 'reviewRange', [WORK_AREA]);

    gitCall.mockClear();
    const prArgs = { title: 't', body: 'b', draft: false };
    await adapter.openPr(prArgs);
    expect(gitCall).toHaveBeenCalledWith(SANDBOX, 'openPr', [prArgs]);

    gitCall.mockClear();
    await adapter.markReady(7);
    expect(gitCall).toHaveBeenCalledWith(SANDBOX, 'markReady', [7]);

    gitCall.mockClear();
    await adapter.commentPr(7, 'findings');
    expect(gitCall).toHaveBeenCalledWith(SANDBOX, 'commentPr', [7, 'findings']);

    // attachDesign takes NO work-area arg (the daemon writes to the clone root); just the base64 artifact.
    gitCall.mockClear();
    await adapter.attachDesign('YmFzZTY0');
    expect(gitCall).toHaveBeenCalledWith(SANDBOX, 'attachDesign', ['YmFzZTY0']);
  });

  it('create() is NOT the work-area create path (create_workspace dispatches createWorktree directly) — loud reject', async () => {
    const { daemon } = makeClient();
    const adapter = new DaemonGitAdapter(daemon, SANDBOX, WORK_AREA);
    await expect(
      adapter.create({ name: 'n', ownerBot: 'a', team: 't', project: 'p' }),
    ).rejects.toThrow(/no in-sandbox counterpart/);
  });

  it('projectRecordFor (the one host-only method) throws a clear unavailable error', async () => {
    const { daemon } = makeClient();
    const adapter = new DaemonGitAdapter(daemon, SANDBOX, WORK_AREA);
    await expect(adapter.projectRecordFor('ws-1')).rejects.toThrow(
      /no in-sandbox counterpart/,
    );
  });
});
