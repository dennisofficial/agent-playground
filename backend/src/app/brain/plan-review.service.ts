import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { ENGINE_RUNNER, type EngineRunnerPort } from '../engine';
import type { EngineAuth } from '../engine';
import type { Decision } from '../domain';
import type { PlannedStep } from '../driver/render-plan';
import { JobLifecycleService } from '../driver/job-lifecycle.service';
import { LeaderElectionService } from '../cluster';
import { CredentialResolver } from '../onboarding';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity, MessageEntity, PlanReviewEntity } from '../persistence/entities';
import { TurnHarnessFactory, laneFor } from '../surface';
import { Agent, renderAgentPrompt } from '../prompt-kit';

/** The transcript lane a job's Codex review dialogue streams on (peeled out of Main by the web).
 *  Thin re-export of the THREAD_REGISTRY — byte-identical string. */
export function codexReviewLane(jobId: string): string {
  return laneFor('codex-review', jobId);
}

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
  jobId: string;
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
  /** The high-level thread briefs (titles) from the plan. */
  threadTitles: string[];
  /**
   * The steps Atlas authored under each thread, aligned by thread index (`stepsByThread[i]` = steps for
   * `threadTitles[i]`). Present on the full-plan path so the reviewer grades the EXECUTION detail, not
   * just titles. Absent on step-less paths (the reviewer then sees titles only).
   */
  stepsByThread?: PlannedStep[][];
};

/** Outcome of `start`: a fresh review round, or the round cap was hit (no review run). */
export type PlanReviewStart =
  | { reviewId: string; round: number }
  | { capped: true; round: number };

/** Render the structured review task: the operator's INTENT first, then the authored plan to grade. */
function renderPlanForReview(input: PlanReviewStartInput): string {
  const decisions = input.decisions.length
    ? input.decisions
        .map((d: Decision) => `  [${d.decisionClass}] ${d.title}: ${d.ruling}`)
        .join('\n')
    : '  (none)';

  const threads = input.threadTitles.length
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
      ? 'THREADS (each with its execute-ready steps — the build runs these directly):'
      : 'THREADS (high-level briefs):',
    threads,
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
 * Render the task for a `respond_to_review` REPLY turn — the input for a RESUMED Codex thread (so the
 * `<role>`/`<what_to_hunt>`/`<output_contract>` from round 1 are already in history; only the reply is
 * sent). Frames Atlas's rebuttal adversarially: Codex re-reads the live specs (evidence — not Atlas's
 * prose about what changed), then concedes or HOLDS FIRM per prior finding, re-emitting anything that
 * still stands via the same `FINDING:`/`NO_FINDINGS` contract the delivery path already parses.
 */
