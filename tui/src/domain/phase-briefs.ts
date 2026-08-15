import { EPhaseKind } from "../generated/prisma/enums.js";
import type { PhaseBrief, PhaseBriefContext } from "./phase-brief.js";

/**
 * The prose for every phase except `generic` and `charting`, whose briefs are long enough — and
 * tuned often enough — to own a file each.
 *
 * Each phase returns two things (see `PhaseBrief`): standing `instructions` that ride the system
 * prompt of every turn, and situational `opening` words said once as the thread's first message.
 * The split is what keeps the vocabulary at nine kinds — a `direct_build` chasing a red build and
 * one opened off a fresh plan share every instruction and differ only in how they open.
 */

/** Where the job's shared prose lives, absolute, because file tools do not expand `$VARS`. */
function map(ctx: PhaseBriefContext): string {
  return `${ctx.contextRoot}/charting/map.md`;
}

function specs(ctx: PhaseBriefContext): string {
  return `${ctx.contextRoot}/specs`;
}

function artifacts(ctx: PhaseBriefContext): string {
  return `${ctx.contextRoot}/artifacts`;
}

/** One line naming where the job just came from — the agent's only cheap read of its own history. */
function origin(ctx: PhaseBriefContext): string {
  if (ctx.previous === undefined) return `This is the job's first phase.`;
  const again = ctx.repeat ? `, and this phase kind has run on this job before` : "";
  return `You are phase ${ctx.ordinal} on this job, arriving from ${ctx.previous.replace(/_/g, " ")}${again}.`;
}

/**
 * Named so the branch is copyable; a job without a worktree works in the project path.
 *
 * The no-branch case NAMES THE VERB, and that is the load-bearing half. Working in the project path
 * is a real state and not a deficiency — most jobs never leave it — but an agent that decides it
 * should leave has to be told what to call, or it reaches for `git worktree add` in the shell, which
 * creates the directory and tells Atlas nothing. Saying "you are in the project path" without saying
 * how to leave is exactly the gap that produced that.
 */
function branchLine(ctx: PhaseBriefContext): string {
  return ctx.branch === undefined
    ? `This job has no branch of its own — you are working in the project path, which is the tree the human has his editor open on. Before you start writing anything that will leave commits behind, call \`enter_worktree\`: it gives this job a branch and a worktree of its own. Never \`git worktree add\` by hand — Atlas would not know where the job went.`
    : `This job's branch is \`${ctx.branch}\`.`;
}

const ADVANCE = `When the phase's work is done you propose what comes next with \`advance_phase\`;
the human confirms it. You never move the job yourself, and a proposal that names what is done and
what is left is the whole content of that confirmation — it is the only thing he reads before \`y\`.`;

export function designBrief(ctx: PhaseBriefContext): PhaseBrief {
  return {
    instructions: `# Design

This phase is visual design, and the work happens OUTSIDE Atlas. Claude Design is closed and cannot
be driven from a thread, so your job is to prepare and then to receive:

- Read ${map(ctx)} first — the destination is what the design has to serve.
- Write a design handoff: what surface is being designed, for whom, the constraints, the states that
  must exist, and what "done" looks like. Prose, complete enough to paste into a fresh tool with no
  Atlas context behind it.
- The human runs it and attaches the returned bundle into ${artifacts(ctx)}. Wait for that rather
  than inventing a design in code.
- When it lands, read it and record in ${map(ctx)} what it decided that planning must respect.

${ADVANCE}`,
    opening: `Design — "${ctx.jobTitle}". ${origin(ctx)}

Read the map, then write the design handoff. Ask about anything the destination leaves ambiguous
before you write it: a handoff is only worth what it settles in advance.`,
  };
}

/**
 * Planning no longer asserts where it came from. Since `generic` can propose `planning` directly, a
 * job can reach here having never been charted, and the old opening ("Charting settled what this is",
 * "Read map.md before you plan") named a file that does not exist. The map is attached by the phase
 * floor exactly when it exists, so its presence is the honest test.
 *
 * Planning does NOT write the map to restore the invariant: that would give the file a second writer
 * and turn the planner into a transcriber of a conversation it did not have.
 */
