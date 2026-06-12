import { SlackDirectoryService, slugify } from './slack-directory.service';

function makeService(overrides?: { existingRoom?: boolean }) {
  const web = {
    users: {
      info: vi.fn(async ({ user }: { user: string }) => ({
        user: {
          profile: { display_name: 'Dennis', real_name: 'Dennis L' },
          name: user,
        },
      })),
      list: vi.fn(() =>
        Promise.resolve({
          members: [] as object[],
          response_metadata: { next_cursor: '' },
        }),
      ),
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
    list: vi.fn(() => [
      { id: 'alex', name: 'Alex' },
      { id: 'sam', name: 'Sam' },
    ]),
    byId: vi.fn(() => undefined as { id: string; name: string } | undefined),
  };
  const identities = {
    slackUserIdFor: vi.fn(
      (): Promise<string | undefined> => Promise.resolve(undefined),
    ),
  };
  // The per-team ears client provider — returns the workspace's WebClient (the `web` mock here).
  const clients = {
    clientFor: vi.fn(() => Promise.resolve(web)),
    selfUserIdFor: vi.fn(async () => 'UBOT'),
  };
  const service = new SlackDirectoryService(
    clients as never,
    registry as never,
    employees as never,
    identities as never,
  );
  return { service, web, registry, employees, identities };
}

describe('SlackDirectoryService.resolveUser', () => {
  it('calls users.info once and serves repeats from cache', async () => {
    const { service, web } = makeService();
    const first = await service.resolveUser('T1', 'U123');
    const second = await service.resolveUser('T1', 'U123');
    expect(first).toEqual({ authorId: 'dennis', authorName: 'Dennis' });
    expect(second).toBe(first);
    expect(web.users.info).toHaveBeenCalledTimes(1);
    expect(service.displayNameOf('T1', 'U123')).toBe('Dennis');
  });

  it('falls back to the raw id when the lookup fails', async () => {
    const { service, web } = makeService();
    web.users.info.mockRejectedValueOnce(new Error('ratelimited'));
    expect(await service.resolveUser('T1', 'U999')).toEqual({
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

describe('SlackDirectoryService.resolveMention', () => {
  it('resolves a roster bot by id (case-insensitive via slug)', async () => {
    const { service, identities, employees } = makeService();
    employees.byId.mockReturnValue({ id: 'alex', name: 'Alex' });
    // Persistent mock (not Once) so both 'alex' and 'Alex' calls hit a resolved value.
    identities.slackUserIdFor.mockResolvedValue('UALEX');
    expect(await service.resolveMention('T1', 'alex')).toBe('UALEX');
    expect(await service.resolveMention('T1', 'Alex')).toBe('UALEX');
  });

  it('resolves a roster bot by display-name slug when byId misses', async () => {
    const { service, identities, employees } = makeService();
    employees.byId.mockReturnValue(undefined);
    // list() returns [{ id: 'alex', name: 'Alex' }, { id: 'sam', name: 'Sam' }]
    identities.slackUserIdFor.mockResolvedValueOnce('USAM');
    expect(await service.resolveMention('T1', 'Sam')).toBe('USAM');
  });

  it('resolves a human from the reverse index populated by resolveUser', async () => {
    const { service } = makeService();
    // Simulate an inbound event that caches the user.
    await service.resolveUser('T1', 'U123'); // populates handleIndex: T1|dennis → U123
    expect(await service.resolveMention('T1', 'Dennis')).toBe('U123');
    expect(await service.resolveMention('T1', 'dennis')).toBe('U123');
  });

  it('falls back to users.list sync and finds the handle in the loaded directory', async () => {
    const { service, web } = makeService();
    web.users.list.mockResolvedValueOnce({
      members: [
        {
          id: 'U999',
          name: 'jdoe',
          deleted: false,
          is_bot: false,
          profile: { display_name: 'Jane Doe', real_name: 'Jane Doe' },
        },
      ],
      response_metadata: { next_cursor: '' },
    });
    expect(await service.resolveMention('T1', 'Jane')).toBeUndefined(); // slug 'jane-doe' ≠ 'jane'
    expect(await service.resolveMention('T1', 'jane-doe')).toBe('U999');
  });

  it('returns undefined for a completely unknown handle (graceful degradation)', async () => {
    const { service } = makeService();
    expect(await service.resolveMention('T1', 'nobody')).toBeUndefined();
  });

  it('deduplicates the users.list call when ensureDirectoryLoaded is hit concurrently', async () => {
    const { service, web } = makeService();
    // Trigger two concurrent resolveMention calls that both miss the cache.
    await Promise.all([
      service.resolveMention('T1', 'ghost1'),
      service.resolveMention('T1', 'ghost2'),
    ]);
    // users.list should be called only once despite the concurrent callers.
    expect(web.users.list).toHaveBeenCalledTimes(1);
  });
});

describe('SlackDirectoryService reverse-index population', () => {
  it('populates the handle index when resolveUser is called', async () => {
    const { service } = makeService();
    await service.resolveUser('T1', 'U123'); // display_name = 'Dennis' → slug 'dennis'
    // Now resolveMention should hit the cached index without a users.list call.
    expect(await service.resolveMention('T1', 'dennis')).toBe('U123');
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
