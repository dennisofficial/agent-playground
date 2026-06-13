import { tmpl } from '../_shared/tmpl';

/**
 * Lifecycle-handler prompt text. Per-run task prompts (NOT cached), built with the house `tmpl` helper
 * rather than inline string concatenation.
 */

/** Seeds the planning engine to revise its plan ONCE after the adversarial self-review. */
export const REVISION_PROMPT = tmpl`A reviewer reviewed your plan and raised these points:

${'critique'}

Revise your plan ONCE, folding in the valid points (ignore any that are wrong, noting why in a line). Output the FULL revised plan with the same structured sections.`;
