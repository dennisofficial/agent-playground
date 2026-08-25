import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type ResultMessage = Extract<SDKMessage, { type: "result" }>;

/**
 * The one `result` shape that does not mean the turn is over.
 *
 * A session that is held open past `result` can be woken by the CLI's own orphan-recovery path: a
 * previous process exited with background work in flight, and this session opens to a run of
 * tombstones — *"Orphaned by a previous Claude Code process exit"* — which are delivered, consumed,
 * and answered with a `result` that did no work whatsoever. From the probe tape:
 *
 * ```
 * NOTIF stopped ×3   INIT
 * RESULT {"subtype":"success","terminal_reason":null,"stop_reason":null,
 *         "num_turns":0,"usage":<all zero>,"origin":{"kind":"task-notification"}}
 * ```
 *
 * Nothing is live by then — the tombstones settled everything — so the hold's verdict is `end` and
 * the turn finishes having done nothing. `~/.atlas/atlas.db` corroborates: of 10 `Turn` rows, 3 carry
 * all-zero usage, one of them `ok=1 durationMs=2361`.
 *
 * **The polarity is the whole design.** A false "this ends the turn" costs one early turn; a false
 * "this does not" wedges the lane forever, because when the live set is empty no timer is armed and
 * nothing else will ever re-evaluate. So this is an ALLOWLIST — a result is non-terminal only when
 * positively identified as one — and every shape not enumerated here ends the turn.
 *
 * Two conditions, and both are load-bearing:
 *
 * - **The delivery was a wake-up.** `origin` is unset on a turn the human started and set on one a
 *   notification or an auto-continuation started.
 * - **It did no work.** `terminal_reason` and `stop_reason` are null and `num_turns` is 0, meaning
 *   the sampling loop was never entered.
 *
 * Dropping the second condition was the first draft of this and it was wrong. Atlas's own tapes carry
 * two results with `origin:{kind:'task-notification'}` AND `terminal_reason:'completed'` — a delegate
 * settled, the model woke, worked, and ended its turn properly, with 235 and 22,995 output tokens.
 * Those are the SUCCESS path of the entire hold feature, and treating them as non-terminal would hold
 * every one of them open for a grace window it has no use for.
 *
 * Dropping the first condition is the mirror-image trap: a local slash command (`/context`, `/status`,
 * `/model`, `Unknown command: /thread`) also reports `terminal_reason:null, stop_reason:null,
 * num_turns:0`, because `TerminalReason` is documented *"Unset when the loop was bypassed"*. Those are
 * ordinary turn ends, they have no origin, and any predicate keying on the null fields alone wedges
 * the lane on every one of them.
 */
export function isWakeUpOnly(message: ResultMessage): boolean {
  // Checked here rather than left to the one call site: this is the predicate the whole polarity
  // argument rests on, and it should be true standing on its own.
  if (message.subtype !== "success" || message.is_error) return false;

  const kind = message.origin?.kind;
  if (kind !== "task-notification" && kind !== "auto-continuation") return false;

  // `terminal_reason` is optional and `stop_reason` is nullable; absent and null are the same claim
  // here, which is that the sampling loop was never entered.
  return (
    message.terminal_reason == null &&
    message.stop_reason == null &&
    message.num_turns === 0
  );
}
