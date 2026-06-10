import { EnvService } from '@core/config/env/env.service';
import { ConductorEventsBus } from '@harness/conductor/conductor-events.bus';
import { DEFAULT_SURFACE_ID } from '@harness/channel/channel.service';
import { titleCase } from '@harness/domain/text';
import type {
  ChatSurface,
  InboundChatMessage,
  OutboundChatMessage,
} from '@harness/surface/chat-surface.port';
import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

/**
 * The terminal's ChatSurface adapter — the local-dev simulation of the group chat. The Ink input
 * handler calls `send()`, which emits an inbound message (authored as the current `/as` speaker)
 * that the SurfaceBridge routes onto the channel. `post`/`react` are no-ops: the TUI renders bot
 * output straight from the conductor events bus, so delivering it again here would double-render.
 * The Slack adapter implements the same port with real chat.postMessage / reactions.add calls —
 * the harness code path is identical.
 */
@Injectable()
export class TuiChatSurface implements ChatSurface {
  readonly name = 'tui';
  private readonly subject = new Subject<InboundChatMessage>();
  private readonly surfaceId: string;
  /** The room the terminal is currently "in" — `send()` posts here; `/room`//`/dm` switch it. */
  private activeChannelId?: string;
  private seq = 0;
  /** Ids persist as channel-message identity now; tag them per boot so a fresh process's `tui-0`
   * can't collide with (and silently update) a hydrated row from the previous run. */
  private readonly mintTag = Date.now().toString(36);

  constructor(
    private readonly bus: ConductorEventsBus,
    env: EnvService,
  ) {
    this.surfaceId = env.get('HARNESS_SURFACE_ID') ?? DEFAULT_SURFACE_ID;
  }

  get inbound$(): Observable<InboundChatMessage> {
    return this.subject.asObservable();
  }

  get activeChannel(): string {
    return this.activeChannelId ?? this.surfaceId;
  }

  setActiveChannel(channelId: string): void {
    this.activeChannelId = channelId;
  }

  /** Emit the human's typed message as a surface-inbound message (speaker = the `/as` identity). */
  send(text: string): void {
    const speaker = this.bus.status.speaker;
    this.subject.next({
      id: `tui-${this.mintTag}-${this.seq++}`,
      authorId: speaker,
      authorName: titleCase(speaker),
      text,
      surfaceId: this.activeChannel,
      ts: new Date(),
    });
  }

  async post(_msg: OutboundChatMessage): Promise<void> {
    // No-op: the TUI renders from the conductor events bus directly.
  }

  async react(
    _targetMessageId: string,
    _emoji: string,
    _asBot: { id: string; name: string },
  ): Promise<void> {
    // No-op: reactions render from the events bus.
  }
}
