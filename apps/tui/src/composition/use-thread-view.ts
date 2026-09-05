import type { Event, ModelRef, ModelUsage, ThreadId } from "@dltech/atlas-core";
import type { TurnSpend } from "@dltech/atlas-harness";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  createConversationStore,
  sameEvents,
  type ConversationStore,
  type EThinkingVisibility,
  type SidebarModel,
  type TranscriptModel,
} from "../store";
import type { TurnClock } from "../ui/components/transcript";
import type { AtlasApp } from "./compose";
import { readThreadSpend } from "./thread-spend";
import {
  IDLE_PROGRESS,
  turnObserved,
  type TurnProgress,
} from "./turn-progress";

/**
 * Which rows of a thread the view reads.
 *
 * A conversation reads the composed view, because a fork inherits its parent's prefix and has to
 * see it. A sub-agent reads only what it owns: it inherits nothing, so the composed read would put
 * the thread that spawned it above its own first word.
 */
export enum EThreadRows {
  Composed = "composed",
  Own = "own",
}

export type ThreadSeed = {
  events: readonly Event[];
  turns?: readonly TurnSpend[] | undefined;
};

export type ThreadView = {
  store: ConversationStore;
  model: TranscriptModel;
  sidebar: SidebarModel;
  events: readonly Event[];
  turn: TurnClock;
  progress: TurnProgress;
  refresh: () => Promise<void>;
  setEvents: (events: readonly Event[]) => void;
  stamp: (advance: (progress: TurnProgress) => TurnProgress) => void;
};

const NO_EVENTS: readonly Event[] = Object.freeze([]);

/**
 * One thread as something on screen: its transcript, its sidebar reading and its turn clock, fed by
 * the log it owns and the channel it publishes on.
 *
 * Parameterised by `threadId` and nothing else, which is the whole point — the root conversation and
 * an open sub-agent are the same mechanism pointed at different threads, so a fix to streaming or to
 * the clock lands on both. What differs between them is not what they are but what drives them: a
 * conversation is driven from the keyboard and stamps its own clock through `stamp`, while a child
 * is driven by the supervisor and has only the channel to go on.
 */
