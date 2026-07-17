import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { EngineAuth, EngineHomeKey } from '../../_shared/engine';
import { ENGINE_RUNNER, type EngineRunnerPort } from '../../_shared/engine';
import { Agent, renderAgentPrompt } from '../../_shared/prompt-kit/system';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ObjectLiteral, Repository } from 'typeorm';
import { LeaderElectionService } from '../cluster/leader-election.service';
import { ConventionProfileResolver } from '../conventions/convention-profile.resolver';
import { JobLifecycleService } from '../driver/job-lifecycle.service';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity, ThreadEntity, ThreadGroupEntity } from '../persistence/entities';
import {
  PlanReviewInput,
  renderPlanForReview,
  renderReReview,
} from '../prompt-kit/messages/plan-review';
import { laneFor } from '../surface/thread-registry';
import { BLOCK_SINK, type BlockSink, TurnHarnessFactory } from '../surface/turn-harness.service';
import { threadKindSpec } from '../thread-kind/registry';
import {
  deserializeFindings,
  parsePlanFindings,
  type ReviewFinding,
  serializeFindings,
} from './plan-review-findings';
export function codexReviewLane(jobId: string): string {
  return laneFor('codex-review', jobId);
}


export { deserializeFindings, parsePlanFindings, serializeFindings, type ReviewFinding };

export type ReviewOutcome = {
  status: 'complete' | 'failed';
  findings: ReviewFinding[];
  specHash: string | null;
  error?: string;
  ceilingHit?: boolean;
};

type PlanReviewStatus = 'running' | 'complete' | 'failed';

export interface PlanReviewConfig {
  specHash: string | null;
  resumeCount: number;
  findings: ReviewFinding[];
  status: PlanReviewStatus;
  error: string | null;
}

export interface PlanReviewRow {
  id: string;
  job_id: string;
  org_id: string;
  codex_session_id: string | null;
  spec_hash: string | null;
  status: PlanReviewStatus;
  findings: string | null;
  error: string | null;
  resume_count: number;
  created_at: Date;
  updated_at: Date;
}

