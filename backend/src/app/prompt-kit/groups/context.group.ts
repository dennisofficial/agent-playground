/**
 * prompt-kit / groups / context — the durable authoring surfaces the normal brain writes into: the
 * `/context` shared folder (specs/generated/artifacts).
 *
 * TOPIC bucket: context / authored artifacts (normal brain only).
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { isBuildBrain } from '../conditions';

@FragmentGroup()
export class ContextGroup {
  /** normal block 15 — the /context shared folder. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1150, condition: isBuildBrain })
  contextFolder(): string {
    return [
      'THE /context SHARED FOLDER: `/context` is a durable, per-thread space OUTSIDE the repo, shared with the',
      'build sessions. THREE buckets, split by who authors them:',
      '  • `/context/specs/` — HAND-AUTHORED by you, live as you work (NOT in one burst at the end), as CONTEXT',
      '    for the operator + the build engines. (The build orchestrates off the structured plan you submit; these',
      '    files are the HANDOFF a fresh, context-less engine reads to build AND review — capture the WHY and the',
      "    domain knowledge you extracted by grilling, especially in each section's `## Context`, not just the WHAT.)",
      '    MULTI-FILE — follow PLAN.MD STRUCTURE below:',
      '      – `plan.md` — the INDEX (goal · overview · architecture/mermaid · the ordered thread list);',
      '      – `sections/NN-<slug>.md` — ONE file per thread (its goal, context, approach, validation);',
      '      – `data-model.md` — cross-cutting schema/migrations/ER diagram, when the work touches the schema.',
      '    The operator watches these fill in; revise as decisions change things.',
      "    CADENCE — write a thread's `sections/NN.md` (and grow the `plan.md` index) the MOMENT its shape settles",
      '    (its files are open and its decisions are logged), BEFORE you scope the next — the same rhythm as',
      '    create_decision. By the time the last decision locks the spec files are near-complete. A thread you have',
      '    fully investigated but not yet written up as an execute-ready `## Approach` is unfinished work. The',
      '    `# <goal>` H1 may be revised until you submit. WHY THE CADENCE IS NON-NEGOTIABLE — CONTEXT ROT: what you',
      '    hold only in your head is the FIRST thing lost when your session is compacted at approval or degrades',
      '    under a filling window. The instant a thread is understood, its understanding belongs on disk in',
      "    `sections/NN.md` — a durable artifact survives compaction; your working memory does not. Batching the",
      '    write-up to the end gambles the whole plan against a window that is rotting the longer you wait.',
      '  • `/context/generated/` — SYSTEM-GENERATED and READ-ONLY (a read-only mount; you cannot write it). The',
      '    decisions you lock via `create_decision` are rendered here as `decision-record.md`, live, on every call.',
      '    Do NOT try to author or edit anything here — it is maintained for you through your tool calls.',
      '  • `/context/artifacts/` — OUTPUTS for the human: preview HTML, screenshots, reports (never the repo).',
      'Treat the repo (`/workspace`) as READ-ONLY until a build is approved — never modify it while planning;',
      'write to `/context/specs` (or `/context/artifacts`) instead.',
    ].join('\n');
  }
}
