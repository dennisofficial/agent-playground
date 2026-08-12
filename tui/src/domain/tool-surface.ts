import type { EPhaseKind, EThreadRole } from '../generated/prisma/enums.js';

/**
 * Who is holding the tool. Independent of ROLE, which says what kind of work is being done — a
 * `builder` thread and a `builder` teammate do the same work and are trusted with different verbs.
 *
 * Only threads may move Atlas's structure. A teammate is a super-subagent owned by a thread, not a
 * peer: it never advances a phase, never opens a thread and never moves the cursor. Granting a tool
 * to the teammate tier is a one-word change on that tool's `tiers`, which is the point of putting
 * the axis in the data rather than in a second registry.
 */
export enum EToolTier {
  thread = 'thread',
  teammate = 'teammate',
}

/**
 * Every Atlas tool, by name. An enum rather than bare strings because the name is what the model
 * emits, what the transcript renders and what a later ticket adds to — three places that must agree.
 */
export enum EAtlasTool {
  advance_thread = 'advance_thread',
  advance_phase = 'advance_phase',
  /**
   * Delegation and its end. `open_thread` leaves the caller open and expects a report; `complete_thread`
   * is what delivers it — which is why they are one pair and neither is `advance_thread`.
   */
  open_thread = 'open_thread',
  complete_thread = 'complete_thread',
  /**
   * The plan, made visible. Three verbs and no `task_get`: a checklist row is one line, so there is
   * nothing a getter could return that the list does not already show.
   */
  task_create = 'task_create',
  task_update = 'task_update',
  task_list = 'task_list',
  /**
   * The session seam, and the only verb on the teammate tier: end this leg and open the next on the
   * same thread, carrying a four-section report. It is the ONE structural tool that is not about
   * Atlas's structure at all — nothing above the session moves.
   */
  rotate = 'rotate',
  /**
   * Ship: rebase, push, open the pull request if none is open. The only tool that reaches outside
   * this machine, and the only one whose whole contract is that calling it twice is harmless.
   */
  ship_pr = 'ship_pr',
}

/**
 * Everything visibility may depend on, and nothing else.
 *
 * `phase` is here because the phase is what decides which structural moves exist at all; `role` is
 * here because it is the other half of "who is asking" and a tool that varies by role would have
 * nowhere else to read it. Nothing about the turn, the session or the account belongs in this type
 * — a tool that appeared and vanished mid-thread would be a surface the agent cannot learn.
 */
export type ToolAudience = {
  tier: EToolTier;
  role: EThreadRole;
  phase: EPhaseKind;
};

/**
 * The part of a tool that gating reads. Declared structurally so the pure filter never has to know
 * what a handler, a schema or an engine is — `AtlasTool` in `app/tools/` satisfies this by having
 * the fields, not by importing anything from here at runtime.
 */
export type ToolGate = {
  name: string;
  tiers: readonly EToolTier[];
  /**
   * Whether this tool has anything legal to offer HERE. Absent means "wherever its tier is", which
   * is the honest default: most tools are not phase-shaped.
   *
   * A tool that returns false is **absent from the session's tool list**, never present-and-throwing.
   * The schema is the only rail the agent has, and a tool it can see is a tool it will try — an
   * offer withdrawn at call time teaches nothing and costs a turn.
   */
  offeredIn?: (audience: ToolAudience) => boolean;
};

/**
 * The whole of gating, in one function.
 *
 * Deliberately a filter over ONE list rather than a per-role or per-phase table of tool sets: two
 * lists disagree the first time someone edits one, and legacy's per-role `inputPolicy` plus per-kind
 * role sets is exactly the shape that made "which tools does a plan reviewer have" unanswerable
 * without reading three files.
 */
export function visibleTools<T extends ToolGate>(args: {
  tools: readonly T[];
  tier: EToolTier;
  role: EThreadRole;
  phase: EPhaseKind;
}): readonly T[] {
  const audience: ToolAudience = {
    tier: args.tier,
    role: args.role,
    phase: args.phase,
  };
  return args.tools.filter(
    (tool) =>
      tool.tiers.includes(args.tier) && (tool.offeredIn?.(audience) ?? true),
  );
}
