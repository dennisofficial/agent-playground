import type { EnvService } from '@core/config/env/env.service';
import type { ExecutionContext } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { SlackSignatureGuard } from './slack-signature.guard';

const SECRET = 'test-signing-secret';

function makeGuard(secret: string = SECRET) {
  return new SlackSignatureGuard({
    // '' models an unconfigured secret (a default-param `undefined` would re-apply SECRET).
    get: (k: string) => (k === 'SLACK_SIGNING_SECRET' ? secret || undefined : undefined),
  } as unknown as EnvService);
}

function contextFor(req: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function signedRequest(body: string, opts: { ts?: string; signature?: string } = {}) {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const signature =
    opts.signature ??
    `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
  return {
    rawBody: Buffer.from(body),
    headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': signature },
  };
}

describe('SlackSignatureGuard', () => {
  it('passes a correctly signed request', () => {
    const guard = makeGuard();
    expect(guard.canActivate(contextFor(signedRequest('{"type":"event_callback"}')))).toBe(true);
  });

  it('rejects a tampered body (signature over different bytes)', () => {
    const guard = makeGuard();
    const req = signedRequest('{"type":"event_callback"}');
    req.rawBody = Buffer.from('{"type":"event_callback","evil":true}');
    expect(() => guard.canActivate(contextFor(req))).toThrow(/signature mismatch/);
  });

  it('rejects a stale timestamp (replay window)', () => {
    const guard = makeGuard();
    const staleTs = String(Math.floor(Date.now() / 1000) - 600);
    expect(() =>
      guard.canActivate(contextFor(signedRequest('{}', { ts: staleTs }))),
    ).toThrow(/Stale/);
  });

  it('rejects missing headers/raw body', () => {
    const guard = makeGuard();
    expect(() =>
      guard.canActivate(contextFor({ rawBody: Buffer.from('{}'), headers: {} })),
    ).toThrow(/Missing/);
    expect(() =>
      guard.canActivate(
        contextFor({ headers: signedRequest('{}').headers }), // no rawBody
      ),
    ).toThrow(/Missing/);
  });

  it('rejects everything when the signing secret is unconfigured', () => {
    const guard = makeGuard('');
    expect(() => guard.canActivate(contextFor(signedRequest('{}')))).toThrow(
      /not configured/,
    );
  });
});
