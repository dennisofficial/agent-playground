/**
 * Boot self-provisioning unit tests — `WorkspaceProvisionerService` against the in-memory container
 * engine fake (NO Docker socket). Covers:
 *   - builds base image + volumes + daemon when absent;
 *   - skips the image build when it's already present (and REBUILD_IMAGE forces it anyway);
 *   - SKIP_DAEMON_BUILD reuses the existing volume (no daemon rebuild);
 *   - ensureProvisioned is memoized (concurrent callers share one run) AND retries after a rejection;
 *   - WORKSPACE_IMAGE unset is a clean no-op (sandboxes disabled);
 *   - the onApplicationBootstrap warm-up drives the same memoized run and never throws on a bad engine.
 */
import { Logger } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import { InMemoryContainerEngine } from './in-memory-container-engine';
import { WorkspaceProvisionerService } from './workspace-provisioner.service';

const IMAGE = 'agent-workspace-base';

function makeEnv(over: Record<string, unknown> = {}): EnvService {
  const values: Record<string, unknown> = {
    WORKSPACE_IMAGE: IMAGE,
    REPO_ROOT: '/repo', // explicit so tests don't depend on the fs walk-up
    ...over,
  };
  return { get: (k: string) => values[k] } as unknown as EnvService;
}

function make(over: Record<string, unknown> = {}): {
  engine: InMemoryContainerEngine;
  svc: WorkspaceProvisionerService;
} {
  const engine = new InMemoryContainerEngine();
  const svc = new WorkspaceProvisionerService(engine, makeEnv(over));
  return { engine, svc };
}

