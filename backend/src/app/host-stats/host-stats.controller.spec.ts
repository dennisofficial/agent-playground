import { describe, expect, it, vi } from 'vitest';
import type { HostStatsSampleRepository } from './host-stats-sample.repository';
import { HostStatsController } from './host-stats.controller';
import type { HostStatsService } from './host-stats.service';
import type { HostStatsHistoryPoint } from './host-stats.types';

function controllerWithHistory(history: (hours: number) => Promise<HostStatsHistoryPoint[]>) {
  return new HostStatsController(
    {} as HostStatsService,
    { history } as unknown as HostStatsSampleRepository,
  );
}

describe('HostStatsController', () => {
  it('defaults history to 24h when the query value is absent or invalid', async () => {
    const history = vi.fn(() => Promise.resolve([]));
    const controller = controllerWithHistory(history);

    await controller.history();
    await controller.history('not-a-number');

    expect(history).toHaveBeenNthCalledWith(1, 24);
    expect(history).toHaveBeenNthCalledWith(2, 24);
  });

  it('clamps history hours into the supported 1..48h window', async () => {
    const history = vi.fn(() => Promise.resolve([]));
    const controller = controllerWithHistory(history);

    await controller.history('0');
    await controller.history('-2');
    await controller.history('72');

    expect(history).toHaveBeenNthCalledWith(1, 1);
    expect(history).toHaveBeenNthCalledWith(2, 1);
    expect(history).toHaveBeenNthCalledWith(3, 48);
  });
});
