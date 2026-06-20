/**
 * W5 — the decision-class GATE. Local domain types for the always-ask / never-ask classifier and the
 * park-and-ask mechanism. Kept in THIS subfolder (not `domain/index.ts`) — these are W5-internal shapes
 * the section driver (W4) consumes; they reference the shared `DecisionRecord`/`DecisionClass` from
 * `../domain` (W3's locked record) but add nothing to it.
 *
 * Zero v1 imports: nothing here reaches `@harness/**` or the v1 `slack-app` surface.
 */
import type { DecisionClass, DecisionRecord } from '../domain';

/**
 * The verdict a `DecisionClassifier` returns for a proposed decision. Three outcomes, mapping directly
 * to the plan's contract:
 *
 *  - `covered`  — the decision matches a LOCKED decision in the record → proceed SILENTLY (no posting
 *                 needed, the record already announced it).
 *  - `proceed`  — a NEVER-ASK decision (internal structure, naming, file placement, test layout,
 *                 refactor mechanics, anything determined by a locked decision) → proceed, but SURFACE
 *                 it in the posted plan for visibility (never gates).
 *  - `ask`      — an UNCOVERED always-ask decision (data model/schema, public/cross-service API
 *                 contracts, new deps/libraries/services, infra/topology, cross-cutting patterns,
 *                 one-way doors) → must PARK & ASK before proceeding.
 */
export type DecisionVerdict = 'covered' | 'proceed' | 'ask';

/** A decision the section planner wants to make, handed to the classifier. */
export interface ProposedDecision {
  /** One-line description of the call ("add a `deleted_at` column to users"). */
  description: string;
  /** Any relevant context that helps classify (the section brief, surrounding plan text). Optional. */
  context?: string;
}

/** The classifier's full result — the verdict plus WHY (for the posted plan / the park question). */
export interface DecisionClassification {
  verdict: DecisionVerdict;
  /**
   * The always-ask class this decision touches, when `verdict !== 'proceed'`. On `covered` it's the
   * class the matched locked decision settles; on `ask` it's the class that triggered the park.
   * Undefined for a plain never-ask `proceed`.
   */
  decisionClass?: DecisionClass;
  /** A short human rationale — surfaced in the posted plan or used as the park question's preamble. */
  reason: string;
  /** How the verdict was reached — `rule` (deterministic) or `llm` (the ambiguous-case fallback). */
  via: 'rule' | 'llm';
  /** When `covered`, the title of the locked decision that covers it (so the plan can cite it). */
  coveredBy?: string;
}

/** The minimal slice of a `DecisionRecord` the classifier reads — model it as a typed input for now. */
export type ClassifierRecord = Pick<DecisionRecord, 'decisions'>;
