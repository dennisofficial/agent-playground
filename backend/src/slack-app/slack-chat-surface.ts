import { ConductorEventsBus } from '@harness/conductor/conductor-events.bus';
import type { AccumulatedUsage } from '@harness/domain/conductor-events';
import { CHAT_MODEL, formatUsageLine } from '@harness/llm/usage-format';
import type {
  ChatSurface,
  InboundChatMessage,
  OutboundChatMessage,
} from '@harness/surface/chat-surface.port';
import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { SlackDirectoryService } from './slack-directory.service';
import type { SlackInboundEvent } from './slack-inbound.types';
import {
  isSlackError,
  parseSlackSurface,
  slackSurfaceId,
} from './slack-membership';
import {
  emojiToSlackName,
  extractHandles,
  extractMentionIds,
  translateInbound,
  translateOutbound,
} from './slack-text';
import { TenantSlackClients } from './tenant-slack-clients';

export { parseSlackSurface } from './slack-membership';

/** Bot-on-bot reactions target harness-minted message ids — remember where we posted each one. */
const POSTED_ID_LRU_MAX = 2_000;
const POST_RETRIES = 3;

/**
 * The Slack ChatSurface — the real group chat. SINGLE VOICE: the one Slack app (Atlas) posts and
 * reacts as itself; inbound channel messages become harness messages after mention translation and
 * room registration. Transport-agnostic since the inbound refactor: the SlackInboundRouter feeds
 * `handleMessageEvent` from whichever transport is live (Socket Mode in dev, the gateway listener on
 * tenant stacks); acking is the transport's job. v1 scope: top-level channel messages only (thread
 * replies dropped), no Slack DMs (non-`slack:` rooms skipped on post), single-human speaker
 * attribution (`patchStatus({ speaker })` before each emit).
 */
@Injectable()
export class SlackChatSurface implements ChatSurface {
  readonly name = 'slack';
  private readonly logger = new Logger(SlackChatSurface.name);
  private readonly subject = new Subject<InboundChatMessage>();
  /** Harness-minted message id → where it landed in Slack (insertion-ordered, LRU-bounded). */
  private readonly postedIds = new Map<
    string,
    { channel: string; ts: string }
  >();

  constructor(
    private readonly clients: TenantSlackClients,
    private readonly directory: SlackDirectoryService,
    private readonly bus: ConductorEventsBus,
  ) {}

  get inbound$(): Observable<InboundChatMessage> {
    return this.subject.asObservable();
  }

  /** Inbound pipeline (router-called; the transport has already acked). Filters: own/bot messages
   * (the echo-loop guard — our own chat.postMessage posts come back as message events), non-plain
   * subtypes, and thread replies (v1). */
  async handleMessageEvent(
    event: SlackInboundEvent,
    teamId: string,
  ): Promise<void> {
    const selfBotUserId = await this.directory.selfUserIdFor(teamId);
    try {
      if (!event || event.type !== 'message') return;
      if (event.bot_id || event.subtype === 'bot_message') return;
      if (event.subtype) return; // message_changed, channel_join, …
      if (!event.user || !event.channel || !event.ts) return;
      if (selfBotUserId && event.user === selfBotUserId) return;
      if (event.thread_ts && event.thread_ts !== event.ts) {
        this.logger.debug(`dropping thread reply in ${event.channel} (v1)`);
        return;
      }

      const author = await this.directory.resolveUser(teamId, event.user);
      // Pre-resolve mentioned users so the sync translator's cache lookups hit.
      for (const id of extractMentionIds(event.text ?? '')) {
        if (id === selfBotUserId) continue;
        await this.directory.resolveUser(teamId, id);
      }
      const text = translateInbound(event.text ?? '', {
        resolveUser: (id) => this.directory.displayNameOf(teamId, id),
        selfBotUserId,
      }).trim();
      if (!text) return;

      // Room registration MUST precede the emit (first-write-wins project + roster membership).
      await this.directory.ensureChannelRegistered(
        event.channel,
        teamId,
        author.authorId,
      );
      // v1 single-human speaker attribution — same semantics as the TUI's `/as`.
      this.bus.patchStatus({ speaker: author.authorId });
      this.subject.next({
        id: event.ts,
        authorId: author.authorId,
        authorName: author.authorName,
        text,
        teamId,
        surfaceId: slackSurfaceId(teamId, event.channel),
        ts: new Date(Number(event.ts) * 1000),
      });
    } catch (err) {
      this.logger.error(`inbound handling failed: ${err}`);
    }
  }

