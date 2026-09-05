import type { ThreadId, Event } from "@dltech/atlas-core";
import type {
  ChannelSignal,
  DeltaChannel,
  TurnSpend,
  Unsubscribe,
} from "@dltech/atlas-harness";

import { IDLE_TURN, type TurnClock } from "../ui/components/transcript";
import { assembleTranscript } from "./derive-transcript";
import { durableEntries } from "./durable-entries";
import {
  advancedGate,
  attachedGate,
  FRAME_MS,
  gateIsDraining,
  type RevealGate,
} from "./reveal";
import {
  sameSidebar,
  sidebarFoldOf,
  sidebarFrom,
  type SidebarContainer,
  type SidebarEventFold,
  type SidebarModel,
} from "./sidebar-model";
import { watchSandbox, type SandboxStatusSource } from "./sandbox-source";
import { pendingTldrOf, subscribeTldrFeed } from "../ui/tldr-feed-store";
import { sameEvents, sameTurns } from "./same-log";
import type { ModelPriceLookup } from "./sidebar-spend";
import { stabilisedEntries } from "./stable-entries";
import { createStepTracker } from "./step-tracker";
import { SHIPPED_THINKING, type EThinkingVisibility } from "./thinking-fold";
import type {
  StepFailure,
  TranscriptEntry,
  TranscriptModel,
} from "./transcript-model";

export type ConversationStore = {
  subscribe(listener: () => void): Unsubscribe
  getSnapshot(): TranscriptModel
  getSidebar(): SidebarModel
  setEvents(args: { events: readonly Event[]; turns?: readonly TurnSpend[] | undefined }): void
  setTurn(turn: TurnClock): void
  supersedeFailure(): void
  resetSteps(): void
  setThinking(thinking: EThinkingVisibility): void
  setTldrStatus(tldrStatus: boolean): void
  setName(name: string | null): void
  dispose(): void
}

const NO_TURNS: readonly TurnSpend[] = Object.freeze([])

