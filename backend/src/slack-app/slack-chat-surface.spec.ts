import { firstValueFrom } from 'rxjs';
import { SlackChatSurface } from './slack-chat-surface';
import type { SlackInboundEvent } from './slack-inbound.types';

function makePuppet() {
  return {
    chat: { postMessage: vi.fn(async () => ({ ok: true, ts: '1712.0009' })) },
    reactions: { add: vi.fn(async () => ({ ok: true })) },
    conversations: { join: vi.fn(async () => ({ ok: true })) },
  };
}

function makeFakes(
  envValues: Record<string, string | undefined> = {},
  puppets: Record<string, ReturnType<typeof makePuppet>> = {},
) {
  const web = {
    chat: {
      postMessage: vi.fn(async () => ({ ok: true, ts: '1712.0001' })),
    },
    reactions: { add: vi.fn(async () => ({ ok: true })) },
  };
  const directory = {
    selfUserIdFor: vi.fn(async () => 'UBOT'),
    resolveUser: vi.fn(async (_teamId: string, id: string) =>
      id === 'U123'
        ? { authorId: 'dennis', authorName: 'Dennis' }
        : { authorId: id.toLowerCase(), authorName: id },
    ),
    displayNameOf: vi.fn((_teamId: string, id: string) =>
      id === 'U123' ? 'Dennis' : undefined,
    ),
    ensureChannelRegistered: vi.fn(async () => {}),
  };
  const identities = {
    clientFor: vi.fn(async (_teamId: string, botId: string) => puppets[botId]),
  };
  // The per-team ears client provider — returns the workspace's WebClient (the `web` mock).
  const clients = { clientFor: vi.fn(async () => web) };
  const bus = { patchStatus: vi.fn() };
  const env = { get: (k: string) => envValues[k] };
  const surface = new SlackChatSurface(
    clients as never,
    directory as never,
    identities as never,
    bus as never,
    env as never,
  );
  const inject = (event: Record<string, unknown>) =>
    surface.handleMessageEvent(event as SlackInboundEvent, 'T1');
  return { surface, web, directory, identities, bus, inject };
}

const human = (overrides: Record<string, unknown> = {}) => ({
  type: 'message',
  user: 'U123',
  text: 'hello team',
  channel: 'C042',
  ts: '1712345678.000100',
  ...overrides,
});

describe('SlackChatSurface inbound', () => {
  it('drops our own posts and other bot messages (the echo-loop guard)', async () => {
    const { surface, inject } = makeFakes();
    const seen: unknown[] = [];
    surface.inbound$.subscribe((m) => seen.push(m));

    await inject(human({ user: 'UBOT' })); // our own chat.postMessage echo
    await inject(human({ bot_id: 'B999' })); // any bot
    await inject(human({ subtype: 'bot_message' }));
    expect(seen).toHaveLength(0);
  });

  it('drops non-plain subtypes and thread replies (v1)', async () => {
    const { surface, inject } = makeFakes();
    const seen: unknown[] = [];
    surface.inbound$.subscribe((m) => seen.push(m));

    await inject(human({ subtype: 'message_changed' }));
    await inject(human({ thread_ts: '1712345678.000001' }));
    expect(seen).toHaveLength(0);
  });

  it('emits a translated message AFTER room registration, with speaker patched', async () => {
    const { surface, directory, bus, inject } = makeFakes();
    const next = firstValueFrom(surface.inbound$);

    const order: string[] = [];
    directory.ensureChannelRegistered.mockImplementation(async () => {
      order.push('register');
    });
    bus.patchStatus.mockImplementation(() => order.push('speaker'));

    await inject(human({ text: '<@U123> ship it &amp; relax' }));
    const msg = await next;

    expect(msg).toMatchObject({
      id: '1712345678.000100',
      authorId: 'dennis',
      authorName: 'Dennis',
      text: 'Dennis ship it & relax',
      surfaceId: 'slack:T1:C042',
    });
    expect(directory.ensureChannelRegistered).toHaveBeenCalledWith('C042', 'T1', 'dennis');
    expect(order).toEqual(['register', 'speaker']);
    expect(bus.patchStatus).toHaveBeenCalledWith({ speaker: 'dennis' });
  });

  it('translates a mention of the app itself into @here', async () => {
    const { surface, inject } = makeFakes();
    const next = firstValueFrom(surface.inbound$);
    await inject(human({ text: '<@UBOT> everyone check in' }));
    expect(((await next) as { text: string }).text).toBe('@here everyone check in');
  });
});

