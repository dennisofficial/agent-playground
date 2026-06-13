import { DEFAULT_TEAM } from '@harness/domain/identity';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { LeadPresenceService } from './lead-presence.service';
import { SlackChatSurface } from './slack-chat-surface';
import {
  APPROVAL_INTERCEPTOR,
  COMMAND_INTERCEPTOR,
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
    private readonly presence: LeadPresenceService,
    @Optional()
    @Inject(JARVIS_INTERCEPTOR)
    private readonly interceptor?: SlackInboundInterceptor,
    @Optional()
    @Inject(APPROVAL_INTERCEPTOR)
    private readonly approvals?: SlackInboundInterceptor,
    @Optional()
    @Inject(COMMAND_INTERCEPTOR)
    private readonly commands?: SlackInboundInterceptor,
  ) {}

  async route(item: SlackInbound): Promise<void> {
    try {
      // Slash commands have their own handler and never reach the conductor or the chat surface.
      if (item.kind === 'command') {
        if (this.commands) await this.commands.maybeHandle(item);
        return;
      }
      // Lead presence watches every event BEFORE the interceptor (Jarvis CONSUMES
      // member_joined_channel, so a post-interceptor hook would never see the lead's own join).
      // Fire-and-forget: presence can never delay or break routing.
      if (item.kind === 'event' && item.body.event) {
        const teamId = item.body.team_id ?? DEFAULT_TEAM;
        this.presence
          .observe(item.body.event, teamId)
          .catch((err) => this.logger.warn(`lead presence failed: ${err}`));
      }
      if (this.interceptor && (await this.interceptor.maybeHandle(item)))
        return;
      if (this.approvals && (await this.approvals.maybeHandle(item))) return;
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
