import {
  Body,
  Controller,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SlackInboundRouter } from './slack-inbound.router';
import type { SlackCommandPayload } from './slack-inbound.types';
import { SlackSignatureGuard } from './slack-signature.guard';

/** Minimal Express response surface — keeps the controller testable without supertest. */
interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): void;
}

/**
 * The slash-command receiver (Events API prod ingress) — IN-PROCESS, signature-verified. Slack
 * sends a form-encoded body with top-level fields (command, text, user_id, team_id, …), NOT a
 * `payload=` wrapper. The reply BODY is meaningful (an ephemeral message), so `respond` is wired to
 * THIS HTTP response and the handler calls it; the post-route call is the idempotent safety net.
 * (Dev/Socket Mode routes the same `slash_commands` envelope through SlackSocketTransport instead.)
 */
@Controller('slack/commands')
@UseGuards(SlackSignatureGuard)
export class SlackCommandsController {
  constructor(private readonly router: SlackInboundRouter) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Body() body: SlackCommandPayload,
    @Res() res: ResponseLike,
  ): Promise<void> {
    let responded = false;
    const respond = (responseBody?: unknown): Promise<void> => {
      if (!responded) {
        responded = true;
        res.status(200).json(responseBody ?? {});
      }
      return Promise.resolve();
    };
    await this.router.route({ kind: 'command', command: body, respond }).then(
      () => respond(),
      () => respond(),
    );
  }
}
