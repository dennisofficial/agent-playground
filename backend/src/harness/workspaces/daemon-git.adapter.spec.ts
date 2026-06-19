/**
 * `DaemonGitAdapter` maps each host `WorkspaceGitPort` op to a typed daemon git RPC under THE
 * WORKSTATION model: a sandbox IS one fresh clone checked out on ONE branch, so the daemon's per-branch
 * RPCs (`publish`/`pull`/`refreshFromBase`/`mergeState`/`ownerDiff`/`reviewRange`) take NO leading id arg
 * — the daemon already knows its one branch. The host `workspaceId` the port methods carry is vestigial
 * and DROPPED; only genuine payload args (the `ownerDiff` sinceRef, the off-port PR args) ride. Verified
 * against a FAKE `DaemonClient`.
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

describe('DaemonGitAdapter — workstation per-branch RPCs', () => {
  it('per-branch ops: drop the vestigial host workspace-id arg; only real payload args ride', async () => {
    const returns = { sentinel: true };
    const { daemon, gitCall } = makeClient(returns);
    const adapter = new DaemonGitAdapter(daemon, SANDBOX, WORK_AREA);

    // Each host call → gitCall(SANDBOX, daemonMethod, [...realArgs]). The host workspace-id arg ('ws-1'
    // below) is DROPPED — the daemon's single checkout IS the branch, so its per-branch RPCs need no key.
    // Only genuine payload (ownerDiff's sinceRef) rides.
    const cases: Array<{
      run: () => Promise<unknown>;
      method: string;
      args: unknown[];
    }> = [
      {
        run: () => adapter.refreshFromBase('ws-1'),
        method: 'refreshFromBase',
        args: [],
      },
      {
        run: () => adapter.mergeState('ws-1'),
        method: 'mergeState',
        args: [],
      },
      {
        run: () => adapter.syncStatus('ws-1'),
        method: 'syncStatus',
        args: [],
      },
      {
        run: () => adapter.ownerDiff('ws-1', 'sha'),
        method: 'ownerDiff',
        args: ['sha'],
      },
      { run: () => adapter.publish('ws-1'), method: 'publish', args: [] },
      { run: () => adapter.pull('ws-1'), method: 'pull', args: [] },
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

  it('referenceOrientation is a PATH RPC (no work-area arg — like ensureReferenceClone)', async () => {
    const { daemon, gitCall } = makeClient('Top level: src');
    const adapter = new DaemonGitAdapter(daemon, SANDBOX, WORK_AREA);
    await adapter.referenceOrientation('/refs/p');
    expect(gitCall).toHaveBeenCalledWith(SANDBOX, 'referenceOrientation', [
      '/refs/p',
    ]);
  });

  it('off-port daemon ops: reviewRange (no id arg), openPr/markReady/commentPr (sandbox-scoped), attachDesign (clone-root)', async () => {
    const { daemon, gitCall } = makeClient({ url: 'http://pr/1', number: 7 });
    const adapter = new DaemonGitAdapter(daemon, SANDBOX, WORK_AREA);

    gitCall.mockClear();
    await adapter.reviewRange();
    expect(gitCall).toHaveBeenCalledWith(SANDBOX, 'reviewRange', []);

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

  it('projectRecordFor (the one host-only method) throws a clear unavailable error', async () => {
    const { daemon } = makeClient();
    const adapter = new DaemonGitAdapter(daemon, SANDBOX, WORK_AREA);
    await expect(adapter.projectRecordFor('ws-1')).rejects.toThrow(
      /no in-sandbox counterpart/,
    );
  });
});
