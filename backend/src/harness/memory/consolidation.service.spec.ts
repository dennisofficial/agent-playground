import { EnvService } from '@core/config/env/env.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Identity } from '../domain/identity';
import type { EmployeeDefinition } from '../employees/employee.types';
import { ConsolidationService } from './consolidation.service';
import type { ReconcileService } from './reconcile.service';

const BOT = {
  id: 'alex',
  name: 'Alex',
  role: 'engineer',
} as EmployeeDefinition;
const ID = (surface = 'room1'): Identity => ({
  selfAgent: 'alex',
  team: 'local',
  project: 'local',
  participants: ['dennis'],
  speaker: 'dennis',
  surface,
  isChannel: true,
});

const DEBOUNCE = 1000;

const makeEnv = (enabled: boolean): EnvService =>
  ({
    get: (k: string) =>
      k === 'MEMORY_CONSOLIDATION_ENABLED'
        ? enabled
        : k === 'MEMORY_CONSOLIDATION_DEBOUNCE_MS'
          ? DEBOUNCE
          : undefined,
  }) as unknown as EnvService;

describe('ConsolidationService', () => {
  let calls: Array<{ transcript: string; surface: string }>;
  let reconcile: ReconcileService;

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    reconcile = {
      consolidateMemory: vi.fn(
        (_bot: EmployeeDefinition, transcript: string, id: Identity) => {
          calls.push({ transcript, surface: id.surface });
          return Promise.resolve();
        },
      ),
    } as unknown as ReconcileService;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when disabled', async () => {
    const svc = new ConsolidationService(reconcile, makeEnv(false));
    svc.schedule(BOT, ID(), 'dennis: we use postgres');
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    expect(calls).toHaveLength(0);
  });

  it('runs one consolidation after the debounce when enabled', async () => {
    const svc = new ConsolidationService(reconcile, makeEnv(true));
    svc.schedule(BOT, ID(), 'dennis: we use postgres');
    expect(calls).toHaveLength(0); // not yet — debounced
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(calls).toHaveLength(1);
    expect(calls[0].transcript).toBe('dennis: we use postgres');
  });

  it('coalesces a burst into a single pass with the latest transcript', async () => {
    const svc = new ConsolidationService(reconcile, makeEnv(true));
    svc.schedule(BOT, ID(), 'first');
    await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
    svc.schedule(BOT, ID(), 'second');
    await vi.advanceTimersByTimeAsync(DEBOUNCE / 2); // first timer would have fired here if not reset
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
    expect(calls).toHaveLength(1);
    expect(calls[0].transcript).toBe('second');
  });

  it('keeps separate rooms independent', async () => {
    const svc = new ConsolidationService(reconcile, makeEnv(true));
    svc.schedule(BOT, ID('room1'), 'a');
    svc.schedule(BOT, ID('room2'), 'b');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(calls.map((c) => c.surface).sort()).toEqual(['room1', 'room2']);
  });

  it('onModuleDestroy cancels pending consolidations', async () => {
    const svc = new ConsolidationService(reconcile, makeEnv(true));
    svc.schedule(BOT, ID(), 'pending');
    svc.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    expect(calls).toHaveLength(0);
  });

  it('flushAll runs armed consolidations immediately', async () => {
    const svc = new ConsolidationService(reconcile, makeEnv(true));
    svc.schedule(BOT, ID(), 'now');
    await svc.flushAll();
    expect(calls).toHaveLength(1);
    expect(calls[0].transcript).toBe('now');
  });
});
