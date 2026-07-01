import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { ENGINE_RUNNER, type EngineRunnerPort } from '../engine';
import type { EngineAuth } from '../engine';
import type { Decision } from '../domain';
import type { PlannedStep } from '../driver/planner-llm';
import { JobLifecycleService } from '../driver/job-lifecycle.service';
import { LeaderElectionService } from '../cluster';
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
export type PlanReviewStartInput = {
  /** Thread the plan belongs to. */
  threadId: string;
  /** Tenant (for credential resolution + sandbox scoping). */
  orgId: string;
  /** The draft decision record this round grades (audit). */
  decisionRecordId?: string | null;
  /**
   * The one-line GOAL of the thread — the operator's INTENT. The reviewer judges whether the plan
   * actually achieves THIS (not just whether it is internally consistent).
   */
  goal: string;
  /**
   * The originating ticket (when the thread was promoted from one) — the operator's captured intent +
   * context. Given to the reviewer so it can check the plan against what was actually asked for. Absent
   * for threads not tied to a ticket.
   */
  ticket?: { number: number; title: string; body?: string } | null;
  /** The overview text from the plan. */
  overview: string;
  /** The locked decisions from the plan. */
  decisions: Decision[];
  /** The high-level track briefs (titles) from the plan. */
  threadTitles: string[];
  /**
   * The steps Atlas authored under each track, aligned by track index (`stepsByThread[i]` = steps for
   * `threadTitles[i]`). Present on the full-plan path so the reviewer grades the EXECUTION detail, not
   * just titles. Absent on step-less paths (the reviewer then sees titles only).
   */
  stepsByThread?: PlannedStep[][];
};

/** Outcome of `start`: a fresh review round, or the round cap was hit (no review run). */
export type PlanReviewStart =
  | { reviewId: string; round: number }
  | { capped: true; round: number };

/**
 * System prompt for the Codex plan-review turn — a STRUCTURED brief, not "review this and tell me your
 * findings". It frames Codex as an independent reviewer (it did NOT write the plan), points it at the
 * authored specs + the repo to GROUND its critique, names the failure modes to hunt in priority order
 * (intent gaps first), and pins a tight FINDING:/NO_FINDINGS output contract. The operator's INTENT and
 * the structured plan arrive in the per-run task (`renderPlanForReview`).
 */
const REVIEW_SYSTEM = [
  '<role>',
  'You are an independent senior software engineer doing a pre-review of a feature PLAN that another',
  'engineer ("Atlas") authored for THIS repository, before it goes to the operator for approval. You did',
  'NOT write this plan — review it skeptically. Your job: find the REAL, actionable problems, and above',
  "all judge whether the plan actually ACHIEVES the operator's stated intent (see <intent> in the task).",
  'Read the repository (read-only) to ground EVERY claim against its real architecture and conventions.',
  'Do NOT implement anything, do NOT change any files, and do NOT nitpick wording.',
  '</role>',
  '',
  '<plan_location>',
  'The full plan is authored under `/context/specs/` — READ THESE before judging (they are authoritative;',
  'the <authored_plan> summary in the task is just an index):',
  '  - `plan.md` — goal · overview · architecture/diagrams · the ordered track list',
  '  - `sections/NN-<slug>.md` — ONE per track: its goal, context, execute-ready steps, validation',
  '  - `data-model.md` — cross-cutting schema/migrations (when the work touches the schema)',
  '  - `generated/decision-record.md` — the locked always-ask decisions',
  'Then read the codebase files the steps reference to verify the plan is GROUNDED in what actually exists.',
  '</plan_location>',
  '',
  '<what_to_hunt>',
  'Report only REAL, actionable problems. Highest-value first:',
  '  1. INTENT GAP — the plan does not achieve what the operator asked for: a missing capability, a misread',
  '     requirement, scope that drifts from the goal/ticket, or an obvious failure mode / edge case the goal',
  '     implies that the plan never handles. This is the most important class.',
  '  2. UNGROUNDED / WRONG touch points — a step cites a `path:line` or symbol that is wrong or does not',
  '     exist, or builds against an API/pattern this repo does not actually have. Verify against the code.',
  '  3. MISSING / CONTRADICTORY decisions — an always-ask decision (data model, API contract, dependency,',
  '     infra, cross-cutting pattern, one-way door) the plan needs but never locks, or two that conflict.',
  '  4. ORDERING / INTEGRATION risk — track/step ordering that breaks the build (e.g. a step depends on a',
  '     migration a later step creates).',
  '  5. UNBUILDABLE step — too vague to build without re-asking the operator, or with no real verification.',
  '     Atlas authors the FULL implementation detail up front (there is no later "step planning"), so grade',
  '     that detail at the altitude of an implementation diff.',
  '  6. VERSION / DEPENDENCY mismatch — the plan assumes an API shape, config flag, component name, or CLI',
  '     syntax that does not match the version actually installed in this repo (check package.json / the',
  '     lockfile / the imports). Flag anything that mixes patterns from a different version or generation of',
  '     a library, SDK, framework, or platform than what is in use.',
  '  7. OVER-ENGINEERING / SCOPE CREEP — the plan introduces a NEW abstraction, dependency, service, or',
  '     pattern where an EXISTING one in this repo would do, or builds more than the goal needs. Changes',
  '     should be minimal and tightly scoped; flag speculative generality and gold-plating.',
  "  8. CONVENTION BREAK — the plan's approach contradicts THIS repo's OWN established conventions: its",
  '     naming, type style, file/module layout, error-handling, state/data-access, and test patterns. Judge',
  '     against what the repo actually does (read neighboring code), NOT an external style preference.',
  'Do NOT report: stylistic nits, personal preferences not grounded in the repo, anything already settled',
  'in the decision record.',
  '</what_to_hunt>',
  '',
  '<output_contract>',
  'Output ONLY findings, one per line, each EXACTLY in this form:',
  '  FINDING: <concise, actionable problem — what is wrong and why it matters>',
  'Be a demanding reviewer: surface every substantive issue you can justify from the specs + the code.',
  'Output EXACTLY `NO_FINDINGS` (and nothing else) ONLY if, after reading the specs and the referenced',
  'code, you genuinely cannot find a substantive problem and the plan clearly achieves the intent.',
  '</output_contract>',
].join('\n');

