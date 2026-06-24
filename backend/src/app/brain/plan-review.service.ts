import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENGINE_RUNNER, type EngineRunnerPort } from '../engine';
import type { EngineAuth } from '../engine';
import type { Decision } from '../domain';

/**
 * R4 — PLAN-LEVEL CODEX PRE-REVIEW.
 *
 * On `submit_plan` (before the operator sees the approval card): runs ONE Codex review turn in the
 * thread's sandbox against the persisted decision-record + section plan, parses the findings, and
 * returns them so `AgentSessionManager` can relay them back into the Claude session for a SINGLE
 * revision.  After that revision the session calls `submit_plan` again; the one-pass guard
 * (per-job `Set`) detects the second call and returns `null` — the caller proceeds directly to the
 * approval card.
 *
 * Architecture notes:
 * - Uses the host-side `ENGINE_RUNNER` (EngineRunner, in-process Codex SDK) — NOT a tool-bridge
 *   runner.  The review turn is read-only so it never needs the bidirectional bridge.
 * - `mode: 'review'` → Codex read-only sandbox; the plan text is its only input (no side-effects).
 * - One-pass guard: the FIRST call for a jobId runs the review and returns findings (or '' if none).
 *   The SECOND call (the revision's re-propose) skips the review and returns `null` → "proceed to
 *   approval card".  The guard resets when the process restarts, which is intentional: a restarted
 *   server means the planning session is fresh too.
 * - Best-effort: a failed Codex turn is logged + treated as "no findings" so the build isn't blocked
 *   by a review-engine outage.
 */

export interface PlanReviewInput {
  /** Job the plan belongs to (used for the one-pass guard). */
  jobId: string;
  /** Team id (for credential resolution — threaded through from the stimulus). */
  orgId: string;
  /** Worktree path the Codex review turn runs inside (read-only). */
  worktreePath: string;
  /** Container id when running in docker mode (absent → in-process local). */
  containerId?: string;
  /** The overview text from the plan. */
  overview: string;
  /** The locked decisions from the plan. */
  decisions: Decision[];
  /** The high-level section briefs from the plan. */
  sectionBriefs: string[];
  /** Optional explicit auth for the Codex turn (falls back to env). */
  auth?: EngineAuth;
}

/**
 * The result of one review pass.
 * - `{ findings }` — FIRST call: the review ran; `findings` is non-empty text if the reviewer found
 *   issues, or `''` if the plan is clean.  The caller feeds `findings` back into the session for one
 *   revision (even on '' — the session can confirm the plan is final and re-call `submit_plan`).
 * - `null` — SECOND call (same jobId): the one-pass guard fired.  Proceed straight to the approval
 *   card, no review, no revision.
 */
export type PlanReviewResult = { findings: string } | null;

/** System prompt for the Codex plan-review turn. */
const REVIEW_SYSTEM =
  'You are a senior software engineer doing a one-pass pre-review of an Atlas feature plan before ' +
  'it reaches the operator. The plan has two levels:\n' +
  '  1. A high-level decision record (locked architectural choices).\n' +
  '  2. Ordered section briefs (each will be expanded JIT into phases at build time).\n\n' +
  'Review ONLY the plan-level artifact — do NOT implement anything, do NOT read the codebase.\n\n' +
  'Report only REAL, actionable problems in this exact format (one item per line):\n' +
  '  FINDING: <concise description>\n\n' +
  'Good findings: missing always-ask decisions that will be needed, contradictions between decisions, ' +
  'section ordering that will cause integration pain, sections whose briefs are dangerously vague.\n' +
  'Do NOT report: stylistic nits, naming preferences, implementation details that belong in phases, ' +
  'anything that is already covered by the decision record.\n\n' +
  'If the plan looks solid, output exactly: NO_FINDINGS';

/** Render the plan as a compact review input. */
function renderPlanForReview(input: PlanReviewInput): string {
  const decisions = input.decisions.length
    ? input.decisions
        .map((d: Decision) => `  [${d.decisionClass}] ${d.title}: ${d.ruling}`)
        .join('\n')
    : '  (none)';

  const sections = input.sectionBriefs.length
    ? input.sectionBriefs.map((b, i) => `  ${i + 1}. ${b}`).join('\n')
    : '  (none)';

  return [
    'Review this Atlas feature plan and identify any real, actionable problems.\n',
    `OVERVIEW:\n${input.overview}\n`,
    `LOCKED DECISIONS:\n${decisions}\n`,
    `SECTIONS (high-level briefs — JIT-expanded at build time):\n${sections}\n`,
    'Output FINDING: lines for each real problem, or NO_FINDINGS if the plan looks solid.',
  ].join('\n');
}

