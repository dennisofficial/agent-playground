/**
 * `WorkspaceGitProvider.resolve` fork (mirrors the `TurnExecutor` fork tests).
 *
 *  (a) LOCAL: a ctx whose work area doesn't resolve to a live sandbox → the injected `LocalWorkspaceAdapter`.
 *  (b) REMOTE: a ctx whose `workAreaId` resolves (via `WorkspaceRegistry`) to a LIVE sandbox
 *      (`SandboxRegistry.has`) → a `DaemonGitAdapter` bound to `(sandboxId, workAreaId)`. No session needed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from './daemon-client';
import { DaemonGitAdapter } from './daemon-git.adapter';
import { LocalWorkspaceAdapter } from './local-workspace.adapter';
import type { SandboxRegistry } from './sandbox-registry';
import { WorkspaceGitProvider } from './workspace-git.provider';
import { WorkspaceRegistry } from './workspace-registry';

const daemon = {} as unknown as DaemonClient;
/** A SandboxRegistry stand-in — only `sandbox-uuid-1` is live. */
const liveSandboxes = {
  has: vi.fn((id: string) => id === 'sandbox-uuid-1'),
} as unknown as SandboxRegistry;
const noSandboxes = { has: () => false } as unknown as SandboxRegistry;

/** A WorkspaceRegistry with one work area (`wa-1`) living in the live sandbox. */
function workAreasWithWa1(): WorkspaceRegistry {
  const reg = new WorkspaceRegistry();
  reg.upsert({
    workAreaId: 'wa-1',
    sandboxId: 'sandbox-uuid-1',
    team: 't',
    project: 'p',
    name: 'wa-1',
    ownerBot: 'alex',
  });
  return reg;
}

describe('WorkspaceGitProvider.resolve fork', () => {
  it('(a) LOCAL: a work area with no live sandbox returns the LocalWorkspaceAdapter', () => {
    const local = {} as unknown as LocalWorkspaceAdapter;
    const provider = new WorkspaceGitProvider(
      local,
      daemon,
      noSandboxes,
      new WorkspaceRegistry(),
    );
    expect(provider.resolve({ team: 't', project: 'p', workspaceId: 'ws-001' })).toBe(
      local,
    );
    expect(
      provider.isContainerized({ team: 't', project: 'p', workspaceId: 'ws-001' }),
    ).toBe(false);
  });

  it('(b) REMOTE: a workArea resolving to a live sandbox returns a DaemonGitAdapter', () => {
    const local = {} as unknown as LocalWorkspaceAdapter;
    const provider = new WorkspaceGitProvider(
      local,
      daemon,
      liveSandboxes,
      workAreasWithWa1(),
    );
    const port = provider.resolve({ team: 't', project: 'p', workspaceId: 'wa-1' });
    expect(port).toBeInstanceOf(DaemonGitAdapter);
    expect(port).not.toBe(local);
    expect(
      provider.isContainerized({ team: 't', project: 'p', workspaceId: 'wa-1' }),
    ).toBe(true);
  });

  it('(b) REMOTE: the session workspace id (the workAreaId) is consulted when a session is present', () => {
    const local = {} as unknown as LocalWorkspaceAdapter;
    const provider = new WorkspaceGitProvider(
      local,
      daemon,
      liveSandboxes,
      workAreasWithWa1(),
    );
    const port = provider.resolve({
      team: 't',
      project: 'p',
      session: { workspaceId: 'wa-1' } as never,
    });
    expect(port).toBeInstanceOf(DaemonGitAdapter);
  });

  it('a containerized-looking ctx whose sandbox is GONE falls back to local (no live container)', () => {
    const local = {} as unknown as LocalWorkspaceAdapter;
    // The work area exists but its sandbox is not live.
    const provider = new WorkspaceGitProvider(
      local,
      daemon,
      noSandboxes,
      workAreasWithWa1(),
    );
    expect(provider.resolve({ team: 't', project: 'p', workspaceId: 'wa-1' })).toBe(
      local,
    );
  });

  it('no workspace id at all → local', () => {
    const local = {} as unknown as LocalWorkspaceAdapter;
    const provider = new WorkspaceGitProvider(
      local,
      daemon,
      liveSandboxes,
      workAreasWithWa1(),
    );
    expect(provider.resolve({ team: 't', project: 'p' })).toBe(local);
  });

  it('daemonFor returns the adapter for a live work area, undefined otherwise', () => {
    const local = {} as unknown as LocalWorkspaceAdapter;
    const provider = new WorkspaceGitProvider(
      local,
      daemon,
      liveSandboxes,
      workAreasWithWa1(),
    );
    expect(
      provider.daemonFor({ team: 't', project: 'p', workspaceId: 'wa-1' }),
    ).toBeInstanceOf(DaemonGitAdapter);
    expect(
      provider.daemonFor({ team: 't', project: 'p', workspaceId: 'wa-unknown' }),
    ).toBeUndefined();
  });
});