export function planningBrief(ctx: PhaseBriefContext): PhaseBrief {
  const uncharted = ctx.previous === EPhaseKind.generic || ctx.previous === undefined;
  return {
    instructions: `# Planning

You settle HOW: architecture, code design, and the spec set the build is executed against.

- What this job IS was settled before you. If the job was charted, ${map(ctx)} is attached — its
  Destination is the bar and its Decisions-so-far are settled and not yours to reopen. If it was
  not, there is no map: the handoff and its attachments are the whole statement of intent, and you
  do NOT write a map to fill the gap — that file has one writer, and it is charting.
- Write the spec set into ${specs(ctx)}. **The filename carries scope**: unnumbered files
  (\`spec.md\`, \`data-model.md\`) are shared by every build thread; \`NN-<slug>.md\` files are one
  vertical slice each, claimable by exactly one thread. Put a decision in a shared file only when
  two slices would otherwise each decide it differently.
- \`spec.md\` carries: problem statement, solution, user stories, implementation decisions, testing
  decisions (which seam, and the prior art to imitate), and what is out of scope.
- **Slices are vertical.** A slice ships a behaviour end to end; layer-shaped tickets ("the API
  layer", "the components") are dead, because none of them is verifiable alone.
- Fog found here does NOT go back to charting. Open a \`charting\` thread beside yourself with
  \`open_thread\` and keep planning; it reports back when it closes.
- A \`plan_review\` teammate reviews the plan before you propose it. It runs on the other engine
  deliberately — a second reader that did not write the thing.

${ADVANCE} Propose \`build\` when the work wants reviewed slices, \`direct_build\` when it is small
enough that a review pass would cost more than it finds. Either way the builder gets a spec.`,
    opening: uncharted
      ? `Planning — "${ctx.jobTitle}". ${origin(ctx)}

This job was never charted, so there is no map to read: what you know is the handoff that follows
and whatever it attaches. Say plainly what you are assuming the destination to be before you spec
against it — if that assumption is wrong, the cheapest moment to hear so is now.`
      : `Planning — "${ctx.jobTitle}". ${origin(ctx)}

Start from ${map(ctx)}: read the destination and the decisions before you write anything. If the map
has no tickets, that is a real answer — a trivial job gets one spec and a \`direct_build\` proposal,
not a ceremony.`,
  };
}

const BUILD_CORE = (ctx: PhaseBriefContext): string => `- Your contract is ${specs(ctx)}. The
  unnumbered files are shared and already attached; the numbered ones are slices, and you work the
  one you were given.
- Walk the slices by prose, not by a materialised list: when yours lands, \`advance_thread\` names
  the next one off the frontier, attaches its spec file, and hands over what the slice you just
  finished changed under it. Exactly one successor.
- **Tick your slice's acceptance boxes in its spec file before you advance.** The thread after you
  gets only your handoff; anything you did not write down is lost.
- \`specs/\` is mutable here. If building proves a spec wrong in a small way, fix the file and say so
  in the handoff. If it proves the PLAN wrong, stop and propose \`planning\` while the discovery is
  fresh — that back-edge exists precisely so you do not build something you know is wrong.
- Tests are part of the slice, not a follow-up.`;

export function buildBrief(ctx: PhaseBriefContext): PhaseBrief {
  return {
    instructions: `# Build

The thorough path: your work gets reviewed before the job moves on.

${BUILD_CORE(ctx)}
- Run your review teammate and fix what it finds BEFORE you propose completion, while it can still
  change something and before the next slice builds on top of it.

${branchLine(ctx)}

${ADVANCE} From here that is \`master_review\` when the work is ready to be read whole, or
\`planning\` when it is not the code that was wrong.`,
    opening: `Build — "${ctx.jobTitle}". ${origin(ctx)}

Read the attached specs before you touch a file. The handoff that follows says which slice is yours;
if it does not, say so rather than guessing which one to claim.`,
  };
}

export function directBuildBrief(ctx: PhaseBriefContext): PhaseBrief {
  const fromCi = ctx.previous === EPhaseKind.ci;
  return {
    instructions: `# Direct build

The fast path: same work as \`build\`, without the review children and without master review. It is
chosen when the change is small enough that a review pass would cost more than it finds — so keep it
small. If it stops being small, say so and propose \`planning\` rather than quietly growing.

${BUILD_CORE(ctx)}

${branchLine(ctx)}

${ADVANCE} From here that is \`post_build\`.`,
    opening: fromCi
      ? `Direct build — "${ctx.jobTitle}", chasing a red build. ${origin(ctx)}

The CI phase before you left a failure, not a plan. ${branchLine(ctx)} Read the handoff for what went
red, reproduce it locally before you change anything, and fix the cause rather than the symptom. If
the failure turns out to be the plan rather than the code, propose \`planning\` and say why.`
      : `Direct build — "${ctx.jobTitle}". ${origin(ctx)}

The plan says this is small. Read the attached specs, do the work, and keep it inside what was
approved: anything you discover that is bigger than the spec belongs in the handoff, not in the diff.`,
  };
}

