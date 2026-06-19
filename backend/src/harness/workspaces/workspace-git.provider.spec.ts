/**
 * `WorkspaceGitProvider.resolve` — daemon-only (every workspace is a sandbox work area; no local path).
 *
 *  - a ctx whose `workAreaId` resolves (via `WorkspaceRegistry`) to a LIVE sandbox (`SandboxRegistry.has`)
 *    → a `DaemonGitAdapter` bound to `(sandboxId, workAreaId)`. No session needed.
 *  - otherwise (no work area / sandbox gone) → `resolve` THROWS; `daemonFor`/`isContainerized` return
 *    undefined/false.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from './daemon-client';
import { DaemonGitAdapter } from './daemon-git.adapter';
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

describe('WorkspaceGitProvider.resolve (daemon-only)', () => {
  it('a workArea resolving to a live sandbox returns a DaemonGitAdapter', () => {
    const provider = new WorkspaceGitProvider(
      daemon,
      liveSandboxes,
      workAreasWithWa1(),
    );
    const port = provider.resolve({ team: 't', project: 'p', workspaceId: 'wa-1' });
    expect(port).toBeInstanceOf(DaemonGitAdapter);
    expect(
      provider.isContainerized({ team: 't', project: 'p', workspaceId: 'wa-1' }),
    ).toBe(true);
  });

  it('the session workspace id (the workAreaId) is consulted when a session is present', () => {
    const provider = new WorkspaceGitProvider(
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

  it('resolve THROWS when the work area’s sandbox is gone (no local fallback)', () => {
    const provider = new WorkspaceGitProvider(
      daemon,
      noSandboxes,
      workAreasWithWa1(),
    );
    expect(() =>
      provider.resolve({ team: 't', project: 'p', workspaceId: 'wa-1' }),
    ).toThrow(/No live sandbox/);
    expect(
      provider.isContainerized({ team: 't', project: 'p', workspaceId: 'wa-1' }),
    ).toBe(false);
  });

  it('resolve THROWS when there is no workspace id at all', () => {
    const provider = new WorkspaceGitProvider(
      daemon,
      liveSandboxes,
      workAreasWithWa1(),
    );
    expect(() => provider.resolve({ team: 't', project: 'p' })).toThrow(
      /No live sandbox/,
    );
  });

  it('daemonFor returns the adapter for a live work area, undefined otherwise', () => {
    const provider = new WorkspaceGitProvider(
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

describe('WorkspaceGitProvider.resolveReferenceTarget (reference-clone routing)', () => {
  it('an explicit workspaceId wins, bound to that work area', () => {
    const provider = new WorkspaceGitProvider(
      daemon,
      liveSandboxes,
      workAreasWithWa1(),
    );
    const t = provider.resolveReferenceTarget({
      team: 't',
      project: 'p',
      workspaceId: 'wa-1',
    });
    expect(t?.workspaceId).toBe('wa-1');
    expect(t?.port).toBeInstanceOf(DaemonGitAdapter);
  });

  it("selects the bot's own live (team,project) work area when no id is given", () => {
    const provider = new WorkspaceGitProvider(
      daemon,
      liveSandboxes,
      workAreasWithWa1(),
    );
    const t = provider.resolveReferenceTarget({
      team: 't',
      project: 'p',
      ownerBot: 'alex',
    });
    expect(t?.workspaceId).toBe('wa-1');
    expect(t?.port).toBeInstanceOf(DaemonGitAdapter);
  });

  it('falls back to a boot-reconciled (ownerBot:"") live area — owner-only would miss it', () => {
    const reg = new WorkspaceRegistry();
    reg.upsert({
      workAreaId: 'wa-recon',
      sandboxId: 'sandbox-uuid-1',
      team: 't',
      project: 'p',
      name: 'wa-recon',
      ownerBot: '', // reconciled from git on boot — ownership unknown
    });
    const provider = new WorkspaceGitProvider(daemon, liveSandboxes, reg);
    const t = provider.resolveReferenceTarget({
      team: 't',
      project: 'p',
      ownerBot: 'alex',
    });
    expect(t?.workspaceId).toBe('wa-recon');
  });

  it("prefers the bot's OWN live area over a teammate's", () => {
    const reg = new WorkspaceRegistry();
    reg.upsert({
      workAreaId: 'wa-other',
      sandboxId: 'sandbox-uuid-1',
      team: 't',
      project: 'p',
      name: 'wa-other',
      ownerBot: 'riley',
    });
    reg.upsert({
      workAreaId: 'wa-mine',
      sandboxId: 'sandbox-uuid-1',
      team: 't',
      project: 'p',
      name: 'wa-mine',
      ownerBot: 'alex',
    });
    const provider = new WorkspaceGitProvider(daemon, liveSandboxes, reg);
    const t = provider.resolveReferenceTarget({
      team: 't',
      project: 'p',
      ownerBot: 'alex',
    });
    expect(t?.workspaceId).toBe('wa-mine');
  });

  it('returns undefined when no live work area exists (never auto-creates)', () => {
    const provider = new WorkspaceGitProvider(
      daemon,
      noSandboxes,
      workAreasWithWa1(),
    );
    expect(
      provider.resolveReferenceTarget({ team: 't', project: 'p', ownerBot: 'alex' }),
    ).toBeUndefined();
    // explicit-but-dead workspaceId also yields undefined (not a throw)
    expect(
      provider.resolveReferenceTarget({ team: 't', project: 'p', workspaceId: 'wa-1' }),
    ).toBeUndefined();
  });
});
