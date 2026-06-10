import { PromptTemplate } from '@langchain/core/prompts';
import { Runnable, RunnableSequence } from '@langchain/core/runnables';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { createMutex } from '../domain/async';
import { ChatModelFactory } from '../llm/chat-model.factory';
import { MemoryMetricsService } from './memory-metrics.service';
import { RememberInput, SemanticMemory } from './semantic-memory';

/**
 * The shared WRITE policy for durable memory. Every path that adds a fact — the post-turn reconcile
 * pass and the bot's own `remember` tool — goes through `rememberDeduped` so none can mint a
 * paraphrase the others can't see. Two guarantees layered on top of `remember`'s cosine upsert:
 *   1. a gray-zone JUDGE that collapses paraphrases the 0.92 threshold misses, without the
 *      contradiction risk of simply lowering it (the judge distinguishes "same fact" from "opposite");
 *   2. a process-wide LOCK (`withLock`) serializing shared-scope writes, so two bots reconciling the
 *      same turn can't both read a stale neighborhood and double-insert.
 *
 * MULTI-PROCESS GAP (deferred): the mutex is PROCESS-LOCAL. When workers move out-of-process,
 * replace with a DB-level guard (advisory lock / staging + unique constraint).
 * (Ported from playground/src/memory/dedup.ts.)
 */

const JudgeSchema = z.object({
  same: z
    .boolean()
    .describe(
      'true if both state the SAME underlying fact (same claim about the same thing, even if worded differently); false if they differ in meaning in any material way — including opposites.',
    ),
});

const JUDGE_PROMPT = `Two short facts from a team's long-term memory. Are they the SAME underlying fact —
the same claim about the same thing, just possibly worded differently? Answer false if they differ in
meaning in any material way, including opposites ("prefers X" vs "dislikes X") or a difference in
specifics that actually matters.

Existing: {existing}
New: {candidate}`;

@Injectable()
export class MemoryWriteService {
  /** Serializes all durable-memory writes (adds/updates/deletes) so concurrent reconciles can't race. */
  readonly withLock = createMutex();

  private judgeChain?: Runnable<Record<string, string>, z.infer<typeof JudgeSchema>>;

  constructor(
    private readonly semantic: SemanticMemory,
    private readonly models: ChatModelFactory,
    private readonly metrics: MemoryMetricsService,
  ) {}

  private judge() {
    return (this.judgeChain ??= RunnableSequence.from<Record<string, string>, z.infer<typeof JudgeSchema>>([
      new PromptTemplate({ template: JUDGE_PROMPT, inputVariables: ['existing', 'candidate'] }),
      this.models.buildExtractModel().withStructuredOutput(JudgeSchema, { name: 'dedup_judge' }),
    ]).withConfig({ runName: 'Dedup Judge' }));
  }

  /**
   * Same underlying fact, even if worded differently? Used only for gray-band near-duplicates, so it
   * fires rarely. On any failure it returns false — a recoverable duplicate beats a wrong merge.
   */
  dedupJudge = async (existing: string, candidate: string): Promise<boolean> => {
    this.metrics.recordJudgeCall();
    try {
      const { same } = await this.judge().invoke({ existing, candidate });
      return same;
    } catch {
      return false;
    }
  };

  /**
   * The canonical fact-write: judge-guarded and serialized. All add paths should use this, never
   * `SemanticMemory.remember` directly. Self-records the session write metric (insert vs dedup-merge)
   * so every caller is counted without touching call sites.
   */
  async rememberDeduped(input: RememberInput): Promise<{ action: 'inserted' | 'updated'; id: number }> {
    const res = await this.withLock(() => this.semantic.remember(input, { judge: this.dedupJudge }));
    this.metrics.recordWrite(res.action);
    return res;
  }
}