  /** Deliver a bot message through the single Slack app (Atlas posts as itself — no per-author
   * username/icon override). Non-Slack rooms (e.g. bot-minted `tui:dm:*`) are skipped — the message
   * is already durable in the channel log; Slack DMs are a v2 item.
   *
   * When `msg.usage` is present, the message is posted as Block Kit with a context footer showing
   * the aggregate token usage and cost. Two-pass Block Kit: first tries the `markdown` block type;
   * if Slack returns `invalid_blocks`, falls back to a `section` + `mrkdwn` block. */
  async post(msg: OutboundChatMessage): Promise<void> {
    const parsed = parseSlackSurface(msg.surfaceId);
    if (!parsed) {
      this.logger.debug(`skipping post to non-slack/DM room ${msg.surfaceId}`);
      return;
    }
    const { teamId, channel } = parsed;
    // Pre-resolve @handles to Slack user ids — mirrors the inbound extractMentionIds pre-resolve
    // pattern. The async resolution happens here; the sync translator gets a callback.
    const handles = extractHandles(msg.text);
    const mentionMap = new Map<string, string>();
    for (const handle of handles) {
      const slackId = await this.directory.resolveMention(teamId, handle);
      if (slackId) mentionMap.set(handle, slackId);
    }
    const text = translateOutbound(msg.text, {
      resolveMention:
        mentionMap.size > 0 ? (h) => mentionMap.get(h) : undefined,
    }); // LLMs emit Markdown; Slack renders mrkdwn; @handles become <@SLACK_USER_ID> when resolved
    const ears = await this.clients.clientFor(teamId);
    if (!ears) {
      this.logger.warn(
        `no Slack client for ${teamId} — dropping post to ${channel}`,
      );
      return;
    }

    let lastErr: unknown;
    for (let attempt = 1; attempt <= POST_RETRIES; attempt++) {
      try {
        let res: { ts?: string; ok?: boolean; blocks?: unknown[] } | undefined;
        res = msg.usage
          ? await this.postWithBlocksFallback(
              // Cast at the Slack boundary: the helper uses Record<string, unknown> internally;
              // the cast here is the single point where we cross into the SDK's union type.
              (args) =>
                ears.chat.postMessage(
                  args as unknown as Parameters<typeof ears.chat.postMessage>[0],
                ),
              { channel, text },
              msg.text,
              msg.usage,
              mentionMap.size > 0,
            )
          : await ears.chat.postMessage({ channel, text });

        if (res?.ts) {
          this.recordPostedId(msg.id, { channel, ts: res.ts });
          // Attach uploaded files to the message via chat.update(file_ids).
          // The files were uploaded UNSHARED during the tool call; this step links them.
          // Re-send the SAME blocks the post used: `chat.update` with `text` and no `blocks`
          // REMOVES the existing blocks, which would strip the usage footer + mention Block Kit.
          //
          // Wrapped in its OWN try/catch — the message has already posted (recordPostedId above), so a
          // failed attach must NOT bubble into the retry loop (that would re-post a duplicate).
          if (msg.fileIds?.length) {
            try {
              await ears.chat.update({
                channel,
                ts: res.ts,
                text,
                ...(res.blocks ? { blocks: res.blocks } : {}),
                file_ids: msg.fileIds,
              });
            } catch (attachErr) {
              this.logger.warn(
                `chat.update(file_ids) failed for ${channel}/${res.ts} — message posted without the artifact: ${attachErr instanceof Error ? attachErr.message : String(attachErr)}`,
              );
            }
          }
        }
        return;
      } catch (err) {
        lastErr = err;
        await sleep(500 * attempt);
      }
    }
    throw lastErr;
  }