const ORDINAL_GAP = 10;

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
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
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

  private readonly ceiling = Number(process.env['PLAN_REVIEW_CEILING']) || 8;

  private readonly timeoutMs = Number(process.env['PLAN_REVIEW_TIMEOUT_MS']) || 45 * 60_000;

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
    @Optional() private readonly conventions?: ConventionProfileResolver,
  ) {}

  get reviewCeiling(): number {
    return this.ceiling;
  }

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

    const ensured = await this.lifecycle.ensureContainer(input.jobId, input.orgId).catch((err) => {
      this.logger.warn(`plan-review: ensureContainer failed for job=${input.jobId}: ${err}`);
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
    const reviewThreadId = row.id;

    const sandboxKey: EngineHomeKey = {
      orgId: input.orgId,
      repoId: sandbox.repoId,
      jobId: input.jobId,
      type: 'plan-review',
    };
    const auth: EngineAuth | undefined = await this.creds.engineAuth(input.orgId, 'codex');
    const priorSessionId = row.codex_session_id ?? undefined;
    const task = isResume ? renderReReview(input, input.note) : renderPlanForReview(input);

    const job = await this.jobs.findOne({
      where: { id: input.jobId },
      select: { id: true, repo_id: true },
    });
    const channel = job?.repo_id ?? input.jobId;
    const repoConventions =
      job?.repo_id && this.conventions
        ? await this.conventions.resolveForRepo(input.orgId, job.repo_id).catch(() => null)
        : null;
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
            new Error(`Codex plan review timed out after ${Math.round(this.timeoutMs / 60_000)}m`),
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
        const findings = parsePlanFindings(result.result);
        row = await this.persistRow(row, input, specHash, 'complete', findings, null);
        await harness.finish(result.result, result.usage ? { usage: result.usage } : undefined);
        return { ok: true, output: result.result, findings };
      } catch (err) {
        await harness.abort().catch(() => undefined);
        return { ok: false, error: summarizeEngineError(err), timedOut };
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    await this.blockSink
      .appendBlockOnce(input.jobId, `codex:${input.jobId}:${row.resume_count}`, {
        kind: 'agent_prompt',
        threadId: reviewThreadId,
        text: task,
        meta: {
          codexReviewId: input.jobId,
          agentPrompt: true,
          reviewRound: row.resume_count,
        },
      })
      .catch((err) =>
        this.logger.warn(`plan-review: emitPrompt failed for job=${input.jobId}: ${err}`),
      );

    let res = await attempt(priorSessionId);
    if (!res.ok && priorSessionId && !res.timedOut && !this.election.isDraining()) {
      this.logger.warn(
        `plan-review: job=${input.jobId} resume failed (${res.error}) — retrying with a fresh Codex thread`,
      );
      res = await attempt(undefined);
    }

    if (!res.ok) {
      if (!res.timedOut && this.election.isDraining()) {
        this.logger.warn(
          `plan-review: job=${input.jobId} left 'running' — aborted by shutdown drain`,
        );
        return { status: 'failed', findings: [], specHash, error: res.error };
      }
      await this.persistRow(row, input, specHash, 'failed', [], res.error);
      return { status: 'failed', findings: [], specHash, error: res.error };
    }

    const findings = res.findings;
    const blocking = findings.filter((f) => f.severity === 'BLOCKING').length;
    this.logger.log(
      findings.length
        ? `plan-review: job=${input.jobId} — ${blocking} blocking, ${findings.length - blocking} advisory`
        : `plan-review: job=${input.jobId} — clean (no findings)`,
    );
    return { status: 'complete', findings, specHash };
  }

  async reviewForCurrentSpecs(
    jobId: string,
    orgId: string,
  ): Promise<{ row: PlanReviewRow; specHash: string | null } | null> {
    const row = await this.loadRow(jobId);
    if (!row || (row.status !== 'complete' && row.status !== 'failed')) return null;
    const currentHash = await this.hashSpecs(jobId, orgId);
    if (row.spec_hash === currentHash) return { row, specHash: currentHash };
    if (row.resume_count >= this.ceiling) return { row, specHash: currentHash };
    return null;
  }

  async loadRow(jobId: string): Promise<PlanReviewRow | null> {
    const thread = await this.threads.findOne({
      where: { job_id: jobId, role: 'plan_review' },
      order: { created_at: 'DESC' },
    });
    return thread ? toReviewRow(thread) : null;
  }

  async findRunningReviews(): Promise<PlanReviewRow[]> {
    const rows = await this.threads
      .createQueryBuilder('t')
      .where("t.role = 'plan_review'")
      .andWhere("t.config ->> 'status' = 'running'")
      .getMany();
    return rows.map(toReviewRow);
  }

  private async ensurePlanReviewThread(jobId: string, orgId: string): Promise<string> {
    let threadGroup = await this.threadGroups.findOne({
      where: { job_id: jobId, kind: 'plan_review' },
      order: { ordinal: 'ASC' },
    });
    if (!threadGroup) {
      const ordinal = (await this.maxOrdinal(this.threadGroups, jobId)) + ORDINAL_GAP;
      threadGroup = await this.threadGroups.save(
        this.threadGroups.create({
          job_id: jobId,
          org_id: orgId,
          ordinal,
          kind: 'plan_review',
          config: {},
        }),
      );
    }
    const existingThread = await this.threads.findOne({
      where: { thread_group_id: threadGroup.id, role: 'plan_review' },
    });
    if (existingThread) return existingThread.id;
    const threadOrdinal =
      (await this.maxOrdinal(this.threads, jobId, 't.parent_thread_id IS NULL')) + ORDINAL_GAP;
    const thread = await this.threads.save(
      this.threads.create({
        thread_group_id: threadGroup.id,
        job_id: jobId,
        org_id: orgId,
        role: 'plan_review',
        parent_thread_id: null,
        ordinal: threadOrdinal,
        brief: 'Plan review',
        type: 'general',
        status: 'reviewing',
        config: {},
      }),
    );
    return thread.id;
  }

  private async persistRow(
    existing: PlanReviewRow | null,
    input: PlanReviewInput,
    specHash: string | null,
    status: PlanReviewStatus,
    findings: ReviewFinding[] | null,
    error: string | null,
  ): Promise<PlanReviewRow> {
    const threadId = existing?.id ?? (await this.ensurePlanReviewThread(input.jobId, input.orgId));
    const thread = await this.threads.findOneOrFail({
      where: { id: threadId },
    });
    const prev = readPlanReviewConfig(thread.config);

    let next: PlanReviewConfig;
    if (status === 'running') {
      const sameVersion = prev.specHash != null && prev.specHash === specHash;
      next = {
        specHash,
        resumeCount: existing ? (sameVersion ? prev.resumeCount : prev.resumeCount + 1) : 0,
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
    await this.threads.update({ id: threadId }, {
      config: { ...(thread.config ?? {}), ...next },
    } as any);
    await this.syncReviewActivity(input.jobId, status);
    return toReviewRow(await this.threads.findOneOrFail({ where: { id: threadId } }));
  }

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

  private async syncReviewActivity(
    jobId: string,
    status: 'running' | 'complete' | 'failed',
  ): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      { activity: status === 'running' ? 'plan_review' : 'idle' },
    );
  }

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

export function summarizeEngineError(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).trim();
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/);
  const msg = (m ? m[1] : raw.split('\n')[0]).trim() || 'unknown engine error';
  return msg.length > 300 ? `${msg.slice(0, 297)}…` : msg;
}
