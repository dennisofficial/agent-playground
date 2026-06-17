import type { ChannelService } from '../channel/channel.service';
import type { ChannelMsg } from '../channel/channel.types';

/**
 * READ-THE-ROOM (optimistic-concurrency posting) — the pieces of the feature that aren't the graph
 * wiring itself. A final text reply is composed BLIND for one model-invoke latency; during that
 * window the room can change: a teammate can answer the same broadcast, OR the user can send more
 * (often the rest of a message they typed in fragments). The `llm` node calls
 * {@link interleavedMessages} right after `model.invoke` returns (synchronously, same JS tick) and,
 * if anything landed, demotes its reply to a DRAFT and loops back through `llm` with
 * {@link revisionNote} appended — so the bot re-reads the room before posting.
 *
 * Kept in the `llm` node (not a separate graph node) on purpose: the suppress-or-commit choice can
 * only be made at the moment the node decides what to write to durable history, and the check must
 * be synchronous with that return to keep the single-winner-per-round guarantee.
 */

/** Max revision passes per turn. Each race round at most one bot posts (the synchronous check),
 * so N contending bots converge in ≤N rounds — 2 covers a realistic pileup; at the cap the draft
 * posts anyway (it already saw the earlier rounds — worst case equals the old blind behavior). The
 * same cap bounds a human typing fast in fragments: after 2 revisions the draft posts regardless. */
export const MAX_REVISION_PASSES = 2;

/** The revision instruction injected as the LAST trailing HumanMessage — strictly after both cache
 * breakpoints (volatile zone), so interpolating the draft never busts the prompt prefix. Author-
 * neutral on purpose: the messages that staled the draft may be a teammate's reply OR the user
 * adding to their own message, and the bot can tell which from the messages themselves — so this
 * must NOT push toward silence when the user simply finished a thought. */
export const revisionNote = (draft: string): string =>
  `(Heads-up: while you were composing, the messages above arrived — a teammate may have replied, or the user added more to their message. You drafted the following reply but it was NOT posted:\n"""\n${draft}\n"""\nRead the new messages first, then post a SINGLE reply that accounts for everything — revise it, extend it, or shorten it to a brief agreement. If your draft is now redundant or no longer makes sense (e.g. the user changed course), output NOTHING (an empty response) and stay silent.)`;

/**
 * Messages from anyone OTHER than this bot that landed in the channel past `sinceCursor` — i.e.
 * while this bot's model call was in flight. A non-empty result means the just-composed reply is
 * STALE: a teammate-bot may have answered the same broadcast, or the user sent more (e.g. the rest
 * of a fragmented message). Either way the bot re-reads before posting. Own messages are excluded —
 * humans carry no `authorBotId` (so they pass the filter), this bot's own posts carry `botId`.
 */
export const interleavedMessages = (
  channel: ChannelService,
  channelId: string,
  sinceCursor: number,
  botId: string,
): ChannelMsg[] =>
  channel.since(sinceCursor, channelId).filter((m) => m.authorBotId !== botId);
