import type { EnvService } from '@core/config/env/env.service';
import { describe, expect, it, vi } from 'vitest';
import type {
  ContainerEngine,
  ContainerInfo,
  NetworkInfo,
  VolumeInfo,
} from './container-engine.port';
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
