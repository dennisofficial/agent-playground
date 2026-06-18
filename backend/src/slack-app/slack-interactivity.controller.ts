import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SlackInboundRouter } from './slack-inbound.router';
import type { SlackInteractivityPayload } from './slack-inbound.types';
import { SlackSignatureGuard } from './slack-signature.guard';

/** Minimal Express response surface — keeps the controller testable without supertest. */
interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): void;
}

/**
 * The interactivity receiver (block_actions, view_submission, …) — IN-PROCESS. Slack sends a
 * form-encoded `payload=<json>`; the response BODY is meaningful (a view_submission may answer
 * `response_action: errors`), so `respond` is wired to THIS HTTP response and the router's
 * handler (the onboarding guard) calls it. The post-route call is the idempotent safety net.
 */
@Controller('slack/interactivity')
@UseGuards(SlackSignatureGuard)
export class SlackInteractivityController {
  private readonly logger = new Logger(SlackInteractivityController.name);

  constructor(private readonly router: SlackInboundRouter) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Body() body: { payload?: string },
    @Res() res: ResponseLike,
  ): Promise<void> {
    if (!body.payload) {
      res.status(200).json({});
      return;
    }
    let payload: SlackInteractivityPayload;
    try {
      payload = JSON.parse(body.payload) as SlackInteractivityPayload;
    } catch (err) {
      this.logger.warn(`unparseable interactivity payload: ${err}`);
      res.status(200).json({});
      return;
    }
    let responded = false;
    const respond = async (responseBody?: unknown): Promise<void> => {
      if (responded) return;
      responded = true;
      res.status(200).json(responseBody ?? {});
    };
    await this.router.route({ kind: 'interactivity', payload, respond }).then(
      () => respond(),
      () => respond(),
    );
  }
}
