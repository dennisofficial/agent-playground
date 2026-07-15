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
import { agentMessage, fromExternal, type AgentMessage } from '../message';
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

/**
 * Frame a NON-operator seed turn: the body is an already-framed/raw passthrough (an event, halt, or seed body —
 * it cannot be a `<user>` chunk), so render only the prefix chunks and join prefix + body with a single newline
 * (body alone when there is no prefix). Same frame as {@link composeTurn}, kept separate because the body bypasses
 * `<user>` rendering; the caller marks the non-hub body via `fromExternal` at the seam. Byte-identical to the old
 * inline `framedPrefix ? `${framedPrefix}\n${body}` : body`.
 */
export function composeSeedTurn(
  prefixChunks: TurnChunk[],
  body: AgentMessage,
): AgentMessage {
  const framedPrefix = renderTurn(prefixChunks);
  return agentMessage(framedPrefix ? `${framedPrefix}\n${body}` : body);
}

/**
 * Prepend a one-time system notice (e.g. the sandbox-reset notice on a cold re-attach + resume) to a resumed
 * turn's task, joining notice + task with a blank line. The notice text is authored outside prompt-kit (it lives
 * with the engine types), so it crosses the seam via `fromExternal`; the hub owns the fold + mint rather than the
 * caller free-handing an `agentMessage`. Byte-identical to `${notice}\n\n${task}`.
 */
export function prependNotice(
  notice: string,
  task: AgentMessage,
): AgentMessage {
  return agentMessage(`${fromExternal(notice)}\n\n${task}`);
}
