/**
 * W3 — the BRAIN's local types: the small structured turn shapes the chat model returns. The brain is
 * deliberately LEGIBLE — a tiny structured action per turn (a typed verb + its payload), NOT a sprawling
 * tool loop. Two turn shapes, two cheap calls:
 *
 *  - the TRIAGE turn (`TriageAction`) — one call per surviving stimulus: ignore / ask / dispatch.
 *  - the GRILL turn (`GrillAction`) — one call per chat turn in a scoping thread: ask a clarifying
 *    question, or propose the locked plan (decision record + high-level section list).
 *
 * These are the brain's in-memory currency, separate from both the domain types and the persistence
 * rows. Zero v1 imports.
 */
import type { Decision, JobKind } from '../domain';

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

/**
 * What ONE grill turn decides. The brain reads the thread transcript + recalled memory and either asks
 * the next clarifying question (walking the always-ask decision classes) or — once it can lock the
 * architecture/system calls + a high-level section list — proposes the plan for approval.
 *  - `ask_question` — not enough is settled; ask the human ONE focused question.
 *  - `propose_plan` — enough is settled; emit the decision record + section briefs for the approval gate.
 */
export type GrillVerb = 'ask_question' | 'propose_plan';

/** The grill turn's typed result — a discriminated union on `verb`. */
export type GrillAction =
  | {
      verb: 'ask_question';
      /** The single clarifying question to post into the thread. */
      question: string;
    }
  | {
      verb: 'propose_plan';
      /** Short feature/bugfix title. */
      title: string;
      kind: JobKind;
      /** The agreed overview seeded into every section's plan prompt (intent, stack, constraints). */
      overview: string;
      /** The locked architecture/system calls (the always-ask decisions settled in the grill). */
      decisions: Decision[];
      /** The high-level section list (one brief per section), in execution order. */
      sectionBriefs: string[];
    };

/** A single transcript line the brain reads — author + text, oldest-first. */
export interface TranscriptLine {
  /** Display name ("Dennis", "Atlas"). */
  author: string;
  /** True when Atlas (the brain) authored it. */
  isAtlas: boolean;
  text: string;
}

/** A recalled memory fact the brain grounds its turn in. */
export interface RecalledContext {
  fact: string;
  /** Cosine similarity to the query (diagnostics). */
  sim: number;
}
