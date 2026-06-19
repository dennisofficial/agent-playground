import { DEFAULT_TEAM } from '@harness/domain/identity';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { SlackChatSurface } from './slack-chat-surface';
import {
  APPROVAL_INTERCEPTOR,
  COMMAND_INTERCEPTOR,
  ONBOARDING_GUARD_INTERCEPTOR,
  PROJECT_ONBOARD_INTERCEPTOR,
  ROTATE_KEYS_INTERCEPTOR,
  SUGGESTION_INTERCEPTOR,
  type SlackInbound,
  type SlackInboundInterceptor,
} from './slack-inbound.types';

/**
 * The ONE consumer of normalized inbound items — explicit ordering instead of subscriber races:
 * ① the deterministic keyless onboarding guard gets first refusal; a consumed item never reaches the
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
    @Inject(ONBOARDING_GUARD_INTERCEPTOR)
    private readonly interceptor?: SlackInboundInterceptor,
    @Optional()
    @Inject(APPROVAL_INTERCEPTOR)
    private readonly approvals?: SlackInboundInterceptor,
    @Optional()
    @Inject(COMMAND_INTERCEPTOR)
    private readonly commands?: SlackInboundInterceptor,
    @Optional()
    @Inject(SUGGESTION_INTERCEPTOR)
    private readonly suggestions?: SlackInboundInterceptor,
    @Optional()
    @Inject(PROJECT_ONBOARD_INTERCEPTOR)
    private readonly projectOnboard?: SlackInboundInterceptor,
    @Optional()
    @Inject(ROTATE_KEYS_INTERCEPTOR)
    private readonly rotateKeys?: SlackInboundInterceptor,
  ) {}

  async route(item: SlackInbound): Promise<void> {
    try {
      // Slash commands have their own handler and never reach the conductor or the chat surface.
      if (item.kind === 'command') {
        if (this.commands) await this.commands.maybeHandle(item);
        return;
      }
      if (this.interceptor && (await this.interceptor.maybeHandle(item)))
        return;
      if (this.approvals && (await this.approvals.maybeHandle(item))) return;
      if (this.suggestions && (await this.suggestions.maybeHandle(item)))
        return;
      if (
        this.projectOnboard &&
        (await this.projectOnboard.maybeHandle(item))
      )
        return;
      if (this.rotateKeys && (await this.rotateKeys.maybeHandle(item)))
        return;
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