/** Render the structured review task: the operator's INTENT first, then the authored plan to grade. */
function renderPlanForReview(input: PlanReviewStartInput): string {
  const decisions = input.decisions.length
    ? input.decisions
        .map((d: Decision) => `  [${d.decisionClass}] ${d.title}: ${d.ruling}`)
        .join('\n')
    : '  (none)';

  const tracks = input.threadTitles.length
    ? input.threadTitles
        .map((b, i) => {
          const steps = input.stepsByThread?.[i] ?? [];
          if (!steps.length) return `  ${i + 1}. ${b}`;
          const body = steps
            .map(
              (p, j) =>
                `     ${i + 1}.${j + 1} ${p.title}\n       ${p.brief.replace(/\n/g, '\n       ')}`,
            )
            .join('\n');
          return `  ${i + 1}. ${b}\n${body}`;
        })
        .join('\n')
    : '  (none)';

  const hasPhases = (input.stepsByThread ?? []).some((p) => p.length);

  // The INTENT block — what the operator is trying to achieve. The reviewer judges the plan against THIS.
  const intent = [
    '<intent>',
    'What the operator is trying to achieve. Judge the plan against THIS — not your own idea of the feature.',
    '',
    `GOAL: ${input.goal || '(see overview)'}`,
  ];
  if (input.ticket) {
    intent.push(
      '',
      `ORIGINATING TICKET #${input.ticket.number} — ${input.ticket.title}`,
      ...(input.ticket.body ? [input.ticket.body] : []),
    );
  }
  intent.push(
    '',
    "OVERVIEW (Atlas's framing of the work):",
    input.overview,
    '</intent>',
  );

  const authoredPlan = [
    '<authored_plan>',
    'The structured plan Atlas authored. The `/context/specs/` files are authoritative — read them; this is',
    'just the index to orient your reading.',
    '',
    'LOCKED DECISIONS:',
    decisions,
    '',
    hasPhases
      ? 'TRACKS (each with its execute-ready steps — the build runs these directly):'
      : 'TRACKS (high-level briefs):',
    tracks,
    '</authored_plan>',
  ];

  return [
    ...intent,
    '',
    ...authoredPlan,
    '',
    'Now review per <what_to_hunt> + <output_contract>. Read the specs and the referenced code first.',
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
  private readonly maxRounds =
    Number(process.env['PLAN_REVIEW_MAX_ROUNDS']) || 3;

  /**
   * Wall-clock ceiling for ONE Codex review turn. A review that has not returned by this point is
   * abandoned: the turn is aborted, the row is stamped `failed` (a timeout), and delivery surfaces it as
   * a non-clean failure (never a silent "no findings"). Set comfortably above the 5-30 min expected range
   * so only a genuine HANG trips it. Doubles as the `runningReview` orphan threshold: a row stuck
   * `running` past this age means the host died before the in-process timer could fire (the timer dies
   * with the process), so the gate stops treating it as blocking. Env-tunable.
   */
  private readonly timeoutMs =
    Number(process.env['PLAN_REVIEW_TIMEOUT_MS']) || 45 * 60_000;

  constructor(
    @Inject(ENGINE_RUNNER) private readonly engine: EngineRunnerPort,
    private readonly creds: CredentialResolver,
    private readonly lifecycle: JobLifecycleService,
    @InjectRepository(PlanReviewEntity, DB_CONNECTION)
    private readonly reviews: Repository<PlanReviewEntity>,
    // Lets the turn catch tell a shutdown-induced abort (leave the row resumable) from a real failure.
    private readonly election: LeaderElectionService,
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
    const prior = await this.reviews.count({
      where: { job_id: input.threadId },
    });
    const round = prior + 1;
    if (round > this.maxRounds) {
      this.logger.log(
        `plan-review: thread=${input.threadId} hit round cap (${this.maxRounds}) — not reviewing`,
      );
      return { capped: true, round: prior };
    }
    const prompt = renderPlanForReview(input);
    const row = await this.reviews.save(
      this.reviews.create({
        job_id: input.threadId,
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
    this.logger.log(
      `plan-review: opened round ${round} (review=${row.id}) for thread=${input.threadId}`,
    );
    return { reviewId: row.id, round };
  }

  /**
   * Run the Codex review turn for a `running` row: (re-)attach the thread's sandbox, run the read-only
   * Codex turn against the stored prompt, parse the findings, and stamp the row `complete` (or `failed`
   * on engine error → treated as no findings). Idempotent-ish: re-running a row simply re-stamps it.
   * Returns the findings (''=clean) and the terminal status.
   */
  async runReview(reviewId: string): Promise<{
    status: 'complete' | 'failed';
    findings: string;
    error?: string;
  }> {
    const row = await this.reviews.findOneOrFail({ where: { id: reviewId } });

    // (Re-)attach a live container against the durable worktree (the async/boot path can't assume one is
    // warm). Returns null only if the thread has no sandbox row or is closed → record failed, no findings.
    const ensured = await this.lifecycle
      .ensureContainer(row.job_id, row.org_id)
      .catch((err) => {
        this.logger.warn(
          `plan-review: ensureContainer failed for review=${reviewId}: ${err}`,
        );
        return null;
      });
    if (!ensured) {
      const error =
        'Could not attach a sandbox to run the review (no container for this thread).';
      await this.stamp(row, 'failed', '', error);
      return { status: 'failed', findings: '', error };
    }
    const sandbox = ensured.sandbox;

    const sandboxKey = `plan-review-${row.org_id}-${reviewId}`;
    // Per-org Codex subscription secret (deployed); undefined locally → the in-container engine falls back
    // to CODEX_OAUTH_TOKEN. With neither set the turn throws and is caught below as "failed / no findings".
    const auth: EngineAuth | undefined = await this.creds.engineAuth(
      row.org_id,
      'codex',
    );

    this.logger.log(
      `plan-review: running Codex review turn for review=${reviewId} thread=${row.job_id}`,
    );

    // Watchdog: bound the turn so a HUNG engine can never leave the row stuck `running` forever (which
    // would wedge the `finalize_plan` gate). The runner honors `signal`, so abort propagates and aborts
    // the turn; the `Promise.race` is the belt-and-suspenders that lets `runReview` return even if a
    // runner ignored the signal. On timeout we throw → the catch below stamps the row `failed`.
    const ac = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
        reject(
          new Error(
            `Codex plan review timed out after ${Math.round(this.timeoutMs / 60_000)}m`,
          ),
        );
      }, this.timeoutMs);
    });

    let reviewerOutput: string;
    try {
      const result = await Promise.race([
        this.engine.run({
          engine: 'codex',
          task: row.prompt,
          cwd: sandbox.worktreePath,
          systemPrompt: REVIEW_SYSTEM,
          sandboxKey,
          mode: 'review',
          // Review hard — pin max reasoning (subscription accounts accept this knob; verified by spike).
          modelReasoningEffort: 'xhigh',
          signal: ac.signal,
          ...(auth ? { auth } : {}),
          ...(sandbox.containerId
            ? {
                target: {
                  containerId: sandbox.containerId,
                  worktreeHost: sandbox.worktreePath,
                },
              }
            : {}),
        }),
        watchdog,
      ]);
      reviewerOutput = result.result;
    } catch (err) {
      const error = summarizeEngineError(err);
      if (!timedOut && this.election.isDraining()) {
        // PROCESS SHUTDOWN (not a local timeout, not a real failure): the drain cut off the review turn.
        // Leave the row 'running' so the boot reconcile (`findReviewsToReconcile`, status:'running')
        // re-runs it; stamping 'failed' would strand it (terminal, never reconciled). `timedOut` aborts
        // fire while still leader/follower, so they still fall through to the 'failed' stamp below.
        this.logger.warn(
          `plan-review: review=${reviewId} left 'running' — aborted by shutdown drain; boot reconcile will re-run`,
        );
        return { status: 'failed', findings: '', error };
      }
      this.logger.warn(
        `plan-review: Codex turn ${timedOut ? 'timed out' : 'failed'} for review=${reviewId} — recording failed: ${err}`,
      );
      await this.stamp(row, 'failed', '', error);
      return { status: 'failed', findings: '', error };
    } finally {
      if (timer) clearTimeout(timer);
    }

    const findings = parsePlanFindings(reviewerOutput);
    await this.stamp(row, 'complete', findings, null);
    this.logger.log(
      findings
        ? `plan-review: review=${reviewId} — ${findings.split('\n').length} finding(s)`
        : `plan-review: review=${reviewId} — clean (no findings)`,
    );
    return { status: 'complete', findings };
  }

  /** Stamp a review row terminal: findings + completed_at + status (+ a failure reason). */
  private async stamp(
    row: PlanReviewEntity,
    status: 'complete' | 'failed',
    findings: string,
    error: string | null,
  ): Promise<void> {
    await this.reviews.update(
      { id: row.id },
      { status, findings, error, completed_at: new Date() },
    );
  }

  /** Load one review row (for delivery). */
  async load(reviewId: string): Promise<PlanReviewEntity | null> {
    return this.reviews.findOne({ where: { id: reviewId } });
  }

  /**
   * The `finalize_plan` gate: is a Codex review round for this thread still IN FLIGHT (`running`)?
   * `submit_plan` flips the thread to `plan_review` and kicks the Codex turn in the background, so the
   * thread status alone never proves the review actually finished — the brain could (and did) post the
   * approval card while Codex was still reviewing. Returns the in-flight round (for the refusal message)
   * or null when no round is running, i.e. the latest review has completed (its findings are delivered, or
   * are being delivered in this very turn) and the brain is free to finalize.
   */
  async runningReview(threadId: string): Promise<{ round: number } | null> {
    const row = await this.reviews.findOne({
      where: { job_id: threadId, status: 'running' },
      order: { round: 'DESC' },
    });
    if (!row) return null;
    // Orphan backstop: a row stuck `running` past the watchdog ceiling can only be a crash orphan — the
    // host died before the in-process timeout could stamp it `failed` (the timer died with the process).
    // Don't let it wedge the operator gate forever; treat it as non-blocking. Boot reconciliation will
    // still re-run/redeliver it, and the live path's watchdog stamps in-process hangs `failed` well
    // before this. Mirrors the service rule: a review outage must NEVER permanently block the build.
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (ageMs > this.timeoutMs) {
      this.logger.warn(
        `plan-review: thread=${threadId} round ${row.round} stuck 'running' for ${Math.round(
          ageMs / 60_000,
        )}m — treating as orphaned (not blocking finalize)`,
      );
      return null;
    }
    return { round: row.round };
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
export function renderFindingsDelivery(
  findings: string,
  round: number,
  capReached: boolean,
  status: 'complete' | 'failed' = 'complete',
  error?: string | null,
): string {
  const header = `🔍 **Codex plan review** (round ${round})`;
  // A FAILED review (engine error) is NOT a clean pass — never report it as "the plan looks solid".
  // Surface the actual reason so the operator + Atlas see WHAT happened, not a silent "no findings".
  // (`findings` is also empty on failure, so this must be checked BEFORE the empty-findings branch.)
  if (status === 'failed') {
    const reason = error?.trim() ? `\n\n> ${error.trim()}` : '';
    return (
      `⚠️ ${header} could NOT run — the review errored before completing, so the plan was NOT validated.${reason}\n\n` +
      'Atlas: this is an infrastructure failure, not a clean pass. Either call `submit_plan` to retry the ' +
      'review, or call `finalize_plan` to send the plan to the operator as-is — but if you finalize, tell ' +
      'them plainly that the Codex review did not run (and why).'
    );
  }
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

/**
 * Reduce a raw engine/Codex error to one concise, human-readable line for the failure surface. Engine
 * errors often embed a JSON body like `{"...","message":"<human readable>"}` (e.g. a 4xx from the model
 * API) — pull that out; otherwise take the first line. Capped so it stays a one-liner in the UI.
 */
export function summarizeEngineError(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).trim();
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/);
  const msg = (m ? m[1] : raw.split('\n')[0]).trim() || 'unknown engine error';
  return msg.length > 300 ? `${msg.slice(0, 297)}…` : msg;
}