describe('SlackChatSurface outbound', () => {
  it('posts with the employee username and skips non-slack rooms', async () => {
    const { surface, web } = makeFakes();

    await surface.post({
      id: 'alex:k2:1',
      authorBotId: 'alex',
      authorName: 'Alex',
      text: 'done!',
      surfaceId: 'slack:T1:C042',
    });
    expect(web.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C042',
      text: 'done!',
      username: 'Alex',
    });

    web.chat.postMessage.mockClear();
    await surface.post({
      id: 'alex:k2:2',
      authorBotId: 'alex',
      authorName: 'Alex',
      text: 'dm attempt',
      surfaceId: 'tui:dm:alex:dennis',
    });
    expect(web.chat.postMessage).not.toHaveBeenCalled();
  });

  it('react() resolves harness-minted ids through the posted-id LRU and translates emoji', async () => {
    const { surface, web } = makeFakes();
    await surface.post({
      id: 'alex:k2:1',
      authorBotId: 'alex',
      authorName: 'Alex',
      text: 'done!',
      surfaceId: 'slack:T1:C042',
    });

    await surface.react('alex:k2:1', '👍', { id: 'sam', name: 'Sam' }, 'slack:T1:C042');
    expect(web.reactions.add).toHaveBeenCalledWith({
      channel: 'C042',
      timestamp: '1712.0001', // the ts chat.postMessage returned
      name: 'thumbsup',
    });
  });

  it('react() treats a raw Slack ts as the target directly, and skips unknown minted ids', async () => {
    const { surface, web } = makeFakes();

    await surface.react('1712345678.000100', '✅', { id: 'sam', name: 'Sam' }, 'slack:T1:C042');
    expect(web.reactions.add).toHaveBeenCalledWith({
      channel: 'C042',
      timestamp: '1712345678.000100',
      name: 'white_check_mark',
    });

    web.reactions.add.mockClear();
    await surface.react('alex:pre-restart:9', '👍', { id: 'sam', name: 'Sam' }, 'slack:T1:C042');
    expect(web.reactions.add).not.toHaveBeenCalled();
  });

  it('adds icon_url from AVATAR_BASE_URL + style when configured; none when unset', async () => {
    const { surface, web } = makeFakes({
      AVATAR_BASE_URL: 'https://cdn.example/avatars/',
      AVATAR_STYLE: 'realistic',
    });
    await surface.post({
      id: 'alex:k2:1',
      authorBotId: 'alex',
      authorName: 'Alex',
      text: 'hi',
      surfaceId: 'slack:T1:C042',
    });
    expect(web.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C042',
      text: 'hi',
      username: 'Alex',
      icon_url: 'https://cdn.example/avatars/realistic/alex.png',
    });

    // Default style is illustrated.
    const plain = makeFakes({ AVATAR_BASE_URL: 'https://cdn.example/avatars' });
    await plain.surface.post({
      id: 'sam:k2:1',
      authorBotId: 'sam',
      authorName: 'Sam',
      text: 'yo',
      surfaceId: 'slack:T1:C042',
    });
    expect(plain.web.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        icon_url: 'https://cdn.example/avatars/illustrated/sam.png',
      }),
    );
  });

  it('react() swallows already_reacted (one Slack app reacts for every employee)', async () => {
    const { surface, web } = makeFakes();
    web.reactions.add.mockRejectedValueOnce(
      Object.assign(new Error('An API error occurred'), {
        data: { error: 'already_reacted' },
      }),
    );
    await expect(
      surface.react('1712345678.000100', '👍', { id: 'sam', name: 'Sam' }, 'slack:T1:C042'),
    ).resolves.toBeUndefined();
  });
});

