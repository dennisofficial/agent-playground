/**
 * Phase 8 — `LocalWorkspaceAdapter` is a PURE 1:1 pass-through.
 *
 * The safety contract of this phase: routing every consumer through `WorkspaceGitProvider.resolve(ctx)`
 * must be byte-identical to the pre-Phase-8 direct `WorkspaceService.<method>(...)` call. So each adapter
 * method must call the SAME service method with the SAME args and return its result UNCHANGED. We spy
 * the service and assert exactly that for the whole async-git surface.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceService } from './workspace.service';
import { LocalWorkspaceAdapter } from './local-workspace.adapter';

/** A WorkspaceService stub where every async-git method is a spy returning a unique sentinel. */
function makeService() {
  return {
    create: vi.fn(async () => ({ workspace: { id: 'ws-001' }, warning: 'w' })),
    remove: vi.fn(async () => undefined),
    refreshFromBase: vi.fn(async () => ({ refreshed: true })),
    mergeState: vi.fn(async () => ({ inProgress: false, files: [] })),
    ensureShared: vi.fn(async () => 'shared/feat'),
    ensureSharedAtBase: vi.fn(async () => ({
      ok: true,
      sharedBranch: 'shared/feat',
    })),
    sharedRef: vi.fn(async () => 'abc123'),
    ownerDiff: vi.fn(async () => ({ range: 'a...b', files: ['x.ts'] })),
    publish: vi.fn(async () => ({ integrated: true, sharedBranch: 'shared/feat' })),
    pull: vi.fn(async () => ({ integrated: true, sharedBranch: 'shared/feat' })),
    pushSharedToOrigin: vi.fn(async () => ({
      sharedBranch: 'shared/feat',
      gitUrl: 'https://github.com/d/p',
    })),
    projectRecordFor: vi.fn(async () => ({ projectId: 'p' })),
    sharedStatus: vi.fn(async () => ({ published: true, aheadOfOrigin: 0 })),
    ensureReferenceClone: vi.fn(async () => ({
      path: '/refs/p',
      projectId: 'p',
      gitUrl: 'https://github.com/d/p',
    })),
    referenceOrientation: vi.fn(async () => 'Top level: src'),
  } as unknown as WorkspaceService;
}

describe('LocalWorkspaceAdapter (pure pass-through)', () => {
  it('delegates every async-git method 1:1 to WorkspaceService with the same args + result', async () => {
    const svc = makeService();
    const adapter = new LocalWorkspaceAdapter(svc);
    const s = svc as unknown as Record<string, ReturnType<typeof vi.fn>>;

    // Each tuple: [adapter call, the service spy it must hit, the exact args expected].
    const newWs = {
      name: 'n',
      ownerBot: 'alex',
      team: 't',
      project: 'p',
    };
    const refTarget = { projectId: 'p' };

    const cases: Array<{
      run: () => Promise<unknown>;
      spy: ReturnType<typeof vi.fn>;
      args: unknown[];
    }> = [
      { run: () => adapter.create(newWs), spy: s.create, args: [newWs] },
      { run: () => adapter.remove('ws-001'), spy: s.remove, args: ['ws-001'] },
      {
        run: () => adapter.refreshFromBase('ws-001'),
        spy: s.refreshFromBase,
        args: ['ws-001'],
      },
      {
        run: () => adapter.mergeState('ws-001'),
        spy: s.mergeState,
        args: ['ws-001'],
      },
      {
        run: () => adapter.ensureShared('ws-001', 'feat', 'sha'),
        spy: s.ensureShared,
        args: ['ws-001', 'feat', 'sha'],
      },
      {
        run: () => adapter.ensureSharedAtBase('ws-001', 'feat'),
        spy: s.ensureSharedAtBase,
        args: ['ws-001', 'feat'],
      },
      {
        run: () => adapter.sharedRef('ws-001'),
        spy: s.sharedRef,
        args: ['ws-001'],
      },
      {
        run: () => adapter.ownerDiff('ws-001', 'sha'),
        spy: s.ownerDiff,
        args: ['ws-001', 'sha'],
      },
      { run: () => adapter.publish('ws-001'), spy: s.publish, args: ['ws-001'] },
      { run: () => adapter.pull('ws-001'), spy: s.pull, args: ['ws-001'] },
      {
        run: () => adapter.pushSharedToOrigin('ws-001'),
        spy: s.pushSharedToOrigin,
        args: ['ws-001'],
      },
      {
        run: () => adapter.projectRecordFor('ws-001'),
        spy: s.projectRecordFor,
        args: ['ws-001'],
      },
      {
        run: () => adapter.sharedStatus('ws-001'),
        spy: s.sharedStatus,
        args: ['ws-001'],
      },
      {
        run: () => adapter.ensureReferenceClone('t', refTarget),
        spy: s.ensureReferenceClone,
        args: ['t', refTarget],
      },
      {
        run: () => adapter.referenceOrientation('/refs/p'),
        spy: s.referenceOrientation,
        args: ['/refs/p'],
      },
    ];

    for (const c of cases) {
      const out = await c.run();
      expect(c.spy).toHaveBeenCalledTimes(1);
      expect(c.spy).toHaveBeenCalledWith(...c.args);
      // The adapter returns the service's result UNCHANGED (same reference).
      expect(out).toBe(await c.spy.mock.results[0].value);
    }
  });
});
