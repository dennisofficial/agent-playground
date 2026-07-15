import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { type EngineUsage, resolveContextLimit } from '../engine';
import { AppVersionService } from '../cluster/app-version.service';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  JobEntity,
  TurnModelUsageEntity,
  TurnStatsEntity,
} from '../persistence/entities';

/** Everything the projector needs to attribute a completed turn. `orgId` is optional — resolved from
 *  `jobId` when the caller (e.g. autofix) doesn't have it in scope. */
export interface TurnUsageIdentity {
  jobId: string;
  orgId?: string;
  /** 'main' | 'thread:<threadId>' | 'phase:<stepId>' | 'codex-review:<jobId>'. */
  lane: string;
  /** The turn's role / phase: 'brain' | 'step' | 'review' | 'gate' | 'autofix' | 'compaction'. */
  kind: string;
  /** 'claude' | 'codex'. */
  engine: string;
  /** The engine turn id when the caller has it; most completion sites don't (minted in the runner). */
  turnId?: string | null;
  /** The claude_credentials.id that authed this turn (Claude only); null/absent for Codex + non-agentic (d3). */
  credentialId?: string | null;
  /** Per-turn attribution tags (phaseId → step_id; the rest → `tags`): batchOrdinal/autofixId/lensId/… */
  metaTag?: Record<string, unknown> | null;
}

/**
 * Projects a completed turn's usage into the durable analytics tables (`turn_stats` +
 * per-model `turn_model_usage`). Called at each turn-completion site with the engine's `result.usage`.
 *
 * This exists because `EngineUsage.modelUsage` (the SDK's per-model breakdown, incl. writer subagents)
 * is otherwise only a transient `turn_meta` message and was historically collapsed to one model. Writes
 * are BEST-EFFORT: a failure here logs and returns — it must never fail a turn.
 */
@Injectable()
export class TurnUsageProjector {
  private readonly logger = new Logger(TurnUsageProjector.name);

  constructor(
    @InjectRepository(TurnStatsEntity, DB_CONNECTION)
    private readonly stats: Repository<TurnStatsEntity>,
    @InjectRepository(TurnModelUsageEntity, DB_CONNECTION)
    private readonly modelUsage: Repository<TurnModelUsageEntity>,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    private readonly version: AppVersionService,
  ) {}

  async record(
    identity: TurnUsageIdentity,
    usage: EngineUsage | undefined,
  ): Promise<void> {
    if (!usage) return;
    try {
      const orgId = identity.orgId ?? (await this.resolveOrgId(identity.jobId));
      if (!orgId) {
        this.logger.warn(
          `turn usage: no org for job=${identity.jobId} — skipping`,
        );
        return;
      }

      const tag = identity.metaTag ?? {};
      const stepId =
        pickUuid(tag.phaseId) ?? laneSuffix(identity.lane, 'phase:');
      const threadId = laneSuffix(identity.lane, 'thread:');
      // Everything in metaTag except the phaseId we lifted to step_id.
      const { phaseId: _phaseId, ...restTags } = tag as Record<string, unknown>;
      const tags = Object.keys(restTags).length ? restTags : null;

      const contextLimit =
        usage.contextTokens != null
          ? resolveContextLimit(usage.contextModel ?? usage.model)
          : null;

      const stat = await this.stats.save(
        this.stats.create({
          turn_id: identity.turnId ?? null,
          org_id: orgId,
          job_id: identity.jobId,
          thread_id: threadId,
          step_id: stepId,
          lane: identity.lane,
          kind: identity.kind,
          engine: identity.engine,
          credential_id: identity.credentialId ?? null,
          engine_git_sha: this.version.sha,
          model: usage.model ?? null,
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
          cache_read_tokens: usage.cacheReadTokens ?? 0,
          cache_write_tokens: usage.cacheWriteTokens ?? 0,
          cost_usd: usage.costUsd ?? null,
          context_tokens: usage.contextTokens ?? null,
          context_limit: contextLimit,
          tags,
          raw: usage as unknown as Record<string, unknown>,
        }),
      );

      const rows = Object.entries(usage.modelUsage ?? {}).map(([model, mu]) =>
        this.modelUsage.create({
          turn_stats_id: stat.id,
          model,
          org_id: orgId,
          job_id: identity.jobId,
          input_tokens: mu.inputTokens,
          output_tokens: mu.outputTokens,
          cache_read_tokens: mu.cacheReadTokens,
          cache_write_tokens: mu.cacheWriteTokens,
          cost_usd: mu.costUsd,
          web_search_requests: mu.webSearchRequests ?? 0,
        }),
      );
      if (rows.length) await this.modelUsage.save(rows);
    } catch (err) {
      this.logger.warn(
        `turn usage projection failed for job=${identity.jobId} lane=${identity.lane}: ${String(err)}`,
      );
    }
  }

  private async resolveOrgId(jobId: string): Promise<string | undefined> {
    const job = await this.jobs.findOne({
      where: { id: jobId },
      select: { org_id: true },
    });
    return job?.org_id;
  }
}

/** `lane` = `<prefix><suffix>` → the suffix, else null. */
function laneSuffix(lane: string, prefix: string): string | null {
  return lane.startsWith(prefix) ? lane.slice(prefix.length) : null;
}

/** A metaTag value that is a plain uuid string, else null. */
function pickUuid(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
