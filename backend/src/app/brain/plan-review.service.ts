import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type ObjectLiteral, Repository } from 'typeorm';
import { ENGINE_RUNNER, type EngineRunnerPort } from '@shared/engine';
import type { EngineAuth, EngineHomeKey } from '@shared/engine';
import { JobLifecycleService } from '../driver/job-lifecycle.service';
import { LeaderElectionService } from '../cluster';
import { CredentialResolver } from '../onboarding';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity, ThreadGroupEntity, ThreadEntity } from '../persistence/entities';
import {
  TurnHarnessFactory,
  laneFor,
  BLOCK_SINK,
  type BlockSink,
} from '../surface';
import {
  Agent,
  renderAgentPrompt,
  renderPlanForReview,
  renderReReview,
  type PlanReviewInput,
} from '../prompt-kit';
import { ConventionProfileResolver } from '../conventions';
import { threadKindSpec } from '../thread-kind/registry';
import {
  type ReviewFinding,
  parsePlanFindings,
  serializeFindings,
  deserializeFindings,
} from './plan-review-findings';

export type { PlanReviewInput } from '../prompt-kit/messages/plan-review';

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
 * The retired `codex_reviews` row folds into the job's single `plan_review` THREAD (d7) — the slim
 * durability + gate spine:
 * - the Codex session id lives on `thread.session_id` (persisted eagerly on the session event) so a
 *   re-dispatched `review_plan` (after a host restart mid-review) RESUMES the Codex thread, not a fresh one.
 * - `thread.config.specHash` ties a terminal review to the exact spec version it read, so `propose_plan`'s
 *   mandatory-run gate accepts it only for the plan version being proposed.
 * - `thread.config.status = 'running'` with no live brain turn is the WORK-OWED signal the backstop re-drives.
 * `resumeCount`/`findings`/`error` ride the same `config`. {@link PlanReviewRow} is the flat read-model the
 * service returns, rebuilt from the thread row (the old `CodexReviewEntity` shape callers still consume).
 */

// Re-exported so existing callers (agent-session-manager.service.ts, specs) keep importing them from
// here — the severity-tagged parser itself is pure (no NestJS/TypeORM) and lives in `plan-review-findings`
// so `plan-review.eval.ts` can import it without dragging the eval CLI through the entity barrel.
export {
  type ReviewFinding,
  parsePlanFindings,
  serializeFindings,
  deserializeFindings,
};

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

type PlanReviewStatus = 'running' | 'complete' | 'failed';

/**
 * The plan-review state folded onto the `plan_review` thread's `config` jsonb (retired `codex_reviews`
 * columns, d7): `specHash`/`resumeCount`/`findings`/`status`/`error`. The Codex session id itself lives on
 * `thread.session_id`, not here. Findings are stored decoded (parsed `ReviewFinding[]`).
 */
export interface PlanReviewConfig {
  specHash: string | null;
  resumeCount: number;
  findings: ReviewFinding[];
  status: PlanReviewStatus;
  error: string | null;
}

/**
 * The flat read-model the service exposes for one job's plan review — rebuilt from the `plan_review` thread
 * row + its {@link PlanReviewConfig}. Mirrors the retired `CodexReviewEntity` field names the callers still
 * read (`codex_session_id`, `spec_hash`, `resume_count`, serialized `findings`), so the propose_plan gate +
 * work-owed backstop are unchanged; only the storage moved onto the thread.
 */
export interface PlanReviewRow {
  /** The `plan_review` thread id. */
  id: string;
  job_id: string;
  org_id: string;
  /** The Codex session id (= `thread.session_id`) — the resume handle. */
  codex_session_id: string | null;
  spec_hash: string | null;
  status: PlanReviewStatus;
  /** Findings SERIALIZED for `deserializeFindings` compatibility (the callers rehydrate it). */
  findings: string | null;
  error: string | null;
  resume_count: number;
  created_at: Date;
  updated_at: Date;
}

/** Parse a `plan_review` thread's `config` jsonb into the typed {@link PlanReviewConfig}, tolerating the
 *  migration backfill shape (`codexStatus`, findings stored as the serialized string) as well as forward
 *  writes (`status`, findings as `ReviewFinding[]`). */
/** Thread groups/threads are gap-numbered (10, 20, 30…) so a re-plan can splice without renumbering. */
const ORDINAL_GAP = 10;