export function masterReviewBrief(ctx: PhaseBriefContext): PhaseBrief {
  return {
    instructions: `# Master review

You read the work whole, against the contract it was built to — the same ${specs(ctx)} the builders
had, attached here unchanged.

- Review the DIFF against the spec: what was promised, what landed, what quietly did not.
- You have taste the review teammates do not. A file that grew to a thousand lines, a switch where a
  strategy belonged, a test that asserts the implementation rather than the behaviour — these are
  the findings that justify this phase existing.
- You run on the other engine from the one that wrote the code. That is the point; read it as a
  stranger would.
- Report findings as prose the next phase can act on, ordered by what would hurt to ship.

${ADVANCE} From here that is \`post_build\` — you report, you do not rewrite.`,
    opening: `Master review — "${ctx.jobTitle}". ${origin(ctx)}

${branchLine(ctx)} Start from the specs, then read the diff on the branch. The handoff says what the
build believes it finished; check it rather than trusting it.`,
  };
}

export function postBuildBrief(ctx: PhaseBriefContext): PhaseBrief {
  return {
    instructions: `# Post build

The tidy-up after the work lands: what a reviewer would ask for before merging, done rather than
listed.

- Act on master review's findings, or say plainly which you are declining and why.
- Dead code, stray debug output, docs that now describe something that no longer exists, and the
  comments that carry the reasoning — this is the last phase where those are cheap to fix.
- Leave the tree green. A failing check discovered here is yours; discovered in \`ci\` it is a phase.

${ADVANCE} From here that is \`ci\` when it is ready to ship, \`planning\` when the tidy-up surfaced
real work, or \`design\` when what it surfaced is a UI rethink.`,
    opening: `Post build — "${ctx.jobTitle}". ${origin(ctx)}

${branchLine(ctx)} Read the review findings in the handoff first and treat them as the agenda.`,
  };
}

/** The pull request this job already has, when it has one — a cached number, not a live state. */
function pullRequestLine(ctx: PhaseBriefContext): string {
  return ctx.prNumber === undefined
    ? `No pull request has been opened for this job yet.`
    : `This job already has pull request #${ctx.prNumber}; \`ship_pr\` will update it rather than open a second.`;
}

export function ciBrief(ctx: PhaseBriefContext): PhaseBrief {
  return {
    instructions: `# CI

You ship, and **shipping is one tool call**: \`ship_pr\` rebases this branch onto the repository's
default branch, pushes it, and opens a pull request if none is open. Do not run git or gh yourself —
the base branch, the force-with-lease and the does-one-already-exist check are all in that call.

- What you write is the title and the body. A reviewer reads the body cold: what changed, why, and
  how it was verified. The specs and the handoff are what it should be written from.
- Calling it again is harmless and is the intended way to re-ship: an existing pull request is
  updated by the push, and no second one is opened. Say which happened.
- If it comes back refusing — uncommitted work, a rebase conflict, a branch that is not checked out
  — that is the message, not a puzzle to work around. Report it and close.

**Nothing here watches GitHub.** Atlas polls nothing and receives no webhooks, so no part of this
phase may wait for a build, a review or a merge. This phase proposes nothing either: when the pull
request exists your work is done — say what you shipped and close with \`complete_thread\`. A red
build is the human's cue to start a new phase, and fixing it is that phase's work, not yours.`,
    opening: ctx.repeat
      ? `CI — "${ctx.jobTitle}", again. ${origin(ctx)}

${branchLine(ctx)} ${pullRequestLine(ctx)} Call \`ship_pr\` with a title and a body; the handoff says
what changed since the last ship, and that is what the description should lead with.`
      : `CI — "${ctx.jobTitle}". ${origin(ctx)}

${branchLine(ctx)} ${pullRequestLine(ctx)} Call \`ship_pr\`. The handoff and ${map(ctx)} between them
are what the description should be written from — a reviewer reading it has none of this context.`,
  };
}
