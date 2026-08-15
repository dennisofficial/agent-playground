import type { RotationSections } from '../../domain/rotation-handoff.js';
import type { EToolTier, ToolGate } from '../../domain/tool-surface.js';
import type { EngineTool } from '../../engine/atlas-tool-server.js';
import type {
  EPhaseKind,
  EThreadCondition,
  ETaskStatus,
  EThreadRole,
} from '../../generated/prisma/enums.js';
import type { Job, Thread } from '../../generated/prisma/client.js';

/**
 * An Atlas tool: what the transport needs (`EngineTool` — name, description, zod shape, handler)
 * plus what gating needs (`ToolGate` — tiers, and where it is offered). Nothing else, and in
 * particular **no engine**: the same object is what a Codex transport will render, and a tool that
 * knew which SDK was calling it would have to be written twice.
 */
export type AtlasTool = EngineTool & ToolGate;

/**
 * What a tool is bound to. Resolved once when a thread is opened rather than per turn — every field
 * is fixed for the life of a thread (a thread never changes phase, role or job), so rebuilding the
 * surface each turn would be a database read for an answer that cannot have changed.
 */
export type ToolContext = {
  job: Job;
  thread: Thread;
  /** The phase the thread lives in. Decides which roles exist and what may be proposed. */
  phase: EPhaseKind;
  /** Where the turn runs — the job's worktree when it has one, else the project path. */
  cwd: string;
  tier: EToolTier;
};

/**
 * The structural moves a tool may perform, as functions rather than as a service.
 *
 * This is what stops the registry from having to know about NestJS, and — more practically — what
 * breaks the loop that otherwise appears here: firing a successor's first turn needs a tool list,
 * and building a tool list needs something that can fire a turn. One owner, injected once, passing
 * itself in.
 */
export type ToolActions = {
  advanceThread(args: {
    ctx: ToolContext;
    role: EThreadRole;
    handoff: string;
    attach: readonly string[];
    /** Ordinals in the CALLER's numbering. Empty is a real answer — see the tool's `carry`. */
    carry: readonly number[];
  }): Promise<string>;
  /**
   * Opens a thread and leaves the caller open. It resolves with an acknowledgement and never with an
   * answer — the answer arrives later, as a message, when the thread it opened closes.
   */
  openThread(args: {
    ctx: ToolContext;
    role: EThreadRole;
    brief: string;
    attach: readonly string[];
  }): Promise<string>;
  /** Closes the caller and hands the cursor on — to its opener, with the report, or to a sibling. */
  completeThread(args: {
    ctx: ToolContext;
    condition: EThreadCondition;
    resolution: string;
  }): Promise<string>;
  /**
   * Raises a proposal and returns. It does NOT transition — the string it resolves with is the
   * whole of what the agent gets, and the phase moves later, if it moves at all.
   */
  advancePhase(args: {
    ctx: ToolContext;
    kind: EPhaseKind;
    reason: string;
    handoff: string;
    attach: readonly string[];
  }): Promise<string>;
  /**
   * Ends this session and opens the next on the SAME thread — the one action here that moves nothing
   * structural. It resolves only once the successor is open and holding the report, because a
   * hand-off that exists while the session has not turned over is the window this design removes.
   */
  rotate(args: {
    ctx: ToolContext;
    sections: RotationSections;
    attach: readonly string[];
  }): Promise<string>;
  /**
   * The task list — the one action set that is not a structural move, and so the one the seam
   * service HOLDS (as an injected `TaskService`) rather than implements.
   *
   * Optional because absent must be a legal state: a caller with no store — a test, or a build
   * where the wiring has not landed — still has to be able to construct these actions. Absent means
   * the three task tools are ABSENT from the session, which is the same rule every other tool
   * follows, applied to wiring rather than to phase.
   */
  tasks?: TaskActions;
  /**
   * Shipping, held the same way and for the same reason as `tasks`: rebasing and opening a pull
   * request moves nothing structural — no phase, no thread, no cursor — so it keeps its own owner
   * rather than becoming a fifth verb on the seam.
   *
   * Optional because absent must be a legal state: a caller with no git — a test, a build where the
   * wiring has not landed — still has to be able to construct these actions, and absent means
   * `ship_pr` is ABSENT from the session rather than present and throwing.
   */
  shipping?: ShipActions;
  /**
   * The job's long-lived processes, held the same way and for the same reason as `tasks` — starting a
   * dev server moves nothing structural.
   *
   * Optional because absent must be a legal state: absent means the three service tools are ABSENT
   * from the session rather than present and throwing, which is the rule every other tool follows
   * applied to wiring rather than to phase.
   */
  services?: ServiceActions;
  /**
   * Taking a worktree, held the same way again. Also not structural — the job stays in its phase, on
   * its thread, with its cursor where it was; only the directory underneath it changes.
   */
  worktree?: WorktreeActions;
};

/**
 * Start, stop, list. No completion signal and no report channel, deliberately: a service that
 * finished would be finite work, and finite work reports back inside its own turn.
 *
 * Keyed by `jobId` rather than by `ToolContext` because the job is the scope — a service outlives the
 * thread that started it, and the UI listing one has no tool call to hand.
 *
 * Strings out, like `TaskActions`: the reply IS the rendered answer, which is what makes an unknown
 * id a sentence rather than an exception.
 */
export type ServiceActions = {
  start(args: {
    jobId: string;
    command: string;
    description: string;
    cwd: string;
  }): Promise<string>;
  stop(args: { jobId: string; id: string }): Promise<string>;
  list(args: { jobId: string }): Promise<string>;
};

/**
 * One verb, and deliberately not two: **take a worktree**, never adopt one.
 *
 * `WorktreeService.adopt` exists and is the door onto a tree somebody else made — but choosing WHICH
 * existing tree is a decision the jobs list already makes, with a human looking at the list of them.
 * An agent picking for itself would be picking, with no way to tell, the tree Dennis has an editor
 * open on: the precise state the worktree feature exists to prevent. So adoption stays a human move
 * and this stays a mint.
 *
 * Idempotent, because `enter()` is: a thread that takes a worktree it already has is told about the
 * one it has, which is what makes the tool safe for an agent that has lost track.
 */
export type WorktreeActions = {
  take(args: { ctx: ToolContext }): Promise<string>;
};

/**
 * One verb, because there is only one: *make the pull request exist*. There is no `ship_status` and
 * no `pr_get` — nothing local watches GitHub, so a getter could only answer with what this call
 * already returned.
 */
export type ShipActions = {
  ship(args: { ctx: ToolContext; title: string; body: string }): Promise<string>;
};

/**
 * Create, update, list — and no get, because a checklist row has no detail view to open.
 *
 * Strings out, not rows: the reply IS the rendered list, which is what makes an unknown number a
 * sentence rather than an exception. Keyed by `threadId` rather than by `ToolContext` because the
 * same three verbs serve the render and a Codex plan mapped onto it, neither of which has a tool
 * call to hand.
 */
export type TaskActions = {
  create(args: { threadId: string; texts: readonly string[] }): Promise<string>;
  update(args: {
    threadId: string;
    ordinal: number;
    status: ETaskStatus;
    text?: string;
  }): Promise<string>;
  list(args: { threadId: string }): Promise<string>;
};
