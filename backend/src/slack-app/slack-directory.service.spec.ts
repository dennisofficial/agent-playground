import { SlackDirectoryService, slugify } from './slack-directory.service';

function makeService(overrides?: { existingRoom?: boolean }) {
  const web = {
    users: {
      info: vi.fn(async ({ user }: { user: string }) => ({
        user: { profile: { display_name: 'Dennis', real_name: 'Dennis L' }, name: user },
      })),
    },
    conversations: {
      info: vi.fn(async () => ({ channel: { name: 'mls-studio' } })),
    },
  };
  const registry = {
    get: vi.fn(() =>
      overrides?.existingRoom ? { channelId: 'slack:C042' } : undefined,
    ),
    ensure: vi.fn(),
  };
  const employees = {
    list: vi.fn(() => [{ id: 'alex' }, { id: 'sam' }]),
  };
  const service = new SlackDirectoryService(
    web as never,
    registry as never,
    employees as never,
  );
  return { service, web, registry, employees };
}

describe('SlackDirectoryService.resolveUser', () => {
  it('calls users.info once and serves repeats from cache', async () => {
    const { service, web } = makeService();
    const first = await service.resolveUser('U123');
    const second = await service.resolveUser('U123');
    expect(first).toEqual({ authorId: 'dennis', authorName: 'Dennis' });
    expect(second).toBe(first);
    expect(web.users.info).toHaveBeenCalledTimes(1);
    expect(service.displayNameOf('U123')).toBe('Dennis');
  });

  it('falls back to the raw id when the lookup fails', async () => {
    const { service, web } = makeService();
    web.users.info.mockRejectedValueOnce(new Error('ratelimited'));
    expect(await service.resolveUser('U999')).toEqual({
      authorId: 'u999',
      authorName: 'U999',
    });
  });
});

describe('SlackDirectoryService.ensureChannelRegistered', () => {
  it('registers the room with the channel-name slug as project and roster + author as members', async () => {
    const { service, registry } = makeService();
    await service.ensureChannelRegistered('C042', 'T1', 'dennis');
    expect(registry.ensure).toHaveBeenCalledWith({
      channelId: 'slack:T1:C042',
      teamId: 'T1',
      kind: 'channel',
      project: 'mls-studio',
      members: ['alex', 'sam', 'dennis'],
      displayName: '#mls-studio',
    });
  });

  it('is a no-op for already-known rooms (first-write-wins respected) and caches the check', async () => {
    const { service, web, registry } = makeService({ existingRoom: true });
    await service.ensureChannelRegistered('C042', 'T1', 'dennis');
    await service.ensureChannelRegistered('C042', 'T1', 'dennis');
    expect(registry.ensure).not.toHaveBeenCalled();
    expect(web.conversations.info).not.toHaveBeenCalled();
    expect(registry.get).toHaveBeenCalledTimes(1); // second call short-circuits on the local cache
  });
});

describe('slugify', () => {
  it('lowercases and collapses non-slug characters', () => {
    expect(slugify('MLS Studio!')).toBe('mls-studio');
    expect(slugify('dev')).toBe('dev');
    expect(slugify('a.b_c-d')).toBe('a.b_c-d');
    expect(slugify('')).toBe('unknown');
  });
});
