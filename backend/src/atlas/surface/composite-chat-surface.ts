import { Logger } from '@nestjs/common';
import { merge, type Observable } from 'rxjs';
import type { ChatSurface, InboundChatMessage, PostOptions } from './chat-surface.port';

/** A `ChatSurface` adapter that can open a transport (the Slack socket). The composite fans `connect` out. */
type Connectable = ChatSurface & { connect?: () => Promise<unknown> };

/**
 * The COMPOSITE chat surface — the one place that knows the set of live surfaces, so Atlas's core stays
 * surface-agnostic. Bound as `CHAT_SURFACE` (built from the ENABLED adapter list in `surface.module.ts`).
 *
 *  - `inbound$` is the rxjs `merge` of every enabled adapter's stream, so the bridge / park / approval
 *    services subscribe ONCE and see messages from all surfaces (each carries its own `surface` tag).
 *  - `post` / `react` / `unreact` / `update` dispatch to the adapter whose `.name === opts.surfaceId`.
 *    A thread belongs to exactly ONE surface, so callers thread `surfaceId` through the route they
 *    already resolve (mirrors `teamId`). When `surfaceId` is unset or matches no enabled adapter, it
 *    falls back to the DEFAULT adapter (the sole one, else the first enabled) — covering legacy rows,
 *    single-surface boots, and the notification path. `react`/`unreact`/`update` carry no surface id in
 *    their signatures and have no surface-aware callers today, so they always route to the default.
 *  - `connect()` fans out to every adapter that exposes one (the Slack socket opens only when Slack is
 *    enabled). The `ChatStimulusBridge` duck-types `surface.connect?.()`, so this is load-bearing.
 *
 * Zero v1 imports.
 */
export class CompositeChatSurface implements ChatSurface {
  readonly name = 'composite';
  private readonly logger = new Logger(CompositeChatSurface.name);
  private readonly adapters: ChatSurface[];
  private readonly byName: Map<string, ChatSurface>;
  private readonly merged: Observable<InboundChatMessage>;

  constructor(adapters: ChatSurface[]) {
    if (adapters.length === 0) {
      throw new Error('CompositeChatSurface requires at least one adapter');
    }
    this.adapters = adapters;
    this.byName = new Map(adapters.map((a) => [a.name, a]));
    this.merged = merge(...adapters.map((a) => a.inbound$));
  }

  get inbound$(): Observable<InboundChatMessage> {
    return this.merged;
  }

  /** The names of the enabled adapters, in priority order — for diagnostics / boot logging. */
  get surfaceNames(): string[] {
    return this.adapters.map((a) => a.name);
  }

  /** Resolve the adapter to act on: by `surfaceId`, else the default (sole, else first enabled). */
  private pick(surfaceId?: string): ChatSurface {
    if (surfaceId) {
      const exact = this.byName.get(surfaceId);
      if (exact) return exact;
      this.logger.debug(
        `surfaceId "${surfaceId}" not enabled (have: ${[...this.byName.keys()].join(',')}) — using default`,
      );
    }
    return this.adapters[0];
  }

  async post(channel: string, text: string, opts: PostOptions = {}): Promise<string | undefined> {
    return this.pick(opts.surfaceId).post(channel, text, opts);
  }

  async react(channel: string, ts: string, emoji: string, teamId?: string): Promise<void> {
    await this.pick().react(channel, ts, emoji, teamId);
  }

  async unreact(channel: string, ts: string, emoji: string, teamId?: string): Promise<void> {
    await this.pick().unreact(channel, ts, emoji, teamId);
  }

  update(
    channel: string,
    ts: string,
    args: { text?: string; blocks?: Array<Record<string, unknown>> },
    teamId?: string,
  ): void | Promise<void> {
    const target = this.pick() as ChatSurface & { update?: ChatSurface['update'] };
    return target.update?.(channel, ts, args, teamId);
  }

  /** Open every enabled adapter's transport (no-op for surfaces without `connect`). */
  async connect(): Promise<void> {
    await Promise.all(
      this.adapters
        .filter((a): a is Connectable => typeof (a as Connectable).connect === 'function')
        .map((a) => a.connect!()),
    );
  }
}
