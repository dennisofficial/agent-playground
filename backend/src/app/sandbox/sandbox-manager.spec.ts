import type { EnvService } from '@core/config/env/env.service';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContainerEngine,
  ContainerInfo,
  NetworkInfo,
  VolumeInfo,
} from './container-engine.port';
import type { FeatureSandbox } from '../git';
import type { SandboxAttachInput } from './sandbox-provider.port';
import { SandboxImageBuilder } from './sandbox-image.builder';
import { SandboxManager, dedupeBindsByTarget } from './sandbox-manager.service';

const env = (v: Record<string, string | undefined> = {}) =>
  ({ get: (k: string) => v[k] }) as unknown as EnvService;

/**
 * A fake ContainerEngine whose `list`/`listNetworks`/`listVolumes` return scripted state and whose
 * `removeNetwork`/`removeVolume` record (or reject) so we can assert the orphan-reaper's name-matching.
 */
function fakeEngine(state: {
  containers: string[];
  networks: string[];
  volumes: string[];
  failRemove?: Set<string>;
}) {
  const removedNetworks: string[] = [];
  const removedVolumes: string[] = [];
  const engine: ContainerEngine = {
    ensureNetwork: vi.fn(),
    connectNetwork: vi.fn(),
    execDetached: vi.fn(),
    imageExists: vi.fn(),
    imageId: vi.fn(),
    imageLabels: vi.fn(),
    buildImage: vi.fn(),
    createContainer: vi.fn(),
    start: vi.fn(),
    exec: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
    removeNetwork: vi.fn(async (name: string) => {
      if (state.failRemove?.has(name)) throw new Error(`network ${name} has active endpoints`);
      removedNetworks.push(name);
    }),
    removeVolume: vi.fn(async (name: string) => {
      if (state.failRemove?.has(name)) throw new Error(`volume ${name} in use`);
      removedVolumes.push(name);
    }),
    list: vi.fn(
      async (): Promise<ContainerInfo[]> =>
        state.containers.map((name) => ({ id: name, name, state: 'running', labels: {} })),
    ),
    inspect: vi.fn(),
    listNetworks: vi.fn(async (): Promise<NetworkInfo[]> => state.networks.map((name) => ({ id: name, name }))),
    listVolumes: vi.fn(async (): Promise<VolumeInfo[]> => state.volumes.map((name) => ({ name }))),
  };
  return { engine, removedNetworks, removedVolumes };
}

const manager = (engine: ContainerEngine) =>
  new SandboxManager(engine, new SandboxImageBuilder(env(), engine), env());

describe('dedupeBindsByTarget', () => {
  it('drops a colliding target keeping the LAST occurrence (system bind wins)', () => {
    // Cache mount (empty per-thread dir) pushed first, then the system shared store at the same target.
    const { binds, dropped } = dedupeBindsByTarget([
      '/caches/thread/.pnpm-store:/workspace/.pnpm-store',
      '/agent-home/pnpm-store:/workspace/.pnpm-store',
    ]);
    expect(binds).toEqual(['/agent-home/pnpm-store:/workspace/.pnpm-store']);
    expect(dropped).toEqual(['/workspace/.pnpm-store']);
  });

  it('keeps nested targets (a parent and its more-specific :ro child both survive)', () => {
    const input = [
      '/host/context:/context',
      '/host/context/generated:/context/generated:ro',
      '/host/store:/workspace/.pnpm-store',
    ];
    const { binds, dropped } = dedupeBindsByTarget(input);
    expect(binds).toEqual(input);
    expect(dropped).toEqual([]);
  });
});

describe('SandboxManager.reapOrphanedArtifacts', () => {
  it('removes only atlas-sbx artifacts whose owning container is gone', async () => {
    const { engine, removedNetworks, removedVolumes } = fakeEngine({
      // `...-b` is a live sandbox; `...-a` was torn down but leaked its net/vol.
      containers: ['atlas-sbx-team-proj-b', 'unrelated-container'],
      networks: ['atlas-sbx-team-proj-a-net', 'atlas-sbx-team-proj-b-net', 'bridge', 'host'],
      volumes: ['atlas-sbx-team-proj-a-dind', 'atlas-sbx-team-proj-b-dind', 'pnpm-store'],
    });

    const result = await manager(engine).reapOrphanedArtifacts();

    expect(result).toEqual({ networks: 1, volumes: 1 });
    // the orphan (no `...-a` container) is reclaimed; the live one + non-atlas artifacts are untouched.
    expect(removedNetworks).toEqual(['atlas-sbx-team-proj-a-net']);
    expect(removedVolumes).toEqual(['atlas-sbx-team-proj-a-dind']);
  });

  it('reclaims nothing when every artifact still has a live container', async () => {
    const { engine, removedNetworks, removedVolumes } = fakeEngine({
      containers: ['atlas-sbx-x'],
      networks: ['atlas-sbx-x-net'],
      volumes: ['atlas-sbx-x-dind'],
    });

    expect(await manager(engine).reapOrphanedArtifacts()).toEqual({ networks: 0, volumes: 0 });
    expect(removedNetworks).toEqual([]);
    expect(removedVolumes).toEqual([]);
  });

  it('does not count (or throw on) an artifact that fails to remove', async () => {
    const { engine } = fakeEngine({
      containers: [],
      networks: ['atlas-sbx-stuck-net'],
      volumes: ['atlas-sbx-stuck-dind'],
      failRemove: new Set(['atlas-sbx-stuck-net', 'atlas-sbx-stuck-dind']),
    });

    expect(await manager(engine).reapOrphanedArtifacts()).toEqual({ networks: 0, volumes: 0 });
  });
});

