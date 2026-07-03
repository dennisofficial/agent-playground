/**
 * prompt-kit / layers — the LAYER buckets: which fragments belong to which audience.
 *
 * A layer is an ordered list of fragment strings. `compose.ts` concatenates GLOBAL + the audience layer
 * (+ job-kind + body) so that adding a fragment to a bucket here reaches every consumer of that audience
 * at once. This is the "dictionary with headers" — the headers are the layer names.
 *
 * NOTE: layers are the DEFAULT composition for the common shape. A body with bespoke fragment placement
 * (e.g. a note embedded mid-prose) splices the fragment constant directly instead of relying on a layer.
 */
import {
  BASELINE_FIRST_NOTE,
  SPIKE_FIRST_NOTE,
  VALIDATE_BY_RUNNING_NOTE,
} from './fragments';

// The sandbox "you run in a cloud container" framing is NOT a layer — it's per-audience FRAMING owned by
// the composer (`compose.ts` `FRAMING_FOR`), so the driver audiences get it exactly once and the brain
// (which has its own longer framing) and meta/review chains don't. `CLOUD_SANDBOX_NOTE` lives in
// `fragments.ts`.

/** Build/execute agents (the thread orchestrator + step/batch executors). */
export const WORKER_LAYER: string[] = [VALIDATE_BY_RUNNING_NOTE, SPIKE_FIRST_NOTE];

/**
 * The ship-time PR-review orchestrator. EMPTY: its body already runs a fixed 3-task flow ending in
 * "verify build & full test suite", and the per-thread build workers already validated at runtime — so
 * appending VALIDATE-BY-RUNNING here just adds a class of work with no slot in the ordered task list and
 * re-does what the workers did. Kept as a seam.
 */
export const SHIP_LAYER: string[] = [];

/** The conversational brain (intent → grill → plan → steer). */
export const BRAIN_LAYER: string[] = [BASELINE_FIRST_NOTE, SPIKE_FIRST_NOTE];

/** The thread planner (turns one approved thread into ordered steps). */
export const PLANNER_LAYER: string[] = [BASELINE_FIRST_NOTE, SPIKE_FIRST_NOTE];

/** Read-only review passes (autofix lenses, master review). No behavioral run-it fragments. */
export const REVIEW_LAYER: string[] = [];

/**
 * LLM meta-chains (decision classifier, titler, plan-review, acceptance gate). These are narrow
 * structured-output prompts; the global "you run in a sandbox" framing does NOT apply, so `meta` composes
 * from its own body + only fragments it explicitly opts into.
 */
export const META_LAYER: string[] = [];