  /**
   * Post with a Block Kit footer showing token usage. When `hasMentions` is true, skips the
   * non-standard `markdown` block entirely and posts via `section`+`mrkdwn` directly (using the
   * already-translated text so `<@USER_ID>` mention pings are preserved). When false, first tries
   * the `markdown` block type (more Markdown-faithful); if Slack rejects it with `invalid_blocks`,
   * falls back to `section`+`mrkdwn`. The `text` field is always populated as the notification
   * fallback (push notifications, accessibility). `baseArgs` carries channel as a plain record so the
   * caller can freely spread extra fields without fighting SDK union types.
   */
  private async postWithBlocksFallback(
    postFn: (
      args: Record<string, unknown>,
    ) => Promise<{ ts?: string; ok?: boolean }>,
    baseArgs: Record<string, unknown>,
    rawText: string,
    usage: AccumulatedUsage,
    hasMentions: boolean,
  ): Promise<{ ts?: string; ok?: boolean; blocks?: unknown[] }> {
    const footer = formatUsageLine(usage, CHAT_MODEL);
    const translatedText = baseArgs.text as string; // already run through translateOutbound

    const divider = { type: 'divider' };
    const contextBlock = {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: footer }],
    };
    const sectionBlocks = [
      { type: 'section', text: { type: 'mrkdwn', text: translatedText } },
      divider,
      contextBlock,
    ];
    const markdownBlocks = [
      { type: 'markdown', text: rawText },
      divider,
      contextBlock,
    ];

    // Return the blocks that were actually posted so the caller can re-send them on a later
    // chat.update(file_ids) — otherwise Slack drops the footer when the files are attached.
    if (hasMentions) {
      // Slack's `markdown` block strips `<@USER_ID>` mention syntax, breaking pings.
      // Route mention-containing messages straight to section+mrkdwn to preserve them.
      const res = await postFn({ ...baseArgs, blocks: sectionBlocks });
      return { ...res, blocks: sectionBlocks };
    }

    try {
      const res = await postFn({ ...baseArgs, blocks: markdownBlocks });
      return { ...res, blocks: markdownBlocks };
    } catch (err) {
      if (!isSlackError(err, ['invalid_blocks'])) throw err;
      // Fall back to the universally-supported section + mrkdwn block.
      const res = await postFn({ ...baseArgs, blocks: sectionBlocks });
      return { ...res, blocks: sectionBlocks };
    }
  }

  /** React on a surface message: a raw Slack ts (human messages ride their native id), or a
   * harness-minted bot-message id resolved through the posted-id LRU. The single app reacts as
   * itself; `asBot` is accepted for the port contract but no longer selects an identity. */
  async react(
    targetMessageId: string,
    emoji: string,
    _asBot: { id: string; name: string },
    channelId: string,
  ): Promise<void> {
    const parsed = parseSlackSurface(channelId);
    if (!parsed) return;
    const posted = this.postedIds.get(targetMessageId);
    const channel = posted?.channel ?? parsed.channel;
    const timestamp = posted?.ts ?? targetMessageId;
    if (!/^\d+\.\d+$/.test(timestamp)) {
      // A minted id we never posted (pre-restart message, or a room we skip) — nothing to target.
      this.logger.debug(`no Slack ts for reaction target ${targetMessageId}`);
      return;
    }
    const args = { channel, timestamp, name: emojiToSlackName(emoji) };
    try {
      const ears = await this.clients.clientFor(parsed.teamId);
      await ears?.reactions.add(args);
    } catch (err) {
      // Same-emoji collisions stay fine: a repeated reaction no-ops.
      if (isSlackError(err, ['already_reacted'])) return;
      throw err;
    }
  }

  /** Remove a reaction this bot added (clears the transient "composing" 💭). The single app removes
   * its own reaction. A missing reaction (`no_reaction`) is a no-op. */
  async unreact(
    targetMessageId: string,
    emoji: string,
    _asBot: { id: string; name: string },
    channelId: string,
  ): Promise<void> {
    const parsed = parseSlackSurface(channelId);
    if (!parsed) return;
    const posted = this.postedIds.get(targetMessageId);
    const channel = posted?.channel ?? parsed.channel;
    const timestamp = posted?.ts ?? targetMessageId;
    if (!/^\d+\.\d+$/.test(timestamp)) {
      this.logger.debug(`no Slack ts for reaction target ${targetMessageId}`);
      return;
    }
    const args = { channel, timestamp, name: emojiToSlackName(emoji) };
    try {
      const ears = await this.clients.clientFor(parsed.teamId);
      await ears?.reactions.remove(args);
    } catch (err) {
      // Nothing to remove (never added) — fine, leave it be.
      if (isSlackError(err, ['no_reaction'])) return;
      throw err;
    }
  }

  private recordPostedId(
    id: string,
    ref: { channel: string; ts: string },
  ): void {
    this.postedIds.set(id, ref);
    if (this.postedIds.size > POSTED_ID_LRU_MAX) {
      const oldest = this.postedIds.keys().next().value;
      if (oldest !== undefined) this.postedIds.delete(oldest);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
