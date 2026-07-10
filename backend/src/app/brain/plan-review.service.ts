import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ENGINE_RUNNER, type EngineRunnerPort } from '../engine';
import type { EngineAuth, EngineHomeKey } from '../engine';
import type { Decision } from '../domain';
import type { PlannedStep } from '../driver/render-plan';
import { JobLifecycleService } from '../driver/job-lifecycle.service';
import { LeaderElectionService } from '../cluster';
import { CredentialResolver } from '../onboarding';
import { DB_CONNECTION } from '../persistence/database.module';
import { CodexReviewEntity, JobEntity, ThreadEntity } from '../persistence/entities';
import { TurnHarnessFactory, laneFor, BLOCK_SINK, type BlockSink } from '../surface';
import { Agent, renderAgentPrompt } from '../prompt-kit';
import { ConventionProfileResolver } from '../conventions';
import { threadKindSpec } from '../thread-kind/registry';
import {
  type ReviewFinding,
  parsePlanFindings,
  serializeFindings,
  deserializeFindings,
} from './plan-review-findings';

/** The transcript lane a job's Codex review streams on (rendered as an inline run card by the web).
 *  Thin re-export of the THREAD_REGISTRY — byte-identical string. */
export function codexReviewLane(jobId: string): string {
  return laneFor('codex-review', jobId);
}

/**
 * SYNCHRONOUS, ATLAS-DRIVEN CODEX PLAN REVIEW.
 *
 * Codex review is no longer an async gate. Atlas invokes `review_plan` (a host tool) which calls
 * {@link PlanReviewService.review} SYNCHRONOUSLY inside the brain turn: it (re-)attaches the job's sandbox,
 * runs a read-only Codex review of the authored `/context/specs/`, and returns severity-tagged findings
 * straight back into the same turn (like a subagent). Atlas re-opens the review (revise + re-review) as
 * often as it likes — each call RESUMES the stored Codex session so Codex keeps its memory of prior
 * findings (adjudication, not blind re-review). No round cap (only a high safety ceiling on `resume_count`).
 * Review is mandatory to RUN but ADVISORY to pass — findings never block; Atlas is the judge.
 *
 * The single {@link CodexReviewEntity} row per job is the slim durability + gate spine:
 * - `codex_session_id` (persisted eagerly on the session event) lets a re-dispatched `review_plan` (after a
 *   host restart mid-review) RESUME the Codex thread instead of starting fresh.
 * - `spec_hash` ties a terminal review to the exact spec version it read, so `propose_plan`'s mandatory-run
 *   gate accepts it only for the plan version being proposed.
 * - `status = 'running'` with no live brain turn is the WORK-OWED signal the backstop re-drives.
 */

// Re-exported so existing callers (agent-session-manager.service.ts, specs) keep importing them from
// here — the severity-tagged parser itself is pure (no NestJS/TypeORM) and lives in `plan-review-findings`
// so `plan-review.eval.ts` can import it without dragging the eval CLI through the entity barrel.
export { type ReviewFinding, parsePlanFindings, serializeFindings, deserializeFindings };

/** Outcome of one synchronous `review` call — fed straight into the brain turn as the tool result. */
export type ReviewOutcome = {
  status: 'complete' | 'failed';
  /** Parsed findings (empty when clean / on failure). */
  findings: ReviewFinding[];
  /** The `/context/specs/` content hash this review read (null if specs unreadable). */
  specHash: string | null;
  /** On a failed/timed-out review, a concise reason (surfaced, never a silent "no findings"). */
  error?: string;
  /** True when the safety ceiling was hit — Atlas should stop re-reviewing and finalize/revise. */
  ceilingHit?: boolean;
};

/** What `review` needs to render the review task (orientation; the specs on disk are authoritative). */
export type PlanReviewInput = {
  jobId: string;
  orgId: string;
  goal: string;
  ticket?: { number: number; title: string; body?: string } | null;
  overview: string;
  decisions: Decision[];
  threadTitles: string[];
  stepsByThread?: PlannedStep[][];
  /** On a RESUME (re-review): what Atlas changed / a point-by-point pushback. Ignored on the first run. */
  note?: string;
};

/** Render the structured review task: the operator's INTENT first, then the authored plan index to grade. */
function renderPlanForReview(input: PlanReviewInput): string {
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
  intent.push('', "OVERVIEW (Atlas's framing of the work):", input.overview, '</intent>');

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
    'Now judge per <what_to_judge> + <output_contract>. Read the specs and the referenced code first.',
  ].join('\n');
}