describe('SandboxManager.teardownByIdentity', () => {
  // The deterministic name `attach` derives for a thread-keyed sandbox (keyed by jobId alone — the
  // globally-unique PK): `atlas-sbx-thread-<id>`. Terminal cleanup must resolve this WITHOUT a container_id,
  // because a boot reconcile nulls the persisted id while the real container keeps running.
  const NAME = 'atlas-sbx-thread-abc';
  const sandbox = (): FeatureSandbox => ({
    repoId: 'proj',
    branch: 'atlas/thread-abc', // ignored for thread-keyed names; proves the name is keyed by jobId
    worktreePath: '/w',
    gitUrl: '',
  });

  /** A fake engine that knows ONE container by name, recording every container/net/volume removal. */
  function fake(opts: { containerExists: boolean }) {
    const removedContainers: string[] = [];
    const removedNetworks: string[] = [];
    const removedVolumes: string[] = [];
    const container: ContainerInfo = { id: 'cid-1', name: NAME, state: 'running', labels: {} };
    const engine: ContainerEngine = {
      ensureNetwork: vi.fn(),
      connectNetwork: vi.fn(),
      execDetached: vi.fn(),
      imageExists: vi.fn(),
      imageId: vi.fn(),
      imageLabels: vi.fn(),
      buildImage: vi.fn(),
      createContainer: vi.fn(),
      start: vi.fn(),
      exec: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn(async (id: string) => {
        removedContainers.push(id);
      }),
      removeNetwork: vi.fn(async (name: string) => {
        removedNetworks.push(name);
      }),
      removeVolume: vi.fn(async (name: string) => {
        removedVolumes.push(name);
      }),
      list: vi.fn(async (): Promise<ContainerInfo[]> => []),
      // Resolve ONLY by the deterministic name (a running orphan has no id we still hold).
      inspect: vi.fn(async (idOrName: string): Promise<ContainerInfo | null> =>
        opts.containerExists && idOrName === NAME ? container : null,
      ),
      listNetworks: vi.fn(async (): Promise<NetworkInfo[]> => []),
      listVolumes: vi.fn(async (): Promise<VolumeInfo[]> => []),
    };
    return { engine, removedContainers, removedNetworks, removedVolumes };
  }

  it('resolves a running orphan by its deterministic name and removes it + its net/vol (no container_id)', async () => {
    const { engine, removedContainers, removedNetworks, removedVolumes } = fake({ containerExists: true });

    await manager(engine).teardownByIdentity({ sandbox: sandbox(), orgId: 'team', jobId: 'abc' });

    expect(removedContainers).toEqual(['cid-1']);
    expect(removedNetworks).toEqual([`${NAME}-net`]);
    expect(removedVolumes).toEqual([`${NAME}-dind`]);
  });

  it('still reclaims leaked net/vol by name when the container is already gone', async () => {
    const { engine, removedContainers, removedNetworks, removedVolumes } = fake({ containerExists: false });

    await manager(engine).teardownByIdentity({ sandbox: sandbox(), orgId: 'team', jobId: 'abc' });

    expect(removedContainers).toEqual([]); // nothing to remove
    expect(removedNetworks).toEqual([`${NAME}-net`]);
    expect(removedVolumes).toEqual([`${NAME}-dind`]);
  });
});

