import type { ChannelService } from '../channel/channel.service';
import type { ChannelMsg } from '../channel/channel.types';

/**
 * READ-THE-ROOM (optimistic-concurrency posting) — the pieces of the feature that aren't the graph
 * wiring itself. A final text reply is composed BLIND for one model-invoke latency; a teammate
 * answering the same broadcast can post during that window. The `llm` node calls
 * {@link interleavedTeammates} right after `model.invoke` returns (synchronously, same JS tick) and,
 * if anything landed, demotes its reply to a DRAFT and loops back through `llm` with
 * {@link revisionNote} appended — so the bot re-reads the room before posting.
 *
 * Kept in the `llm` node (not a separate graph node) on purpose: the suppress-or-commit choice can
 * only be made at the moment the node decides what to write to durable history, and the check must
 * be synchronous with that return to keep the single-winner-per-round guarantee.
 */

/** Max revision passes per turn. Each race round at most one bot posts (the synchronous check),
 * so N contending bots converge in ≤N rounds — 2 covers a realistic pileup; at the cap the draft
 * posts anyway (it already saw the earlier rounds — worst case equals the old blind behavior). */
export const MAX_REVISION_PASSES = 2;

/** The revision instruction injected as the LAST trailing HumanMessage — strictly after both cache
 * breakpoints (volatile zone), so interpolating the draft never busts the prompt prefix. */
export const revisionNote = (draft: string): string =>
  `(Heads-up: while you were composing, the messages above arrived. You drafted the following reply but it was NOT posted:\n"""\n${draft}\n"""\nRead the new messages first. Post only if your reply still adds something beyond what teammates already said — revise it, or shorten it to a brief agreement. If it's now redundant, output NOTHING (an empty response) and stay silent.)`;

/**
 * Teammate-BOT messages that landed in the channel past `sinceCursor` — i.e. while this bot's
 * model call was in flight. A non-empty result means the just-composed reply is STALE. Only
 * teammate-bot interleaves count: a human message landing mid-compose folds into the next gate/turn
 * as usual rather than forcing a rewrite of a finished reply.
 */
export const interleavedTeammates = (
  channel: ChannelService,
  channelId: string,
  sinceCursor: number,
  botId: string,
): ChannelMsg[] =>
  channel
    .since(sinceCursor, channelId)
    .filter((m) => m.authorBotId && m.authorBotId !== botId);
