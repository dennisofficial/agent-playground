/**
 * Phase 9 — `DaemonGitAdapter` maps each host `WorkspaceGitPort` op to a typed daemon git RPC, applying
 * THE HOST↔DAEMON IDENTITY MAPPING: the host port is keyed by the host workspace id (the sandbox uuid),
 * but the daemon keys per-WORKTREE ops by the HARNESS SESSION ID (one sandbox ⊃ many session worktrees).
 * So for every per-worktree method the adapter DROPS the host workspace-id arg and SUBSTITUTES
 * `ctx.session.id` as the daemon method's leading arg.
 *
 * DORMANT at runtime (the provider only resolves to it once a sandbox exists), so verified purely against
 * a FAKE `DaemonClient`. `workspaceId` is the SANDBOX the adapter dispatches to.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from './daemon-client';
import { DaemonGitAdapter } from './daemon-git.adapter';
import type { WorkspaceGitCtx } from './workspace-git.port';

const SANDBOX = 'sandbox-uuid-1';
const SESSION_ID = 'sess-42';
// The ctx the provider resolves the adapter with — its session.id is the daemon's worktree key.
const CTX: WorkspaceGitCtx = {
  team: 't',
  project: 'p',
  workspaceId: SANDBOX,
  session: { id: SESSION_ID, workspaceId: SANDBOX } as never,
};

function makeClient(returns: unknown = { ok: true }) {
  const gitCall = vi.fn(async () => returns);
  const daemon = { gitCall } as unknown as DaemonClient;
  return { daemon, gitCall };
}

describe('DaemonGitAdapter — host↔daemon identity mapping', () => {
  it('per-worktree ops: substitute the host workspace-id arg with ctx.session.id and dispatch to the sandbox', async () => {
    const returns = { sentinel: true };
    const { daemon, gitCall } = makeClient(returns);
    const adapter = new DaemonGitAdapter(daemon, SANDBOX, CTX);

    const newWs = { name: 'n', ownerBot: 'a', team: 't', project: 'p' };

    // Each host call → gitCall(SANDBOX, daemonMethod, [SESSION_ID, ...rest]). The host workspace-id arg
    // ('ws-1' below) is DROPPED in favor of the session id; trailing args (name/startPoint/sinceRef) ride.
    const cases: Array<{
      run: () => Promise<unknown>;
      method: string;
      args: unknown[];
    }> = [
      // create_workspace's git side → createWorktree keyed by the session id (input dropped).
      { run: () => adapter.create(newWs), method: 'createWorktree', args: [SESSION_ID] },
      { run: () => adapter.remove('ws-1'), method: 'removeWorktree', args: [SESSION_ID] },
      {
        run: () => adapter.refreshFromBase('ws-1'),
        method: 'refreshFromBase',
        args: [SESSION_ID],
      },
      {
        run: () => adapter.mergeState('ws-1'),
        method: 'mergeState',
        args: [SESSION_ID],
      },
      {
        run: () => adapter.ensureShared('ws-1', 'feat', 'sha'),
        method: 'ensureShared',
        args: [SESSION_ID, 'feat', 'sha'],
      },
      {
        run: () => adapter.ensureSharedAtBase('ws-1', 'feat'),
        method: 'ensureSharedAtBase',
        args: [SESSION_ID, 'feat'],
      },
      {
        run: () => adapter.sharedRef('ws-1'),
        method: 'sharedRef',
        args: [SESSION_ID],
      },
      {
        run: () => adapter.ownerDiff('ws-1', 'sha'),
        method: 'ownerDiff',
        args: [SESSION_ID, 'sha'],
      },
      { run: () => adapter.publish('ws-1'), method: 'publish', args: [SESSION_ID] },
      { run: () => adapter.pull('ws-1'), method: 'pull', args: [SESSION_ID] },
      {
        run: () => adapter.pushSharedToOrigin('ws-1'),
        method: 'pushSharedToOrigin',
        args: [SESSION_ID],
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
    const adapter = new DaemonGitAdapter(daemon, SANDBOX, CTX);
    const target = { gitUrl: 'https://github.com/d/p' };
    await adapter.ensureReferenceClone('t', target);
    expect(gitCall).toHaveBeenCalledWith(SANDBOX, 'ensureReferenceClone', [
      target,
    ]);
  });

  it('a per-worktree op with NO session in ctx throws (the session is the worktree key)', async () => {
    const { daemon } = makeClient();
    const adapter = new DaemonGitAdapter(daemon, SANDBOX, {
      team: 't',
      project: 'p',
      workspaceId: SANDBOX,
    });
    await expect(adapter.publish('ws-1')).rejects.toThrow(/needs ctx\.session/);
  });

  it('host-only methods (no daemon counterpart) throw a clear unavailable error', async () => {
    const { daemon } = makeClient();
    const adapter = new DaemonGitAdapter(daemon, SANDBOX, CTX);
    await expect(adapter.projectRecordFor('ws-1')).rejects.toThrow(
      /no in-sandbox counterpart/,
    );
    await expect(adapter.sharedStatus('ws-1')).rejects.toThrow(
      /no in-sandbox counterpart/,
    );
    await expect(adapter.referenceOrientation('/refs/p')).rejects.toThrow(
      /no in-sandbox counterpart/,
    );
  });
});
