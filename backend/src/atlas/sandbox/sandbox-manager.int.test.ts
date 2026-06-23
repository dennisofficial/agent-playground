import type { EnvService } from '@core/config/env/env.service';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeatureSandbox } from '../git';
import { DockerodeContainerEngine } from './dockerode-container-engine';
import { SandboxImageBuilder } from './sandbox-image.builder';
import { SandboxManager } from './sandbox-manager.service';

/**
 * Integration test for the docker SANDBOX_PROVIDER (D2/D3). Proves the manager's substrate without an
 * LLM: it ensures a privileged per-feature container with the LINKED worktree + its git common dir
 * bind-mounted at their same host paths (so in-container git resolves), an inner dockerd (DinD), and a
 * host-uid exec that can write the worktree. Needs Docker; a no-op when Docker is unreachable.
 */
const env = (v: Record<string, string | undefined> = {}) =>
  ({ get: (k: string) => v[k] }) as unknown as EnvService;

let dockerUp = false;
beforeAll(async () => {
  try {
    await new Docker().ping();
    dockerUp = true;
  } catch {
    dockerUp = false;
  }
});

describe('SandboxManager (integration, needs Docker)', () => {
  const engine = new DockerodeContainerEngine(env());
  const builder = new SandboxImageBuilder(env(), engine);
  // Keep the agent-home under the repos tmp so it's a Docker-shared path on macOS.
  let repoRoot: string;
  let worktree: string;
  let homeRoot: string;
  let sandbox: FeatureSandbox;
  let manager: SandboxManager;
  let containerId: string | undefined;
  let artifacts: { net: string; vol: string } | undefined;

  beforeAll(() => {
    if (!dockerUp) return;
    repoRoot = mkdtempSync(join(tmpdir(), 'atlas-sbxmgr-'));
    homeRoot = mkdtempSync(join(tmpdir(), 'atlas-sbxhome-'));
    const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    git(['init', '-q'], repoRoot);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'a@b.c']);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'a']);
    execFileSync('bash', ['-c', `echo "# repo" > ${repoRoot}/README.md`]);
    git(['add', '-A'], repoRoot);
    git(['commit', '-qm', 'init'], repoRoot);
    // A LINKED worktree (the real Atlas shape: .git is a file → external gitdir).
    worktree = join(repoRoot, '.worktrees', 'feat');
    git(['worktree', 'add', '-q', worktree, '-b', 'atlas/feat'], repoRoot);
    sandbox = { projectId: 'proj', branch: 'atlas/feat', worktreePath: worktree, gitUrl: '' };
    manager = new SandboxManager(engine, builder, env({ ATLAS_AGENT_HOME_ROOT: homeRoot }));
  });

  afterAll(async () => {
    if (containerId) await engine.remove(containerId, { force: true }).catch(() => undefined);
    if (artifacts) {
      await engine.removeNetwork(artifacts.net).catch(() => undefined);
      await engine.removeVolume(artifacts.vol).catch(() => undefined);
    }
    for (const p of [repoRoot, homeRoot]) if (p) rmSync(p, { recursive: true, force: true });
  });

  it('attaches a sandbox where in-container git resolves the linked worktree and host-uid can write', async () => {
    if (!dockerUp) {
      // eslint-disable-next-line no-console
      console.warn('Docker not reachable — skipping SandboxManager integration test');
      return;
    }
    await builder.ensureImage();

    const attached = await manager.attach({ sandbox, teamId: 'team1' });
    containerId = attached.containerId;
    expect(attached.containerId).toBeTruthy();
    expect(attached.execUser).toMatch(/^\d+:\d+$/);

    // in-container git resolves the LINKED worktree (gitdir mounted at its same host path).
    const branch = await engine.exec(attached.containerId!, ['git', '-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      user: attached.execUser,
    });
    expect(branch.exitCode).toBe(0);
    expect(branch.stdout.trim()).toBe('atlas/feat');

    // host-uid exec can write the worktree; the file round-trips to the host bind mount.
    const marker = `sbxmgr-${Date.now().toString(36)}`;
    const w = await engine.exec(
      attached.containerId!,
      ['bash', '-c', `echo ${marker} > ${worktree}/MARKER.txt`],
      { user: attached.execUser },
    );
    expect(w.exitCode).toBe(0);
    expect(readFileSync(join(worktree, 'MARKER.txt'), 'utf8').trim()).toBe(marker);

    // idempotent: a second attach reuses the same container.
    const again = await manager.attach({ sandbox, teamId: 'team1' });
    expect(again.containerId).toBe(attached.containerId);

    // the per-sandbox network + DinD volume exist while the sandbox is up (named off the container).
    const docker = new Docker();
    const containerName = (await engine.inspect(attached.containerId!))!.name;
    const netName = `${containerName}-net`;
    const volName = `${containerName}-dind`;
    artifacts = { net: netName, vol: volName };
    const netExists = async () =>
      (await docker.listNetworks({ filters: { name: [netName] } })).some((n) => n.Name === netName);
    const volExists = async () => {
      try {
        await docker.getVolume(volName).inspect();
        return true;
      } catch {
        return false;
      }
    };
    expect(await netExists()).toBe(true);
    expect(await volExists()).toBe(true);

    // teardown removes the container AND reclaims its network + DinD volume (no orphan accumulation).
    await manager.teardown(attached);
    expect(await engine.inspect(attached.containerId!)).toBeNull();
    expect(await netExists()).toBe(false);
    expect(await volExists()).toBe(false);
    containerId = undefined;
    artifacts = undefined;
  }, 600_000);

  it('reaps a fully orphaned network + volume left behind by a crashed teardown', async () => {
    if (!dockerUp) {
      // eslint-disable-next-line no-console
      console.warn('Docker not reachable — skipping SandboxManager orphan-reap test');
      return;
    }
    await builder.ensureImage();

    // A distinct team → a distinct container name, independent of the first test.
    const attached = await manager.attach({ sandbox, teamId: 'team2' });
    containerId = attached.containerId;
    const docker = new Docker();
    const containerName = (await engine.inspect(attached.containerId!))!.name;
    const netName = `${containerName}-net`;
    const volName = `${containerName}-dind`;
    artifacts = { net: netName, vol: volName };
    const netExists = async () =>
      (await docker.listNetworks({ filters: { name: [netName] } })).some((n) => n.Name === netName);
    const volExists = async () => {
      try {
        await docker.getVolume(volName).inspect();
        return true;
      } catch {
        return false;
      }
    };

    // Simulate a crash: drop ONLY the container (teardown never ran) — net + volume are now orphaned.
    await engine.remove(attached.containerId!, { force: true });
    containerId = undefined;
    expect(await netExists()).toBe(true);
    expect(await volExists()).toBe(true);

    // The catch-all reaper reclaims them (their owning container no longer exists).
    const result = await manager.reapOrphanedArtifacts();
    expect(result.networks).toBeGreaterThanOrEqual(1);
    expect(result.volumes).toBeGreaterThanOrEqual(1);
    expect(await netExists()).toBe(false);
    expect(await volExists()).toBe(false);
    artifacts = undefined;
  }, 600_000);
});
