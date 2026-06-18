/**
 * Phase 8 — `WorkspaceGitProvider.resolve` fork (mirrors the `TurnExecutor` fork tests).
 *
 *  (a) LOCAL (the production default, isContainerized=false): `resolve(ctx)` returns the injected
 *      `LocalWorkspaceAdapter` — the live hot path stays 100% local this phase.
 *  (b) REMOTE (isContainerized forced true via a test-only subclass): `resolve(ctx)` returns a
 *      `DaemonGitAdapter` bound to ctx's workspace id — and a containerized op with NO workspace id
 *      throws (there'd be no sandbox to dispatch to).
 */
import { describe, expect, it } from 'vitest';
import type { DaemonClient } from './daemon-client';
import { DaemonGitAdapter } from './daemon-git.adapter';
import { LocalWorkspaceAdapter } from './local-workspace.adapter';
import type { WorkspaceGitCtx } from './workspace-git.port';
import { WorkspaceGitProvider } from './workspace-git.provider';

const CTX: WorkspaceGitCtx = {
  team: 'team-1',
  project: 'proj-1',
  workspaceId: 'ws-001',
};

const daemon = {} as unknown as DaemonClient;

/** A provider whose routing policy is forced (the real `isContainerized` is hard-false this phase). */
class TestableProvider extends WorkspaceGitProvider {
  constructor(
    local: LocalWorkspaceAdapter,
    daemonClient: DaemonClient,
    private readonly forceContainerized: boolean,
  ) {
    super(local, daemonClient);
  }
  protected isContainerized(): boolean {
    return this.forceContainerized;
  }
}

describe('WorkspaceGitProvider.resolve fork', () => {
  it('(a) LOCAL: returns the LocalWorkspaceAdapter (the live default — isContainerized hard-false)', () => {
    const local = {} as unknown as LocalWorkspaceAdapter;
    const provider = new WorkspaceGitProvider(local, daemon);
    expect(provider.resolve(CTX)).toBe(local);
  });

  it('(b) REMOTE (forced true): returns a DaemonGitAdapter, NOT the local adapter', () => {
    const local = {} as unknown as LocalWorkspaceAdapter;
    const provider = new TestableProvider(local, daemon, true);
    const port = provider.resolve(CTX);
    expect(port).toBeInstanceOf(DaemonGitAdapter);
    expect(port).not.toBe(local);
  });

  it('(b) REMOTE: keys the daemon adapter off the session workspace id when a session is present', () => {
    const local = {} as unknown as LocalWorkspaceAdapter;
    const provider = new TestableProvider(local, daemon, true);
    const port = provider.resolve({
      team: 't',
      project: 'p',
      session: { workspaceId: 'sandbox-uuid-9' } as never,
    });
    expect(port).toBeInstanceOf(DaemonGitAdapter);
  });

  it('(b) REMOTE: throws when a containerized op has no workspace id (no sandbox to reach)', () => {
    const local = {} as unknown as LocalWorkspaceAdapter;
    const provider = new TestableProvider(local, daemon, true);
    expect(() => provider.resolve({ team: 't', project: 'p' })).toThrow(
      /needs a workspaceId/,
    );
  });

  it('isContainerized defaults OFF (the live hot path stays local this phase)', () => {
    const local = {} as unknown as LocalWorkspaceAdapter;
    const provider = new WorkspaceGitProvider(local, daemon);
    // Even with full team/project/workspace context, the real policy returns the local adapter.
    expect(provider.resolve(CTX)).toBe(local);
  });
});
