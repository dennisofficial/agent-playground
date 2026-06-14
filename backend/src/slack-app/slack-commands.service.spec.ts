import { EnvService } from '@core/config/env/env.service';
import { ConductorMetricsService } from '@harness/conductor/conductor-metrics.service';
import { MemoryMetricsService } from '@harness/memory/memory-metrics.service';
import { describe, expect, it, vi } from 'vitest';
import { SlackCommandService } from './slack-commands.service';
import type { SlackInbound } from './slack-inbound.types';
import type { TenantStore } from './tenant.store';

const env = (boss?: string): EnvService =>
  ({
    get: (k: string) => (k === 'APPROVAL_BOSS_USER_ID' ? boss : undefined),
  }) as unknown as EnvService;

// No tenant row → boss falls back to APPROVAL_BOSS_USER_ID (the dev path).
const tenants = (): TenantStore =>
  ({ get: () => Promise.resolve(undefined) }) as unknown as TenantStore;

const make = (boss?: string) => {
  const metrics = new MemoryMetricsService();
  return {
    svc: new SlackCommandService(
      metrics,
      new ConductorMetricsService(),
      tenants(),
      env(boss),
    ),
    metrics,
  };
};

const command = (over: Partial<{ command: string; user_id: string }> = {}) => {
  const respond = vi.fn((_body?: unknown) => Promise.resolve());
  const item: SlackInbound = {
    kind: 'command',
    command: {
      command: over.command ?? '/metrics',
      team_id: 'T1',
      user_id: over.user_id ?? 'U_BOSS',
    },
    respond,
  };
  return { item, respond };
};

describe('SlackCommandService', () => {
  it('answers /metrics for the boss with a health summary', async () => {
    const { svc, metrics } = make('U_BOSS');
    metrics.recordRecall(2);
    metrics.recordRecall(0);
    const { item, respond } = command({ user_id: 'U_BOSS' });
    expect(await svc.maybeHandle(item)).toBe(true);
    const reply = respond.mock.calls[0][0] as { text: string };
    expect(reply.text).toContain('Memory health');
    expect(reply.text).toContain('2 attempts');
    expect(reply.text).toContain('50% surfaced'); // 1 of 2 passes had a hit
  });

  it('refuses /metrics from a non-boss', async () => {
    const { svc } = make('U_BOSS');
    const { item, respond } = command({ user_id: 'U_RANDO' });
    expect(await svc.maybeHandle(item)).toBe(true);
    const reply = respond.mock.calls[0][0] as { text: string };
    expect(reply.text).toContain('boss-only');
  });

  it('declines unknown commands and non-command items', async () => {
    const { svc } = make('U_BOSS');
    const other = command({ command: '/deploy' });
    expect(await svc.maybeHandle(other.item)).toBe(false);
    expect(other.respond).not.toHaveBeenCalled();

    const evt: SlackInbound = {
      kind: 'event',
      body: {},
      respond: vi.fn(() => Promise.resolve()),
    };
    expect(await svc.maybeHandle(evt)).toBe(false);
  });
});
