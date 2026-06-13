import { PromptTemplate } from '@langchain/core/prompts';
import { Runnable, RunnableSequence } from '@langchain/core/runnables';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Fact } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { z } from 'zod';
import { CredentialContext } from '../llm-keys/credential-context';
import { TenantCredentialService } from '../llm-keys/tenant-credential.service';
import { ChatModelFactory } from '../llm/chat-model.factory';
import { MemoryMetricsService } from './memory-metrics.service';
import { MemoryWriteService } from './memory-write.service';
import { SemanticMemory } from './semantic-memory';

/**
 * Phase 7 — Periodic memory consolidation (LangMem-style housekeeping).
 *
 * A scheduled background job — NOT per-turn — that runs an LLM pass over existing facts to
 * keep the store clean. Runs nightly by default (override via `CONSOLIDATION_CRON` env var).
 *
 * Per (tenant, scope):
 *   - merge:          auto-apply — collapses undeniable duplicates into one canonical statement.
 *                     Janitorial (not a truth judgment), so auto is safe.
 *   - drop-stale:     auto-apply — soft-deletes facts that are clearly no longer relevant.
 *   - flag-contradiction: LOG ONLY — choosing which side wins IS a truth judgment; the consent
 *                     model protects against it. Surface via metrics + logger, never auto-resolve.
 *
 * Wiring: registered in MemoryModule's `cronJobs` slot; `ScheduleModule.forRoot()` lives in
 * HarnessModule (single composition root — only one process should compose the scheduler).
 *
 * Re-entrancy: if a prior run is still in flight the incoming tick is skipped.
 * Per-scope fire-and-forget: a failure in one scope does not abort the rest of the run.
 */

// ── Cron schedule ─────────────────────────────────────────────────────────────
// Evaluated at class-definition time (module load); dotenvx has already populated process.env.
const CRON_SCHEDULE: string =
  process.env.CONSOLIDATION_CRON ?? CronExpression.EVERY_DAY_AT_2AM;

// ── Safety caps ───────────────────────────────────────────────────────────────
/** Minimum live facts in a scope before we bother running the LLM pass. */
const MIN_FACTS_PER_SCOPE = 3;
/** Max facts loaded per scope per run (bounds LLM prompt size and cost). */
const FACTS_PER_SCOPE_LIMIT = 100;
/** Max scopes processed per tenant per run. */
const MAX_SCOPES_PER_TENANT = 20;

// ── Structured output schema ──────────────────────────────────────────────────
const ConsolidationSchema = z.object({
  reasoning: z
    .string()
    .describe(
      'one sentence: what this scope needs — "nothing to do" is the expected answer for most scopes',
    ),
  merge: z
    .array(
      z.object({
        survivorId: z
          .number()
          .describe(
            'id of the fact to keep; its text is replaced with canonicalText',
          ),
        droppedIds: z
          .array(z.number())
          .describe(
            'ids of the duplicate facts to soft-delete; must NOT include survivorId',
          ),
        canonicalText: z
          .string()
          .describe(
            'the clean minimal canonical statement that replaces all duplicates',
          ),
      }),
    )
    .describe(
      'groups of duplicate facts to collapse into one; [] if none. Only merge facts that state the EXACT SAME underlying claim.',
    ),
  dropStale: z
    .array(
      z.object({
        id: z.number().describe('id of the clearly stale fact'),
        reason: z.string().describe('one sentence why it is stale'),
      }),
    )
    .describe(
      'facts to soft-delete as clearly outdated; [] if none. High bar — only drop if obviously no longer true.',
    ),
  flagContradiction: z
    .array(
      z.object({
        idA: z.number(),
        idB: z.number(),
        reason: z
          .string()
          .describe(
            'one sentence describing the conflict between the two facts',
          ),
      }),
    )
    .describe(
      'pairs of contradicting facts; [] if none. FLAG ONLY — do NOT auto-resolve.',
    ),
});
type ConsolidationResult = z.infer<typeof ConsolidationSchema>;

