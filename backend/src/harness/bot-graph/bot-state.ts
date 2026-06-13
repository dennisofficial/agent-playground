import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { ChannelMsg } from '../channel/channel.types';
import type { GateAction, MessageUsage } from '../domain/conductor-events';

/** What the conductor reads out of a node's streamed delta (a partial of BotState). */
export interface BotStateDelta {
  messages?: BaseMessage[];
  cursor?: number;
  decision?: GateAction;
  ackEmoji?: string;
  /** A reaction emoji to surface immediately — the gate's "seen, working" 👀 on a real respond. */
  reaction?: string;
  /** The channel-message id this turn's reaction (👀 or ack) is ON — chosen HERE in the graph so the
   * conductor can tell the surface which message to fold the reaction into. */
  reactionTargetId?: string;
  /** The pre-LLM recall's `recalled` block — the conductor emits a `recall` event from it. */
  recalled?: string;
  /** Debug only: the soft gate's one-line rationale. Absent for hard rules. */
  reasoning?: string;
  /** Debug only: token usage for this turn's gate call. Absent for hard rules. */
  gateUsage?: { input: number; output: number };
  /** Set by the `loop_guard` node when a no-progress loop is detected — routes to `pause`. */
  loopBreak?: boolean;
  /** Debug only: the guard's one-line rationale. NOT named `reasoning` to avoid conflation with
   * the gate event the conductor emits on `delta.reasoning`. Rides in the checkpoint only. */
  guardReasoning?: string;
  /** A reply suppressed at the post seam (teammates posted mid-compose) — the conductor emits a
   * `draft` debug event from it. NEVER appears in `messages`, so the commit loop can't post it. */
  draft?: string;
  /** Token usage of the suppressed draft step — still a billed call: the conductor emits a normal
   * `usage` event from it so the per-post footer stays the true turn total. */
  draftUsage?: MessageUsage;
  /** Read-the-room revision passes taken this turn (debug only in the delta). */
  revisionPasses?: number;
}

export const BotState = Annotation.Root({
  /** The bot's persisted conversation (the real, durable history). */
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  /** Delivered-up-to seq. Overwritten from the conductor each run (see header). */
  cursor: Annotation<number>({
    reducer: (_: number, b: number) => b ?? 0,
    default: () => 0,
  }),
  /** Forces the respond path, gate-bypassed — used for job relays (a seeded synthetic message). */
  forced: Annotation<boolean>({
    reducer: (_: boolean, b: boolean) => b ?? false,
    default: () => false,
  }),
  /** Gate verdict for this turn (drives the conditional edge out of `gate`). */
  decision: Annotation<GateAction>({
    reducer: (_: GateAction, b: GateAction) => b ?? 'ignore',
    default: () => 'ignore',
  }),
  /** Ack emoji, surfaced when the gate said acknowledge. */
  ackEmoji: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** The "seen, working" reaction the gate emits the moment it commits to a (non-forced) respond. */
  reaction: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** The channel-message id this turn's reaction is on (the gated message). */
  reactionTargetId: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** Debug only: the soft gate's rationale this turn. */
  reasoning: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** Debug only: token usage for this turn's gate call. */
  gateUsage: Annotation<{ input: number; output: number } | undefined>({
    reducer: (_: unknown, b: { input: number; output: number } | undefined) =>
      b,
    default: () => undefined,
  }),
  /** The non-own batch the gate decided on — consumed by `mark_seen` on the ack/ignore path. */
  pending: Annotation<ChannelMsg[]>({
    reducer: (_: ChannelMsg[], b: ChannelMsg[]) => b ?? [],
    default: () => [],
  }),
  /** Ephemeral pre-LLM memory context (the `recall` node's output). Re-injected each llm call
   * like the persona, NEVER written into `messages`. Overwritten on EVERY path — by `recall`
   * (respond) and reset by `mark_seen` (ack/ignore) — so a stale recall never survives the
   * checkpoint. */
  recalled: Annotation<string>({
    reducer: (_: string, b: string) => b ?? '',
    default: () => '',
  }),
  /** `messages.length` at the start of this turn (set by `gate`), so reconcile can slice just this
   * turn's exchange out of the full persisted history. */
  turnStart: Annotation<number>({
    reducer: (_: number, b: number) => b ?? 0,
    default: () => 0,
  }),
  /** Set by the `loop_guard` node when a no-progress loop is detected. Routes to `pause` instead of
   * `recall`. Reset to false on every run (default) so a prior pause doesn't poison the next turn. */
  loopBreak: Annotation<boolean>({
    reducer: (_: boolean, b: boolean) => b ?? false,
    default: () => false,
  }),
  /** Debug only: the guard's one-line rationale for this turn. Absent when the guard skipped or
   * when `loopBreak` is false. Rides in the checkpoint; never surfaced in the event stream. */
  guardReasoning: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** READ-THE-ROOM: the unposted reply from a step that went stale mid-compose (a teammate posted
   * during model.invoke). Survives exactly one edge — llm → llm — where the revision note
   * carries it back to the model. NEVER enters `messages`: durable history records only what was
   * actually said. Reset explicitly by `gate` every run (Annotation defaults don't re-apply on an
   * existing thread), so a draft orphaned by a crash is dropped, never replayed. */
  draft: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** Usage of the suppressed draft step (billed even though unposted). Reset with `draft`. */
  draftUsage: Annotation<MessageUsage | undefined>({
    reducer: (_: unknown, b: MessageUsage | undefined) => b,
    default: () => undefined,
  }),
  /** Revision passes taken THIS turn — bounds the read-the-room loop at MAX_REVISION_PASSES.
   * Reset explicitly by `gate` every run. */
  revisionPasses: Annotation<number>({
    reducer: (_: number, b: number) => b ?? 0,
    default: () => 0,
  }),
});

export type BotStateType = typeof BotState.State;
