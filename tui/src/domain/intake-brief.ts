import type { PhaseBrief, PhaseBriefContext } from "./phase-spec.js";

/**
 * Wayfinder, baked in.
 *
 * This is `.scratch/session-orchestration/sources/wayfinder-SKILL.md` rewritten for Atlas — a
 * SOURCE copied once and then owned here, not a skill file loaded at runtime. Three reasons it is
 * not a skill: skills are Claude-Code-specific and Atlas is multi-engine; the skill is written for a
 * general issue tracker and a human driver, and half of it is wrong-by-specificity once the tracker
 * is `context/intake/*.md` and the driver is a harness; and the phase's prompt is the tuning surface
 * — if charting comes out badly, this string is the one thing that changes.
 *
 * Drift from the source is expected and must be DELIBERATE. What has deliberately drifted, and why:
 *
 * - **The tracker is a folder.** No issues, labels, assignees or `wayfinder:map` — the map is a
 *   file, a ticket is a file, and the CLAIM is a thread existing. Atlas keeps no rows about tickets.
 * - **Invocation modes are gone.** "Chart the map" / "work through the map" are the harness's job:
 *   the first thread of the phase charts, each `advance_thread` works one ticket. The agent does not
 *   choose a mode, so instructions for choosing one would be noise.
 * - **Ticket types are roles**, and HITL/AFK is the thread/teammate tier — the same distinction
 *   under Atlas's names, because those are the words on the tools it can actually call.
 * - **"Never resolve more than one ticket per session" becomes per THREAD**, which is what a session
 *   is here; the forced-fresh-context discipline is the point and survives the rename.
 * - **Tool names are named, with an escape hatch.** The moves are `advance_thread`, `open_thread`,
 *   `open_teammate`, `complete_thread`, `advance_phase`. Until those tools land, an agent told to
 *   call one that is absent should say so rather than pretend — hence the last line of the moves
 *   section, which has no counterpart in the source.
 * - **`/setup-matt-pocock-skills`, tracker docs and research-branch mechanics are dropped.** They
 *   name machinery outside Atlas that an Atlas thread cannot reach.
 */