// ── Prompt ────────────────────────────────────────────────────────────────────
const CONSOLIDATION_PROMPT = `You are reviewing stored memory facts for a team's AI assistant.
This is a housekeeping pass — NOT a conversation. Scope: {scope} | Team: {teamId}

Facts (each shown as [#id] statement):
{facts}

Your job (be VERY conservative — most scopes need nothing):

1. MERGE — two facts state the EXACT same underlying claim, just worded differently.
   Only merge obvious duplicates. Do NOT merge related-but-distinct facts.
   Pick the best-worded one as the survivor; write a clean minimal canonical statement.

2. DROP-STALE — a fact clearly refers to something time-bounded that is obviously no longer true
   (e.g., "standup is tomorrow at 9am", "sprint ends Friday"). High bar — if in doubt, leave it.

3. FLAG-CONTRADICTION — two facts directly contradict each other (e.g., "uses Postgres" vs
   "uses MySQL"). FLAG ONLY — do NOT auto-resolve. Surface both ids for human/agent review.

Return empty arrays for all three when nothing qualifies. Returning [] everywhere is correct and expected for most scopes.`;

// ── Raw query result shapes ────────────────────────────────────────────────────
interface TenantRow {
  team_id: string;
}
interface ScopeRow {
  scope: string;
}

@Injectable()
export class MemoryConsolidationService {
  private readonly logger = new Logger(MemoryConsolidationService.name);
  /** Re-entrancy guard: skip if a prior run is still in flight. */
  private running = false;

  private consolidationChain?: Runnable<
    Record<string, string>,
    ConsolidationResult
  >;

  constructor(
    private readonly semantic: SemanticMemory,
    private readonly write: MemoryWriteService,
    private readonly metrics: MemoryMetricsService,
    private readonly models: ChatModelFactory,
    private readonly tenantCreds: TenantCredentialService,
    private readonly credCtx: CredentialContext,
    @InjectRepository(Fact)
    private readonly factRepo: Repository<Fact>,
  ) {}

  private chain(): Runnable<Record<string, string>, ConsolidationResult> {
    return (this.consolidationChain ??= RunnableSequence.from<
      Record<string, string>,
      ConsolidationResult
    >([
      new PromptTemplate({
        template: CONSOLIDATION_PROMPT,
        inputVariables: ['scope', 'teamId', 'facts'],
      }),
      // buildModel (full model) — contradiction/merge judgment is higher-stakes than cheap
      // extraction. buildExtractModel is acceptable for cost-sensitive deployments.
      this.models.buildModel().withStructuredOutput(ConsolidationSchema, {
        name: 'memory_consolidation',
      }),
    ]).withConfig({ runName: 'Memory Consolidation' }));
  }

