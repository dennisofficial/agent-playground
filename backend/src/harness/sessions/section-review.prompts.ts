/**
 * Prompts for the per-section MULTI-LENS self-review (Phase 5a). After a section's last coding-session
 * group is built, the pipeline runs one read-only review per LENS (correctness / SOLID / DRY /
 * conventions) over the section's accumulated diff; any lens that returns CHANGES drives the bounded
 * fix loop (REVIEW_FIX_PROMPT, shared with review-pipeline.prompts.ts) and only the still-failing lenses
 * are re-run. Each lens review ends with a machine VERDICT line so the pipeline branches without an LLM
 * judge — reuse `parseVerdict` from review-pipeline.prompts.ts. Plain string factories (no LangChain).
 */

/** The review lenses, in the order they run. Each is a distinct failure mode so a single pass can't
 * hide a problem the others would catch (correctness ≠ structure ≠ duplication ≠ house style). */
export type Lens = 'correctness' | 'solid' | 'dry' | 'conventions';
export const LENSES: readonly Lens[] = [
  'correctness',
  'solid',
  'dry',
  'conventions',
];

/** What each lens looks for — folded into the lens review prompt so the pass stays focused. */
const LENS_FOCUS: Record<Lens, string> = {
  correctness:
    'CORRECTNESS — bugs, broken or unhandled contracts, missing error handling, off-by-ones, race conditions, security holes, and edge cases the code silently mishandles. Flag anything that would behave wrong at runtime, plus obviously-missing tests for the new behavior.',
  solid:
    'STRUCTURE (SOLID) — single-responsibility violations, tight coupling, leaky or wrong abstractions, god functions/classes, logic in the wrong layer. Flag where the shape will be hard to change or test, not cosmetic preferences.',
  dry:
    "DUPLICATION (DRY) — copy-pasted blocks, logic repeated across files, hand-rolled helpers that reinvent something the codebase already has. Flag concrete duplication with both locations; don't invent abstractions for a single use.",
  conventions:
    "CONVENTIONS — does this match how THIS codebase already does things (naming, file/module layout, error/return idioms, existing utilities)? Read a neighbouring file or two for the established pattern and flag drift from it, not generic style nits.",
};

/** One lens's read-only review over the section's diff range. Mirrors CODE_REVIEW_PROMPT's shape and
 * the same trailing VERDICT contract so `parseVerdict` reads it. */
export const LENS_REVIEW_PROMPT = (p: {
  lens: Lens;
  goal: string;
  ticket: string;
  range: string;
  section?: string;
}): string =>
  `You are a code-review agent doing ONE focused pass over the work just built${
    p.section ? ` for the "${p.section}" section` : ''
  }. Review ONLY the changes in the git range \`${p.range}\` — run \`git diff ${p.range}\` and read the touched files (and a neighbour or two) for context. This turn is READ-ONLY — do not modify anything.

Look ONLY through this lens — ignore problems another pass would own:
${LENS_FOCUS[p.lens]}

The work implements:
${p.ticket}

Goal: ${p.goal}

Report concrete, actionable problems with file:line references. Do not praise. If nothing in this lens needs changing, say so in one line.

End your response with EXACTLY ONE of these lines and nothing after it:
VERDICT: PASS
VERDICT: CHANGES`;
