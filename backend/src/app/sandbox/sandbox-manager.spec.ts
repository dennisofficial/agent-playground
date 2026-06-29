import type { EnvService } from '@core/config/env/env.service';
import { describe, expect, it, vi } from 'vitest';
import type {
  ContainerEngine,
  ContainerInfo,
  NetworkInfo,
  VolumeInfo,
} from './container-engine.port';
import type { FeatureSandbox } from '../git';
import { SandboxImageBuilder } from './sandbox-image.builder';
import { SandboxManager } from './sandbox-manager.service';

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
    imageExists: vi.fn(),
    imageId: vi.fn(),
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
  // The deterministic name `attach` derives for a thread-keyed sandbox (keyed by threadId alone — the
  // globally-unique PK): `atlas-sbx-thread-<id>`. Terminal cleanup must resolve this WITHOUT a container_id,
  // because a boot reconcile nulls the persisted id while the real container keeps running.
  const NAME = 'atlas-sbx-thread-abc';
  const sandbox = (): FeatureSandbox => ({
    repoId: 'proj',
    branch: 'atlas/thread-abc', // ignored for thread-keyed names; proves the name is keyed by threadId
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
      imageExists: vi.fn(),
      imageId: vi.fn(),
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

    await manager(engine).teardownByIdentity({ sandbox: sandbox(), orgId: 'team', threadId: 'abc' });

    expect(removedContainers).toEqual(['cid-1']);
    expect(removedNetworks).toEqual([`${NAME}-net`]);
    expect(removedVolumes).toEqual([`${NAME}-dind`]);
  });

  it('still reclaims leaked net/vol by name when the container is already gone', async () => {
    const { engine, removedContainers, removedNetworks, removedVolumes } = fake({ containerExists: false });

    await manager(engine).teardownByIdentity({ sandbox: sandbox(), orgId: 'team', threadId: 'abc' });

    expect(removedContainers).toEqual([]); // nothing to remove
    expect(removedNetworks).toEqual([`${NAME}-net`]);
    expect(removedVolumes).toEqual([`${NAME}-dind`]);
  });
});
