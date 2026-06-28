import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { ENGINE_RUNNER, type EngineRunnerPort } from '../engine';
import type { EngineAuth } from '../engine';
import type { Decision } from '../domain';
import type { PlannedStep } from '../driver/planner-llm';
import { ThreadLifecycleService } from '../driver/thread-lifecycle.service';
import { CredentialResolver } from '../onboarding';
import { DB_CONNECTION } from '../persistence/database.module';
import { PlanReviewEntity } from '../persistence/entities';

/**
 * R4 — ASYNC, DURABLE CODEX PLAN PRE-REVIEW.
 *
 * On `submit_plan` the thread enters `plan_review` and a `plan_reviews` ROW is created (`start`) with the
 * rendered review `prompt`. A background Codex turn then runs in the thread's sandbox (`runReview`,
 * 5-30 min) — NOT inside the `submit_plan` tool call (which returns immediately). On completion the row is
 * stamped (`findings`, `completed_at`, `status`); `AgentSessionManager` delivers the findings to Atlas in
 * a server-initiated turn and stamps `delivered_at`.
 *
 * Durability (mirrors the `ask_question` gate): the row is the at-least-once spine. A host restart mid-
 * review leaves a `running` row (boot re-runs it) or a `complete`/`failed` row with `delivered_at = null`
 * (boot re-delivers it). Each `submit_plan` is a new bounded `round`.
 *
 * Architecture notes:
 * - Uses `ENGINE_RUNNER` (the Docker engine runner) — NOT the bidirectional tool bridge. The review turn
 *   is read-only so it never needs the bridge.
 * - `mode: 'review'` → Codex read-only sandbox; the stored `prompt` is its only input (no side-effects).
 * - Best-effort: a failed Codex turn is recorded as `failed` + treated as "no findings" so the build is
 *   never blocked by a review-engine outage.
 */

/** What `start` needs to render + persist a review round. */
export interface PlanReviewStartInput {
  /** Thread the plan belongs to. */
  threadId: string;
  /** Tenant (for credential resolution + sandbox scoping). */
  orgId: string;
  /** The draft decision record this round grades (audit). */
  decisionRecordId?: string | null;
  /** The overview text from the plan. */
  overview: string;
  /** The locked decisions from the plan. */
  decisions: Decision[];
  /** The high-level track briefs (titles) from the plan. */
  trackTitles: string[];
  /**
   * The steps Atlas authored under each track, aligned by track index (`stepsByTrack[i]` = steps for
   * `trackTitles[i]`). Present on the full-plan path so the reviewer grades the EXECUTION detail, not
   * just titles. Absent on step-less paths (the reviewer then sees titles only).
   */
  stepsByTrack?: PlannedStep[][];
}

/** Outcome of `start`: a fresh review round, or the round cap was hit (no review run). */
export type PlanReviewStart =
  | { reviewId: string; round: number }
  | { capped: true; round: number };

/** System prompt for the Codex plan-review turn. */
const REVIEW_SYSTEM =
  'You are a senior software engineer doing a one-pass pre-review of an Atlas feature plan before ' +
  'it reaches the operator. The full plan is authored across `/context/specs/` — `plan.md` (the INDEX: ' +
  'goal, overview, architecture, the ordered track list), `sections/NN-<slug>.md` (one per track, with ' +
  'its steps), `data-model.md` (cross-cutting schema, when present), `decision-record.md`, and diagrams. ' +
  'You are given the overview, the locked decisions, and the ordered track titles below.\n\n' +
  'READ `plan.md` AND the per-track `sections/*.md` (and `data-model.md`) for the full detail, and you ' +
  'MAY read the codebase files they reference (read-only) to verify it is GROUNDED — but do NOT ' +
  'implement anything or change any files.\n\n' +
  'Report only REAL, actionable problems in this exact format (one item per line):\n' +
  '  FINDING: <concise description>\n\n' +
  'Each track lists its STEPS — the execute-ready steps, each with concrete touch points and ' +
  'instructions. Atlas authors the full implementation detail up front (there is no later "step ' +
  'planning" step), so grade that detail: a step whose touch points are wrong/missing, that is too ' +
  'vague to build from without further questions, that lacks a real verification command, or that ' +
  'contradicts a locked decision IS a finding.\n' +
  'Good findings: missing always-ask decisions that will be needed, contradictions between decisions, ' +
  'track/step ordering that will cause integration pain, touch points that are wrong or do not ' +
  'exist, steps that are dangerously vague or ungrounded, missing or hand-wavy verification.\n' +
  'Do NOT report: stylistic nits, naming preferences, anything already covered by the decision record.\n\n' +
  'If the plan looks solid, output exactly: NO_FINDINGS';