  /**
   * Nightly housekeeping pass over all tenants' fact stores. Skipped when a previous run is still
   * in flight. Outer errors (failing to list tenants) are surfaced; per-tenant errors are logged
   * and skipped so one bad workspace doesn't abort the run.
   */
  @Cron(CRON_SCHEDULE)
  async consolidate(): Promise<void> {
    if (this.running) {
      this.logger.warn(
        'Memory consolidation already in flight — skipping this tick.',
      );
      return;
    }
    this.running = true;
    this.logger.log('Memory consolidation run started.');
    try {
      await this.runAllTenants();
    } finally {
      this.running = false;
      this.logger.log('Memory consolidation run complete.');
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async runAllTenants(): Promise<void> {
    // Only process tenants that currently have live facts — no point iterating an empty store.
    const rows = await this.factRepo.manager.query<TenantRow[]>(
      `SELECT DISTINCT team_id
         FROM facts
        WHERE deleted_at IS NULL
          AND team_id IS NOT NULL`,
      [],
    );
    const teamIds = (Array.isArray(rows) ? rows : []).map((r) => r.team_id);

    if (teamIds.length === 0) {
      this.logger.debug('No tenants with live facts — consolidation no-op.');
      return;
    }
    this.logger.debug(`Consolidation: ${teamIds.length} tenant(s) to process.`);

    for (const teamId of teamIds) {
      try {
        const keys = await this.tenantCreds.resolve(teamId);
        // Establish the tenant credential context so ChatModelFactory and
        // OpenAIEmbeddingProvider pick up the correct workspace keys — same
        // pattern as the conductor wraps every turn.
        await this.credCtx.run({ teamId, keys }, () => this.runTenant(teamId));
      } catch (err) {
        this.logger.warn(
          `Consolidation skipped tenant=${teamId}: ${errMsg(err)}`,
        );
      }
    }
  }

  private async runTenant(teamId: string): Promise<void> {
    const rows = await this.factRepo.manager.query<ScopeRow[]>(
      `SELECT scope
         FROM facts
        WHERE team_id = $1
          AND deleted_at IS NULL
        GROUP BY scope
       HAVING COUNT(*) >= $2
        ORDER BY COUNT(*) DESC
        LIMIT $3`,
      [teamId, MIN_FACTS_PER_SCOPE, MAX_SCOPES_PER_TENANT],
    );
    const scopes = (Array.isArray(rows) ? rows : []).map((r) => r.scope);

    if (scopes.length === 0) return;
    this.logger.debug(
      `Consolidation tenant=${teamId}: ${scopes.length} scope(s) eligible.`,
    );

    // Sequential — one scope at a time to bound concurrent LLM and DB cost.
    for (const scope of scopes) {
      await this.runScope(scope, teamId);
    }
  }

  private async runScope(scope: string, teamId: string): Promise<void> {
    let merged = 0;
    let dropped = 0;
    let contradictionsFlagged = 0;
    let errors = 0;

    try {
      const liveFacts = await this.semantic.listLiveByScope(
        scope,
        teamId,
        FACTS_PER_SCOPE_LIMIT,
      );
      if (liveFacts.length < MIN_FACTS_PER_SCOPE) {
        // Re-check after load — another run may have reduced the count.
        this.metrics.recordConsolidation({
          merged,
          dropped,
          contradictionsFlagged,
          errors,
        });
        return;
      }

      const factsText = liveFacts.map((f) => `[#${f.id}] ${f.fact}`).join('\n');

      const result = await this.chain().invoke({
        scope,
        teamId,
        facts: factsText,
      });

      // ── Apply merges ────────────────────────────────────────────────────────
      for (const m of result.merge) {
        if (
          !m.survivorId ||
          !Array.isArray(m.droppedIds) ||
          m.droppedIds.length === 0 ||
          !m.canonicalText?.trim()
        )
          continue;
        // Safety: survivor must not appear in the dropped list (model may hallucinate it).
        const safeDropped = m.droppedIds.filter((id) => id !== m.survivorId);
        if (safeDropped.length === 0) continue;

        try {
          await this.write.withLock(() =>
            this.semantic.mergeFacts(
              m.survivorId,
              safeDropped,
              m.canonicalText,
              teamId,
            ),
          );
          merged += safeDropped.length;
          this.logger.debug(
            `Consolidation merge scope=${scope}: survivor=#${m.survivorId} dropped=[${safeDropped.join(',')}]`,
          );
        } catch (err) {
          errors++;
          this.logger.warn(
            `Consolidation merge failed scope=${scope} survivor=${m.survivorId}: ${errMsg(err)}`,
          );
        }
      }

      // ── Apply drops ─────────────────────────────────────────────────────────
      for (const d of result.dropStale) {
        if (!d.id) continue;
        try {
          await this.write.withLock(() =>
            this.semantic.forgetByIdInScope(d.id, scope, teamId),
          );
          dropped++;
          this.logger.debug(
            `Consolidation drop scope=${scope}: #${d.id} — ${d.reason}`,
          );
        } catch (err) {
          errors++;
          this.logger.warn(
            `Consolidation drop failed scope=${scope} id=${d.id}: ${errMsg(err)}`,
          );
        }
      }

      // ── Flag contradictions (log only — NEVER auto-resolve) ──────────────────
      for (const c of result.flagContradiction) {
        if (!c.idA || !c.idB) continue;
        contradictionsFlagged++;
        this.logger.warn(
          `Contradiction flagged scope=${scope}: #${c.idA} vs #${c.idB} — ${c.reason}`,
        );
      }
    } catch (err) {
      errors++;
      this.logger.warn(
        `Consolidation scope=${scope} tenant=${teamId} failed: ${errMsg(err)}`,
      );
    } finally {
      this.metrics.recordConsolidation({
        merged,
        dropped,
        contradictionsFlagged,
        errors,
      });
    }
  }
}

/** Safe error-to-string helper (avoids `any` capture in logger calls). */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