/**
 * Render the task for a RESUMED review (Atlas revised the specs and/or is pushing back). Codex remembers
 * its prior findings from the session history, so this just re-orients it to re-read the live specs and
 * adjudicate per the <output_contract>'s RE-REVIEW rule (concede what's fixed, hold firm on what stands,
 * don't manufacture ever-smaller findings).
 */
function renderReReview(input: PlanReviewInput, note?: string): string {
  return [
    '<re_review>',
    'You have reviewed this plan before (your prior findings are in this conversation). Atlas has revised the',
    'specs and/or is responding to your findings. RE-READ the current `/context/specs/` and the referenced',
    'code — do NOT rely on any description of what changed. For EACH prior finding decide: genuinely RESOLVED',
    '(concede it), or does it STILL STAND (hold firm, restate concisely). Only raise something NEW if it is as',
    'serious as a first-pass BLOCKING issue.',
    ...(note?.trim() ? ['', "ATLAS'S NOTE:", note.trim()] : []),
    '</re_review>',
    '',
    'Now output per your <output_contract>: a severity-tagged `FINDING [...]:` line for every issue that STILL',
    'STANDS or is newly revealed, or EXACTLY `NO_FINDINGS` if everything is resolved and the plan achieves the',
    'intent.',
  ].join('\n');
}

@Injectable()
export class PlanReviewService {
  private readonly logger = new Logger(PlanReviewService.name);

  /** Safety ceiling on re-reviews of one plan — NOT a product round cap (Atlas converges well before it);
   *  purely a backstop against a pathological re-review loop. Env-tunable. */
  private readonly ceiling = Number(process.env['PLAN_REVIEW_CEILING']) || 8;

  /** Wall-clock ceiling for ONE Codex review turn. A review that has not returned by this point is aborted
   *  and recorded failed (a timeout) — never a silent "no findings". Env-tunable. */
  private readonly timeoutMs =
    Number(process.env['PLAN_REVIEW_TIMEOUT_MS']) || 45 * 60_000;

  constructor(
    @Inject(ENGINE_RUNNER) private readonly engine: EngineRunnerPort,
    private readonly creds: CredentialResolver,
    private readonly lifecycle: JobLifecycleService,
    @InjectRepository(CodexReviewEntity, DB_CONNECTION)
    private readonly reviews: Repository<CodexReviewEntity>,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    private readonly turnHarness: TurnHarnessFactory,
    private readonly election: LeaderElectionService,
    @Inject(BLOCK_SINK) private readonly blockSink: BlockSink,
    // The repo's opt-in house-style profile — folded into the META_PLAN_REVIEW prompt so the reviewer judges
    // the plan against the same conventions the builders will follow. @Optional so unit tests construct the
    // service without it (undefined → no house style injected); DI (@Global) supplies it live.
    @Optional() private readonly conventions?: ConventionProfileResolver,
  ) {}

  get reviewCeiling(): number {
    return this.ceiling;
  }