export function useThreadView(args: {
  app: AtlasApp;
  threadId: ThreadId;
  rows: EThreadRows;
  thinking: EThinkingVisibility;
  /** Absent on child threads — a sub-agent's log holds no footers, so the default shows them. */
  tldrStatus?: boolean;
  readClock: () => number;
  /**
   * Rows already read by whoever opened the thread, as a getter so that swapping conversations
   * hands the fresh store the rows of the thread it is actually for. Absent means nobody has read
   * them, so the view reads the log itself on mount — which is how an open sub-agent gets its
   * transcript.
   */
  initial?: (() => ThreadSeed) | undefined;
  paceReveal?: boolean;
  projectEvents?: ((args: { events: readonly Event[] }) => void) | undefined;
  /** Fired after every read, for a caller holding something the rows settle. */
  afterRead?: ((events: readonly Event[]) => void) | undefined;
  /**
   * What the model reported spending. Only a conversation passes this: a child runs its own window
   * and folding its usage into the parent's meter would make the parent's remaining context a lie.
   */
  onUsage?: ((usage: ModelUsage) => void) | undefined;
}): ThreadView {
  const { app, threadId, rows, thinking, readClock, initial } = args;
  const tldrStatus = args.tldrStatus ?? true;
  const { afterRead, onUsage, projectEvents } = args;

  const paceReveal = args.paceReveal ?? false;

  const [events, setEventsState] = useState<readonly Event[]>(
    () => initial?.().events ?? NO_EVENTS,
  );
  /**
   * A refresh that re-read the log it already has must not cost a render: the OpenTUI reconciler
   * commits even when a setState updater returns its current value, so the no-op case never
   * dispatches. The ref holds the truth synchronously, where the state lags a commit behind.
   */
  const heldEvents = useRef(events);
  const setEvents = useCallback((next: readonly Event[]) => {
    if (sameEvents({ left: heldEvents.current, right: next })) return;

    heldEvents.current = next;
    setEventsState(next);
  }, []);
  const [progress, setProgress] = useState<TurnProgress>(IDLE_PROGRESS);
  const characters = useRef(0);

  /**
   * `characters` counts for the token estimate but is not itself on screen, so a chunk that moves
   * only it must not cost a render — the ref keeps the count while the state keeps the clock. The
   * clock is compared ahead of dispatch for the same reason: the OpenTUI reconciler commits even
   * when an updater returns its current value, so an unchanged clock never reaches setProgress.
   */
  const heldProgress = useRef(progress);
  const stamp = useCallback(
    (advance: (progress: TurnProgress) => TurnProgress) => {
      const current = heldProgress.current;
      const next = advance({ characters: characters.current, clock: current.clock });
      characters.current = next.characters;
      if (next.clock === current.clock) return;

      heldProgress.current = next;
      setProgress(next);
    },
    [],
  );

  const priceOf = useCallback(
    (ref: ModelRef) => app.models.cardFor(ref)?.cost,
    [app.models],
  );

  const store = useMemo(() => {
    const seed = initial?.();

    return createConversationStore({
      channel: app.channel,
      threadId,
      events: seed?.events ?? NO_EVENTS,
      ...(seed?.turns === undefined ? {} : { turns: seed.turns }),
      paceReveal,
      priceOf,
      sandbox: app.containerStatus,
      ...(projectEvents === undefined ? {} : { projectEvents }),
    });
  }, [app.channel, app.containerStatus, threadId, paceReveal, priceOf, projectEvents, initial]);

  /**
   * A conversation swapped for another one arrives as a fresh getter, and the rows it already read
   * are the ones to show — the store was just rebuilt around them, so the hook's own copy has to
   * follow or the two disagree about what the thread says.
   */
  useEffect(() => {
    if (initial === undefined) return;

    setEvents(initial().events);
  }, [initial, setEvents]);

  useEffect(() => () => store.dispose(), [store]);

  useEffect(() => store.setThinking(thinking), [store, thinking]);
  useEffect(() => store.setTldrStatus(tldrStatus), [store, tldrStatus]);

  const readRows = useCallback(
    (): Promise<readonly Event[]> =>
      rows === EThreadRows.Own
        ? app.log.readOwn({ threadId })
        : app.log.read({ threadId }),
    [app.log, rows, threadId],
  );

  const refresh = useCallback(async () => {
    const [read, spent] = await Promise.all([
      readRows(),
      readThreadSpend({ ledger: app.ledger, threadId }),
    ]);
    store.setEvents({ events: read, turns: spent.turns });
    setEvents(read);
    afterRead?.(read);
  }, [afterRead, app.ledger, readRows, store, threadId]);

  /**
   * A thread nobody handed rows for reads them itself, once, on the way in. The channel replays the
   * step in flight to a late subscriber, so a sub-agent opened mid-step catches up on that step
   * without anything polling for it.
   */
  const load = useRef(refresh);
  load.current = refresh;
  useEffect(() => {
    if (initial !== undefined) return;

    void load.current().catch(() => undefined);
  }, [initial, threadId]);

  useEffect(
    () =>
      app.channel.subscribe({
        threadId,
        listener: (signal) => {
          stamp((current) => turnObserved({ progress: current, signal, now: readClock() }));

          if (signal.type === "chunk" && signal.chunk.type === "finish") {
            const { usage } = signal.chunk;
            if (usage !== undefined) onUsage?.(usage);
          }

          /**
           * A step opening means the log already moved — something was appended to prompt it. Not
           * everything that writes to a thread writes through the publishing log: the supervisor
           * appends the operator's message to a child and then steps it, so without this the
           * operator's own words would not appear until the child had finished answering them.
           */
          if (
            signal.type === "step-started" ||
            signal.type === "step-ended" ||
            signal.type === "events-appended"
          ) {
            void refresh();
          }
        },
      }),
    [app.channel, onUsage, readClock, refresh, stamp, threadId],
  );

  const model = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const sidebar = useSyncExternalStore(store.subscribe, store.getSidebar);

  const turn = progress.clock;

  useEffect(() => store.setTurn(turn), [store, turn]);

  return {
    store,
    model,
    sidebar,
    events,
    turn,
    progress,
    refresh,
    setEvents,
    stamp,
  };
}
