import * as os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerEngine } from '../sandbox/container-engine.port';
import { HostStatsService } from './host-stats.service';

/**
 * Integration test (D-crux): proves `collect()` reports real, plausible numbers for the actual host
 * this test runs on, not just that the plumbing type-checks. Binds a fake `CONTAINER_ENGINE` since the
 * container counts/df aren't the point here.
 */
function fakeEngine(overrides: Partial<ContainerEngine> = {}): ContainerEngine {
  return {
    ensureNetwork: vi.fn(),
    connectNetwork: vi.fn(),
    disconnectNetwork: vi.fn(),
    imageExists: vi.fn(),
    imageId: vi.fn(),
    imageLabels: vi.fn(),
    buildImage: vi.fn(),
    createContainer: vi.fn(),
    start: vi.fn(),
    exec: vi.fn(),
    execDetached: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
    removeNetwork: vi.fn(),
    removeVolume: vi.fn(),
    list: vi.fn(() => Promise.resolve([])),
    inspect: vi.fn(),
    listNetworks: vi.fn(),
    listVolumes: vi.fn(),
    ...overrides,
  };
}

describe('HostStatsService (integration, real host numbers)', () => {
  it('collects a plausible snapshot of the actual host', async () => {
    const service = new HostStatsService(fakeEngine());
    const snapshot = await service.collect();

    const totalMem = os.totalmem();
    expect(
      Math.abs(snapshot.memory.totalBytes - totalMem) / totalMem,
    ).toBeLessThan(0.01);

    expect(snapshot.cpu.usagePct).toBeGreaterThanOrEqual(0);
    expect(snapshot.cpu.usagePct).toBeLessThanOrEqual(100);
    expect(snapshot.cpu.cores).toBe(os.cpus().length);

    expect(snapshot.disk.usagePct).toBeGreaterThanOrEqual(0);
    expect(snapshot.disk.usagePct).toBeLessThanOrEqual(100);
    expect(snapshot.disk.totalBytes).toBeGreaterThan(0);

    expect(snapshot.containers.total).toBeGreaterThanOrEqual(0);
    expect(snapshot.containers.running).toBeGreaterThanOrEqual(0);

    expect(snapshot.dockerDisk).toBeNull();

    expect(Number.isNaN(Date.parse(snapshot.sampledAt))).toBe(false);
  }, 10_000);

  it('coalesces concurrent cold-cache collection', async () => {
    const list = vi.fn(() => Promise.resolve([]));
    const systemDf = vi.fn(() =>
      Promise.resolve({
        imagesBytes: 1,
        containersBytes: 2,
        volumesBytes: 3,
        buildCacheBytes: 4,
        totalBytes: 10,
      }),
    );
    const service = new HostStatsService(fakeEngine({ list, systemDf }));

    const [first, second] = await Promise.all([
      service.collect(),
      service.collect(),
    ]);

    expect(first).toBe(second);
    expect(list).toHaveBeenCalledTimes(1);
    expect(systemDf).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('scopes the container count to Atlas-managed sandboxes via the label filter', async () => {
    const list = vi.fn(() => Promise.resolve([]));
    const service = new HostStatsService(fakeEngine({ list }));

    await service.collect();

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ all: true, label: 'atlas.managed=1' }),
    );
  }, 10_000);
});
