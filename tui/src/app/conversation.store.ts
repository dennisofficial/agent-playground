import type { ContextReading } from "../domain/context-nudge.js";
import { NO_DELEGATES, reduceDelegates, retireRunning } from "../domain/delegates.js";
import type { EngineEvent, Message, TurnSummary } from "../domain/message.js";
import type { UsageWindow } from "../domain/usage.js";
import { EMPTY, type ConversationState, type LiveTail, type QueuedSteer, type RunningTool } from "./conversation-state.js";

// Re-exported: this module is the one every caller already imports, and which half of the pair a type
// lives in is not their business.
export {
  EMPTY,
  type ConversationState,
  type LiveTail,
  type QueuedSteer,
  type RunningTool,
} from "./conversation-state.js";

/**
 * One thread's observable state, read through `useSyncExternalStore`. One instance per thread, handed
 * out by `ConversationStoreRegistry` — turns run in parallel, and a shared instance rendered one
 * thread's output inside another's transcript.
 *
 * Delta writes coalesce on a frame tick and reveal a slice of their backlog per frame: the engine
 * hands over 20-30 characters at a time, which otherwise lands as a jump-then-stall.
 */

const FRAME_MS = 33;

/** How far the tail runs behind the wire — each frame releases the backlog divided by this in frames. */
const REVEAL_HORIZON_MS = 150;

/** Floor under the proportional slice, or a chunk's last characters trickle out one per frame. */
const REVEAL_MIN_CHARS = 3;

/** Past this much backlog, reveal everything at once — a replayed or batched burst is not a stream. */
const REVEAL_BURST_CAP = 600;

export class ConversationStore {
  private state: ConversationState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | undefined;
  private unrevealed = "";
  private unrevealedKind: "text" | "thinking" | null = null;
  /** Which standing conditions have already had their say. See `noticeOnce`. */
  private readonly announced = new Set<string>();

  /**
   * Deliberately outside `state`: the composer already holds the text it is editing, and routing every
   * keystroke through `patch` would wake every subscriber — the transcript included — to redraw for a
   * character it does not display. In memory only; a draft survives navigation, not a restart.
   */
  draft = "";

  getSnapshot = (): ConversationState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  reset(messages: Message[], closed = false): void {
    this.dropUnrevealed();
    // The notices these guarded are gone with the state, so the conditions get to speak again.
    this.announced.clear();
    this.state = { ...EMPTY, messages, closed };
    this.flush();
  }

  /** Re-seed the durable half from the database, leaving the live half of a running turn alone. */
  hydrate(
    messages: Message[],
    closed: boolean,
    lastTurn?: TurnSummary | null,
  ): void {
    const read = new Set(messages.map((message) => message.id));
    const arrivedSinceRead = this.state.messages.filter(
      (message) => !read.has(message.id),
    );
    // The ledger is only the floor: a turn that ran since this store was created knows better than the
    // database read that raced it, and a running turn has no finished summary at all.
    const memoryKnowsBetter = Boolean(this.state.lastTurn) || this.state.running;
    this.patch({
      messages: [...messages, ...arrivedSinceRead],
      closed,
      ...(lastTurn && !memoryKnowsBetter ? { lastTurn } : {}),
    });
  }

  /** A block became authoritative: it leaves the live tail and enters scrollback for good. */
  commit(message: Message): void {
    this.dropUnrevealed();
    this.patch({ messages: [...this.state.messages, message], tail: null });
  }

  appendDelta(kind: "text" | "thinking", text: string): void {
    const backlogIsForAFinishedBlock = this.unrevealedKind !== kind;
    if (backlogIsForAFinishedBlock) {
      this.unrevealed = "";
      this.unrevealedKind = kind;
    }
    this.unrevealed += text;
    // Counted on arrival, not on reveal: this meter tracks the engine's work, not the animation.
    this.patchOnNextFrame({
      outputTokens: this.state.outputTokens + estimateTokens(text),
    });
  }

  startTurn(): void {
    this.dropUnrevealed();
    this.patch({
      running: true,
      startedAt: Date.now(),
      outputTokens: 0,
      interrupting: false,
      tail: null,
      // Delegates belong to the CLI process that ran them, and the SDK emits no membership level at
      // startup. A set carried across a turn boundary is a set that can only be stale — one row per
      // agent that died with the last process, spinning forever. See `background_tasks`.
      delegates: NO_DELEGATES,
      holding: false,
    });
  }

  /**
   * `engineSummary` is real token counts read off the terminal frame; without one the working line
   * falls back to wall clock and the character-count estimate. Only real numbers reach the turn
   * ledger, so a reopened thread never shows an estimate dressed as a total.
   */
  endTurn(engineSummary?: TurnSummary): void {
    this.dropUnrevealed();
    const { startedAt, outputTokens, lastTurn } = this.state;
    const fallback: TurnSummary | null =
      startedAt === null
        ? lastTurn
        : { durationMs: Date.now() - startedAt, outputTokens };
    this.patch({
      running: false,
      startedAt: null,
      tail: null,
      runningTool: null,
      interrupting: false,
      holding: false,
      // The turn ending closed the session, which ended the CLI process, which took every delegate
      // with it. A row still saying `running` under the composer would be a spinner for an agent that
      // no longer exists — see `retireRunning` for the two ways a turn can end with one still live.
      delegates: retireRunning(this.state.delegates, Date.now()),
      lastTurn: engineSummary ?? fallback,
    });
  }