/** Render the plan as a compact review input. */
function renderPlanForReview(input: PlanReviewStartInput): string {
  const decisions = input.decisions.length
    ? input.decisions
        .map((d: Decision) => `  [${d.decisionClass}] ${d.title}: ${d.ruling}`)
        .join('\n')
    : '  (none)';

  const tracks = input.trackTitles.length
    ? input.trackTitles
        .map((b, i) => {
          const steps = input.stepsByTrack?.[i] ?? [];
          if (!steps.length) return `  ${i + 1}. ${b}`;
          const body = steps
            .map((p, j) => `     ${i + 1}.${j + 1} ${p.title}\n       ${p.brief.replace(/\n/g, '\n       ')}`)
            .join('\n');
          return `  ${i + 1}. ${b}\n${body}`;
        })
        .join('\n')
    : '  (none)';

  const hasPhases = (input.stepsByTrack ?? []).some((p) => p.length);
  return [
    'Review this Atlas feature plan and identify any real, actionable problems.\n',
    `OVERVIEW:\n${input.overview}\n`,
    `LOCKED DECISIONS:\n${decisions}\n`,
    hasPhases
      ? `TRACKS (each with its authored steps — the build executes these directly):\n${tracks}\n`
      : `TRACKS (high-level briefs):\n${tracks}\n`,
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

  /** Max review ROUNDS per thread — each `submit_plan` is a round. Bounds Codex cost/latency. */
  private readonly maxRounds = Number(process.env['PLAN_REVIEW_MAX_ROUNDS']) || 3;

  constructor(
    @Inject(ENGINE_RUNNER) private readonly engine: EngineRunnerPort,
    private readonly creds: CredentialResolver,
    private readonly lifecycle: ThreadLifecycleService,
    @InjectRepository(PlanReviewEntity, DB_CONNECTION)
    private readonly reviews: Repository<PlanReviewEntity>,
  ) {}

  /** The round cap (so callers can phrase the "cap reached" message). */
  get maxReviewRounds(): number {
    return this.maxRounds;
  }

  /**
   * Open a review round: render the prompt, persist a `running` row. Returns `{ reviewId, round }`, or
   * `{ capped }` when the thread has already had `maxRounds` rounds (the caller then lets Atlas finalize
   * over the existing findings rather than re-reviewing forever). Does NOT run the Codex turn — call
   * `runReview(reviewId)` next (in the background).
   */
  async start(input: PlanReviewStartInput): Promise<PlanReviewStart> {
    const prior = await this.reviews.count({ where: { thread_id: input.threadId } });
    const round = prior + 1;
    if (round > this.maxRounds) {
      this.logger.log(`plan-review: thread=${input.threadId} hit round cap (${this.maxRounds}) — not reviewing`);
      return { capped: true, round: prior };
    }
    const prompt = renderPlanForReview(input);
    const row = await this.reviews.save(
      this.reviews.create({
        thread_id: input.threadId,
        org_id: input.orgId,
        decision_record_id: input.decisionRecordId ?? null,
        round,
        status: 'running',
        prompt,
        findings: null,
        completed_at: null,
        delivered_at: null,
      }),
    );
    this.logger.log(`plan-review: opened round ${round} (review=${row.id}) for thread=${input.threadId}`);
    return { reviewId: row.id, round };
  }

  /**
   * Run the Codex review turn for a `running` row: (re-)attach the thread's sandbox, run the read-only
   * Codex turn against the stored prompt, parse the findings, and stamp the row `complete` (or `failed`
   * on engine error → treated as no findings). Idempotent-ish: re-running a row simply re-stamps it.
   * Returns the findings (''=clean) and the terminal status.
   */
  async runReview(reviewId: string): Promise<{ status: 'complete' | 'failed'; findings: string }> {
    const row = await this.reviews.findOneOrFail({ where: { id: reviewId } });

    // (Re-)attach a live container against the durable worktree (the async/boot path can't assume one is
    // warm). Returns null only if the thread has no sandbox row or is closed → record failed, no findings.
    const ensured = await this.lifecycle.ensureContainer(row.thread_id, row.org_id).catch((err) => {
      this.logger.warn(`plan-review: ensureContainer failed for review=${reviewId}: ${err}`);
      return null;
    });
    if (!ensured) {
      await this.stamp(row, 'failed', '');
      return { status: 'failed', findings: '' };
    }
    const sandbox = ensured.sandbox;

    const sandboxKey = `plan-review-${row.org_id}-${reviewId}`;
    // Per-org Codex subscription secret (deployed); undefined locally → the in-container engine falls back
    // to CODEX_OAUTH_TOKEN. With neither set the turn throws and is caught below as "failed / no findings".
    const auth: EngineAuth | undefined = await this.creds.engineAuth(row.org_id, 'codex');

    this.logger.log(`plan-review: running Codex review turn for review=${reviewId} thread=${row.thread_id}`);
    let reviewerOutput: string;
    try {
      const result = await this.engine.run({
        engine: 'codex',
        task: row.prompt,
        cwd: sandbox.worktreePath,
        systemPrompt: REVIEW_SYSTEM,
        sandboxKey,
        mode: 'review',
        ...(auth ? { auth } : {}),
        ...(sandbox.containerId
          ? { target: { containerId: sandbox.containerId, worktreeHost: sandbox.worktreePath } }
          : {}),
      });
      reviewerOutput = result.result;
    } catch (err) {
      this.logger.warn(`plan-review: Codex turn failed for review=${reviewId} — recording failed: ${err}`);
      await this.stamp(row, 'failed', '');
      return { status: 'failed', findings: '' };
    }

    const findings = parsePlanFindings(reviewerOutput);
    await this.stamp(row, 'complete', findings);
    this.logger.log(
      findings
        ? `plan-review: review=${reviewId} — ${findings.split('\n').length} finding(s)`
        : `plan-review: review=${reviewId} — clean (no findings)`,
    );
    return { status: 'complete', findings };
  }

  /** Stamp a review row terminal: findings + completed_at + status. */
  private async stamp(row: PlanReviewEntity, status: 'complete' | 'failed', findings: string): Promise<void> {
    await this.reviews.update({ id: row.id }, { status, findings, completed_at: new Date() });
  }

  /** Load one review row (for delivery). */
  async load(reviewId: string): Promise<PlanReviewEntity | null> {
    return this.reviews.findOne({ where: { id: reviewId } });
  }

  /** Stamp a review delivered (its findings reached Atlas in a turn that actually ran). */
  async markDelivered(reviewId: string): Promise<void> {
    await this.reviews.update({ id: reviewId }, { delivered_at: new Date() });
  }

  /**
   * Boot reconciliation: rows whose Codex turn was in flight when the host died (`running`). Each must be
   * re-run. (`completed_at` is null on these.)
   */
  async findIncompleteReviews(): Promise<PlanReviewEntity[]> {
    return this.reviews.find({ where: { status: 'running' } });
  }

  /**
   * Boot reconciliation: rows the Codex turn finished but whose delivery turn the host crash dropped
   * (`complete`/`failed`, `delivered_at` null). Each must be re-delivered (at-least-once).
   */
  async findUndeliveredReviews(): Promise<PlanReviewEntity[]> {
    return this.reviews.find({
      where: { status: In(['complete', 'failed']), delivered_at: IsNull() },
    });
  }
}

/**
 * Build the operator-visible + Atlas-facing body for a delivered review round. Serves DOUBLE DUTY: it is
 * the harness-seeded "Codex review" message the operator sees AND the input the brain's session receives,
 * so the operator watches the exact same exchange Atlas reacts to.
 */
export function renderFindingsDelivery(findings: string, round: number, capReached: boolean): string {
  const header = `🔍 **Codex plan review** (round ${round})`;
  if (!findings) {
    return (
      `${header} — no findings. The plan looks solid.\n\n` +
      'Atlas: call `finalize_plan` to send it to the operator for approval, or `submit_plan` to revise ' +
      'further first.'
    );
  }
  const capNote = capReached
    ? '\n\n(Review-round cap reached — address these, then `finalize_plan`; the operator sees any you push back on.)'
    : '\n\nAtlas: address each — APPLY it, or PUSH BACK with reasoning — then call `submit_plan` to ' +
      're-review, or `finalize_plan` to send the reviewed plan to the operator for approval.';
  return `${header} — ${findings.split('\n').length} finding(s):\n\n${findings}${capNote}`;
}
