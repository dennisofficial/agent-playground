import type { Channel } from '@workspace/shared/schemas';
import type { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { ChannelRegistryService } from './channel-registry.service';

function makeRegistry() {
  const upsert = vi.fn(async () => undefined);
  const repo = {
    find: vi.fn(async () => []),
    upsert,
  } as unknown as Repository<Channel>;
  return { registry: new ChannelRegistryService(repo), upsert };
}

const ROOM = {
  channelId: 'slack:T1:C1',
  teamId: 'T1',
  kind: 'channel' as const,
  project: 'ai-crew-local-testing',
  members: ['atlas'],
  displayName: '#ai-crew-local-testing',
};

describe('ChannelRegistryService.setProject', () => {
  it('repoints a known room and persists the new project', async () => {
    const { registry, upsert } = makeRegistry();
    registry.ensure(ROOM);
    await registry.flush();
    upsert.mockClear();

    registry.setProject('slack:T1:C1', 'cubix-infra');
    await registry.flush();

    expect(registry.projectOf('slack:T1:C1')).toBe('cubix-infra');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'slack:T1:C1',
        project: 'cubix-infra',
      }),
      ['channel_id'],
    );
  });

  it('no-ops on an unknown room', async () => {
    const { registry, upsert } = makeRegistry();
    upsert.mockClear();
    registry.setProject('slack:T1:CX', 'cubix-infra');
    await registry.flush();
    // unknown room → projectOf falls back to DEFAULT_PROJECT
    expect(registry.projectOf('slack:T1:CX')).toBe('local');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('no-ops when already on the target project', async () => {
    const { registry, upsert } = makeRegistry();
    registry.ensure({ ...ROOM, project: 'cubix-infra' });
    await registry.flush();
    upsert.mockClear();
    registry.setProject('slack:T1:C1', 'cubix-infra');
    await registry.flush();
    expect(upsert).not.toHaveBeenCalled();
  });
});
