import { EnvService } from '@core/config/env/env.service';
import { ConductorEventsBus } from '@harness/conductor/conductor-events.bus';
import { DEFAULT_SURFACE_ID } from '@harness/channel/channel.service';
import type { ChatSurface, InboundChatMessage, OutboundChatMessage } from '@harness/surface/chat-surface.port';
import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

const titleCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

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
  private seq = 0;

  constructor(
    private readonly bus: ConductorEventsBus,
    env: EnvService,
  ) {
    this.surfaceId = env.get('HARNESS_SURFACE_ID') ?? DEFAULT_SURFACE_ID;
  }

  get inbound$(): Observable<InboundChatMessage> {
    return this.subject.asObservable();
  }

  /** Emit the human's typed message as a surface-inbound message (speaker = the `/as` identity). */
  send(text: string): void {
    const speaker = this.bus.status.speaker;
    this.subject.next({
      id: `tui-${this.seq++}`,
      authorId: speaker,
      authorName: titleCase(speaker),
      text,
      surfaceId: this.surfaceId,
      ts: new Date(),
    });
  }

  async post(_msg: OutboundChatMessage): Promise<void> {
    // No-op: the TUI renders from the conductor events bus directly.
  }

  async react(_targetMessageId: string, _emoji: string, _asBot: { id: string; name: string }): Promise<void> {
    // No-op: reactions render from the events bus.
  }
}
