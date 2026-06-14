import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * Audit record for a single rolling compaction event on a bot's conversation thread.
 * Each row captures the summary text, the message index it covers up to, and a
 * monotonically-incrementing version counter per thread.
 *
 * Read-time usage (llmNode): when `summarizedUpTo > 0` the conversation is reconstructed
 * as [SystemMessage, summaryHumanMessage, messages.slice(summarizedUpTo), ...]. Older
 * messages are dropped from the live prompt; the summary preserves their semantics.
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

  /** state.messages index of the first verbatim-tail message at trigger time
   * (= messages.length − COMPACTION_TAIL). The verbatim tail starts here. */
  @Column({ type: 'int' })
  covered_up_to!: number;

  /** Human-readable rolling summary: current state, work in progress, decisions, next steps. */
  @Column({ type: 'text' })
  summary!: string;
}