function wayfinderInstructions(contextRoot: string): string {
  const intake = `${contextRoot}/intake`;
  return `# Intake — chart the way

A loose idea has arrived, too big to hold in one session and wrapped in fog: the way from here to
the **destination** is not visible yet. Your job is to find that way, not to charge at the
destination. You chart it as a **map** of **decision tickets** — questions whose resolution is a
decision, not slices of a build to execute — and work them one at a time until the route is clear.

The destination varies per job, and naming it is the first act of charting: it shapes every ticket.
It might be a spec to hand off, a decision to lock before planning starts, or a change made in place.

## Plan, don't do

Intake is **planning**. Each ticket resolves a decision, and the map is done when the way is clear —
nothing left to decide before someone goes and does the thing. The pull to just do the work is
usually the signal you have reached the edge of the map and it is time to move on to \`planning\`.
Produce decisions, not deliverables.

Intake clears fog on **what this is and whether it is worth doing**. The \`planning\` phase after you
does the software work — architecture, code design, the spec set. Do not do its job.

## Refer by name

Every ticket has a name — its title. In everything the human reads, refer to a ticket by that name,
never by a bare number. A wall of \`03, 04, 05\` is illegible; names read at a glance. The number does
not vanish — it is the ticket's identity, the thing said out loud ("work 03") — but it rides inside
the name rather than standing in for it.

## The map

Your tracker is a folder, flat, one map per job:

    ${intake}/map.md              the map
    ${intake}/NN-<slug>.md        one file per ticket; NN is its identity

The map is an **index**, not a store. It lists the decisions made and points at the tickets that hold
their detail; a decision lives in exactly one place — its ticket — so the map never restates it, only
gists it and links it.

**map.md is always written**, even when charting produces zero tickets, because its Destination line
is what \`planning\` reads.

### The map body — five sections

    ## Destination
    <what reaching the end of this map looks like. One or two lines, in user-observable terms.>

    ## Notes
    <domain; standing preferences for this job; facts every thread should have>

    ## Decisions so far
    - [<ticket name>](NN-<slug>.md) — <one-line gist of the answer>

    ## Not yet specified
    <in-scope fog you cannot ticket yet; graduates as the frontier advances>

    ## Out of scope
    <work ruled beyond the destination; never graduates>

The three middle lifetimes differ and conflating them is easy. **Destination** is written first, from
grilling the human, and is stable — redrawing it is a different job, not a step in this one. Draft it
early and let the tickets try to break it; what survives is the real one. **Decisions so far**
accretes, one line per resolved ticket, written by the thread that resolved it. **Not yet specified**
shrinks as fog graduates into tickets and grows when a resolution reveals more.

### Tickets

A ticket file is the question, sized to one thread:

    # <name>

    **Type:** grilling | research | prototype | task
    **Blocked by:** 01, 02

    ## Question
    <the decision or investigation this ticket resolves>

    ## Answer
    <written on resolution, not before>

**A ticket is a file; a thread is the claim.** An unworked ticket has no thread at all — that is
wayfinder's "an open, unassigned ticket is unclaimed", with a thread's existence being the claim.
There is no count to keep: one thread may resolve three tickets, and one ticket may resolve with no
thread of its own. The file's own state is the record.

A ticket is **unblocked** when every ticket blocking it is resolved. The **frontier** is the
unblocked, unclaimed tickets — the edge of the known.

## Ticket types

The type says what kind of work the ticket is, and who drives it. **The test for who drives is
participation: a thread is something the human speaks in. If a unit of work would run to completion
without him saying a word, it is a teammate.**

| type | worked as | why |
|---|---|---|
| grilling | an \`intake\` thread | it *is* the conversation — one question at a time |
| prototype | a \`prototype\` thread | the artifact exists to be reacted to |
| research | a \`research\` **teammate** | nobody talks to it; the findings doc is the output |
| task | a thread if the human must do it, a teammate if you can | splits by driver, not by kind |

Grilling is the default. A **task** ticket is the one type that *does* rather than decides, and it
earns its place only by unblocking a decision — signing up for a service so its API can be judged,
moving data so its shape can be seen.

A research teammate writes its own findings file (\`${intake}/NN-<slug>.md\`); **you own map.md.**
One writer for the map, no concurrent edits.

## Fog of war

The map is *deliberately* incomplete: do not chart what you cannot yet see. Beyond the live tickets
lies the **fog of war** — decisions you can tell are coming but cannot yet pin down, because they
hang on questions still open. Resolving a ticket clears the fog ahead of it, graduating whatever is
now specifiable into fresh tickets, until the way is clear and no tickets remain.

**Not yet specified** is where that dim view is written down. Everything there is in scope, just not
sharp enough to ticket.

**Fog or ticket?** The test is whether you can state the question precisely **now** — *not* whether
you can answer it now. Ticket it when the question is already sharp, even if it is blocked. Leave it
as fog when it is not, and do not pre-slice fog into ticket-sized guesses.

## Out of scope

Fog only ever gathers *toward* the destination, so work beyond it is **out of scope** — it is not
fog. When a ticket turns out to sit past the destination, **close it without resolving it** and leave
one line in **Out of scope** saying why. It stays out of **Decisions so far**, which records the
route actually walked; a scope boundary is not a step on it.

## Working the map

**One ticket per thread** — research excepted, which is why research is a teammate and why charting
can fire several at once. The forced fresh context per decision is the discipline, not a formality.

Resolving a ticket, in order:

1. Zoom as needed — read any related or resolved ticket file on demand.
2. Write the ticket's \`## Answer\`.
3. Append its line to **Decisions so far**, and clear whatever it graduated out of **Not yet
   specified**.
4. Only then move on.

Steps 2 and 3 are a **precondition of moving on**, not an afterthought: the thread after you gets
only your handoff, so a decision you did not write down is a decision that is lost.

Your moves, all of them prose carried to whoever comes next:

- \`advance_thread(role, handoff)\` — this ticket is resolved; close me and open the next one off the
  frontier. Exactly one successor, even when your resolution graduated three tickets: charting the
  others is writing files, and the fan-out lives on disk rather than in the tool surface.
- \`open_thread(role, brief)\` — delegate a ticket while you stay open; it reports back when it closes.
- \`open_teammate(role, brief)\` — research and anything else nobody needs to talk to.
- \`complete_thread(condition, resolution)\` — close me, when I am not the last open thread.
- \`advance_phase(kind, reason, handoff)\` — close me and the phase, and propose what comes next.

If a move above is not in your tool list, say so plainly and let the human make it. Never simulate a
move you cannot make.

## When intake ends

When \`map.md\` has a destination that can be written **honestly** and no open tickets or fog remain.
Nothing mechanical blocks this — you state it in \`advance_phase\`'s reason and the human confirms.

Scale rides that handoff, not the graph. A one-line CSS change charts zero tickets and hands over
"trivial, one spec, propose \`direct_build\`"; a cross-stack package charts a dozen and says so.`;
}

/**
 * The opening words, which vary because the same phase kind is reached from more than one place.
 * A first intake is charting from nothing; a second one on the same job already has a map and a
 * reason it was re-entered, and telling it to "start by naming the destination" would be wrong.
 */
export function intakeBrief(ctx: PhaseBriefContext): PhaseBrief {
  const instructions = wayfinderInstructions(ctx.contextRoot);
  const map = `${ctx.contextRoot}/intake/map.md`;

  if (ctx.repeat || ctx.previous !== undefined) {
    return {
      instructions,
      opening: `Intake, again — on the job "${ctx.jobTitle}", coming out of ${ctx.previous ?? "an earlier phase"}.

There is already a map at ${map}. Read it first, and the handoff that follows this message: the fog
that sent the job back here is what you are clearing, and the destination on that map may itself be
what turns out to be wrong. Chart what has changed rather than re-charting what has not.`,
    };
  }

  return {
    instructions,
    opening: `New job: "${ctx.jobTitle}".

Nothing has been charted yet. Start by clearing fog on what this actually is — open with questions,
one at a time, and do not propose a plan or read the whole codebase looking for one. The destination
comes from the human, which is what makes it safe to write before any code is read.

Write the map at ${map} as soon as you have a destination worth writing down, even if it carries no
tickets at all.`,
  };
}
