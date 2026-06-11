import type { EnvService } from '@core/config/env/env.service';
import type { ExecutionContext } from '@nestjs/common';
import {
  GatewaySecretGuard,
  SlackInboundController,
} from './slack-inbound.controller';
import type { SlackInbound } from './slack-inbound.types';

function makeController() {
  const router = {
    route: vi.fn(async (_item: SlackInbound) => {}),
  };
  const controller = new SlackInboundController(router as never);
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
    },
  };
  return { controller, router, res };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('SlackInboundController', () => {
  it('answers events immediately and routes them async', async () => {
    const { controller, router, res } = makeController();
    controller.receive(
      { kind: 'event', teamId: 'T1', body: { event: { type: 'message' } } },
      res,
    );
    expect(res.statusCode).toBe(200); // answered before routing settles
    await settle();
    expect(router.route).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'event', body: { event: { type: 'message' } } }),
    );
  });

  it("relays the handler's interactivity response body (modal validation errors round-trip)", async () => {
    const { controller, router, res } = makeController();
    router.route.mockImplementation(async (item: SlackInbound) => {
      await item.respond({ response_action: 'errors', errors: { k: 'bad' } });
    });
    controller.receive(
      { kind: 'interactivity', teamId: 'T1', payload: { type: 'view_submission' } },
      res,
    );
    await settle();
    expect(res.body).toEqual({ response_action: 'errors', errors: { k: 'bad' } });
  });

  it('answers unconsumed interactivity with an empty 200 (the safety net, exactly once)', async () => {
    const { controller, router, res } = makeController();
    router.route.mockImplementation(async () => {});
    controller.receive(
      { kind: 'interactivity', teamId: 'T1', payload: { type: 'block_actions' } },
      res,
    );
    await settle();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({});
  });

  it('shrugs at malformed forwards', async () => {
    const { controller, router, res } = makeController();
    controller.receive({}, res);
    await settle();
    expect(router.route).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});

describe('GatewaySecretGuard', () => {
  const contextFor = (authorization?: string): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }),
    }) as unknown as ExecutionContext;

  const guard = (secret?: string) =>
    new GatewaySecretGuard({
      get: (k: string) => (k === 'GATEWAY_SHARED_SECRET' ? secret : undefined),
    } as unknown as EnvService);

  it('passes the right bearer, rejects wrong/missing ones', () => {
    expect(guard('shh').canActivate(contextFor('Bearer shh'))).toBe(true);
    expect(() => guard('shh').canActivate(contextFor('Bearer wrong'))).toThrow(/Bad gateway/);
    expect(() => guard('shh').canActivate(contextFor(undefined))).toThrow(/Bad gateway/);
    expect(() => guard(undefined).canActivate(contextFor('Bearer shh'))).toThrow(
      /not configured/,
    );
  });
});
