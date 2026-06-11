import { EnvService } from '@core/config/env/env.service';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Reject requests whose timestamp is older than this (replay window per Slack's guidance). */
const MAX_SKEW_S = 300;

interface RawBodyRequest {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Slack request-signature verification (`v0=` HMAC-SHA256 of `v0:<ts>:<raw body>` with the
 * signing secret) — the gate on every public Slack-facing endpoint. Needs `rawBody: true` on the
 * Nest app: the HMAC covers the exact bytes Slack sent.
 */
@Injectable()
export class SlackSignatureGuard implements CanActivate {
  constructor(private readonly env: EnvService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RawBodyRequest>();
    const secret = this.env.get('SLACK_SIGNING_SECRET');
    if (!secret) throw new UnauthorizedException('SLACK_SIGNING_SECRET is not configured.');

    const ts = header(req, 'x-slack-request-timestamp');
    const signature = header(req, 'x-slack-signature');
    if (!ts || !signature || !req.rawBody) {
      throw new UnauthorizedException('Missing Slack signature headers.');
    }
    if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_S) {
      throw new UnauthorizedException('Stale Slack request timestamp.');
    }

    const expected = `v0=${createHmac('sha256', secret)
      .update(`v0:${ts}:${req.rawBody.toString('utf8')}`)
      .digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Slack signature mismatch.');
    }
    return true;
  }
}

function header(req: RawBodyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
