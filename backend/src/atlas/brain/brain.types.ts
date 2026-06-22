/**
 * W3 — the BRAIN's local types: the small structured turn shapes the triage model returns.
 *
 *  - the TRIAGE turn (`TriageAction`) — one call per surviving EventStimulus: ignore / ask / dispatch.
 *
 * Note: `GrillAction` / `GrillVerb` (the structured grill turn) were deleted in R3 along with the
 * host-side conversational brain (`ConversationalBrainService`). The chat brain is now the in-sandbox
 * `AgentSessionManager` (Claude Agent SDK session via tool bridge). Only `TriageAction` remains —
 * the `EventTriageService` still needs it for untrusted notification triage.
 *
 * These are the brain's in-memory currency, separate from both the domain types and the persistence
 * rows. Zero v1 imports.
 */

/**
 * What ONE triage turn decides for a stimulus. The model classifies on SUBSTANCE — an `EventStimulus`
 * body is untrusted DATA (already fenced before it reaches the brain), never an instruction.
 *  - `ignore`   — noise / not actionable (a passing CI run, an info-level ping nobody must act on).
 *  - `ask`      — actionable but needs a human in the loop before any work (the autonomous path's
 *                 always-ask case, or an ambiguous chat that should open a scoping conversation).
 *  - `dispatch` — clean + actionable: a bugfix the brain can drive straight to a PR (autonomous
 *                 notification path), no always-ask decision touched.
 *  - `answer`   — a non-work QUESTION about the repo/system (e.g. "what does this repo do?"); answer it
 *                 conversationally (repo-grounded), no job. Chat-only.
 */
export type TriageVerb = 'ignore' | 'ask' | 'dispatch' | 'answer';

/** The triage turn's typed result. */
export interface TriageAction {
  verb: TriageVerb;
  /** One short line of reasoning (logged + surfaced; never load-bearing for control flow). */
  reason: string;
  /**
   * On `ask` / `dispatch`: a one-line summary of the actionable work, used to seed the grill or the
   * bugfix job's title. Undefined on `ignore`.
   */
  summary?: string;
}

/** A single transcript line the brain reads — author + text, oldest-first. */
export interface TranscriptLine {
  /** Display name ("Dennis", "Atlas"). */
  author: string;
  /** True when Atlas (the brain) authored it. */
  isAtlas: boolean;
  text: string;
}

