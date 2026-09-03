import {
  EPlanStatus,
  eventsOfType,
  grantsFrom,
  outstandingApproval,
  planFromEvents,
  type CallId,
  type Event,
  type Grant,
} from "@dltech/atlas-core";

import type { TurnSpend } from "@dltech/atlas-harness";

import { classifierFold, type ClassifierFold } from "./classifier-fold";
import { truncateCells } from "../ui/components/sidebar/cells";
import { orderSections, type SidebarSection } from "../ui/sidebar-section";
import type { TurnClock } from "../ui/components/transcript";
import {
  NOTHING_TALLIED,
  sidebarSpendOf,
  type ModelPriceLookup,
  type SidebarSpend,
} from "./sidebar-spend";
import { TITLE_CELLS, oneLineOf } from "./sidebar-text";
import type { SidebarCrewFold, SidebarSubagent } from "./subagent-row";

export type SidebarApproval = { callId: CallId; reason: string };

export enum ESidebarTaskState {
  Done = "done",
  Running = "running",
  Pending = "pending",
}

export type SidebarTask = {
  id: string;
  label: string;
  state: ESidebarTaskState;
  activeForm?: string | undefined;
};

export type SidebarTeammate = {
  id: string;
  name: string;
  activity: string | null;
};

export type SidebarModel = {
  title: string | null;
  turnCount: number;
  spend: SidebarSpend;
  approvals: readonly SidebarApproval[];
  lastActivity: string | null;
  todo?: readonly SidebarTask[];
  subagents?: readonly SidebarSubagent[];
  crewFold?: SidebarCrewFold;
  teammates?: readonly SidebarTeammate[];
  sections?: readonly SidebarSection[];
  classifier?: ClassifierFold;
  grants?: readonly Grant[];
};

export const IDLE_SIDEBAR: SidebarModel = {
  title: null,
  turnCount: 0,
  spend: NOTHING_TALLIED,
  approvals: [],
  lastActivity: null,
};

const approvalNames = (events: readonly Event[]): SidebarApproval[] => {
  const outstanding = outstandingApproval(events);
  if (outstanding === undefined) return [];

  const requested = eventsOfType({ events, type: "approval-requested" }).find(
    (event) => event.callId === outstanding,
  );
  if (requested === undefined) return [];

  return [{ callId: outstanding, reason: requested.reason }];
};

const TASK_STATE_OF: Record<EPlanStatus, ESidebarTaskState> = {
  [EPlanStatus.Pending]: ESidebarTaskState.Pending,
  [EPlanStatus.InProgress]: ESidebarTaskState.Running,
  [EPlanStatus.Completed]: ESidebarTaskState.Done,
};

const todoOf = (events: readonly Event[]): readonly SidebarTask[] =>
  planFromEvents(events).map((task) => ({
    id: String(task.ordinal),
    label: task.text,
    state: TASK_STATE_OF[task.status],
    ...(task.activeForm === undefined ? {} : { activeForm: task.activeForm }),
  }));

export type SidebarEventFold = {
  opening: string | null;
  turnCount: number;
  approvals: readonly SidebarApproval[];
  lastActivity: string | null;
  todo: readonly SidebarTask[];
  classifier: ClassifierFold | null;
  grants: readonly Grant[];
};

export function sidebarFoldOf(events: readonly Event[]): SidebarEventFold {
  const opening = eventsOfType({ events, type: "user-said" }).at(0);

  return {
    opening: opening === undefined ? null : oneLineOf(opening.text),
    turnCount: eventsOfType({ events, type: "user-said" }).length,
    approvals: approvalNames(events),
    lastActivity: events.at(-1)?.at ?? null,
    todo: todoOf(events),
    classifier: classifierFold({ events }),
    grants: grantsFrom(events),
  };
}

export function sidebarFrom(args: {
  fold: SidebarEventFold;
  turn: TurnClock;
  turns?: readonly TurnSpend[] | undefined;
  priceOf?: ModelPriceLookup | undefined;
  name?: string | null | undefined;
}): SidebarModel {
  const { fold, turn } = args;
  const name = args.name ?? null;

  const spend = sidebarSpendOf({
    turns: args.turns ?? [],
    liveOutputTokens: turn.startedAt === null ? 0 : turn.outputTokens,
    priceOf: args.priceOf,
  });
  const named = name === null ? null : oneLineOf(name);
  const titleText = named ?? fold.opening;

  return {
    title:
      titleText === null ? null : truncateCells({ text: titleText, cells: TITLE_CELLS }),
    turnCount: fold.turnCount,
    spend,
    approvals: fold.approvals,
    lastActivity: fold.lastActivity,
    ...(fold.todo.length === 0 ? {} : { todo: fold.todo }),
    ...(fold.classifier === null ? {} : { classifier: fold.classifier }),
    ...(fold.grants.length === 0 ? {} : { grants: fold.grants }),
  };
}

export function deriveSidebar(args: {
  events: readonly Event[];
  turn: TurnClock;
  turns?: readonly TurnSpend[] | undefined;
  priceOf?: ModelPriceLookup | undefined;
  name?: string | null | undefined;
}): SidebarModel {
  return sidebarFrom({
    fold: sidebarFoldOf(args.events),
    turn: args.turn,
    turns: args.turns,
    priceOf: args.priceOf,
    name: args.name,
  });
}

/**
 * A crew with nothing left to show takes its heading with it rather than leaving a tally behind:
 * the whole point of retiring a row is the cells it gives back, and `/agents` is where a settled
 * child is read from once the panel has let it go.
 */
export function withCrew(args: {
  model: SidebarModel;
  subagents: readonly SidebarSubagent[];
  fold?: SidebarCrewFold;
}): SidebarModel {
  const { model, subagents } = args;
  if (subagents.length === 0) return model;

  const fold = args.fold;
  if (fold === undefined || fold.hidden === 0) return { ...model, subagents };

  return { ...model, subagents, crewFold: fold };
}

export function withSections(args: {
  model: SidebarModel;
  sections: readonly SidebarSection[];
}): SidebarModel {
  const sections = orderSections(args.sections);
  if (sections.length === 0) return args.model;

  return { ...args.model, sections };
}
