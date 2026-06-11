import { SlackSocketTransport } from './slack-socket-transport';

type Handler = (envelope: unknown) => void;

function makeTransport() {
  const handlers = new Map<string, Handler>();
  const socket = {
    on: vi.fn((event: string, h: Handler) => handlers.set(event, h)),
    start: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
  const directory = {
    bootIdentity: vi.fn(async () => ({ botName: 'teambot' })),
  };
  const router = {
    route: vi.fn(async (_item: { respond: (b?: unknown) => Promise<void> }) => {}),
  };
  const transport = new SlackSocketTransport(
    socket as never,
    directory as never,
    router as never,
  );
  const inject = async (envelope: Record<string, unknown>) => {
    const handler = handlers.get('slack_event');
    if (!handler) throw new Error('connect() not called');
    handler(envelope);
    // handleEnvelope is fire-and-forget from the socket listener — let it settle.
    await new Promise((r) => setTimeout(r, 0));
  };
  return { transport, socket, directory, router, inject };
}

describe('SlackSocketTransport', () => {
  it('connects: resolves self identity, subscribes slack_event, starts the socket', async () => {
    const { transport, socket, directory } = makeTransport();
    const { botName } = await transport.connect();
    expect(botName).toBe('teambot');
    expect(directory.bootIdentity).toHaveBeenCalled();
    expect(socket.on).toHaveBeenCalledWith('slack_event', expect.any(Function));
    expect(socket.start).toHaveBeenCalled();
  });

  it('acks events BEFORE routing them (Slack redelivers unacked envelopes)', async () => {
    const { transport, router, inject } = makeTransport();
    await transport.connect();
    const order: string[] = [];
    const ack = vi.fn(async () => {
      order.push('ack');
    });
    router.route.mockImplementation(async () => {
      order.push('route');
    });

    await inject({ type: 'events_api', body: { event: { type: 'message' } }, ack });
    expect(order).toEqual(['ack', 'route']);
    expect(router.route).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'event', body: { event: { type: 'message' } } }),
    );
  });

  it('lets interactivity handlers respond with a payload; the post-route ack is a no-op', async () => {
    const { transport, router, inject } = makeTransport();
    await transport.connect();
    const ack = vi.fn(async () => {});
    router.route.mockImplementation(async (item: { respond: (b?: unknown) => Promise<void> }) => {
      await item.respond({ response_action: 'errors', errors: { key: 'bad' } });
    });

    await inject({ type: 'interactive', body: { type: 'view_submission' }, ack });
    expect(ack).toHaveBeenCalledTimes(1); // handler's payload won; safety net no-oped
    expect(ack).toHaveBeenCalledWith({ response_action: 'errors', errors: { key: 'bad' } });
  });

  it('acks unconsumed interactivity after routing (the safety net)', async () => {
    const { transport, router, inject } = makeTransport();
    await transport.connect();
    const ack = vi.fn(async () => {});
    router.route.mockImplementation(async () => {}); // nobody responds

    await inject({ type: 'interactive', body: { type: 'block_actions' }, ack });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(undefined);
  });

  it('ignores non-events/interactive envelopes (hello, slash_commands, …)', async () => {
    const { transport, router, inject } = makeTransport();
    await transport.connect();
    const ack = vi.fn(async () => {});
    await inject({ type: 'hello', body: {}, ack });
    expect(router.route).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it('survives ack failures (logged, not thrown — the envelope just redelivers)', async () => {
    const { transport, router, inject } = makeTransport();
    await transport.connect();
    const ack = vi.fn(async () => {
      throw new Error('socket closed');
    });
    await inject({ type: 'events_api', body: { event: { type: 'message' } }, ack });
    expect(router.route).toHaveBeenCalled(); // routing proceeded despite the failed ack
  });
});
