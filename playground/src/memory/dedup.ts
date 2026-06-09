import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { z } from 'zod';
import { buildExtractModel } from '../model.js';
import { remember, type RememberInput } from './semantic.js';

/**
 * The shared WRITE policy for durable memory. Every path that adds a fact — the post-turn reconcile
 * pass and the bot's own `remember` tool — goes through `rememberDeduped` so none can mint a paraphrase
 * the others can't see. Two guarantees layered on top of `remember`'s cosine upsert:
 *   1. a gray-zone JUDGE (`dedupJudge`) that collapses paraphrases the 0.92 threshold misses, without
 *      the contradiction risk of simply lowering it (the judge distinguishes "same fact" from "opposite");
 *   2. a process-wide LOCK (`withMemoryLock`) serializing shared-scope writes, so two bots reconciling
 *      the same turn can't both read an empty/stale neighborhood and double-insert — the second sees the
 *      first's write and the judge merges it. This mirrors the lock + unique-index `tasks` already has.
 */

/** A process-wide async mutex (promise-chain): serializes the wrapped critical sections. */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let lock: Promise<void> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = lock.then(fn);
    lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

/**
 * Serializes all durable-memory writes (adds/updates/deletes) so concurrent reconciles can't race.
 *
 * MULTI-PROCESS GAP (deferred): this is a PROCESS-LOCAL mutex. It protects concurrent bots within one
 * Node process, but provides ZERO protection once memory is written from more than one process (the
 * planned Docker/multi-process worker direction). The `tasks` board already dedups via a DB unique index,
 * which survives multiple writers; fact dedup does not. When workers move out-of-process, replace this
 * with a DB-level guard (advisory lock / staging + unique constraint) — see semantic.ts `remember`.
 */
export const withMemoryLock = createMutex();

// ── The gray-zone judge ────────────────────────────────────────────────────────────────────────────

namespace DedupJudge {
  const Schema = z.object({
    same: z
      .boolean()
      .describe(
        'true if both state the SAME underlying fact (same claim about the same thing, even if worded differently); false if they differ in meaning in any material way — including opposites.',
      ),
  });
  type Result = z.infer<typeof Schema>;

  const PROMPT = `Two short facts from a team's long-term memory. Are they the SAME underlying fact —
the same claim about the same thing, just possibly worded differently? Answer false if they differ in
meaning in any material way, including opposites ("prefers X" vs "dislikes X") or a difference in
specifics that actually matters.

Existing: {existing}
New: {candidate}`;

  let chain: ReturnType<typeof build> | undefined;
  export const get = () => (chain ??= build());
  const build = () =>
    RunnableSequence.from<Record<string, string>, Result>([
      new PromptTemplate({ template: PROMPT, inputVariables: ['existing', 'candidate'] }),
      buildExtractModel().withStructuredOutput(Schema, { name: 'dedup_judge' }),
    ]).withConfig({ runName: 'Dedup Judge' });
}

/**
 * Same underlying fact, even if worded differently? Used only for gray-band near-duplicates, so it
 * fires rarely. On any failure it returns false — a recoverable duplicate beats a wrong merge.
 */
export async function dedupJudge(existing: string, candidate: string): Promise<boolean> {
  try {
    const { same } = await DedupJudge.get().invoke({ existing, candidate });
    return same;
  } catch {
    return false;
  }
}

/** The canonical fact-write: judge-guarded and serialized. All add paths should use this, not `remember`. */
export function rememberDeduped(
  input: RememberInput,
): Promise<{ action: 'inserted' | 'updated'; id: number }> {
  return withMemoryLock(() => remember(input, { judge: dedupJudge }));
}
