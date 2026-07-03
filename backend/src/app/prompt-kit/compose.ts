/**
 * prompt-kit / compose — the system-prompt COMPOSER.
 *
 * `buildSystemPrompt` assembles: the role BODY (a complete persona prompt), then the AUDIENCE FRAMING
 * (the "you run in a cloud sandbox" note, for the driver-side audiences whose bodies don't carry their
 * own framing), then the JOB-KIND context block, then the audience LAYER (behavioral reminders). A body
 * whose fragments must sit at a bespoke position assembles itself and passes the finished string as `body`.
 *
 * The sandbox note lives in exactly ONE place per audience — the composer owns it (via `FRAMING_FOR`), so
 * no body has to remember to splice it and it can never be double-added or forgotten. Audiences whose body
 * already carries richer framing (the brain) or that need none (meta / review) get no framing.
 */
import type { JobKind } from '../domain';
import { CLOUD_SANDBOX_NOTE } from './fragments';
import { jobKindFragment } from './job-kind';
import {
  BRAIN_LAYER,
  META_LAYER,
  PLANNER_LAYER,
  REVIEW_LAYER,
  SHIP_LAYER,
  WORKER_LAYER,
} from './layers';

export type PromptAudience =
  | 'brain'
  | 'worker'
  | 'planner'
  | 'ship'
  | 'review'
  | 'meta';

const LAYER_FOR: Record<PromptAudience, string[]> = {
  brain: BRAIN_LAYER,
  worker: WORKER_LAYER,
  planner: PLANNER_LAYER,
  ship: SHIP_LAYER,
  review: REVIEW_LAYER,
  meta: META_LAYER,
};

/**
 * Per-audience system FRAMING, prepended... actually appended right after the body (before the job-kind
 * block + behavioral layer), matching where the driver bodies historically carried it. Only the in-sandbox
 * driver audiences get the sandbox note; the brain has its own longer framing in its body, and meta/review
 * chains don't run in the sandbox.
 */
const FRAMING_FOR: Record<PromptAudience, string[]> = {
  brain: [],
  worker: [CLOUD_SANDBOX_NOTE],
  planner: [CLOUD_SANDBOX_NOTE],
  ship: [CLOUD_SANDBOX_NOTE],
  review: [],
  meta: [],
};

export interface BuildSystemPromptOpts {
  audience: PromptAudience;
  /** The fully-assembled role body (any body-owned fragments already spliced in place). */
  body: string;
  /** Injects the job-kind context block. Null/undefined → no job-kind block. */
  jobKind?: JobKind | null;
}

/** Join non-empty parts with a blank line between them. */
export function joinParts(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join('\n\n');
}

/**
 * Compose a system prompt: BODY (leads) → audience FRAMING (sandbox note, driver audiences only) →
 * JOB-KIND block → audience LAYER (behavioral reminders). Deterministic order → stable/diffable output.
 *
 * INTERNAL to prompt-kit — production code never calls this directly; it goes through
 * `renderSystemPrompt(id, ctx)` (registry.ts), the single accessor. There is deliberately no head/tail
 * escape hatch: a prompt's shape is fully determined by its audience + body + job kind.
 */
export function buildSystemPrompt(opts: BuildSystemPromptOpts): string {
  return joinParts([
    opts.body,
    ...FRAMING_FOR[opts.audience],
    jobKindFragment(opts.jobKind),
    ...LAYER_FOR[opts.audience],
  ]);
}
