import { Body, Controller, HttpCode, Logger, Post, UseGuards } from '@nestjs/common';
import { SlackInboundRouter } from './slack-inbound.router';
import type { SlackEventsApiBody } from './slack-inbound.types';
import { SlackSignatureGuard } from './slack-signature.guard';
import { TenantStore } from './tenant.store';

interface EventsApiBody extends SlackEventsApiBody {
  type?: string; // url_verification | event_callback
  challenge?: string;
}

/**
 * The Events API receiver — the public Slack front door, now IN-PROCESS (single-process model: no
 * HTTP hop to a per-tenant stack). Slack expects a 200 within 3s and retries otherwise, so the
 * handler answers immediately and dispatches async to the SlackInboundRouter (which routes by the
 * body's team_id). Uninstall/token-revoke suspend the workspace. One OAuth-distributed app feeds
 * every workspace's events here; routing happens in the router/surface by team_id.
 */
@Controller('slack/events')
@UseGuards(SlackSignatureGuard)
export class SlackEventsController {
  private readonly logger = new Logger(SlackEventsController.name);

  constructor(
    private readonly router: SlackInboundRouter,
    private readonly tenants: TenantStore,
  ) {}

  @Post()
  @HttpCode(200)
  receive(@Body() body: EventsApiBody): unknown {
    // Slack's endpoint-ownership handshake (sent when the request URL is configured).
    if (body.type === 'url_verification') return { challenge: body.challenge };
    if (body.type !== 'event_callback' || !body.team_id) return {};

    const teamId = body.team_id;
    const eventType = body.event?.type;
    if (eventType === 'app_uninstalled' || eventType === 'tokens_revoked') {
      void this.tenants
        .setStatus(teamId, 'suspended')
        .then(() => this.logger.warn(`tenant ${teamId} suspended (${eventType})`))
        .catch((err) => this.logger.error(`suspend ${teamId} failed: ${err}`));
      return {};
    }
    // Fire-and-forget into the router (Jarvis interceptor → surface); the 200 has already returned.
    void this.router.route({ kind: 'event', body, respond: async () => {} });
    return {};
  }
}
