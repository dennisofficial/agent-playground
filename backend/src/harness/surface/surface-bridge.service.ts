import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { ConductorEventsBus } from '../conductor/conductor-events.bus';
import { ConductorService } from '../conductor/conductor.service';
import { CHAT_SURFACE, type ChatSurface } from './chat-surface.port';

/**
 * The ONLY component that touches both the conductor and the bound ChatSurface:
 *  - inbound: surface messages → `conductor.submitFrom` (onto the channel);
 *  - outbound: conductor `message` events from bots → `surface.post`; `reaction` events → `surface.react`.
 *
 * The surface binding is OPTIONAL: a hosting app provides `{ provide: CHAT_SURFACE, useClass: … }`
 * (the TUI binds TuiChatSurface; the api will bind a Slack adapter). Without one — tests, headless
 * boots — the bridge is inert and the conductor still runs (its events bus is still observable).
 */
@Injectable()
export class SurfaceBridge
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SurfaceBridge.name);
  private subs: Subscription[] = [];

  constructor(
    private readonly conductor: ConductorService,
    private readonly bus: ConductorEventsBus,
    @Optional() @Inject(CHAT_SURFACE) private readonly surface?: ChatSurface,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.surface) {
      this.logger.log(
        'No ChatSurface bound — running headless (events bus only)',
      );
      return;
    }
    this.subs.push(
      this.surface.inbound$.subscribe((m) =>
        // The surface-native id and channel coordinate ride along — reactions/edits must target the
        // surface's own ids (a Slack ts), and posting routes by the message's channel, not a singleton.
        this.conductor.submitFrom(m.authorId, m.authorName, m.text, {
          id: m.id,
          channelId: m.surfaceId,
        }),
      ),
    );
    this.subs.push(
      this.bus.events$.subscribe((e) => {
        if (e.kind === 'message' && !e.fromHuman) {
          void this.surface!.post({
            id: e.id,
            authorBotId: e.authorId,
            authorName: e.authorName,
            text: e.text,
            surfaceId: e.channelId,
          }).catch((err) => this.logger.error(`surface.post failed: ${err}`));
        } else if (e.kind === 'reaction') {
          void this.surface!.react(
            e.targetId,
            e.emoji,
            { id: e.botId, name: e.botName },
            e.channelId,
          ).catch((err) => this.logger.error(`surface.react failed: ${err}`));
        }
      }),
    );
  }

  onApplicationShutdown(): void {
    for (const s of this.subs) s.unsubscribe();
  }
}
