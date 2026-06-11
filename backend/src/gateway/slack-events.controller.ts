import { Body, Controller, HttpCode, Logger, Post, UseGuards } from '@nestjs/common';
import { ForwarderService } from './forwarder.service';
import { SlackSignatureGuard } from './slack-signature.guard';
import { TenantStore } from './tenants/tenant.store';

interface EventsApiBody {
  type?: string; // url_verification | event_callback
  challenge?: string;
  team_id?: string;
  event?: { type?: string };
}

/**
 * The Events API receiver. Slack expects a 200 within 3 seconds and retries otherwise — so the
 * handler returns IMMEDIATELY and forwards async (the forwarder owns retries/drops; Slack-side
 * redelivery is deliberately not used, matching the no-backfill stance).
 */
@Controller('slack/events')
@UseGuards(SlackSignatureGuard)
export class SlackEventsController {
  private readonly logger = new Logger(SlackEventsController.name);

  constructor(
    private readonly forwarder: ForwarderService,
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
    void this.forwarder.forwardEvent(teamId, body);
    return {};
  }
}