describe('SandboxManager.attach — onMilestone', () => {
  // CONFIG_REV is a private module constant (currently 9); mirrored here to construct a matching
  // fingerprint label for the warm-reuse case. `atlas.cfg` mirrors the private L_CFG label key.
  const CONFIG_REV = 9;
  const IMAGE_ID = 'img-1';
  const FINGERPRINT = `${IMAGE_ID}|cfg${CONFIG_REV}|mnone`; // no mounts in these tests

  let agentHomeRoot: string;
  beforeEach(() => {
    agentHomeRoot = mkdtempSync(join(tmpdir(), 'atlas-sbxmgr-'));
  });
  afterEach(() => rmSync(agentHomeRoot, { recursive: true, force: true }));

  /** A fake engine that lets `attach()` run to completion: image ready, create succeeds, waitReady
   *  resolves on its first poll (no real 1s waits). */
  function fullFakeEngine(existing: ContainerInfo | null) {
    const createContainer = vi.fn(async () => 'new-container-id');
    const engine: ContainerEngine = {
      ensureNetwork: vi.fn(),
      connectNetwork: vi.fn(),
      execDetached: vi.fn(),
      imageExists: vi.fn(async () => true),
      imageId: vi.fn(async () => IMAGE_ID),
      imageLabels: vi.fn(),
      buildImage: vi.fn(),
      createContainer,
      start: vi.fn(),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: 'v1', stderr: '' })), // waitReady resolves immediately
      stop: vi.fn(),
      remove: vi.fn(),
      removeNetwork: vi.fn(),
      removeVolume: vi.fn(),
      list: vi.fn(async () => []),
      inspect: vi.fn(async () => existing),
      listNetworks: vi.fn(async () => []),
      listVolumes: vi.fn(async () => []),
    };
    return { engine, createContainer };
  }

  /** A fake `SandboxImageBuilder` whose `ensureImage` mirrors the real "fires onBuildStart only on a
   *  real rebuild" contract, controlled directly per test (bypasses real context-hashing entirely). */
  function fakeBuilder(rebuilds: boolean) {
    const ensureImage = vi.fn(async (onBuildStart?: () => void) => {
      if (rebuilds) onBuildStart?.();
      return 'atlas-sandbox:latest';
    });
    return { ensureImage } as unknown as SandboxImageBuilder;
  }

  // worktreePath is NOT a real git repo — attach()'s `gitCommonDir` shells out to `git rev-parse` and
  // safely returns undefined on failure (no linked-worktree .git bind), which is fine for these tests.
  const sandbox = (): FeatureSandbox => ({
    repoId: 'proj',
    branch: 'main',
    worktreePath: agentHomeRoot,
    gitUrl: '',
  });

  it('fires onMilestone("container_create") on a cold create (no existing container)', async () => {
    const { engine, createContainer } = fullFakeEngine(null);
    const mgr = new SandboxManager(engine, fakeBuilder(false), env({ AGENT_HOME_ROOT: agentHomeRoot }));
    const onMilestone = vi.fn();

    await mgr.attach({ sandbox: sandbox(), orgId: 'org1', jobId: 'job1', onMilestone } as SandboxAttachInput);

    expect(createContainer).toHaveBeenCalledOnce();
    expect(onMilestone).toHaveBeenCalledWith('container_create');
    expect(onMilestone).not.toHaveBeenCalledWith('image_build');
  });

  it('binds the durable per-job /playground scratch mount, keyed by jobId and outside the worktree', async () => {
    const { engine, createContainer } = fullFakeEngine(null);
    const mgr = new SandboxManager(engine, fakeBuilder(false), env({ AGENT_HOME_ROOT: agentHomeRoot }));

    await mgr.attach({ sandbox: sandbox(), orgId: 'org1', jobId: 'job1' } as SandboxAttachInput);

    const spec = (createContainer.mock.calls[0] as unknown as [{ binds: string[] }])[0];
    const playgroundBind = spec.binds.find((b) => b.endsWith(':/playground'));
    expect(playgroundBind).toBeDefined();
    // Host side resolves to the jobId-keyed dir (the int test proves it lives outside the worktree).
    const hostDir = playgroundBind!.slice(0, -':/playground'.length);
    expect(hostDir).toBe(mgr.playgroundDirHost('org1', 'job1'));
  });

  it('does NOT fire container_create on a warm reuse (already running, matching fingerprint)', async () => {
    const existing: ContainerInfo = {
      id: 'existing-id',
      name: 'atlas-sbx-thread-job1',
      state: 'running',
      labels: { 'atlas.cfg': FINGERPRINT },
    };
    const { engine, createContainer } = fullFakeEngine(existing);
    const mgr = new SandboxManager(engine, fakeBuilder(false), env({ AGENT_HOME_ROOT: agentHomeRoot }));
    const onMilestone = vi.fn();

    await mgr.attach({ sandbox: sandbox(), orgId: 'org1', jobId: 'job1', onMilestone } as SandboxAttachInput);

    expect(createContainer).not.toHaveBeenCalled();
    expect(onMilestone).not.toHaveBeenCalled();
  });

  it('fires onMilestone("image_build") when the builder signals a real rebuild', async () => {
    const { engine } = fullFakeEngine(null);
    const mgr = new SandboxManager(engine, fakeBuilder(true), env({ AGENT_HOME_ROOT: agentHomeRoot }));
    const onMilestone = vi.fn();

    await mgr.attach({ sandbox: sandbox(), orgId: 'org1', jobId: 'job1', onMilestone } as SandboxAttachInput);

    expect(onMilestone).toHaveBeenCalledWith('image_build');
  });

  it('never throws when onMilestone is omitted (optional, backward-compatible)', async () => {
    const { engine } = fullFakeEngine(null);
    const mgr = new SandboxManager(engine, fakeBuilder(true), env({ AGENT_HOME_ROOT: agentHomeRoot }));

    await expect(
      mgr.attach({ sandbox: sandbox(), orgId: 'org1', jobId: 'job1' } as SandboxAttachInput),
    ).resolves.toBeDefined();
  });
});
