import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ForwarderService } from './forwarder.service';
import { SlackSignatureGuard } from './slack-signature.guard';

/**
 * The interactivity receiver (block_actions, view_submission, …). Slack sends a form-encoded
 * `payload=<json>`; the response BODY is meaningful (a view_submission may answer
 * `response_action: errors`), so unlike events this relays synchronously and pipes the tenant
 * stack's reply back — bounded by the forwarder's timeout to stay inside Slack's 3s budget.
 */
@Controller('slack/interactivity')
@UseGuards(SlackSignatureGuard)
export class SlackInteractivityController {
  private readonly logger = new Logger(SlackInteractivityController.name);

  constructor(private readonly forwarder: ForwarderService) {}

  @Post()
  @HttpCode(200)
  async receive(@Body() body: { payload?: string }): Promise<unknown> {
    if (!body.payload) return {};
    let payload: { team?: { id?: string } };
    try {
      payload = JSON.parse(body.payload) as { team?: { id?: string } };
    } catch (err) {
      this.logger.warn(`unparseable interactivity payload: ${err}`);
      return {};
    }
    const teamId = payload.team?.id;
    if (!teamId) return {};
    const relayed = await this.forwarder.forwardInteractivity(teamId, payload);
    return relayed.body ?? {};
  }
}
