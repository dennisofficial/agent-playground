/**
 * The locked DECISION RECORD — the upfront grill's output. Atlas grills Dennis once → the
 * architecture/system calls + the high-level track list, approved ONCE. Sections then auto-run; a
 * track planner parks & asks async only when it hits an ALWAYS-ASK decision class NOT already
 * covered by the record. The record is the durable "what we agreed" that grounds every track's
 * just-in-time plan and the decision-class gate. This is the in-memory shape (separate from the
 * `decision_records` row).
 */

/**
 * The ALWAYS-ASK decision classes — the ones a track planner must park on if not already covered by
 * a locked decision. The boundary doubles as a security control (injected "go change X" in an
 * untrusted event body touches one of these → park, never execute).
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH for the classes, their canonical order, and their human-facing
 * blurbs. Everything else derives from it: the {@link DecisionClass} union, the order + section
 * headings of the generated `decision-record.md`, the grilling-protocol enumeration and the
 * `create_decision` validation in the brain's system prompt, the runtime arg-coercion set, and the
 * classifier's Zod enum. Add or reorder a class HERE and every consumer follows — do not re-list
 * the classes anywhere else.
 */
export const DECISION_CLASS_META = [
  { id: 'data_model', heading: 'Data model', grill: 'data model/schema' },
  { id: 'api_contract', heading: 'API contract', grill: 'public API contracts' },
  { id: 'dependency', heading: 'Dependencies', grill: 'new dependencies' },
  { id: 'infrastructure', heading: 'Infrastructure', grill: 'infrastructure/topology' },
  {
    id: 'cross_cutting',
    heading: 'Cross-cutting',
    grill: 'cross-cutting patterns (auth, caching, state, concurrency, error-handling)',
  },
  { id: 'one_way_door', heading: 'One-way doors', grill: 'one-way doors' },
] as const satisfies ReadonlyArray<{ id: string; heading: string; grill: string }>;

export type DecisionClass = (typeof DECISION_CLASS_META)[number]['id'];

/** The canonical ordered list of class ids — drives every derived enumeration (order, set, enum). */
export const DECISION_CLASS_IDS: readonly DecisionClass[] = DECISION_CLASS_META.map((c) => c.id);

/**
 * Allocate the next stable decision id for a thread's working set: `d<max+1>` over the existing
 * `d<n>` ids (`d1` when none). Max-based so ids are NEVER reused after a delete (a deleted id must
 * not resurface and re-point a stale reference). Tolerates entries with no/legacy id.
 */
export function nextDecisionId(existing: Pick<Decision, 'id'>[]): string {
  const max = existing.reduce((m, d) => {
    const match = /^d(\d+)$/.exec(d.id ?? '');
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  return `d${max + 1}`;
}

/** One locked decision inside the record — a class + the call that was made. */
export interface Decision {
  /**
   * Server-issued stable id (`d1`, `d2`, …), the handle `update_decision`/`delete_decision` address.
   * OPTIONAL by design: `BrainStoreService.createDecision` always populates it, but pre-existing
   * working-set rows and explicit-override entries may lack one (and are then simply not addressable
   * by id). Keeping it optional also lets the many `Decision` literals across specs compile unchanged.
   */
  id?: string;
  /** Which always-ask class this decision settles (so a track planner can skip parking on it). */
  decisionClass: DecisionClass;
  /** A short human label for the decision. */
  title: string;
  /** The ruling — what we decided and (briefly) why. */
  ruling: string;
  /**
   * The formal question the brain asked the operator that this decision settles (when it came from an
   * `ask_question` → answer flow). Captured so the generated decision record shows the actual exchange,
   * not just the after-the-fact ruling. Optional — a decision can be logged without a prior question.
   */
  question?: string;
  /** The operator's answer to {@link question} (the option they picked or the free text they typed). */
  answer?: string;
}

/** The record's lifecycle. Approved ONCE upfront, then immutable for the thread's build duration. */
export type DecisionRecordStatus = 'draft' | 'approved' | 'superseded';

/** The upfront grill's locked output: the system calls + the high-level track list. */
export interface DecisionRecord {
  /** Stable id (`decision_records.id`). */
  id: string;
  /** The owning organization (`org_id`). */
  orgId: string;
  /** The project this record scopes to. */
  repoId: string;
  /** The thread this record was produced for. */
  threadId: string;
  status: DecisionRecordStatus;
  /**
   * The agreed overview — the feature's intent, stack, constraints, and how the tracks fit
   * together. Seeded into EVERY track's just-in-time plan prompt so each track is grounded in the
   * whole, not just its one-line brief.
   */
  overview: string;
  /** The locked architecture/system calls. */
  decisions: Decision[];
  /** The high-level track list (briefs) approved upfront — drives the thread's `Track` rows. */
  trackTitles: string[];
  /** Who approved it (Dennis's id); null until approved. */
  approvedBy: string | null;
  approvedAt: Date | null;
}
