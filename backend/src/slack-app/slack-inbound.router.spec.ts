import { SlackInboundRouter } from './slack-inbound.router';
import type {
  SlackInbound,
  SlackInboundInterceptor,
} from './slack-inbound.types';

const eventItem = (event: Record<string, unknown>): SlackInbound => ({
  kind: 'event',
  body: { team_id: 'T1', event: event as never },
  respond: vi.fn(async () => {}),
});

const interactivityItem = (): SlackInbound => ({
  kind: 'interactivity',
  payload: { type: 'block_actions' },
  respond: vi.fn(async () => {}),
});

function makeRouter(
  interceptor?: SlackInboundInterceptor,
  approvals?: SlackInboundInterceptor,
) {
  const surface = { handleMessageEvent: vi.fn(async () => {}) };
  const presence = { observe: vi.fn(async () => {}) };
  const router = new SlackInboundRouter(
    surface as never,
    presence as never,
    interceptor,
    approvals,
  );
  return { router, surface, presence };
}

describe('SlackInboundRouter', () => {
  it('routes message events to the surface when no interceptor is bound', async () => {
    const { router, surface } = makeRouter();
    await router.route(eventItem({ type: 'message', text: 'hi' }));
    expect(surface.handleMessageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', text: 'hi' }),
      'T1',
    );
  });

  it('gives the interceptor first refusal — consumed items never reach the surface', async () => {
    const interceptor = { maybeHandle: vi.fn(async () => true) };
    const { router, surface } = makeRouter(interceptor);
    await router.route(eventItem({ type: 'message', text: 'setup talk' }));
    expect(interceptor.maybeHandle).toHaveBeenCalled();
    expect(surface.handleMessageEvent).not.toHaveBeenCalled();
  });

  it('falls through to the surface when the interceptor declines', async () => {
    const order: string[] = [];
    const interceptor = {
      maybeHandle: vi.fn(async () => {
        order.push('interceptor');
        return false;
      }),
    };
    const { router, surface } = makeRouter(interceptor);
    surface.handleMessageEvent.mockImplementation(async () => {
      order.push('surface');
    });
    await router.route(eventItem({ type: 'message' }));
    expect(order).toEqual(['interceptor', 'surface']); // explicit ordering, no races
  });

  it('drops non-message events and unconsumed interactivity without touching the surface', async () => {
    const { router, surface } = makeRouter();
    await router.route(eventItem({ type: 'member_joined_channel' }));
    await router.route(interactivityItem());
    expect(surface.handleMessageEvent).not.toHaveBeenCalled();
  });

  it('lead presence observes every event — even ones the interceptor consumes — and a rejected observe never breaks routing', async () => {
    const interceptor = { maybeHandle: vi.fn(async () => true) };
    const { router, presence } = makeRouter(interceptor);
    presence.observe.mockImplementation(async () => {
      throw new Error('presence boom');
    });
    await router.route(
      eventItem({ type: 'member_joined_channel', user: 'U1' }),
    );
    expect(presence.observe).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'member_joined_channel' }),
      'T1',
    );
    expect(interceptor.maybeHandle).toHaveBeenCalled(); // routing proceeded regardless
  });

  it('tries the approval interceptor AFTER Jarvis: Jarvis-false → approval handles; approval-true consumes', async () => {
    const order: string[] = [];
    const jarvis = {
      maybeHandle: vi.fn(async () => {
        order.push('jarvis');
        return false;
      }),
    };
    const approvals = {
      maybeHandle: vi.fn(async () => {
        order.push('approvals');
        return true;
      }),
    };
    const { router, surface } = makeRouter(jarvis, approvals);
    await router.route(eventItem({ type: 'message', text: 'hi' }));
    expect(order).toEqual(['jarvis', 'approvals']);
    expect(surface.handleMessageEvent).not.toHaveBeenCalled();
  });

  it('a Jarvis-consumed item never reaches the approval interceptor', async () => {
    const jarvis = { maybeHandle: vi.fn(async () => true) };
    const approvals = { maybeHandle: vi.fn(async () => true) };
    const { router } = makeRouter(jarvis, approvals);
    await router.route(interactivityItem());
    expect(approvals.maybeHandle).not.toHaveBeenCalled();
  });

  it('contains handler errors (a poison item must not take down the transport)', async () => {
    const interceptor = {
      maybeHandle: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const { router } = makeRouter(interceptor);
    await expect(
      router.route(eventItem({ type: 'message' })),
    ).resolves.toBeUndefined();
  });
});
