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
import type { AccumulatedUsage } from '../domain/conductor-events';
import { calculateCost, CHAT_MODEL, GATE_MODEL } from '../llm/usage-format';
import { CHAT_SURFACE, type ChatSurface } from './chat-surface.port';

/**
 * The ONLY component that touches both the conductor and the bound ChatSurface:
 *  - inbound: surface messages → `conductor.submitFrom` (onto the channel);
 *  - outbound: conductor `message` events from bots → `surface.post`; `reaction` events → `surface.react`.
 *
 * The surface binding is OPTIONAL: a hosting app provides `{ provide: CHAT_SURFACE, useClass: … }`
 * (slack-app binds SlackChatSurface). Without one — tests, headless
 * boots — the bridge is inert and the conductor still runs (its events bus is still observable).
 *
 * **Usage accumulation** (Option B — per-Slack-message aggregate):
 * Gate costs (Haiku) and per-LLM-step chat costs (Sonnet) are accumulated in `usageByBot`, keyed
 * by bot id. When a `message` event fires for a bot, the accumulated total rides along as `usage`
 * on the `OutboundChatMessage` and the accumulator is reset. Gate costs from ignore/acknowledge
 * turns are NOT discarded — they roll forward into the next real post from that bot.
 */
@Injectable()
export class SurfaceBridge
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SurfaceBridge.name);
  private subs: Subscription[] = [];

  /** Per-bot aggregate usage, accumulating from the last post (or boot) until the next post. */
  private usageByBot = new Map<string, AccumulatedUsage>();

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
          teamId: m.teamId,
        }),
      ),
    );
    this.subs.push(
      this.bus.events$.subscribe((e) => {
        if (e.kind === 'gate' && e.usage) {
          // Accumulate gate cost (Haiku model) for this bot, even on ignore/acknowledge — these
          // costs roll into the next real post from that bot.
          this.accumulateGate(e.botId, e.usage);
        } else if (e.kind === 'usage' && e.role === 'chat') {
          // Per-LLM-step chat usage (Sonnet model): tool-call-only steps produce no message event
          // but are billed — accumulate them so the footer captures the full turn cost.
          this.accumulateChat(e.botId, e.usage);
        } else if (e.kind === 'message' && !e.fromHuman) {
          // Read the accumulated total for this bot, attach it, reset, then post.
          const usage = this.usageByBot.get(e.authorId);
          this.usageByBot.delete(e.authorId);
          void this.surface!.post({
            id: e.id,
            authorBotId: e.authorId,
            authorName: e.authorName,
            text: e.text,
            surfaceId: e.channelId,
            usage,
            fileIds: e.fileIds,
          }).catch((err) => this.logger.error(`surface.post failed: ${err}`));
        } else if (e.kind === 'reaction') {
          const asBot = { id: e.botId, name: e.botName };
          const op = e.remove
            ? this.surface!.unreact(e.targetId, e.emoji, asBot, e.channelId)
            : this.surface!.react(e.targetId, e.emoji, asBot, e.channelId);
          void op.catch((err) =>
            this.logger.error(
              `surface.${e.remove ? 'unreact' : 'react'} failed: ${err}`,
            ),
          );
        }
      }),
    );
  }

  onApplicationShutdown(): void {
    for (const s of this.subs) s.unsubscribe();
  }

  private accumulateGate(
    botId: string,
    gateUsage: { input: number; output: number },
  ): void {
    const cost = calculateCost(GATE_MODEL, {
      input: gateUsage.input,
      output: gateUsage.output,
    });
    const cur = this.usageByBot.get(botId) ?? zeroAccum();
    this.usageByBot.set(botId, {
      input: cur.input + gateUsage.input,
      output: cur.output + gateUsage.output,
      cacheRead: cur.cacheRead,
      cacheWrite5m: cur.cacheWrite5m,
      cacheWrite1h: cur.cacheWrite1h,
      costUsd: cur.costUsd + cost,
      callCount: cur.callCount + 1,
    });
  }

  private accumulateChat(
    botId: string,
    usage: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite5m?: number;
      cacheWrite1h?: number;
    },
  ): void {
    const cost = calculateCost(CHAT_MODEL, {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite5m: usage.cacheWrite5m,
      cacheWrite1h: usage.cacheWrite1h,
    });
    const cur = this.usageByBot.get(botId) ?? zeroAccum();
    this.usageByBot.set(botId, {
      input: cur.input + usage.input,
      output: cur.output + usage.output,
      cacheRead: cur.cacheRead + (usage.cacheRead ?? 0),
      cacheWrite5m: cur.cacheWrite5m + (usage.cacheWrite5m ?? 0),
      cacheWrite1h: cur.cacheWrite1h + (usage.cacheWrite1h ?? 0),
      costUsd: cur.costUsd + cost,
      callCount: cur.callCount + 1,
    });
  }
}

function zeroAccum(): AccumulatedUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    costUsd: 0,
    callCount: 0,
  };
}
