import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * Audit record for a single rolling compaction event on a bot's conversation thread.
 * Each row captures the summary text, the message index it covers up to, and a
 * monotonically-incrementing version counter per thread.
 *
 * Read-time usage (llmNode): when `state.summaries.length > 0` the conversation is
 * reconstructed as [SystemMessage, summaryBlock (block 2), messages.slice(summarizedUpTo)
 * (block 3), ...]. Block 2 renders ALL entries in the rolling summary queue (oldest first);
 * block 3 is the verbatim tail. Older messages are dropped from the live prompt; the
 * summary queue preserves their semantics.
 *
 * The `thread` column mirrors the LangGraph checkpointer thread id
 * (`${botId}:${project}:root`), so rows are queryable per bot/project.
 */
@Entity({ name: 'compaction_summaries' })
@Index(['thread'])
export class CompactionSummary extends TimestampedEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** LangGraph thread id — `${botId}:${project}:root`. */
  @Column({ type: 'text' })
  thread!: string;

  /** Monotonically incrementing compaction count for this thread (1, 2, 3, …). */
  @Column({ type: 'int' })
  version!: number;

  /** state.messages index of the first verbatim-tail message (block 3) at trigger time.
   * Equals the token-budget cut point returned by `findCompactionCutPoint`, which is then
   * walked back by `pairSafeBoundary` to a HumanMessage boundary (never splits a
   * tool_use/tool_result group). The verbatim tail starts here. */
  @Column({ type: 'int' })
  covered_up_to!: number;

  /** Human-readable rolling summary: current state, work in progress, decisions, next steps. */
  @Column({ type: 'text' })
  summary!: string;
}
