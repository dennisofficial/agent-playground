/**
 * Phase 8 — `DaemonGitAdapter` maps each git op to a typed Redis RPC.
 *
 * DORMANT at runtime (the provider never resolves to it until Phase 9), so it is verified purely against
 * a FAKE `DaemonClient`: each method must call `gitCall(workspaceId, method, positionalArgs)` and return
 * its result. `workspaceId` is the SANDBOX the adapter was constructed for (the dispatch target).
 */
import { describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from './daemon-client';
import { DaemonGitAdapter } from './daemon-git.adapter';

const SANDBOX = 'sandbox-uuid-1';

function makeClient(returns: unknown = { ok: true }) {
  const gitCall = vi.fn(async () => returns);
  const daemon = { gitCall } as unknown as DaemonClient;
  return { daemon, gitCall };
}

describe('DaemonGitAdapter (typed git RPC over DaemonClient)', () => {
  it('forwards each method to gitCall(workspaceId, method, args) and returns the result', async () => {
    const returns = { sentinel: true };
    const { daemon, gitCall } = makeClient(returns);
    const adapter = new DaemonGitAdapter(daemon, SANDBOX);

    const newWs = { name: 'n', ownerBot: 'a', team: 't', project: 'p' };
    const refTarget = { gitUrl: 'https://github.com/d/p' };

    const cases: Array<{
      run: () => Promise<unknown>;
      method: string;
      args: unknown[];
    }> = [
      { run: () => adapter.create(newWs), method: 'create', args: [newWs] },
      { run: () => adapter.remove('ws-1'), method: 'remove', args: ['ws-1'] },
      {
        run: () => adapter.refreshFromBase('ws-1'),
        method: 'refreshFromBase',
        args: ['ws-1'],
      },
      {
        run: () => adapter.mergeState('ws-1'),
        method: 'mergeState',
        args: ['ws-1'],
      },
      {
        run: () => adapter.ensureShared('ws-1', 'feat', 'sha'),
        method: 'ensureShared',
        args: ['ws-1', 'feat', 'sha'],
      },
      {
        run: () => adapter.ensureSharedAtBase('ws-1', 'feat'),
        method: 'ensureSharedAtBase',
        args: ['ws-1', 'feat'],
      },
      {
        run: () => adapter.sharedRef('ws-1'),
        method: 'sharedRef',
        args: ['ws-1'],
      },
      {
        run: () => adapter.ownerDiff('ws-1', 'sha'),
        method: 'ownerDiff',
        args: ['ws-1', 'sha'],
      },
      { run: () => adapter.publish('ws-1'), method: 'publish', args: ['ws-1'] },
      { run: () => adapter.pull('ws-1'), method: 'pull', args: ['ws-1'] },
      {
        run: () => adapter.pushSharedToOrigin('ws-1'),
        method: 'pushSharedToOrigin',
        args: ['ws-1'],
      },
      {
        run: () => adapter.projectRecordFor('ws-1'),
        method: 'projectRecordFor',
        args: ['ws-1'],
      },
      {
        run: () => adapter.sharedStatus('ws-1'),
        method: 'sharedStatus',
        args: ['ws-1'],
      },
      {
        run: () => adapter.ensureReferenceClone('t', refTarget),
        method: 'ensureReferenceClone',
        args: ['t', refTarget],
      },
      {
        run: () => adapter.referenceOrientation('/refs/p'),
        method: 'referenceOrientation',
        args: ['/refs/p'],
      },
    ];

    for (const c of cases) {
      gitCall.mockClear();
      const out = await c.run();
      expect(gitCall).toHaveBeenCalledTimes(1);
      // Always dispatched to the SANDBOX the adapter was built for, with the method name + positional args.
      expect(gitCall).toHaveBeenCalledWith(SANDBOX, c.method, c.args);
      expect(out).toBe(returns);
    }
  });
});
