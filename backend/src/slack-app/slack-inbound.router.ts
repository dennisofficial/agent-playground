import { DEFAULT_TEAM } from '@harness/domain/identity';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { SlackChatSurface } from './slack-chat-surface';
import {
  JARVIS_INTERCEPTOR,
  type SlackInbound,
  type SlackInboundInterceptor,
} from './slack-inbound.types';

/**
 * The ONE consumer of normalized inbound items — explicit ordering instead of subscriber races:
 * ① the deterministic interceptor (Jarvis) gets first refusal; a consumed item never reaches the
 * conductor or the channel log (pending-keys onboarding chatter must not pile up as billable
 * backlog). ② message events flow into the chat surface's existing filter/translate/emit pipeline.
 * Interactivity that nothing consumed is dropped here — `respond` is the transport's job.
 */
@Injectable()
export class SlackInboundRouter {
  private readonly logger = new Logger(SlackInboundRouter.name);

  constructor(
    private readonly surface: SlackChatSurface,
    @Optional()
    @Inject(JARVIS_INTERCEPTOR)
    private readonly interceptor?: SlackInboundInterceptor,
  ) {}

  async route(item: SlackInbound): Promise<void> {
    try {
      if (this.interceptor && (await this.interceptor.maybeHandle(item))) return;
      if (item.kind === 'event' && item.body.event?.type === 'message') {
        // team_id routes the message to its workspace; the Events API always carries it.
        const teamId = item.body.team_id ?? DEFAULT_TEAM;
        await this.surface.handleMessageEvent(item.body.event, teamId);
      }
    } catch (err) {
      this.logger.error(`inbound routing failed: ${err}`);
    }
  }
}
