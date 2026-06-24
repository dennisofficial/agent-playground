/**
 * The locked DECISION RECORD — the upfront grill's output. Atlas grills Dennis once → the
 * architecture/system calls + the high-level section list, approved ONCE. Sections then auto-run; a
 * section planner parks & asks async only when it hits an ALWAYS-ASK decision class NOT already
 * covered by the record. The record is the durable "what we agreed" that grounds every section's
 * just-in-time plan and the decision-class gate. This is the in-memory shape (separate from the
 * `decision_records` row).
 */

/**
 * The ALWAYS-ASK decision classes — the ones a section planner must park on if not already covered by
 * a locked decision. The boundary doubles as a security control (injected "go change X" in an
 * untrusted event body touches one of these → park, never execute).
 */
export type DecisionClass =
  | 'data_model' // schema / data model
  | 'api_contract' // public / cross-service API contracts
  | 'dependency' // new deps / libraries / services
  | 'infrastructure' // infra / topology
  | 'cross_cutting' // auth, caching, state, concurrency, error-handling patterns
  | 'one_way_door'; // irreversible calls

/** One locked decision inside the record — a class + the call that was made. */
export interface Decision {
  /** Which always-ask class this decision settles (so a section planner can skip parking on it). */
  decisionClass: DecisionClass;
  /** A short human label for the decision. */
  title: string;
  /** The ruling — what we decided and (briefly) why. */
  ruling: string;
}

/** The record's lifecycle. Approved ONCE upfront, then immutable for the thread's build duration. */
export type DecisionRecordStatus = 'draft' | 'approved' | 'superseded';

/** The upfront grill's locked output: the system calls + the high-level section list. */
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
   * The agreed overview — the feature's intent, stack, constraints, and how the sections fit
   * together. Seeded into EVERY section's just-in-time plan prompt so each section is grounded in the
   * whole, not just its one-line brief.
   */
  overview: string;
  /** The locked architecture/system calls. */
  decisions: Decision[];
  /** The high-level section list (briefs) approved upfront — drives the thread's `Section` rows. */
  sectionBriefs: string[];
  /** Who approved it (Dennis's id); null until approved. */
  approvedBy: string | null;
  approvedAt: Date | null;
}
