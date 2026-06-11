import { SlackEventsController } from './slack-events.controller';

function makeController() {
  const forwarder = { forwardEvent: vi.fn(async () => {}) };
  const tenants = { setStatus: vi.fn(async () => {}) };
  const controller = new SlackEventsController(forwarder as never, tenants as never);
  return { controller, forwarder, tenants };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('SlackEventsController', () => {
  it('answers the url_verification handshake with the challenge', () => {
    const { controller, forwarder } = makeController();
    expect(controller.receive({ type: 'url_verification', challenge: 'c0ffee' })).toEqual({
      challenge: 'c0ffee',
    });
    expect(forwarder.forwardEvent).not.toHaveBeenCalled();
  });

  it('returns 200 immediately and forwards event_callbacks by team_id async', async () => {
    const { controller, forwarder } = makeController();
    const body = { type: 'event_callback', team_id: 'T1', event: { type: 'message' } };
    expect(controller.receive(body)).toEqual({}); // ack before any forwarding work
    await settle();
    expect(forwarder.forwardEvent).toHaveBeenCalledWith('T1', body);
  });

  it('suspends the tenant on app_uninstalled / tokens_revoked instead of forwarding', async () => {
    const { controller, forwarder, tenants } = makeController();
    controller.receive({ type: 'event_callback', team_id: 'T1', event: { type: 'app_uninstalled' } });
    controller.receive({ type: 'event_callback', team_id: 'T2', event: { type: 'tokens_revoked' } });
    await settle();
    expect(tenants.setStatus).toHaveBeenCalledWith('T1', 'suspended');
    expect(tenants.setStatus).toHaveBeenCalledWith('T2', 'suspended');
    expect(forwarder.forwardEvent).not.toHaveBeenCalled();
  });

  it('ignores bodies without a team_id', async () => {
    const { controller, forwarder } = makeController();
    expect(controller.receive({ type: 'event_callback' })).toEqual({});
    await settle();
    expect(forwarder.forwardEvent).not.toHaveBeenCalled();
  });
});
