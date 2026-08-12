import { EPhaseKind } from "../generated/prisma/enums.js";
import type { PhaseBrief, PhaseBriefContext } from "./phase-spec.js";

/**
 * The prose for every phase except `intake`, whose brief is long enough to own a file.
 *
 * Each phase returns two things (see `PhaseBrief`): standing `instructions` that ride the system
 * prompt of every turn, and situational `opening` words said once as the thread's first message.
 * The split is what keeps the vocabulary at eight kinds — a `direct_build` chasing a red build and
 * one opened off a fresh plan share every instruction and differ only in how they open.
 */

/** Where the job's shared prose lives, absolute, because file tools do not expand `$VARS`. */
function map(ctx: PhaseBriefContext): string {
  return `${ctx.contextRoot}/intake/map.md`;
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

/** Named so the branch is copyable; a job without a worktree works in the project path. */
function branchLine(ctx: PhaseBriefContext): string {
  return ctx.branch === undefined
    ? `This job has no branch of its own — you are working in the project path.`
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

export function planningBrief(ctx: PhaseBriefContext): PhaseBrief {
  return {
    instructions: `# Planning

Intake settled what this is. You settle HOW: architecture, code design, and the spec set the build
is executed against.

- Read ${map(ctx)} before you plan. Its Destination is the bar; its Decisions-so-far are already
  settled and are not yours to reopen.
- Write the spec set into ${specs(ctx)}. **The filename carries scope**: unnumbered files
  (\`spec.md\`, \`data-model.md\`) are shared by every build thread; \`NN-<slug>.md\` files are one
  vertical slice each, claimable by exactly one thread. Put a decision in a shared file only when
  two slices would otherwise each decide it differently.
- \`spec.md\` carries: problem statement, solution, user stories, implementation decisions, testing
  decisions (which seam, and the prior art to imitate), and what is out of scope.
- **Slices are vertical.** A slice ships a behaviour end to end; layer-shaped tickets ("the API
  layer", "the components") are dead, because none of them is verifiable alone.
- Fog found here does NOT go back to intake. Open an \`intake\` thread beside yourself with
  \`open_thread\` and keep planning; it reports back when it closes.
- A \`plan_review\` teammate reviews the plan before you propose it. It runs on the other engine
  deliberately — a second reader that did not write the thing.

${ADVANCE} Propose \`build\` when the work wants reviewed slices, \`direct_build\` when it is small
enough that a review pass would cost more than it finds. Either way the builder gets a spec.`,
    opening: `Planning — "${ctx.jobTitle}". ${origin(ctx)}

Start from ${map(ctx)}: read the destination and the decisions before you write anything. If the map
has no tickets, that is a real answer — a trivial job gets one spec and a \`direct_build\` proposal,
not a ceremony.`,
  };
}

const BUILD_CORE = (ctx: PhaseBriefContext): string => `- Your contract is ${specs(ctx)}. The
  unnumbered files are shared and already attached; the numbered ones are slices, and you work the
  one you were given.
- Walk the slices by prose, not by a materialised list: when yours lands, \`advance_thread\` names
  the next one off the frontier and hands over what the slice you just finished changed under it.
  Exactly one successor.
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

export function ciBrief(ctx: PhaseBriefContext): PhaseBrief {
  return {
    instructions: `# CI

You ship. **Nothing here watches GitHub** — Atlas polls nothing and receives no webhooks, so no part
of this phase is allowed to wait for an external event.

- Push the branch and open the pull request: title, and a body a reviewer can read cold — what
  changed, why, and how it was verified.
- Opening the PR is idempotent. If one already exists for this branch, update it rather than opening
  a second, and say which you did.
- Then stop. A red build is not something you sit and wait for: the human sees it and starts a new
  phase, and fixing it is that phase's work, not this one's.

This phase proposes nothing. When the PR exists your work is done — say so and close.`,
    opening: ctx.repeat
      ? `CI — "${ctx.jobTitle}", again. ${origin(ctx)}

${branchLine(ctx)} A pull request for this branch may already exist; check before you open one, and
update it instead if it does. The handoff says what changed since the last ship.`
      : `CI — "${ctx.jobTitle}". ${origin(ctx)}

${branchLine(ctx)} Push it and open the pull request. The handoff and ${map(ctx)} between them are
what the description should be written from — a reviewer reading it has none of this context.`,
  };
}
