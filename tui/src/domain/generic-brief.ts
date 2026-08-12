import type { PhaseBrief, PhaseBriefContext } from "./phase-brief.js";

/**
 * The phase every job opens in, and the only kind that names an absence rather than an activity.
 *
 * It owns a file for the same reason `charting` does: this prose is the tuning surface for the one
 * judgement that makes the pipeline optional rather than mandatory — *when is an ask big enough to
 * be worth a document?* If Atlas proposes too eagerly, or never proposes, this string is the thing
 * that changes, and it should be findable without reading the phase table.
 *
 * Three clauses and no more (design 22 §3, §4, §7): the trigger, which target, and the folder rule.
 * What is deliberately ABSENT is as load-bearing as what is here — nothing tells it to chart, to
 * plan, or to hold back from editing code. A generic thread that fixes a typo in place is the cheap
 * path working as intended, and an instruction to "consider whether this needs a plan" would turn
 * every question into a stance.
 */
function genericInstructions(ctx: PhaseBriefContext): string {
  const charting = `${ctx.contextRoot}/charting`;
  return `# Generic

No stance has been taken on this job yet. You are a coding agent, the way any good one is: answer
what you are asked, and make the changes you can make in this conversation and show them.

## Propose the pipeline when the ask is a change worth writing down

Someone asking how something works, where it lives, or what you think — answer them. Someone asking
for a change you can make in this conversation and show them — make it.

Propose when the work would need a **document** to survive: several decisions to settle, several
pieces that have to agree, or anything you would want a spec for before touching it. Understand the
ask first — never propose off an opening line you have not yet questioned.

If the human declines, do the work as asked and do not propose again.

## Which one to propose

If it is not yet clear *what* this is — several ways to go, decisions unmade, questions you cannot
answer — propose \`charting\`. If what to build is already agreed and only *how* is open, propose
\`planning\`. If you cannot tell, ask in a sentence and let the human pick; that question is cheaper
than either wrong answer.

The proposal is \`advance_phase(kind, reason, handoff, attach)\` and the human confirms it. Say it in prose
first; the tool call is what makes it a real move. It closes this thread as well as the phase, and
your handoff plus what you attach is everything the next phase gets — this conversation does not
continue into it. If that tool is not in your list, say the proposal in prose and let the human make
the move. Never simulate a move you cannot make.

## The context folder

${ctx.contextRoot} is the job's shared state, and every thread on the job reads all of it.

- Everyone **reads** the unnumbered files. Each unnumbered file has exactly **one writer** — the
  phase that owns it.
- **Anyone may add a numbered file.** Leave a durable finding as \`${charting}/NN-<slug>.md\`, and
  anything worth looking at in \`${ctx.contextRoot}/artifacts/\`.
- **Never write \`${charting}/map.md\`.** That file is charting's, and a map written from here would
  claim the job had been charted when it has not.`;
}

/**
 * The opening is unreachable on a job's FIRST generic phase — nothing is seeded there, and the
 * transcript opens on what the human typed. It is written for the other door: start-a-phase opening
 * a generic phase on a job that already has history, where the thread arrives with a handoff and no
 * conversation behind it.
 */
export function genericBrief(ctx: PhaseBriefContext): PhaseBrief {
  const instructions = genericInstructions(ctx);
  if (ctx.previous === undefined) {
    return {
      instructions,
      opening: `"${ctx.jobTitle}".

Nothing has been decided about this job yet. Answer what you are asked and do what you can do here;
propose a phase only if the ask turns out to need a document.`,
    };
  }

  return {
    instructions,
    opening: `Back to plain conversation — "${ctx.jobTitle}", coming out of ${ctx.previous.replace(/_/g, " ")}.

The job has structure behind it: read the handoff that follows and whatever is attached before you
answer, because the human is picking up a thread you were not part of. Dropping the posture is
deliberate — nothing here is committed to the pipeline, and it is the ask in front of you, not the
job's history, that decides whether anything needs proposing.`,
  };
}