function renderReplyForReview(rebuttal: string): string {
  return [
    '<author_response>',
    'The plan author ("Atlas") is responding to your PRIOR findings on this same plan — this is a',
    'continuation of your review, and you remember what you flagged. Before judging, RE-READ the current',
    '`/context/specs/` (the plan may have been revised since) and the referenced code; do NOT rely on the',
    "author's description of what changed. For EACH prior finding decide: genuinely RESOLVED, or does it",
    'STILL STAND? Concede only when actually fixed — otherwise HOLD FIRM and say why in one line. The',
    'author is a motivated party (they want approval); weigh the argument on its merits, not its confidence.',
    '',
    "AUTHOR'S RESPONSE:",
    rebuttal.trim() || '(no message provided)',
    '</author_response>',
    '',
    'Now output per your <output_contract>: a `FINDING:` line for every issue that STILL STANDS (restate it',
    'concisely) or is newly revealed by the revision, or EXACTLY `NO_FINDINGS` if everything is resolved and',
    'the plan achieves the intent.',
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
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(MessageEntity, DB_CONNECTION)
    private readonly messages: Repository<MessageEntity>,
    // The shared transcript spine: the review turn streams its full reasoning + tool reads onto the job's
    // `codex-review:<jobId>` lane (durable + live SSE), so the operator can open the whole exchange.
    private readonly turnHarness: TurnHarnessFactory,
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
      where: { job_id: input.jobId },
    });
    const round = prior + 1;
    if (round > this.maxRounds) {
      this.logger.log(
        `plan-review: thread=${input.jobId} hit round cap (${this.maxRounds}) — not reviewing`,
      );
      return { capped: true, round: prior };
    }
    const prompt = renderPlanForReview(input);
    const row = await this.reviews.save(
      this.reviews.create({
        job_id: input.jobId,
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
    // Atlas's side of the dialogue: a request bubble opens the round on the review lane.
    await this.appendReviewInput(
      input.jobId,
      round === 1
        ? '🔍 Requested a Codex review of this plan.'
        : '🔁 Requested a re-review of the revised plan.',
    );
    this.logger.log(
      `plan-review: opened round ${round} (review=${row.id}) for thread=${input.jobId}`,
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

    // STABLE per JOB (not per review round): the Codex SDK stores its session transcript under the
    // CODEX_HOME keyed by this sandboxKey, so resuming a prior round's session (see priorSessionId) only
    // finds it when every round of a job shares ONE home. A per-reviewId key gave each round a fresh home,
    // so `resumeThread` hit a missing transcript and Codex Exec exited 1. Mirrors the brain's per-job key.
    const sandboxKey = `plan-review-${row.org_id}-${row.job_id}`;
    // Per-org Codex subscription secret (deployed); undefined locally → the in-container engine falls back
    // to CODEX_OAUTH_TOKEN. With neither set the turn throws and is caught below as "failed / no findings".
    const auth: EngineAuth | undefined = await this.creds.engineAuth(
      row.org_id,
      'codex',
    );

    this.logger.log(
      `plan-review: running Codex review turn for review=${reviewId} thread=${row.job_id}`,
    );

    // Resume ONE Codex conversation per job: the latest round/reply that captured a session id. Round 1
    // (none yet) starts a fresh thread; every later round + `respond_to_review` reply resumes it, so Codex
    // keeps its memory of prior findings and grades whether the revision/pushback actually resolved them.
    const priorSessionId = await this.latestSessionId(row.job_id);

    // Stream the full review turn (reasoning + tool reads/commands + findings) onto the job's review lane —
    // durable transcript + live SSE, reusing the shared spine every engine turn rides. `channel` MUST be
    // the repo id: the web SSE endpoint fans by `channel === repoId`.
    const job = await this.jobs.findOne({
      where: { id: row.job_id },
      select: { id: true, repo_id: true },
    });
    const channel = job?.repo_id ?? row.job_id;
    // ONE Codex review turn wrapped in its OWN harness (durable + live SSE) + watchdog. `resumeSessionId`
    // is the prior session to continue, or undefined for a fresh thread. Returns the reviewer output, or a
    // failure descriptor (distinguishing a watchdog TIMEOUT from an ordinary error) — never throws, so the
    // caller can decide whether to retry.
    const attempt = async (
      resumeSessionId: string | undefined,
    ): Promise<
      | { ok: true; output: string }
      | { ok: false; error: string; timedOut: boolean }
    > => {
      const harness = this.turnHarness.create({
        jobId: row.job_id,
        channel,
        lane: codexReviewLane(row.job_id),
        metaTag: { codexReviewId: row.job_id, reviewRound: row.round },
      });
      // Watchdog: bound the turn so a HUNG engine can never leave the row stuck `running` forever (which
      // would wedge the `finalize_plan` gate). The runner honors `signal`, so abort propagates; the
      // `Promise.race` lets the attempt return even if a runner ignored the signal.
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
      try {
        const result = await Promise.race([
          this.engine.run({
            engine: 'codex',
            task: row.prompt,
            cwd: sandbox.worktreePath,
            systemPrompt: renderAgentPrompt(Agent.META_PLAN_REVIEW),
            sandboxKey,
            mode: 'review',
            // Review hard — pin max reasoning (subscription accounts accept this knob; verified by spike).
            modelReasoningEffort: 'xhigh',
            signal: ac.signal,
            // Resume the same Codex thread when we have one (undefined → fresh thread).
            ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
            // Rich stream so the review lane captures Codex's reasoning + tool_use/tool_result (file reads,
            // commands), not just prose. Capture the session id the moment it's known (crash-safe) so the
            // next round can resume even if this turn later times out.
            richStream: true,
            onEvent: (e) => {
              if (e.kind === 'session' && e.sessionId) {
                void this.reviews
                  .update({ id: reviewId }, { codex_session_id: e.sessionId })
                  .catch(() => undefined);
              }
              harness.onEvent(e);
            },
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
        await harness.finish(
          result.result,
          result.usage ? { usage: result.usage } : undefined,
        );
        return { ok: true, output: result.result };
      } catch (err) {
        // Persist whatever streamed before the error/timeout + close the live lane (idempotent vs finish).
        await harness.abort().catch(() => undefined);
        return { ok: false, error: summarizeEngineError(err), timedOut };
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    let res = await attempt(priorSessionId);
    // RESUME-FAILURE FALLBACK: if we tried to CONTINUE a prior session and it failed (not a watchdog
    // timeout, not a shutdown drain), the session may be unresumable — a stale id, or the container was
    // reaped between rounds so the in-container CODEX_HOME (which holds the session transcript) is gone.
    // Retry ONCE with a FRESH thread so a resume glitch degrades to a fresh review instead of hard-failing
    // every re-review for the job. A fresh first attempt (no priorSessionId) never retries.
    if (!res.ok && priorSessionId && !res.timedOut && !this.election.isDraining()) {
      this.logger.warn(
        `plan-review: review=${reviewId} resume failed (${res.error}) — retrying with a fresh Codex thread`,
      );
      res = await attempt(undefined);
    }

    if (!res.ok) {
      if (!res.timedOut && this.election.isDraining()) {
        // PROCESS SHUTDOWN (not a local timeout, not a real failure): the drain cut off the review turn.
        // Leave the row 'running' so the boot reconcile (status:'running') re-runs it; stamping 'failed'
        // would strand it. Timeout aborts fire while still leader/follower, so they fall through to 'failed'.
        this.logger.warn(
          `plan-review: review=${reviewId} left 'running' — aborted by shutdown drain; boot reconcile will re-run`,
        );
        return { status: 'failed', findings: '', error: res.error };
      }
      this.logger.warn(
        `plan-review: Codex turn ${res.timedOut ? 'timed out' : 'failed'} for review=${reviewId} — recording failed: ${res.error}`,
      );
      await this.stamp(row, 'failed', '', res.error);
      return { status: 'failed', findings: '', error: res.error };
    }

    const findings = parsePlanFindings(res.output);
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
  async runningReview(jobId: string): Promise<{ round: number } | null> {
    const row = await this.reviews.findOne({
      where: { job_id: jobId, status: 'running' },
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
        `plan-review: thread=${jobId} round ${row.round} stuck 'running' for ${Math.round(
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

  /** The latest review round on a job (any status) — for the `respond_to_review` gate. */
  async latestReview(jobId: string): Promise<PlanReviewEntity | null> {
    return this.reviews.findOne({
      where: { job_id: jobId },
      order: { round: 'DESC' },
    });
  }

  /**
   * The Codex thread id to RESUME for this job — the latest round/reply that captured one. Undefined until
   * round 1 emits its session event (→ a fresh thread is started).
   */
  private async latestSessionId(jobId: string): Promise<string | undefined> {
    const row = await this.reviews.findOne({
      where: { job_id: jobId, codex_session_id: Not(IsNull()) },
      order: { round: 'DESC' },
    });
    return row?.codex_session_id ?? undefined;
  }

  /**
   * Persist an INPUT message on the job's Codex review lane — ATLAS's side of the dialogue (the review
   * request, or a `respond_to_review` rebuttal). Authored `'user'` so it renders as the human/input bubble:
   * from Codex's point of view Atlas IS the user, mirroring the operator↔Atlas shape of the main
   * conversation. `meta.codexReviewId` peels it onto the review lane (hidden from Main). Best-effort.
   */
  private async appendReviewInput(jobId: string, text: string): Promise<void> {
    await this.messages
      .save(
        this.messages.create({
          job_id: jobId,
          author: 'user',
          author_id: 'atlas',
          author_bot_id: null,
          text,
          kind: 'chat',
          meta: { codexReviewId: jobId },
        }),
      )
      .catch((err) => this.logger.debug(`appendReviewInput failed: ${err}`));
  }

  /**
   * Open a REPLY round for `respond_to_review`: Atlas pushes back on the last round's findings WITHOUT
   * re-submitting a whole plan. Persists a `running` row carrying the reply prompt (the rebuttal); the
   * subsequent `runReview` RESUMES the job's Codex thread (see {@link latestSessionId}) so Codex adjudicates
   * with full memory of what it flagged. Bounded by the same round cap as `submit_plan` re-reviews.
   */
  async openReplyRound(input: {
    jobId: string;
    orgId: string;
    rebuttal: string;
  }): Promise<PlanReviewStart> {
    const prior = await this.reviews.count({
      where: { job_id: input.jobId },
    });
    const round = prior + 1;
    if (round > this.maxRounds) {
      return { capped: true, round: prior };
    }
    // Carry the last round's decision record for audit continuity (a reply grades the same plan state).
    const last = await this.reviews.findOne({
      where: { job_id: input.jobId },
      order: { round: 'DESC' },
    });
    const row = await this.reviews.save(
      this.reviews.create({
        job_id: input.jobId,
        org_id: input.orgId,
        decision_record_id: last?.decision_record_id ?? null,
        round,
        status: 'running',
        prompt: renderReplyForReview(input.rebuttal),
        findings: null,
        completed_at: null,
        delivered_at: null,
        codex_session_id: null,
      }),
    );
    // Atlas's rebuttal is its message TO Codex — render it as the input/human bubble on the review lane.
    await this.appendReviewInput(input.jobId, input.rebuttal.trim());
    this.logger.log(
      `plan-review: opened REPLY round ${round} (review=${row.id}) for thread=${input.jobId}`,
    );
    return { reviewId: row.id, round };
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
