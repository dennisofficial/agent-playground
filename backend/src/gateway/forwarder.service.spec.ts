import type { EnvService } from '@core/config/env/env.service';
import { ForwarderService } from './forwarder.service';
import type { TenantRecord, TenantStore } from './tenants/tenant.store';

function makeForwarder(tenant?: Partial<TenantRecord>) {
  const record: TenantRecord | undefined = tenant
    ? {
        teamId: 'T1',
        teamName: 'Acme',
        status: 'active',
        stackBaseUrl: 'http://127.0.0.1:4201',
        installedBy: null,
        ...tenant,
      }
    : undefined;
  const tenants = { get: vi.fn(async () => record) } as unknown as TenantStore;
  const env = {
    get: (k: string) => (k === 'GATEWAY_SHARED_SECRET' ? 'shh' : undefined),
  } as unknown as EnvService;
  return new ForwarderService(tenants, env);
}

const okResponse = (body = '{}', status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });

describe('ForwarderService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('forwards events to the tenant stack with the shared-secret bearer', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    await makeForwarder({}).forwardEvent('T1', { event: { type: 'message' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4201/slack/inbound');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer shh');
    expect(JSON.parse(init.body as string)).toMatchObject({ kind: 'event', teamId: 'T1' });
  });

  it('drops events for unknown or non-active tenants without fetching', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    await makeForwarder(undefined).forwardEvent('T9', {});
    await makeForwarder({ status: 'suspended' }).forwardEvent('T1', {});
    await makeForwarder({ stackBaseUrl: null }).forwardEvent('T1', {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries events on 5xx/network errors, then drops; never retries 4xx', async () => {
    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(okResponse('{}', 503))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', flaky);
    await makeForwarder({}).forwardEvent('T1', {});
    expect(flaky).toHaveBeenCalledTimes(3); // error → 503 → 200

    const rejecting = vi.fn(async () => okResponse('{}', 400));
    vi.stubGlobal('fetch', rejecting);
    await makeForwarder({}).forwardEvent('T1', {});
    expect(rejecting).toHaveBeenCalledTimes(1); // 4xx = contract problem, no retry
  });

  it('relays interactivity synchronously and returns the stack body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse('{"response_action":"errors","errors":{"k":"bad"}}')),
    );
    const res = await makeForwarder({}).forwardInteractivity('T1', { type: 'view_submission' });
    expect(res.body).toEqual({ response_action: 'errors', errors: { k: 'bad' } });
  });

  it('degrades interactivity failures to an empty 200 (Slack closes the modal)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('timeout');
      }),
    );
    const res = await makeForwarder({}).forwardInteractivity('T1', {});
    expect(res).toEqual({ status: 200, body: {} });
  });
});
