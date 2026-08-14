import type { RunningTurn } from "../engine/claude-engine.service.js";
import type { TurnUsage } from "../domain/message.js";

/** Typed while the query was still being set up, waiting for a handle to push it into. */
export type PreflightSteer = { id: string; text: string; deliver: () => void };

/**
 * One thread's slot. Threads run in parallel; turns within a thread do not — so everything that must
 * not be shared between two conversations lives here rather than on the service.
 */
export type Lane = {
  turnSeq: number;
  inFlight?: Promise<void>;
  chain: Promise<void>;
  preflight: PreflightSteer[];
  /**
   * The last occupancy this turn reported, in TOKENS — the form the nudge decides in, the meter
   * prints, and the session row stores. `contextLimit` is the window the engine reported on the
   * same frame; Codex's moves remotely, so it is carried rather than re-derived from the model name.
   */
  contextTokens?: number;
  contextLimit?: number;
  /**
   * Did this turn's FIRST prose block open with the canary — read off the text on its way to the
   * store, never off a rendered block, which always has the glyph stripped. `undefined` means the
   * turn has not spoken yet, which is not the same as a miss.
   */
  canary?: boolean;
  usage?: TurnUsage;
  /**
   * May this turn's account spend credits. Read from the row at spawn, for the same reason
   * `fastModeRequested` is: the frames that report on the wallet arrive later and carry no account.
   */
  extraUsageAllowed?: boolean;
  /**
   * Did Atlas ask for fast mode on this turn. Carried here because the answer comes back on the
   * result frame, by which point the applier no longer has the account row that asked — and an
   * unrequested `sdk_opt_in_required` is the default, not a failure worth reporting.
   */
  fastModeRequested?: boolean;
  turn?: RunningTurn;
};

/**
 * The lane map, the per-lane write chain, and the running-thread snapshot the UI subscribes to.
 *
 * Split out of `TurnRunnerService` because it is the one part with no engine, no repository and no
 * store in it: pure bookkeeping about what is running where. A single shared version of any of this
 * was a live bug once — job A's blocks rendering inside job B's transcript — so it is worth being
 * able to read the whole thing on one screen.
 *
 * Not a Nest provider: it holds the runner's private state and has exactly one owner. Injecting it
 * would invite a second consumer, which is precisely the bug.
 */
export class TurnLanes {
  private readonly lanes = new Map<string, Lane>();

  private snapshot: string[] = [];
  private readonly listeners = new Set<() => void>();

  /** Get or create. A lane exists only while something is happening in its thread. */
  for(threadId: string): Lane {
    const existing = this.lanes.get(threadId);
    if (existing) return existing;
    const lane: Lane = { turnSeq: 0, chain: Promise.resolve(), preflight: [] };
    this.lanes.set(threadId, lane);
    return lane;
  }

  /** Look, without creating — a steer into an idle thread must not conjure a lane for it. */
  peek(threadId: string): Lane | undefined {
    return this.lanes.get(threadId);
  }

  busy(threadId: string): boolean {
    return this.lanes.get(threadId)?.inFlight !== undefined;
  }

  /** An idle lane is just bookkeeping — dropping it keeps the map the size of what is running. */
  reap(threadId: string): void {
    const lane = this.lanes.get(threadId);
    if (!lane) return;
    if (lane.inFlight === undefined && lane.preflight.length === 0)
      this.lanes.delete(threadId);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getRunningThreadIds = (): string[] => this.snapshot;

  /**
   * Publish which threads are running. The snapshot is compared before it is replaced, because
   * `useSyncExternalStore` re-renders on identity: a new array every announce would repaint every
   * subscribed page on every turn event.
   */
  announce(): void {
    const ids = [...this.lanes.entries()]
      .filter(([, lane]) => lane.inFlight !== undefined)
      .map(([threadId]) => threadId)
      .sort();
    const unchanged =
      ids.length === this.snapshot.length &&
      ids.every((id, index) => id === this.snapshot[index]);
    if (unchanged) return;
    this.snapshot = ids;
    for (const listener of this.listeners) listener();
  }

  /** Claims the finished turn's usage and clears it, so the next turn cannot inherit it. */
  takeUsage(lane: Lane): TurnUsage | undefined {
    const usage = lane.usage;
    lane.usage = undefined;
    return usage;
  }

  /**
   * The engine emits events synchronously, but handling one means writing to the database. Running
   * those handlers concurrently raced two appends for the same thread ordinal — which is UNIQUE, so
   * one write was rejected, and being fire-and-forget it took the process down with it as an
   * unhandled rejection. One chain PER THREAD: in order, one at a time, and a failure is reported
   * through `onError` rather than thrown. Two threads have two chains, which is exactly right —
   * their ordinals are independent.
   *
   * An assistant frame carrying text AND a tool_use — the commonest frame there is — emits two
   * persisting events in the same tick, so this is the normal path, not an edge case.
   */
  enqueue(args: {
    lane: Lane;
    work: () => Promise<void>;
    onError: (detail: string) => void;
  }): void {
    args.lane.chain = args.lane.chain.then(args.work).catch((error: unknown) => {
      args.onError(error instanceof Error ? error.message : String(error));
    });
  }

  async settle(lane: Lane): Promise<void> {
    await lane.chain;
  }

  hold(args: { lane: Lane; steer: PreflightSteer }): void {
    args.lane.preflight.push(args.steer);
  }

  /**
   * The query is live — hand it everything typed while it was being set up. Cleared BEFORE the
   * handoff: a steer that the engine refuses is dequeued, and one that lands must not still be
   * sitting in the list for `drop` to dequeue a second time.
   */
  flush(args: { lane: Lane; dequeue: (id: string) => void }): void {
    const held = args.lane.preflight;
    args.lane.preflight = [];
    for (const steer of held) {
      if (!args.lane.turn?.steer(steer.text, steer.deliver)) args.dequeue(steer.id);
    }
  }

  /** The turn died before the query opened; nothing will ever pull these. No ghost entries. */
  drop(args: { lane: Lane; dequeue: (id: string) => void }): void {
    for (const steer of args.lane.preflight) args.dequeue(steer.id);
    args.lane.preflight = [];
  }
}
