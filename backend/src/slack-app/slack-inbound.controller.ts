import { EnvService } from '@core/config/env/env.service';
import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  HttpCode,
  Injectable,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { SlackInboundRouter } from './slack-inbound.router';
import type {
  SlackEventsApiBody,
  SlackInteractivityPayload,
} from './slack-inbound.types';

/** Constant-time bearer check on the gateway→stack hop (one shared secret, internal network). */
@Injectable()
export class GatewaySecretGuard implements CanActivate {
  constructor(private readonly env: EnvService) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.env.get('GATEWAY_SHARED_SECRET');
    if (!secret) throw new UnauthorizedException('GATEWAY_SHARED_SECRET is not configured.');
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const presented = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(secret);
    const b = Buffer.from(presented);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Bad gateway secret.');
    }
    return true;
  }
}

interface ForwardedItem {
  kind?: 'event' | 'interactivity';
  teamId?: string;
  body?: SlackEventsApiBody;
  payload?: SlackInteractivityPayload;
}

/** Minimal Express response surface — keeps the controller testable without supertest. */
interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): void;
}

/**
 * The gateway-inbound transport (SLACK_INBOUND=gateway): tenant stacks own no Slack connection —
 * the gateway verifies, routes by team_id, and POSTs here over the internal network. Events are
 * enqueued and answered immediately; interactivity wires `respond` to THIS response — the gateway
 * pipes the body back to Slack (modal validation errors round-trip). Declared unconditionally:
 * in socket mode the app is a context (no HTTP listener), so the controller is inert.
 */
@Controller('slack/inbound')
@UseGuards(GatewaySecretGuard)
export class SlackInboundController {
  constructor(private readonly router: SlackInboundRouter) {}

  @Post()
  @HttpCode(200)
  receive(@Body() item: ForwardedItem, @Res() res: ResponseLike): void {
    if (item.kind === 'event' && item.body) {
      const body = item.body;
      res.status(200).json({});
      void this.router.route({ kind: 'event', body, respond: async () => {} });
      return;
    }
    if (item.kind === 'interactivity' && item.payload) {
      const payload = item.payload;
      let responded = false;
      const respond = async (responseBody?: unknown): Promise<void> => {
        if (responded) return;
        responded = true;
        res.status(200).json(responseBody ?? {});
      };
      void this.router.route({ kind: 'interactivity', payload, respond }).then(
        () => respond(), // safety net — no-op when the handler already answered
        () => respond(),
      );
      return;
    }
    res.status(200).json({});
  }
}