/**
 * Parse the Codex reviewer's output into a trimmed findings string. Returns '' if the reviewer
 * reported NO_FINDINGS or produced no FINDING: lines.
 */
export function parsePlanFindings(reviewerOutput: string): string {
  if (/\bNO_FINDINGS\b/i.test(reviewerOutput)) return '';

  const lines = reviewerOutput
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^FINDING:/i.test(l))
    .map((l) => l.replace(/^FINDING:\s*/i, '').trim())
    .filter(Boolean);

  return lines.length > 0 ? lines.map((f) => `• ${f}`).join('\n') : '';
}

@Injectable()
export class PlanReviewService {
  private readonly logger = new Logger(PlanReviewService.name);

  /**
   * Tracks which jobs have already had their plan reviewed this process lifetime.
   * The second call for the same job returns `null` (one-pass guard).
   */
  private readonly reviewed = new Set<string>();

  constructor(
    @Inject(ENGINE_RUNNER) private readonly engine: EngineRunnerPort,
  ) {}

  /**
   * Run the plan pre-review for a job.
   *
   * FIRST call for `jobId` → runs ONE Codex review turn in-sandbox → returns `{ findings }`.
   *   - `findings` is non-empty text when the reviewer flagged issues.
   *   - `findings` is `''` when the plan is clean (the plan doc mandates we still relay empty
   *     findings back so the session can confirm and re-call `submit_plan`).
   *
   * SECOND call for the same `jobId` → one-pass guard → returns `null` → caller raises the
   * approval card immediately.
   *
   * On any Codex engine error: logs a warning + returns `{ findings: '' }` (best-effort; never
   * blocks the build).
   */
  async review(input: PlanReviewInput): Promise<PlanReviewResult> {
    // ── One-pass guard ──────────────────────────────────────────────────────────────────────────
    if (this.reviewed.has(input.jobId)) {
      this.logger.log(
        `plan-review: job=${input.jobId} already reviewed — skipping (raising approval card)`,
      );
      return null;
    }
    this.reviewed.add(input.jobId);

    // ── Codex review turn ────────────────────────────────────────────────────────────────────────
    const sandboxKey = `plan-review-${input.orgId}-${input.jobId}`;
    const task = renderPlanForReview(input);

    this.logger.log(`plan-review: running Codex review turn for job=${input.jobId}`);

    let reviewerOutput: string;
    try {
      const result = await this.engine.run({
        engine: 'codex',
        task,
        cwd: input.worktreePath,
        systemPrompt: REVIEW_SYSTEM,
        sandboxKey,
        mode: 'review',
        ...(input.auth ? { auth: input.auth } : {}),
        ...(input.containerId ? { target: { containerId: input.containerId } } : {}),
      });
      reviewerOutput = result.result;
    } catch (err) {
      this.logger.warn(
        `plan-review: Codex turn failed for job=${input.jobId} — treating as no findings: ${err}`,
      );
      return { findings: '' };
    }

    const findings = parsePlanFindings(reviewerOutput);
    this.logger.log(
      findings
        ? `plan-review: job=${input.jobId} — ${findings.split('\n').length} finding(s)`
        : `plan-review: job=${input.jobId} — clean (no findings)`,
    );

    return { findings };
  }

  /**
   * Expose for testing: reset the guard for a specific job (used in test teardowns when a single
   * test exercises both the review pass and the guard pass).
   * @internal
   */
  _resetGuardForJob(jobId: string): void {
    this.reviewed.delete(jobId);
  }
}

/**
 * Build the revision instruction that is injected into the Claude session's `submit_plan` tool
 * response when the plan reviewer finds issues.
 */
export function buildRevisionInstruction(findings: string): string {
  return (
    'The plan was reviewed by a Codex reviewer before being shown to the operator. ' +
    'The following issues were found — please revise your plan to address them, ' +
    'then call `submit_plan` again with the updated plan:\n\n' +
    findings +
    '\n\n' +
    'Address each finding above (or explicitly note why one does not apply). ' +
    'After revising, call `submit_plan` again. The revised plan will go straight to the operator.'
  );
}
