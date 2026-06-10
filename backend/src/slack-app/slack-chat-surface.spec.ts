import { firstValueFrom } from 'rxjs';
import { SlackChatSurface } from './slack-chat-surface';

type Handler = (envelope: unknown) => void;

function makeFakes() {
  const handlers = new Map<string, Handler>();
  const socket = {
    on: vi.fn((event: string, h: Handler) => handlers.set(event, h)),
    start: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
  const web = {
    auth: { test: vi.fn(async () => ({ user_id: 'UBOT', user: 'teambot' })) },
    chat: {
      postMessage: vi.fn(async () => ({ ok: true, ts: '1712.0001' })),
    },
    reactions: { add: vi.fn(async () => ({ ok: true })) },
  };
  const directory = {
    resolveUser: vi.fn(async (id: string) =>
      id === 'U123'
        ? { authorId: 'dennis', authorName: 'Dennis' }
        : { authorId: id.toLowerCase(), authorName: id },
    ),
    displayNameOf: vi.fn((id: string) => (id === 'U123' ? 'Dennis' : undefined)),
    ensureChannelRegistered: vi.fn(async () => {}),
  };
  const bus = { patchStatus: vi.fn() };
  const surface = new SlackChatSurface(
    web as never,
    socket as never,
    directory as never,
    bus as never,
  );
  const inject = async (event: Record<string, unknown>) => {
    const handler = handlers.get('message');
    if (!handler) throw new Error('connect() not called');
    await handler({ ack: vi.fn(async () => {}), event });
    // handleMessageEvent is fire-and-forget from the socket listener — let it settle.
    await new Promise((r) => setTimeout(r, 0));
  };
  return { surface, web, socket, directory, bus, inject };
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
    await surface.connect();

    await inject(human({ user: 'UBOT' })); // our own chat.postMessage echo
    await inject(human({ bot_id: 'B999' })); // any bot
    await inject(human({ subtype: 'bot_message' }));
    expect(seen).toHaveLength(0);
  });

  it('drops non-plain subtypes and thread replies (v1)', async () => {
    const { surface, inject } = makeFakes();
    const seen: unknown[] = [];
    surface.inbound$.subscribe((m) => seen.push(m));
    await surface.connect();

    await inject(human({ subtype: 'message_changed' }));
    await inject(human({ thread_ts: '1712345678.000001' }));
    expect(seen).toHaveLength(0);
  });

  it('emits a translated message AFTER room registration, with speaker patched', async () => {
    const { surface, directory, bus, inject } = makeFakes();
    await surface.connect();
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
      surfaceId: 'slack:C042',
    });
    expect(directory.ensureChannelRegistered).toHaveBeenCalledWith('C042', 'dennis');
    expect(order).toEqual(['register', 'speaker']);
    expect(bus.patchStatus).toHaveBeenCalledWith({ speaker: 'dennis' });
  });

  it('translates a mention of the app itself into @here', async () => {
    const { surface, inject } = makeFakes();
    await surface.connect();
    const next = firstValueFrom(surface.inbound$);
    await inject(human({ text: '<@UBOT> everyone check in' }));
    expect((await next as { text: string }).text).toBe('@here everyone check in');
  });
});

describe('SlackChatSurface outbound', () => {
  it('posts with the employee username and skips non-slack rooms', async () => {
    const { surface, web } = makeFakes();
    await surface.connect();

    await surface.post({
      id: 'alex:k2:1',
      authorBotId: 'alex',
      authorName: 'Alex',
      text: 'done!',
      surfaceId: 'slack:C042',
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
    await surface.connect();
    await surface.post({
      id: 'alex:k2:1',
      authorBotId: 'alex',
      authorName: 'Alex',
      text: 'done!',
      surfaceId: 'slack:C042',
    });

    await surface.react('alex:k2:1', '👍', { id: 'sam', name: 'Sam' }, 'slack:C042');
    expect(web.reactions.add).toHaveBeenCalledWith({
      channel: 'C042',
      timestamp: '1712.0001', // the ts chat.postMessage returned
      name: 'thumbsup',
    });
  });

  it('react() treats a raw Slack ts as the target directly, and skips unknown minted ids', async () => {
    const { surface, web } = makeFakes();
    await surface.connect();

    await surface.react('1712345678.000100', '✅', { id: 'sam', name: 'Sam' }, 'slack:C042');
    expect(web.reactions.add).toHaveBeenCalledWith({
      channel: 'C042',
      timestamp: '1712345678.000100',
      name: 'white_check_mark',
    });

    web.reactions.add.mockClear();
    await surface.react('alex:pre-restart:9', '👍', { id: 'sam', name: 'Sam' }, 'slack:C042');
    expect(web.reactions.add).not.toHaveBeenCalled();
  });

  it('react() swallows already_reacted (one Slack app reacts for every employee)', async () => {
    const { surface, web } = makeFakes();
    await surface.connect();
    web.reactions.add.mockRejectedValueOnce(
      Object.assign(new Error('An API error occurred'), {
        data: { error: 'already_reacted' },
      }),
    );
    await expect(
      surface.react('1712345678.000100', '👍', { id: 'sam', name: 'Sam' }, 'slack:C042'),
    ).resolves.toBeUndefined();
  });
});