describe('WorkspaceProvisionerService (in-memory container engine)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('builds the base image + volumes + daemon when nothing exists', async () => {
    const { engine, svc } = make();
    await svc.ensureProvisioned();

    // image built with the tiny explicit context (Dockerfile + entrypoint, never the monorepo)
    expect(engine.builtImages).toEqual([IMAGE]);
    expect(engine.imageBuilds[0]).toMatchObject({
      tag: IMAGE,
      contextDir: '/repo',
      dockerfile: 'backend/src/daemon/Dockerfile',
      src: ['backend/src/daemon/Dockerfile', 'backend/src/daemon/entrypoint.sh'],
    });

    // both persistent volumes ensured (idempotent createVolume)
    expect(engine.createdVolumes).toContain('agent-daemon-build');
    expect(engine.createdVolumes).toContain('agent-pnpm-store');

    // daemon built into the volume via the same inner recipe the host script uses
    expect(engine.daemonBuilds).toHaveLength(1);
    expect(engine.daemonBuilds[0]).toMatchObject({
      image: IMAGE,
      repoRoot: '/repo',
      buildVolume: 'agent-daemon-build',
      storeVolume: 'agent-pnpm-store',
      innerScript: '/src/backend/scripts/daemon-build-inner.sh',
    });
  });

  it('skips the image build when the image is already present (but still builds the daemon)', async () => {
    const { engine, svc } = make();
    engine.seedImage(IMAGE);
    await svc.ensureProvisioned();

    expect(engine.builtImages).toHaveLength(0); // image reused
    expect(engine.daemonBuilds).toHaveLength(1); // daemon still (re)built
  });

  it('REBUILD_IMAGE forces a rebuild even when the image is present (with --pull)', async () => {
    const { engine, svc } = make({ REBUILD_IMAGE: true });
    engine.seedImage(IMAGE);
    await svc.ensureProvisioned();

    expect(engine.builtImages).toEqual([IMAGE]);
    expect(engine.imageBuilds[0]).toMatchObject({ pull: true });
  });

  it('SKIP_DAEMON_BUILD reuses the existing volume (no daemon rebuild)', async () => {
    const { engine, svc } = make({ SKIP_DAEMON_BUILD: true });
    await svc.ensureProvisioned();

    // image + volumes still ensured, but the daemon build is skipped
    expect(engine.builtImages).toEqual([IMAGE]);
    expect(engine.createdVolumes).toContain('agent-daemon-build');
    expect(engine.daemonBuilds).toHaveLength(0);
  });

  it('is memoized — concurrent ensureProvisioned() calls share one build', async () => {
    const { engine, svc } = make();
    await Promise.all([svc.ensureProvisioned(), svc.ensureProvisioned()]);
    expect(engine.builtImages).toHaveLength(1);
    expect(engine.daemonBuilds).toHaveLength(1);
    // a later call after success returns the cached run (no extra build)
    await svc.ensureProvisioned();
    expect(engine.daemonBuilds).toHaveLength(1);
  });

  it('clears the memo on failure so a later call retries', async () => {
    const { engine, svc } = make();
    engine.failNextDaemonBuild = true; // first daemon build rejects

    await expect(svc.ensureProvisioned()).rejects.toThrow(/build failure/);
    expect(engine.daemonBuilds).toHaveLength(0);

    // the memo was cleared → a retry runs the build to completion
    await svc.ensureProvisioned();
    expect(engine.daemonBuilds).toHaveLength(1);
  });

  it('is a clean no-op when WORKSPACE_IMAGE is unset (sandboxes disabled)', async () => {
    const { engine, svc } = make({ WORKSPACE_IMAGE: undefined });
    await expect(svc.ensureProvisioned()).resolves.toBeUndefined();
    expect(engine.builtImages).toHaveLength(0);
    expect(engine.createdVolumes).toHaveLength(0);
    expect(engine.daemonBuilds).toHaveLength(0);
  });

  it('honours WORKSPACE_DAEMON_BUILD_VOLUME / WORKSPACE_PNPM_STORE_VOLUME overrides', async () => {
    const { engine, svc } = make({
      WORKSPACE_DAEMON_BUILD_VOLUME: 'my-daemon',
      WORKSPACE_PNPM_STORE_VOLUME: 'my-store',
    });
    await svc.ensureProvisioned();
    expect(engine.createdVolumes).toEqual(
      expect.arrayContaining(['my-daemon', 'my-store']),
    );
    expect(engine.daemonBuilds[0]).toMatchObject({
      buildVolume: 'my-daemon',
      storeVolume: 'my-store',
    });
  });

  it('resolves the repo root from the fs when REPO_ROOT is unset', async () => {
    const engine = new InMemoryContainerEngine();
    // env WITHOUT REPO_ROOT → walk up from the compiled module to the pnpm-workspace.yaml marker.
    const env = {
      get: (k: string) => (k === 'WORKSPACE_IMAGE' ? IMAGE : undefined),
    } as unknown as EnvService;
    const svc = new WorkspaceProvisionerService(engine, env);
    await svc.ensureProvisioned();

    const resolved = engine.daemonBuilds[0].repoRoot;
    expect(existsSync(join(resolved, 'pnpm-workspace.yaml'))).toBe(true);
  });

  it('the onApplicationBootstrap warm-up drives the same memoized run and never throws', async () => {
    const { engine, svc } = make();
    svc.onApplicationBootstrap(); // fire-and-forget warm-up
    await svc.ensureProvisioned(); // same memoized promise → flushes + asserts
    expect(engine.builtImages).toHaveLength(1);
    expect(engine.daemonBuilds).toHaveLength(1);
  });

  it('warm-up swallows a Docker-absent engine error (boot never crashes)', async () => {
    const failing = {
      imagePresent: vi.fn(async () => {
        throw new Error('connect ENOENT /var/run/docker.sock');
      }),
    } as unknown as InMemoryContainerEngine;
    const svc = new WorkspaceProvisionerService(failing, makeEnv());
    expect(() => svc.onApplicationBootstrap()).not.toThrow();
    await expect(svc.ensureProvisioned()).rejects.toThrow(/ENOENT/);
  });

  describe('currentBuildVersion (drives boot version reconciliation)', () => {
    it('provisions FIRST, then reads the stamped version from the volume, and caches it', async () => {
      const { engine, svc } = make();
      engine.buildVersion = 'sha-built'; // the volume stamp after the build

      const v1 = await svc.currentBuildVersion();
      expect(v1).toBe('sha-built');
      // ensure-provisioned ran (the daemon was built before the version read).
      expect(engine.daemonBuilds).toHaveLength(1);

      // Cached: a second call doesn't re-read or re-build.
      const readSpy = vi.spyOn(engine, 'readDaemonBuildVersion');
      const v2 = await svc.currentBuildVersion();
      expect(v2).toBe('sha-built');
      expect(readSpy).not.toHaveBeenCalled();
    });

    it('returns undefined when the build has no stamp (a build predating the stamp)', async () => {
      const { engine, svc } = make();
      engine.buildVersion = undefined; // no .build-version on the volume
      await expect(svc.currentBuildVersion()).resolves.toBeUndefined();
    });

    it('returns undefined (no read) when WORKSPACE_IMAGE is unset (sandboxes disabled)', async () => {
      const { engine, svc } = make({ WORKSPACE_IMAGE: undefined });
      const readSpy = vi.spyOn(engine, 'readDaemonBuildVersion');
      await expect(svc.currentBuildVersion()).resolves.toBeUndefined();
      expect(readSpy).not.toHaveBeenCalled();
    });
  });
});