const slackError = (code: string) =>
  Object.assign(new Error('An API error occurred'), { data: { error: code } });

describe('SlackChatSurface puppet identities', () => {
  const msg = {
    id: 'alex:k2:1',
    authorBotId: 'alex',
    authorName: 'Alex',
    text: 'done!',
    surfaceId: 'slack:T1:C042',
  };

  it('posts via the puppet WITHOUT username/icon overrides; main app untouched', async () => {
    const alex = makePuppet();
    const { surface, web } = makeFakes(
      { AVATAR_BASE_URL: 'https://cdn.example/avatars' },
      { alex },
    );
    await surface.post(msg);
    expect(alex.chat.postMessage).toHaveBeenCalledWith({ channel: 'C042', text: 'done!' });
    expect(web.chat.postMessage).not.toHaveBeenCalled();

    // The puppet's ts feeds the posted-id LRU, so reactions still resolve minted ids.
    const sam = makePuppet();
    const both = makeFakes({}, { alex, sam });
    await both.surface.post(msg);
    await both.surface.react('alex:k2:1', '👍', { id: 'sam', name: 'Sam' }, 'slack:T1:C042');
    expect(sam.reactions.add).toHaveBeenCalledWith({
      channel: 'C042',
      timestamp: '1712.0009',
      name: 'thumbsup',
    });
  });

  it('joins the channel and retries once on a membership failure', async () => {
    const alex = makePuppet();
    alex.chat.postMessage
      .mockRejectedValueOnce(slackError('not_in_channel'))
      .mockResolvedValueOnce({ ok: true, ts: '1712.0009' });
    const { surface, web } = makeFakes({}, { alex });
    await surface.post(msg);
    expect(alex.conversations.join).toHaveBeenCalledWith({ channel: 'C042' });
    expect(alex.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(web.chat.postMessage).not.toHaveBeenCalled();
  });

  it('falls back to the main-app identity when the join also fails (private channel)', async () => {
    const alex = makePuppet();
    alex.chat.postMessage.mockRejectedValue(slackError('not_in_channel'));
    alex.conversations.join.mockRejectedValue(slackError('method_not_supported_for_channel_type'));
    const { surface, web } = makeFakes({}, { alex });
    await surface.post(msg);
    expect(web.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C042', text: 'done!', username: 'Alex' }),
    );
  });

  it('reacts via the puppet, handling its method-specific membership code (no_permission)', async () => {
    const sam = makePuppet();
    sam.reactions.add
      .mockRejectedValueOnce(slackError('no_permission'))
      .mockResolvedValueOnce({ ok: true });
    const { surface, web } = makeFakes({}, { sam });
    await surface.react('1712345678.000100', '✅', { id: 'sam', name: 'Sam' }, 'slack:T1:C042');
    expect(sam.conversations.join).toHaveBeenCalledWith({ channel: 'C042' });
    expect(sam.reactions.add).toHaveBeenCalledTimes(2);
    expect(web.reactions.add).not.toHaveBeenCalled();
  });

  it("swallows a puppet's already_reacted without falling back (no double identity)", async () => {
    const sam = makePuppet();
    sam.reactions.add.mockRejectedValue(slackError('already_reacted'));
    const { surface, web } = makeFakes({}, { sam });
    await expect(
      surface.react('1712345678.000100', '👍', { id: 'sam', name: 'Sam' }, 'slack:T1:C042'),
    ).resolves.toBeUndefined();
    expect(web.reactions.add).not.toHaveBeenCalled();
  });
});