export function createConversationStore(args: {
  channel: DeltaChannel;
  threadId: ThreadId;
  events?: readonly Event[];
  turns?: readonly TurnSpend[];
  paceReveal?: boolean;
  thinking?: EThinkingVisibility;
  name?: string | null;
  priceOf?: ModelPriceLookup | undefined;
  projectEvents?: ((args: { events: readonly Event[] }) => void) | undefined;
  sandbox?: SandboxStatusSource | undefined;
}): ConversationStore {
  const paceReveal = args.paceReveal ?? false;
  let thinking: EThinkingVisibility = args.thinking ?? SHIPPED_THINKING;
  let tldrStatus = true;
  let name: string | null = args.name ?? null;
  let events: readonly Event[] = args.events ?? [];
  let turns: readonly TurnSpend[] = args.turns ?? NO_TURNS;
  let turn: TurnClock = IDLE_TURN;
  let gate: RevealGate | null = null;
  let sandbox: SidebarContainer | null = args.sandbox?.current() ?? null;
  let pendingTldr = pendingTldrOf(args.threadId) ?? null;
  let frame: ReturnType<typeof setTimeout> | undefined;
  const tracker = createStepTracker();
  let durable: {
    events: readonly Event[];
    turns: readonly TurnSpend[];
    entries: TranscriptEntry[];
  } | null = null;
  let folded: { events: readonly Event[]; fold: SidebarEventFold } | null = null;
  let projected: readonly Event[] | null = null;

  const durableNow = (): readonly TranscriptEntry[] => {
    if (durable !== null && durable.events === events && durable.turns === turns) {
      return durable.entries;
    }

    const entries = durableEntries({ events, turns });
    durable = { events, turns, entries };
    return entries;
  };

  const foldNow = (): SidebarEventFold => {
    if (folded !== null && folded.events === events) return folded.fold;

    const fold = sidebarFoldOf(events);
    folded = { events, fold };
    return fold;
  };

  const sidebarNow = (): SidebarModel =>
    sidebarFrom({ fold: foldNow(), turn, turns, priceOf: args.priceOf, name });

  let model = assembleTranscript({ durable: durableNow(), live: [], thinking, pendingTldr, tldrStatus, sandbox })
  let sidebar = sidebarNow()

  args.projectEvents?.({ events });
  projected = events;

  const listeners = new Set<() => void>();

  const wake = () => {
    for (const listener of [...listeners]) listener();
  };

  const sameFailure = (
    left: StepFailure | null,
    right: StepFailure | null,
  ): boolean =>
    left === right ||
    (left !== null && right !== null && left.message === right.message);

  const settled = (derived: TranscriptModel): TranscriptModel => {
    const entries = stabilisedEntries({
      previous: model.entries,
      next: derived.entries,
    });
    const unchanged =
      entries === model.entries &&
      derived.isEmpty === model.isEmpty &&
      derived.streaming === model.streaming &&
      sameFailure(derived.failure, model.failure);

    return unchanged ? model : { ...derived, entries };
  };

  const republish = () => {
    tracker.pruneSuperseded(events);
    model = settled(
      assembleTranscript({
        durable: durableNow(),
        live: tracker.live(events),
        reveal: gate,
        thinking,
        pendingTldr,
        tldrStatus,
        sandbox,
      }),
    )
    const nextSidebar = sidebarNow()
    if (!sameSidebar(sidebar, nextSidebar)) sidebar = nextSidebar
    if (projected !== events) {
      args.projectEvents?.({ events });
      projected = events;
    }
    wake();
  };

  const scheduleFrame = () => {
    if (frame !== undefined) return;

    frame = setTimeout(() => {
      frame = undefined;
      const tail = tracker.tailRun(events);
      gate = advancedGate({ gate, tail });
      republish();
      if (gateIsDraining({ gate, tail })) scheduleFrame();
    }, FRAME_MS);
  };

  const handleSignal = (signal: ChannelSignal) => {
    if (
      signal.type === "events-appended" ||
      signal.type === "retry-waiting" ||
      signal.type === "retry-cleared"
    ) {
      return;
    }

    tracker.absorb(signal);

    if (!paceReveal || signal.type !== "chunk") {
      gate = null;
      republish();
      return;
    }

    gate = attachedGate({ gate, tail: tracker.tailRun(events) });
    scheduleFrame();
  };

  let unsubscribeFromChannel: Unsubscribe | undefined = args.channel.subscribe({
    threadId: args.threadId,
    listener: handleSignal,
  });

  const unsubscribeFromFeed = subscribeTldrFeed(() => {
    const next = pendingTldrOf(args.threadId) ?? null;
    if (next === null && pendingTldr === null) return;
    if (
      next !== null &&
      pendingTldr !== null &&
      next.anchorSeq === pendingTldr.anchorSeq &&
      next.text === pendingTldr.text
    ) {
      return;
    }
    pendingTldr = next;
    republish();
  });

  const unsubscribeFromSandbox = watchSandbox({
    source: args.sandbox,
    current: () => sandbox,
    onMoved: (next) => {
      sandbox = next;
      republish();
    },
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    getSnapshot: () => model,

    getSidebar: () => sidebar,

    setEvents(next) {
      const logMoved = !sameEvents({ left: events, right: next.events });
      const spendMoved =
        next.turns !== undefined && !sameTurns({ left: turns, right: next.turns });
      if (!logMoved && !spendMoved) return;

      events = next.events;
      if (next.turns !== undefined) turns = next.turns;
      republish();
    },

    setTurn(next) {
      if (next === turn) return;

      turn = next
      const nextSidebar = sidebarNow()
      if (sameSidebar(sidebar, nextSidebar)) return

      sidebar = nextSidebar
      wake()
    },

    supersedeFailure() {
      if (!tracker.dropFailedTail(events)) return;

      republish();
    },

    resetSteps() {
      tracker.reset()
      republish()
    },

    setThinking(next) {
      if (next === thinking) return;
      thinking = next;
      republish();
    },

    setTldrStatus(next) {
      if (next === tldrStatus) return;
      tldrStatus = next;
      republish();
    },

    setName(next) {
      if (next === name) return;
      name = next;
      republish();
    },

    dispose() {
      if (frame !== undefined) clearTimeout(frame);
      frame = undefined;
      unsubscribeFromChannel?.();
      unsubscribeFromChannel = undefined;
      unsubscribeFromFeed();
      unsubscribeFromSandbox?.();
      listeners.clear();
    },
  };
}
