/**
 * One message in the channel — the shared, append-only log that IS the conversation. Everyone (the
 * human and every bot) writes to it asynchronously; nobody waits. `seq` is the monotonic cursor
 * coordinate: a bot tracks how far it has consumed via `since(cursor)`.
 * (Ported from playground/src/channel.ts.)
 */
export interface ChannelMsg {
  /** Monotonic position — the cursor coordinate. */
  seq: number;
  /** Stable id (for dedupe + UI keys + streaming re-emits). Surface-native when the surface has
   * one (Slack ts); minted otherwise. Unique per channel, NOT globally — identity is (channelId, id). */
  id: string;
  /** Channel/thread coordinate the message belongs to, e.g. 'tui:main' | 'slack:C042:1712.5678'. */
  channelId: string;
  /** Display name ("Dennis", "Alex"). */
  author: string;
  /** Scope id ("dennis", "alex"). */
  authorId: string;
  /** Set when a bot authored it. */
  authorBotId?: string;
  text: string;
}