/** Rebuild the flat {@link PlanReviewRow} read-model from a `plan_review` thread row + its `config`.
 *  `findings` is re-serialized so callers can `deserializeFindings` it (the retired column was a string). */
function toReviewRow(thread: ThreadEntity): PlanReviewRow {
  const config = readPlanReviewConfig(thread.config);
  return {
    id: thread.id,
    job_id: thread.job_id,
    org_id: thread.org_id,
    codex_session_id: thread.session_id,
    spec_hash: config.specHash,
    status: config.status,
    findings: serializeFindings(config.findings),
    error: config.error,
    resume_count: config.resumeCount,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
  };
}

function readPlanReviewConfig(raw: unknown): PlanReviewConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const rawStatus = c['status'] ?? c['codexStatus'];
  const status: PlanReviewStatus =
    rawStatus === 'complete' || rawStatus === 'failed' ? rawStatus : 'running';
  const findings = Array.isArray(c['findings'])
    ? (c['findings'] as ReviewFinding[])
    : typeof c['findings'] === 'string'
      ? deserializeFindings(c['findings'])
      : [];
  return {
    specHash: typeof c['specHash'] === 'string' ? c['specHash'] : null,
    resumeCount: typeof c['resumeCount'] === 'number' ? c['resumeCount'] : 0,
    findings,
    status,
    error: typeof c['error'] === 'string' ? c['error'] : null,
  };
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
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(ThreadGroupEntity, DB_CONNECTION)
    private readonly threadGroups: Repository<ThreadGroupEntity>,
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
      const error =
        'Could not attach a sandbox to run the review (no container for this job).';
      row = await this.persistRow(row, input, null, 'failed', [], error);
      return { status: 'failed', findings: [], specHash: null, error };
    }
    const sandbox = ensured.sandbox;
    const specHash = await this.hashSpecs(input.jobId, input.orgId);
    const isResume = Boolean(row?.codex_session_id);

    // Find-or-create the job's `plan_review` thread group + thread and flip its config to `running`. The thread IS
    // the authoritative work-owed/recovery source now (retired `codex_reviews`); the driver never executes
    // it (render-only role). Idempotent — a resume/re-review reuses the same thread.
    row = await this.persistRow(row, input, specHash, 'running', null, null);
    // The plan_review thread's own row id — the anchor every message from this review round is stamped
    // onto. Captured as a non-null const so the `attempt` closure below can reference it without renarrowing.
    const reviewThreadId = row.id;

    // STABLE per JOB (not per review): the Codex SDK stores its transcript under CODEX_HOME keyed by this
    // sandboxKey, so resuming a prior session only finds it when every review of a job shares ONE home.
    const sandboxKey: EngineHomeKey = {
      orgId: input.orgId,
      repoId: sandbox.repoId,
      jobId: input.jobId,
      type: 'plan-review',
    };
    const auth: EngineAuth | undefined = await this.creds.engineAuth(
      input.orgId,
      'codex',
    );
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
        ? await this.conventions
            .resolveForRepo(input.orgId, job.repo_id)
            .catch(() => null)
        : null;
    // The reviewer's reasoning effort — sourced from the `codex_review` kind spec so it lives in one place
    // (and the composer footer's pre-turn default matches what the turn actually runs at).
    const reviewEffort = threadKindSpec('codex_review').reasoningEffort;

    const attempt = async (
      resumeSessionId: string | undefined,
    ): Promise<
      | { ok: true; output: string; findings: ReviewFinding[] }
      | { ok: false; error: string; timedOut: boolean }
    > => {
      const harness = this.turnHarness.create({
        jobId: input.jobId,
        orgId: input.orgId,
        threadId: reviewThreadId,
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
            liveRoute: {
              channel,
              jobId: input.jobId,
              lane: codexReviewLane(input.jobId),
            },
            onEvent: (e) => {
              if (e.kind === 'session' && e.sessionId) {
                // The Codex session id folds onto the plan_review thread's own `session_id` (retired
                // `codex_reviews.codex_session_id`) — the resume handle a re-dispatched review reads back.
                void this.threads
                  .update({ id: row!.id }, { session_id: e.sessionId })
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
        row = await this.persistRow(
          row,
          input,
          specHash,
          'complete',
          findings,
          null,
        );
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
      .appendBlockOnce(
        input.jobId,
        `codex:${input.jobId}:${row.resume_count}`,
        {
          kind: 'agent_prompt',
          threadId: reviewThreadId,
          text: task,
          meta: {
            codexReviewId: input.jobId,
            agentPrompt: true,
            reviewRound: row.resume_count,
          },
        },
      )
      .catch((err) =>
        this.logger.warn(
          `plan-review: emitPrompt failed for job=${input.jobId}: ${err}`,
        ),
      );

    let res = await attempt(priorSessionId);
    // RESUME-FAILURE FALLBACK: a stale/unresumable session degrades to a fresh review instead of failing.
    if (
      !res.ok &&
      priorSessionId &&
      !res.timedOut &&
      !this.election.isDraining()
    ) {
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
   * Returns the job's plan-review row when it is TERMINAL (`complete` OR `failed` — a review that ran, even
   * if it errored, satisfies the gate so an infra outage can never permanently block approval) AND its
   * `spec_hash` matches the CURRENT specs. Null when no terminal review exists or the specs changed since
   * (→ Atlas must run `review_plan` again). Advisory: findings on the row never affect this gate.
   */
  async reviewForCurrentSpecs(
    jobId: string,
    orgId: string,
  ): Promise<{ row: PlanReviewRow; specHash: string | null } | null> {
    const row = await this.loadRow(jobId);
    if (!row || (row.status !== 'complete' && row.status !== 'failed'))
      return null;
    const currentHash = await this.hashSpecs(jobId, orgId);
    if (row.spec_hash === currentHash) return { row, specHash: currentHash };
    // CEILING ESCAPE VALVE: below the ceiling a hash mismatch correctly forces a re-review (Atlas edited
    // the specs after the last review). But once the re-review ceiling is exhausted, `review()`
    // short-circuits and can NEVER re-run — so a later spec edit (even a cosmetic file renumber) would
    // freeze the mismatch forever and deadlock propose_plan with no self-serve escape. A review
    // demonstrably RAN (>= ceiling genuine rounds) and findings are advisory anyway, so accept the
    // terminal review for the current specs instead of blocking approval indefinitely.
    if (row.resume_count >= this.ceiling) return { row, specHash: currentHash };
    return null;
  }

  /** The single plan-review row for a job (latest thread if a race ever created more than one), rebuilt
   *  from the `codex_review` thread + its `config`. Null when the job has no codex_review thread yet. */
  async loadRow(jobId: string): Promise<PlanReviewRow | null> {
    const thread = await this.threads.findOne({
      where: { job_id: jobId, role: 'codex_review' },
      order: { created_at: 'DESC' },
    });
    return thread ? toReviewRow(thread) : null;
  }

  /**
   * The WORK-OWED backstop worklist: `codex_review` threads whose `config.status` is still `running` (a
   * `review_plan` was dispatched but neither completed nor consumed). A running row whose job has no live
   * brain turn is the interrupted-`review_plan` fingerprint the backstop re-drives (it survives the Redis
   * stream cleanup that wipes tool-bridge recovery on the alive-grace/watchdog path).
   */
  async findRunningReviews(): Promise<PlanReviewRow[]> {
    const rows = await this.threads
      .createQueryBuilder('t')
      .where("t.role = 'codex_review'")
      .andWhere("t.config ->> 'status' = 'running'")
      .getMany();
    return rows.map(toReviewRow);
  }

  /**
   * Find-or-create the job's `codex_review`-role thread INSIDE its existing `planning` thread group (d10:
   * planning + plan-review collapsed into one thread group) — returns the thread id. Never creates a new
   * thread group: the planning thread group always exists once the job is bootstrapped
   * (`job-bootstrap.service.ts`'s `ensurePlanningThreadGroup`), so its absence here is a bug elsewhere, not
   * something to paper over. Ordered `ordinal: 'DESC'` to land on the CURRENT planning group, mirroring
   * `job-bootstrap.service.ts`'s `planningThreadId()` (a heavy amend can append a later planning group). The
   * new thread is a top-level (parent null) row whose ordinal is job-GLOBAL-unique (past the highest existing
   * top-level ordinal), to satisfy the job-wide UNIQUE(job_id, parent_thread_id, ordinal). Idempotent: a
   * resume/re-review reuses the same thread. The driver never executes the row (render-only role).
   */
  private async ensureCodexReviewThread(
    jobId: string,
    orgId: string,
  ): Promise<string> {
    const threadGroup = await this.threadGroups.findOne({
      where: { job_id: jobId, kind: 'planning' },
      order: { ordinal: 'DESC' },
    });
    if (!threadGroup) {
      throw new Error(
        `plan-review: job ${jobId} has no planning thread group to anchor its codex_review thread`,
      );
    }
    const existingThread = await this.threads.findOne({
      where: { thread_group_id: threadGroup.id, role: 'codex_review' },
    });
    if (existingThread) return existingThread.id;
    const threadOrdinal =
      (await this.maxOrdinal(
        this.threads,
        jobId,
        't.parent_thread_id IS NULL',
      )) + ORDINAL_GAP;
    const thread = await this.threads.save(
      this.threads.create({
        thread_group_id: threadGroup.id,
        job_id: jobId,
        org_id: orgId,
        role: 'codex_review',
        parent_thread_id: null,
        ordinal: threadOrdinal,
        brief: 'Plan review',
        type: 'general',
        status: 'idle',
        config: {},
      }),
    );
    return thread.id;
  }

  /**
   * Upsert the job's plan-review state onto its `codex_review` thread's `config` (find-or-creating the
   * thread inside the job's existing planning thread group), fold the Codex session onto `thread.session_id`
   * (done by the caller's session event), and return the flat {@link PlanReviewRow}. A transition to
   * `running` refreshes the spec hash + clears stale findings; `resumeCount` is the plan-version/round
   * number, bumped ONLY when the specs actually changed (a genuine re-review). A same-spec_hash re-drive is
   * a RECOVERY of the same round — keep the count stable so the prompt idempotency key
   * (`codex:<jobId>:<round>`) still dedups and a flaky recovery can't burn the re-review ceiling.
   */
  private async persistRow(
    existing: PlanReviewRow | null,
    input: PlanReviewInput,
    specHash: string | null,
    status: PlanReviewStatus,
    findings: ReviewFinding[] | null,
    error: string | null,
  ): Promise<PlanReviewRow> {
    const threadId =
      existing?.id ??
      (await this.ensureCodexReviewThread(input.jobId, input.orgId));
    const thread = await this.threads.findOneOrFail({
      where: { id: threadId },
    });
    const prev = readPlanReviewConfig(thread.config);

    let next: PlanReviewConfig;
    if (status === 'running') {
      const sameVersion = prev.specHash != null && prev.specHash === specHash;
      next = {
        specHash,
        resumeCount: existing
          ? sameVersion
            ? prev.resumeCount
            : prev.resumeCount + 1
          : 0,
        findings: [],
        status,
        error,
      };
    } else {
      next = {
        specHash: specHash !== null ? specHash : prev.specHash,
        resumeCount: prev.resumeCount,
        findings: findings ?? prev.findings,
        status,
        error,
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TypeORM's QueryDeepPartialEntity
    // over an index-signature jsonb column (`config: Record<string, unknown>`) does not accept a plain
    // object even when it structurally matches; the raw-SQL `.set({ config: () => ... })` escape (used
    // elsewhere in driver-store.service.ts) is overkill for a simple merge-and-write.
    await this.threads.update({ id: threadId }, {
      config: { ...(thread.config ?? {}), ...next },
    } as any);
    return toReviewRow(
      await this.threads.findOneOrFail({ where: { id: threadId } }),
    );
  }

  /** The highest `ordinal` among a job's rows in `repo` (0 when none). `extraWhere` (aliased `t`) narrows
   *  the pool — e.g. only top-level threads, which share the job-wide unique ordinal index. */
  private async maxOrdinal<T extends ObjectLiteral>(
    repo: Repository<T>,
    jobId: string,
    extraWhere?: string,
  ): Promise<number> {
    const qb = repo
      .createQueryBuilder('t')
      .select('MAX(t.ordinal)', 'max')
      .where('t.job_id = :jobId', { jobId });
    if (extraWhere) qb.andWhere(extraWhere);
    const row = await qb.getRawOne<{ max: number | null }>();
    return row?.max ?? 0;
  }

  /**
   * Content hash of the job's authored `/context/specs/` (host-readable durable mount, keyed by jobId) —
   * the plan version a review graded. Stable across restarts; null when the specs dir is unreadable/empty.
   */
  private async hashSpecs(
    jobId: string,
    orgId: string,
  ): Promise<string | null> {
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
