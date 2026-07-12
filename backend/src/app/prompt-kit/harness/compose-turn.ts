/**
 * prompt-kit / harness — `composeTurn` (Thread 5, decision d18).
 *
 * The hub-owned assembly of ONE agent turn: a set of PREFIX chunks (system_notice / system_reminder — pipeline
 * awareness, open-questions, and the JIT turn-prefix rail's reserved `memory` slot) framing a set of chronological
 * `<user>` chunks (one per coalesced operator message). This is pure framing over the one tag vocabulary
 * (`renderTurn`) — no live state, no I/O — lifted out of `agent-session-manager`'s `runChatTurnInner` so operator
 * messages, system seeds, and JIT prepends compose through a SINGLE tested function instead of ad-hoc string glue.
 *
 * Output is byte-identical to the old inline assembly (`framedPrefix ? `${framedPrefix}\n${body}` : body`):
 * `renderTurn` already orders notices → reminders → untrusted → `<user>` (last) and keeps same-kind chunks in
 * input order, so coalesced `<user>` chunks stay chronological and a prefix always renders before the bubble.
 */
import { agentMessage, type AgentMessage } from '../message';
import { renderTurn, type TurnChunk } from './tag-vocabulary';

export type ComposeTurnInput = {
  /** system_notice / system_reminder chunks that frame the turn (rendered before the `<user>` bubble). */
  prefixChunks: TurnChunk[];
  /** One `<user>` chunk per operator message, in chronological (oldest-first) order. */
  userChunks: TurnChunk[];
};

/**
 * Frame a turn: render the prefix chunks and the chronological `<user>` chunks through the one tag vocabulary,
 * joining prefix + body with a single newline (and emitting body alone when there is no prefix). Returns a
 * hub-minted {@link AgentMessage}.
 */
export function composeTurn(input: ComposeTurnInput): AgentMessage {
  const framedPrefix = renderTurn(input.prefixChunks);
  const body = renderTurn(input.userChunks);
  return agentMessage(framedPrefix ? `${framedPrefix}\n${body}` : body);
}
