import { EnvService } from '@core/config/env/env.service';
import { ConductorEventsBus } from '@harness/conductor/conductor-events.bus';
import type { AccumulatedUsage } from '@harness/domain/conductor-events';
import { CHAT_MODEL, formatUsageLine } from '@harness/llm/usage-format';
import type {
  ChatSurface,
  InboundChatMessage,
  OutboundChatMessage,
} from '@harness/surface/chat-surface.port';
import { Injectable, Logger } from '@nestjs/common';
import type { WebClient } from '@slack/web-api';
import { Observable, Subject } from 'rxjs';
import { SlackDirectoryService } from './slack-directory.service';
import { SlackIdentityRegistry } from './slack-identity.registry';
import type { SlackInboundEvent } from './slack-inbound.types';
import {
  isSlackError,
  parseSlackSurface,
  slackSurfaceId,
  withMembershipJoin,
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

/** Slack's membership-failure codes differ per method: puppets hit these in channels they
 * haven't joined → `conversations.join` + one retry, then fall back to the main app. */
const POST_MEMBERSHIP_ERRORS = ['not_in_channel', 'channel_not_found'];
const REACT_MEMBERSHIP_ERRORS = [
  'no_permission',
  'not_in_channel',
  'channel_not_found',
];

/**
 * The Slack ChatSurface — the real group chat. One Slack app posts for every employee via
 * `chat.postMessage` `username` overrides (`chat:write.customize`); inbound channel messages
 * become harness messages after mention translation and room registration. Transport-agnostic
 * since the inbound refactor: the SlackInboundRouter feeds `handleMessageEvent` from whichever
 * transport is live (Socket Mode in dev, the gateway listener on tenant stacks); acking is the
 * transport's job. v1 scope: top-level channel messages only (thread replies dropped), no Slack
 * DMs (non-`slack:` rooms skipped on post), single-human speaker attribution (`patchStatus({
 * speaker })` before each emit).
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

  /** `<AVATAR_BASE_URL>/<style>/<botId>.png`, or undefined → post without icons. The style
   * segment is the illustrated↔realistic feature toggle; hosting is swappable via the base URL
   * (raw GitHub today, the deployed web app later) without touching roster code. */
  private readonly avatarBase?: string;

  /** Channels where a puppet's join+retry already failed (private, uninvited) — warn once. */
  private readonly membershipFallbacks = new Set<string>();

  constructor(
    private readonly clients: TenantSlackClients,
    private readonly directory: SlackDirectoryService,
    private readonly identities: SlackIdentityRegistry,
    private readonly bus: ConductorEventsBus,
    env: EnvService,
  ) {
    const base = env.get('AVATAR_BASE_URL');
    if (base) {
      const style = env.get('AVATAR_STYLE') ?? 'illustrated';
      this.avatarBase = `${base.replace(/\/+$/, '')}/${style}`;
    }
  }

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
        if (id !== selfBotUserId) await this.directory.resolveUser(teamId, id);
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

  /** Deliver a bot message. An employee with a puppet token posts as their OWN bot user (no
   * username/icon overrides — the app identity IS the employee); everyone else (Jarvis, employees
   * without tokens) rides the main app + `username` override, exactly the pre-puppet behavior.
   * Non-Slack rooms (e.g. bot-minted `tui:dm:*`) are skipped — the message is already durable in
   * the channel log; Slack DMs are a v2 item.
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
    const puppet = await this.identities.clientFor(teamId, msg.authorBotId);
    // The ears app (username/icon override) is the fallback — used when there's no puppet AND when a
    // puppet's post fails membership (private channel). No puppet AND no ears token (workspace not
    // installed yet) → nothing to post with.
    const ears = await this.clients.clientFor(teamId);
    if (!puppet && !ears) {
      this.logger.warn(
        `no Slack client for ${teamId}/${msg.authorBotId} — dropping post to ${channel}`,
      );
      return;
    }

    const earsExtras: Record<string, unknown> = {
      username: msg.authorName,
      ...(this.avatarBase
        ? { icon_url: `${this.avatarBase}/${msg.authorBotId}.png` }
        : {}),
    };

    let lastErr: unknown;
    for (let attempt = 1; attempt <= POST_RETRIES; attempt++) {
      try {
        let res: { ts?: string; ok?: boolean; blocks?: unknown[] } | undefined;
        let usedClient: WebClient | undefined;

        if (puppet) {
          res = await this.tryWithJoin(
            puppet,
            channel,
            msg.authorBotId,
            POST_MEMBERSHIP_ERRORS,
            msg.usage
              ? () =>
                  this.postWithBlocksFallback(
                    // Cast at the Slack boundary: the helper uses Record<string, unknown> internally;
                    // the cast here is the single point where we cross into the SDK's union type.
                    (args) =>
                      puppet.chat.postMessage(
                        args as unknown as Parameters<
                          typeof puppet.chat.postMessage
                        >[0],
                      ),
                    { channel, text },
                    msg.text,
                    msg.usage!,
                    mentionMap.size > 0,
                  )
              : () => puppet.chat.postMessage({ channel, text }),
          );
          if (res) usedClient = puppet;
        }

        if (!res && ears) {
          res = msg.usage
            ? await this.postWithBlocksFallback(
                (args) =>
                  ears.chat.postMessage(
                    args as unknown as Parameters<
                      typeof ears.chat.postMessage
                    >[0],
                  ),
                { channel, text, ...earsExtras },
                msg.text,
                msg.usage,
                mentionMap.size > 0,
              )
            : await ears.chat.postMessage({
                channel,
                text,
                ...earsExtras,
              });
          if (res) usedClient = ears;
        }

        if (res?.ts) {
          this.recordPostedId(msg.id, { channel, ts: res.ts });
          // Attach uploaded files to the message via chat.update(file_ids).
          // The files were uploaded UNSHARED during the tool call; this step links them.
          // Re-send the SAME blocks the post used: `chat.update` with `text` and no `blocks`
          // REMOVES the existing blocks, which would strip the usage footer + mention Block Kit.
          //
          // Wrapped in its OWN try/catch — the message has already posted (recordPostedId above), so a
          // failed attach must NOT bubble into the retry loop (that would re-post a duplicate). Known
          // failure mode: the file was uploaded by the puppet but the post fell back to the ears
          // client (puppet not a channel member) — ears can't attach the puppet-owned private file.
          // Degrade to the message-without-file rather than duplicating or failing the turn.
          if (msg.fileIds?.length && usedClient) {
            try {
              await usedClient.chat.update({
                channel,
                ts: res.ts,
                text,
                ...(res.blocks ? { blocks: res.blocks } : {}),
                file_ids: msg.fileIds,
              } as unknown as Parameters<typeof usedClient.chat.update>[0]);
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
   * fallback (push notifications, accessibility). `baseArgs` carries channel + username/icon as a
   * plain record so the caller can freely spread extra fields without fighting SDK union types.
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
   * harness-minted bot-message id resolved through the posted-id LRU. An employee with a puppet
   * token reacts as their own bot user (the hover names THEM); otherwise the main app reacts. */
  async react(
    targetMessageId: string,
    emoji: string,
    asBot: { id: string; name: string },
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
      const puppet = await this.identities.clientFor(parsed.teamId, asBot.id);
      const reacted = puppet
        ? await this.tryWithJoin(
            puppet,
            channel,
            asBot.id,
            REACT_MEMBERSHIP_ERRORS,
            () => puppet.reactions.add(args),
          )
        : undefined;
      if (!reacted) {
        const ears = await this.clients.clientFor(parsed.teamId);
        await ears?.reactions.add(args);
      }
    } catch (err) {
      // Same-emoji collisions stay fine: per-identity duplicates (or two fallback bots) no-op.
      if (isSlackError(err, ['already_reacted'])) return;
      throw err;
    }
  }

  /** Remove a reaction this bot added (clears the transient "composing" 💭). Mirrors `react`'s
   * puppet-first/ears-fallback resolution — Slack only lets an identity remove its OWN reaction,
   * so the resolution order MUST match the add. A missing reaction (`no_reaction`) is a no-op. */
  async unreact(
    targetMessageId: string,
    emoji: string,
    asBot: { id: string; name: string },
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
      const puppet = await this.identities.clientFor(parsed.teamId, asBot.id);
      const removed = puppet
        ? await this.tryWithJoin(
            puppet,
            channel,
            asBot.id,
            REACT_MEMBERSHIP_ERRORS,
            () => puppet.reactions.remove(args),
          )
        : undefined;
      if (!removed) {
        const ears = await this.clients.clientFor(parsed.teamId);
        await ears?.reactions.remove(args);
      }
    } catch (err) {
      // Nothing to remove (never added, or added by the other identity) — fine, leave it be.
      if (isSlackError(err, ['no_reaction'])) return;
      throw err;
    }
  }

  /** Run a puppet call; on a membership failure, `conversations.join` (public channels — the
   * `channels:join` scope) and retry ONCE. Returns undefined when the join/retry also fails
   * (private channel, puppet not invited) — callers fall back to the main-app identity. Anything
   * that is NOT a membership failure (network, already_reacted, …) propagates to the caller's
   * own handling. Delegates the join-and-retry logic to `withMembershipJoin`; this method adds the
   * class-level dedup warn so private-channel fallbacks are only logged once. */
  private async tryWithJoin<T>(
    client: WebClient,
    channel: string,
    botId: string,
    membershipCodes: string[],
    call: () => Promise<T>,
  ): Promise<T | undefined> {
    return withMembershipJoin(client, channel, membershipCodes, call, () => {
      const key = `${botId}|${channel}`;
      if (!this.membershipFallbacks.has(key)) {
        this.membershipFallbacks.add(key);
        this.logger.warn(
          `puppet '${botId}' can't act in ${channel} (private channel? invite the bot) — falling back to the main app identity`,
        );
      }
    });
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
