import type { Message, TurnSummary } from "../domain/message.js";
import type { UsageWindow } from "../domain/usage.js";

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

export type LiveTail = { kind: "text" | "thinking"; text: string } | null;

export type RunningTool = {
  toolUseId: string;
  name: string;
  target?: string | undefined;
  startedAt: number;
  lines: string[];
} | null;

export type QueuedSteer = { id: string; text: string };

export type ConversationState = {
  messages: Message[];
  tail: LiveTail;
  runningTool: RunningTool;
  running: boolean;
  startedAt: number | null;
  outputTokens: number;
  lastTurn: TurnSummary | null;
  interrupting: boolean;
  queued: QueuedSteer[];
  contextPercent: number | null;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  notices: string[];
  /** Set when another instance holds this thread's session lock. */
  closed: boolean;
};

const EMPTY: ConversationState = {
  messages: [],
  tail: null,
  runningTool: null,
  running: false,
  startedAt: null,
  outputTokens: 0,
  lastTurn: null,
  interrupting: false,
  queued: [],
  contextPercent: null,
  fiveHour: null,
  sevenDay: null,
  notices: [],
  closed: false,
};

export class ConversationStore {
  private state: ConversationState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | undefined;
  private unrevealed = "";
  private unrevealedKind: "text" | "thinking" | null = null;

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
      lastTurn: engineSummary ?? fallback,
    });
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

  setContextPercent(percent: number | null): void {
    this.patch({ contextPercent: percent });
  }

  setUsage(window: "fiveHour" | "sevenDay", value: UsageWindow): void {
    this.patch(
      window === "fiveHour" ? { fiveHour: value } : { sevenDay: value },
    );
  }

  notice(text: string): void {
    this.patch({ notices: [...this.state.notices, text] });
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