  /**
   * A delegate frame, folded into the live index. Live-only by construction — nothing here reaches a
   * repository, which is the whole point: a delegate's work is counted, never quoted.
   */
  observeDelegate(event: EngineEvent): void {
    const delegates = reduceDelegates(this.state.delegates, event, Date.now());
    // The reducer returns the same array when a frame changed nothing — a `task_progress` repeating a
    // count arrives every few seconds and must not repaint the transcript for saying nothing new.
    if (delegates === this.state.delegates) return;
    this.patch({ delegates });
  }

  /** The model is done but a backgrounded delegate is not, so the session stays open. See `holding`. */
  setHolding(holding: boolean): void {
    if (this.state.holding === holding) return;
    this.patch({ holding });
  }

  startTool(tool: NonNullable<RunningTool>): void {
    this.dropUnrevealed();
    this.patch({ runningTool: tool, tail: null });
  }

  endTool(): void {
    this.patch({ runningTool: null });
  }

  markInterrupting(): void {
    this.patch({ interrupting: true });
  }

  enqueue(steer: QueuedSteer): void {
    this.patch({ queued: [...this.state.queued, steer] });
  }

  dequeue(id: string): void {
    this.patch({ queued: this.state.queued.filter((q) => q.id !== id) });
  }

  clearQueue(): void {
    this.patch({ queued: [] });
  }

  setContextReading(reading: ContextReading | null): void {
    this.patch({ contextReading: reading });
  }

  /**
   * Set on open and at every turn boundary, both ways: adding an account has to clear it without a
   * reload, and forgetting the last one has to show it the same way.
   */
  setNoAccount(reason: string | null): void {
    if (this.state.noAccount === reason) return;
    this.patch({ noAccount: reason });
  }

  setUsage(window: "fiveHour" | "sevenDay", value: UsageWindow): void {
    this.patch(
      window === "fiveHour" ? { fiveHour: value } : { sevenDay: value },
    );
  }

  notice(text: string): void {
    this.patch({ notices: [...this.state.notices, text] });
  }

  /**
   * A notice about a CONDITION rather than an event — said when it starts, and not again while it
   * holds.
   *
   * Notices accumulate into the transcript forever, so a line re-emitted at every turn boundary
   * builds a wall of identical rows. Both of this method's callers describe standing states ("this
   * account is spending credits", "the server will not serve fast mode"), and the server restates
   * them on every request; whether they are worth a row is a question about the state changing, not
   * about a frame arriving.
   *
   * The keys live outside `state` for the same reason `draft` does: they are bookkeeping about what
   * has been said, not something anything renders.
   */
  noticeOnce(key: string, text: string): void {
    if (this.announced.has(key)) return;
    this.announced.add(key);
    this.notice(text);
  }

  /** The condition lifted: let it announce itself again if it comes back. Prefix, so a family clears together. */
  forgetNotices(prefix: string): void {
    for (const key of this.announced) {
      if (key.startsWith(prefix)) this.announced.delete(key);
    }
  }

  setClosed(closed: boolean): void {
    this.patch({ closed });
  }

  private patch(partial: Partial<ConversationState>): void {
    this.state = { ...this.state, ...partial };
    this.flush();
  }

  private patchOnNextFrame(partial: Partial<ConversationState>): void {
    this.state = { ...this.state, ...partial };
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.reveal();
      this.flush();
    }, FRAME_MS);
  }

  private reveal(): void {
    const kind = this.unrevealedKind;
    if (!this.unrevealed || !kind) return;
    const take = this.withoutSplittingSurrogatePair(this.revealSize());
    const tail = this.state.tail;
    const base = tail && tail.kind === kind ? tail.text : "";
    this.state = {
      ...this.state,
      tail: { kind, text: base + this.unrevealed.slice(0, take) },
    };
    this.unrevealed = this.unrevealed.slice(take);
  }

  /**
   * Proportional drain rather than a measured character rate, because a rate estimate is open-loop and
   * its error accumulates: guess low and the tail falls further behind every chunk, guess high and it
   * drains empty and stalls between them. Dividing the backlog makes arrival rate the input, so the
   * reveal tracks any speed and settles about one horizon behind the wire.
   */
  private revealSize(): number {
    const backlog = this.unrevealed.length;
    if (backlog > REVEAL_BURST_CAP) return backlog;
    const frames = Math.max(1, Math.round(REVEAL_HORIZON_MS / FRAME_MS));
    return Math.min(
      backlog,
      Math.max(REVEAL_MIN_CHARS, Math.ceil(backlog / frames)),
    );
  }

  private dropUnrevealed(): void {
    this.unrevealed = "";
    this.unrevealedKind = null;
  }

  private withoutSplittingSurrogatePair(size: number): number {
    const code = this.unrevealed.charCodeAt(size - 1);
    const highSurrogate = code >= 0xd800 && code <= 0xdbff;
    return highSurrogate && size < this.unrevealed.length ? size + 1 : size;
  }

  private flush(): void {
    // A backlog owns the timer: restarting it on every structural notify would push the next reveal out
    // a full frame each time, and a busy turn could starve the animation entirely.
    if (this.timer && !this.unrevealed) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const listener of this.listeners) listener();
    if (this.unrevealed) this.schedule();
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
