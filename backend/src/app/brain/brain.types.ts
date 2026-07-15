/**
 * W3 — the BRAIN's local types.
 *
 * Note: `GrillAction`/`GrillVerb` (the structured grill turn) AND `TriageAction`/`TriageVerb` (the
 * event-triage turn) were both deleted along with the host-side second brain. The chat brain is the
 * in-sandbox `AgentSessionManager`; an event is now delivered to that SAME session as a harness message
 * (`AgentSessionManager.deliverEvent`), so there is no separate triage shape. See `../ARCHITECTURE.md` §7.
 *
 * These are the brain's in-memory currency, separate from both the domain types and the persistence
 * rows. Zero v1 imports.
 */

/** A single transcript line the brain reads — author + text, oldest-first. */
export interface TranscriptLine {
  /** Display name ("Dennis", "Atlas"). */
  author: string;
  /** True when Atlas (the brain) authored it. */
  isAtlas: boolean;
  text: string;
}