  /**
   * Run (or RESUME) ONE synchronous Codex review for a job and return severity-tagged findings. Blocks
   * until the review turn is terminal. Reuses the job's single `codex_reviews` row (resume + bump
   * `resume_count`), stamps `spec_hash` (the reviewed plan version), and keeps the Codex session across
   * calls. Best-effort: an engine failure/timeout is recorded `failed` and returned as such (never masked
   * as clean) — Atlas may still proceed (advisory), noting the review did not run.
   */
  async review(input: PlanReviewInput): Promise<ReviewOutcome> {
    let row = await this.loadRow(input.jobId);

    if (row && row.resume_count >= this.ceiling) {
      this.logger.warn(
        `plan-review: job=${input.jobId} hit re-review ceiling (${this.ceiling}) — not re-reviewing`,
      );
      return {
        status: row.status === 'failed' ? 'failed' : 'complete',
        findings: deserializeFindings(row.findings),
        specHash: row.spec_hash,
        ...(row.error ? { error: row.error } : {}),
        ceilingHit: true,
      };
    }

    const ensured = await this.lifecycle
      .ensureContainer(input.jobId, input.orgId)
      .catch((err) => {
        this.logger.warn(
          `plan-review: ensureContainer failed for job=${input.jobId}: ${err}`,
        );
        return null;
      });
    if (!ensured) {
      const error = 'Could not attach a sandbox to run the review (no container for this job).';
      row = await this.persistRow(row, input, null, 'failed', [], error);
      return { status: 'failed', findings: [], specHash: null, error };
    }
    const sandbox = ensured.sandbox;
    const specHash = await this.hashSpecs(input.jobId, input.orgId);
    const isResume = Boolean(row?.codex_session_id);

    row = await this.persistRow(row, input, specHash, 'running', null, null);
    // Give the plan review a first-class, render/identity-only `plan_review` thread row so it has a place in
    // the thread tree. Its RUNTIME stays here (this synchronous `review_plan` turn + the `codex_reviews` row,
    // which remains the authoritative work-owed/recovery source) — the driver never executes the row.
    // Idempotent + best-effort (a persistPlan re-propose deletes it; the next review re-creates it).
    await this.ensurePlanReviewThread(input.jobId, input.orgId);

    // STABLE per JOB (not per review): the Codex SDK stores its transcript under CODEX_HOME keyed by this
    // sandboxKey, so resuming a prior session only finds it when every review of a job shares ONE home.
    const sandboxKey: EngineHomeKey = {
      orgId: input.orgId,
      repoId: sandbox.repoId,
      jobId: input.jobId,
      type: 'plan-review',
    };
    const auth: EngineAuth | undefined = await this.creds.engineAuth(input.orgId, 'codex');
    const priorSessionId = row.codex_session_id ?? undefined;
    const task = isResume
      ? renderReReview(input, input.note)
      : renderPlanForReview(input);

    const job = await this.jobs.findOne({
      where: { id: input.jobId },
      select: { id: true, repo_id: true },
    });
    const channel = job?.repo_id ?? input.jobId;
    // The repo's house-style (null when none attached) — folded into the reviewer's system prompt so it
    // grades the plan against the same conventions the builders get.
    const repoConventions =
      job?.repo_id && this.conventions
        ? await this.conventions.resolveForRepo(input.orgId, job.repo_id).catch(() => null)
        : null;
    // The reviewer's reasoning effort — sourced from the `plan_review` kind spec so it lives in one place
    // (and the composer footer's pre-turn default matches what the turn actually runs at).
    const reviewEffort = threadKindSpec('plan_review').reasoningEffort;

    const attempt = async (
      resumeSessionId: string | undefined,
    ): Promise<
      | { ok: true; output: string; findings: ReviewFinding[] }
      | { ok: false; error: string; timedOut: boolean }
    > => {
      const harness = this.turnHarness.create({
        jobId: input.jobId,
        orgId: input.orgId,
        channel,
        lane: codexReviewLane(input.jobId),
        metaTag: { codexReviewId: input.jobId },
      });
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
            task,
            cwd: sandbox.worktreePath,
            systemPrompt: renderAgentPrompt(Agent.META_PLAN_REVIEW, {
              settings: { repoConventions },
            }),
            sandboxKey,
            mode: 'review',
            ...(reviewEffort ? { modelReasoningEffort: reviewEffort } : {}),
            signal: ac.signal,
            ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
            richStream: true,
            onEvent: (e) => {
              if (e.kind === 'session' && e.sessionId) {
                void this.reviews
                  .update({ id: row!.id }, { codex_session_id: e.sessionId })
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
        // Flip the control row TERMINAL before persisting the reply transcript. A re-drive requires the
        // row to be `running`, so once it is `complete` the work-owed backstop can never re-run a review
        // whose reply is about to become durable — the invariant "reply durable ⟹ row terminal" that
        // stops the whole review turn (prompt + tools + reply + footer) from being re-persisted twice.
        const findings = parsePlanFindings(result.result);
        row = await this.persistRow(row, input, specHash, 'complete', findings, null);
        await harness.finish(
          result.result,
          result.usage ? { usage: result.usage } : undefined,
        );
        return { ok: true, output: result.result, findings };
      } catch (err) {
        await harness.abort().catch(() => undefined);
        return { ok: false, error: summarizeEngineError(err), timedOut };
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    // Surface THIS round's review task (the intent + authored-plan index Codex actually reads) on the
    // codex-review lane, so the operator can see what the reviewer was asked — not just its reply. Tagged
    // `codexReviewId` so the web routes it into the review sub-page; keyed per round so a resume-retry (two
    // `attempt()` calls) or a restart never duplicates it. Best-effort.
    await this.blockSink
      .appendBlockOnce(input.jobId, `codex:${input.jobId}:${row.resume_count}`, {
        kind: 'agent_prompt',
        text: task,
        meta: { codexReviewId: input.jobId, agentPrompt: true, reviewRound: row.resume_count },
      })
      .catch((err) =>
        this.logger.warn(`plan-review: emitPrompt failed for job=${input.jobId}: ${err}`),
      );

    let res = await attempt(priorSessionId);
    // RESUME-FAILURE FALLBACK: a stale/unresumable session degrades to a fresh review instead of failing.
    if (!res.ok && priorSessionId && !res.timedOut && !this.election.isDraining()) {
      this.logger.warn(
        `plan-review: job=${input.jobId} resume failed (${res.error}) — retrying with a fresh Codex thread`,
      );
      res = await attempt(undefined);
    }

    if (!res.ok) {
      if (!res.timedOut && this.election.isDraining()) {
        // Shutdown drain cut the review off — leave the row 'running' so the backstop/reattach re-runs it.
        this.logger.warn(
          `plan-review: job=${input.jobId} left 'running' — aborted by shutdown drain`,
        );
        return { status: 'failed', findings: [], specHash, error: res.error };
      }
      await this.persistRow(row, input, specHash, 'failed', [], res.error);
      return { status: 'failed', findings: [], specHash, error: res.error };
    }

    // The row was already flipped `complete` (with these findings) inside `attempt()`, before the reply
    // transcript was persisted — see the invariant note there.
    const findings = res.findings;
    const blocking = findings.filter((f) => f.severity === 'BLOCKING').length;
    this.logger.log(
      findings.length
        ? `plan-review: job=${input.jobId} — ${blocking} blocking, ${findings.length - blocking} advisory`
        : `plan-review: job=${input.jobId} — clean (no findings)`,
    );
    return { status: 'complete', findings, specHash };
  }

  /**
   * The `propose_plan` mandatory-run gate: has a review actually RUN for the plan version being proposed?
   * Returns the job's `codex_reviews` row when it is TERMINAL (`complete` OR `failed` — a review that ran,
   * even if it errored, satisfies the gate so an infra outage can never permanently block approval) AND its
   * `spec_hash` matches the CURRENT specs. Null when no terminal review exists or the specs changed since
   * (→ Atlas must run `review_plan` again). Advisory: findings on the row never affect this gate.
   */
  async reviewForCurrentSpecs(
    jobId: string,
    orgId: string,
  ): Promise<{ row: CodexReviewEntity; specHash: string | null } | null> {
    const row = await this.loadRow(jobId);
    if (!row || (row.status !== 'complete' && row.status !== 'failed')) return null;
    const currentHash = await this.hashSpecs(jobId, orgId);
    if (row.spec_hash !== currentHash) return null;
    return { row, specHash: currentHash };
  }

  /** The single review row for a job (latest if a race ever created more than one). */
  async loadRow(jobId: string): Promise<CodexReviewEntity | null> {
    return this.reviews.findOne({
      where: { job_id: jobId },
      order: { created_at: 'DESC' },
    });
  }

  /**
   * The WORK-OWED backstop worklist: `codex_reviews` rows still `running` (a `review_plan` was dispatched
   * but neither completed nor consumed). A running row whose job has no live brain turn is the interrupted-
   * `review_plan` fingerprint the backstop re-drives (it survives the Redis stream cleanup that wipes
   * tool-bridge recovery on the alive-grace/watchdog path).
   */
  async findRunningReviews(): Promise<CodexReviewEntity[]> {
    return this.reviews.find({ where: { status: 'running' } });
  }

  /** Ensure a render/identity-only `plan_review` thread row exists for the job (idempotent, best-effort).
   *  Root row (parent null), ordinal 5 — before the builders (10, 20, …) and after the `main` row (0). The
   *  driver never executes it (its kind is render-only); it just gives the plan review a node in the tree. */
  private async ensurePlanReviewThread(jobId: string, orgId: string): Promise<void> {
    try {
      const existing = await this.threads.findOne({
        where: { job_id: jobId, kind: 'plan_review' },
        select: { id: true },
      });
      if (existing) return;
      await this.threads.save(
        this.threads.create({
          job_id: jobId,
          org_id: orgId,
          kind: 'plan_review',
          parent_thread_id: null,
          ordinal: 5,
          brief: 'Plan review',
          type: 'general',
          status: 'reviewing',
        }),
      );
    } catch (err) {
      this.logger.warn(`could not ensure plan_review thread row for job=${jobId}: ${err}`);
    }
  }

  /** Upsert the job's single review row into a new state. Returns the persisted row. */
  private async persistRow(
    existing: CodexReviewEntity | null,
    input: PlanReviewInput,
    specHash: string | null,
    status: 'running' | 'complete' | 'failed',
    findings: ReviewFinding[] | null,
    error: string | null,
  ): Promise<CodexReviewEntity> {
    if (!existing) {
      const created = await this.reviews.save(
        this.reviews.create({
          job_id: input.jobId,
          org_id: input.orgId,
          codex_session_id: null,
          spec_hash: specHash,
          status,
          findings: findings ? serializeFindings(findings) : null,
          error,
          resume_count: 0,
        }),
      );
      await this.syncReviewActivity(input.jobId, status);
      return created;
    }
    // A transition to 'running' refreshes the spec hash + clears stale findings. `resume_count` is the
    // plan-version/round number: bump it ONLY when the specs actually changed (a genuine re-review after
    // Atlas revised the plan). A same-spec_hash re-drive is a RECOVERY of the same round — keep the count
    // stable so the prompt idempotency key (`codex:<jobId>:<round>`) still dedups and a flaky recovery
    // can't burn the re-review ceiling.
    const patch: Partial<CodexReviewEntity> = { status, error };
    if (status === 'running') {
      const sameVersion = existing.spec_hash != null && existing.spec_hash === specHash;
      patch.resume_count = sameVersion
        ? existing.resume_count
        : existing.resume_count + 1;
      patch.spec_hash = specHash;
      patch.findings = null;
    } else {
      if (findings) patch.findings = serializeFindings(findings);
      if (specHash !== null) patch.spec_hash = specHash;
    }
    await this.reviews.update({ id: existing.id }, patch);
    await this.syncReviewActivity(input.jobId, status);
    return (await this.reviews.findOneOrFail({ where: { id: existing.id } }));
  }

  /**
   * Reflect the review row's status onto the job's `activity` axis: `plan_review` while running, `idle`
   * when it finalizes (`complete`/`failed`). `persistRow` is the single choke point for every
   * `codex_reviews` status transition, so `activity` can never drift from the review. `deriveNeedsYou`
   * reads it to suppress the "needs you" dot while a review is in flight — critically, the live sidebar's
   * single-table WAL realtime mapper can only see the `jobs` row, so writing it here is what makes the live
   * dot correct. Setting `idle` on complete is SAFE: if the enclosing brain turn is still live it re-asserts
   * `turn` (see the `review_plan` handler); if the turn already ended, `idle` is correct. The shutdown-drain
   * abort path deliberately does NOT call `persistRow`, leaving the row `running` (and `activity`
   * untouched) so the backstop re-drives an interrupted review.
   */
  private async syncReviewActivity(
    jobId: string,
    status: 'running' | 'complete' | 'failed',
  ): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      { activity: status === 'running' ? 'plan_review' : 'idle' },
    );
  }

  /**
   * Content hash of the job's authored `/context/specs/` (host-readable durable mount, keyed by jobId) —
   * the plan version a review graded. Stable across restarts; null when the specs dir is unreadable/empty.
   */
  private async hashSpecs(jobId: string, orgId: string): Promise<string | null> {
    const specsDir = join(this.lifecycle.contextDirHost(jobId, orgId), 'specs');
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // missing dir → nothing to hash
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) files.push(full);
      }
    };
    await walk(specsDir);
    if (files.length === 0) return null;
    files.sort();
    const hash = createHash('sha256');
    for (const f of files) {
      hash.update(f.slice(specsDir.length)); // relative path (stable across hosts)
      hash.update('\0');
      hash.update(await readFile(f).catch(() => Buffer.alloc(0)));
      hash.update('\0');
    }
    return hash.digest('hex');
  }
}

/**
 * Reduce a raw engine/Codex error to one concise, human-readable line for the failure surface. Engine
 * errors often embed a JSON body like `{"...","message":"<human readable>"}` — pull that out; otherwise
 * take the first line. Capped so it stays a one-liner in the UI.
 */
export function summarizeEngineError(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).trim();
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/);
  const msg = (m ? m[1] : raw.split('\n')[0]).trim() || 'unknown engine error';
  return msg.length > 300 ? `${msg.slice(0, 297)}…` : msg;
}
