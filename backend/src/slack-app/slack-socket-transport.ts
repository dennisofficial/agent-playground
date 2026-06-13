import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import type { SocketModeClient } from '@slack/socket-mode';
import { SlackDirectoryService } from './slack-directory.service';
import { SlackInboundRouter } from './slack-inbound.router';
import { SLACK_SOCKET_MODE_CLIENT } from './slack.tokens';

/** The generic envelope SocketModeClient hands `slack_event` listeners: `type` is the envelope
 * kind (`events_api` | `interactive` | …), `body` the payload, `ack` the envelope acknowledger
 * (accepts an optional response payload — how view_submission returns validation errors). */
interface SlackSocketEnvelope {
  type: string;
  body: Record<string, unknown>;
  ack: (response?: unknown) => Promise<void>;
}

/**
 * The Socket Mode transport (dev / single-workspace mode): owns the socket lifecycle + auth.test,
 * normalizes envelopes into the router's `SlackInbound` items. Events are acked FIRST (Slack
 * redelivers unacked envelopes; matches the pre-refactor behavior); interactivity defers `respond`
 * to the handler (view_submission may carry `response_action: errors`) with a post-route ack as
 * the safety net — `respond` is idempotent, so the net never double-sends.
 */
@Injectable()
export class SlackSocketTransport implements OnApplicationShutdown {
  private readonly logger = new Logger(SlackSocketTransport.name);

  constructor(
    @Optional()
    @Inject(SLACK_SOCKET_MODE_CLIENT)
    private readonly socket: SocketModeClient | undefined,
    private readonly directory: SlackDirectoryService,
    private readonly router: SlackInboundRouter,
  ) {}

  /** Called from main.ts AFTER Nest bootstrap, so the SurfaceBridge is already subscribed to
   * `inbound$` before the first event can arrive. Returns the bot's identity for the boot banner. */
  async connect(): Promise<{ botName?: string }> {
    if (!this.socket) {
      throw new Error(
        'Socket Mode client is not provided — is SLACK_APP_TOKEN set?',
      );
    }
    const identity = await this.directory.bootIdentity();
    this.socket.on('slack_event', (envelope: SlackSocketEnvelope) => {
      void this.handleEnvelope(envelope);
    });
    for (const state of [
      'connected',
      'disconnected',
      'reconnecting',
    ] as const) {
      this.socket.on(state, () => this.logger.log(`Socket Mode: ${state}`));
    }
    await this.socket.start();
    return identity;
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.socket?.disconnect();
    } catch {
      // already down — nothing to tear down
    }
  }

  private async handleEnvelope(envelope: SlackSocketEnvelope): Promise<void> {
    const respond = this.respondOnce(envelope);
    if (envelope.type === 'events_api') {
      await respond(); // ack first — handlers never hold up redelivery
      await this.router.route({ kind: 'event', body: envelope.body, respond });
    } else if (envelope.type === 'interactive') {
      await this.router.route({
        kind: 'interactivity',
        payload: envelope.body as never,
        respond,
      });
      await respond(); // safety net — no-op when the handler already responded
    } else if (envelope.type === 'slash_commands') {
      // The handler's reply rides the ack body; the post-route ack is the idempotent safety net.
      await this.router.route({
        kind: 'command',
        command: envelope.body as never,
        respond,
      });
      await respond();
    }
    // Other envelope kinds (hello, …) are not ours — leave them be.
  }

  /** Idempotent ack: the first call wins (with or without a payload), later calls no-op. Ack
   * failures are logged, never thrown — an unacked envelope just redelivers. */
  private respondOnce(
    envelope: SlackSocketEnvelope,
  ): (body?: unknown) => Promise<void> {
    let sent = false;
    return async (body?: unknown) => {
      if (sent) return;
      sent = true;
      try {
        await envelope.ack(body);
      } catch (err) {
        this.logger.warn(`ack failed: ${err}`);
      }
    };
  }
}
