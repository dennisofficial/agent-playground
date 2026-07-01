import { describe, expect, it, vi } from 'vitest';
import { TurnWatchdogService } from './turn-watchdog.service';
import type { TurnRegistry } from './turn-registry.service';
import type { LeaderElectionService } from '../cluster';
import type { EnvService } from '@core/config/env/env.service';
import type { ActiveTurnEntity } from '../persistence/entities';

const env = (vals: Record<string, unknown> = {}) =>
  ({ get: (k: string) => vals[k] }) as unknown as EnvService;
const election = {} as unknown as LeaderElectionService;

describe('TurnWatchdogService.sweep', () => {
  it('finalizes every stale turn as failed', async () => {
    const registry = {
      findStale: vi.fn(async () => [
        { turn_id: 't1', job_id: 'th1' },
        { turn_id: 't2', job_id: 'th2' },
      ] as ActiveTurnEntity[]),
      finalize: vi.fn(async () => undefined),
    } as unknown as TurnRegistry & { findStale: ReturnType<typeof vi.fn>; finalize: ReturnType<typeof vi.fn> };

    await new TurnWatchdogService(registry, election, env({ TURN_STALE_MS: 5000 })).sweep();

    expect(registry.findStale).toHaveBeenCalledWith(5000);
    expect(registry.finalize).toHaveBeenCalledTimes(2);
    expect(registry.finalize).toHaveBeenCalledWith('t1', 'failed');
    expect(registry.finalize).toHaveBeenCalledWith('t2', 'failed');
  });

  it('uses the default stale window when TURN_STALE_MS is unset, and no-ops on an empty sweep', async () => {
    const registry = {
      findStale: vi.fn(async () => [] as ActiveTurnEntity[]),
      finalize: vi.fn(async () => undefined),
    } as unknown as TurnRegistry & { findStale: ReturnType<typeof vi.fn>; finalize: ReturnType<typeof vi.fn> };

    await new TurnWatchdogService(registry, election, env()).sweep();

    expect(registry.findStale).toHaveBeenCalledWith(90_000); // default
    expect(registry.finalize).not.toHaveBeenCalled();
  });

  it('a findStale failure is swallowed (the sweep retries next tick, never throws)', async () => {
    const registry = {
      findStale: vi.fn(async () => {
        throw new Error('db down');
      }),
      finalize: vi.fn(async () => undefined),
    } as unknown as TurnRegistry & { findStale: ReturnType<typeof vi.fn>; finalize: ReturnType<typeof vi.fn> };

    await expect(
      new TurnWatchdogService(registry, election, env()).sweep(),
    ).resolves.toBeUndefined();
    expect(registry.finalize).not.toHaveBeenCalled();
  });
});
