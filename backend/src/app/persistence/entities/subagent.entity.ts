import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { ThreadEntity } from './thread.entity';
import { MessageEntity } from './message.entity';
import { numberColumn } from './numeric.transformer';

/**
 * A SUBAGENT — one Claude Agent SDK `Task` sub-session spawned inside a thread's turn (d4). Subagents
 * are NOT threads: they don't get a driver/session lane of their own, they're a normalized replacement
 * for the old ad-hoc `meta.parentToolUseId ↔ meta.id` pointer pair on `messages`.
 *
 * Transcript fidelity stays option (a): the streamed subagent blocks remain persisted in `messages` (now
 * keyed by `subagent_id`, `thread_id` = the parent thread), plus `session_ref` for full raw-JSONL depth.
 * Rendering is uniform via "messages for this node" — a node is either a thread (`subagent_id IS NULL`)
 * or a subagent (`subagent_id = X`).
 */
@Entity({ name: 'subagents' })
@Index(['thread_id'])
@Index(['tool_use_id'])
export class SubagentEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The parent thread this subagent ran inside (FK → threads.id). */
  @Column({ type: 'uuid' })
  thread_id!: string;

  @ManyToOne(() => ThreadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_id' })
  thread?: ThreadEntity;

  /** The `Task` tool_use message that launched this subagent (FK → messages.id). */
  @Column({ type: 'uuid' })
  parent_message_id!: string;

  @ManyToOne(() => MessageEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parent_message_id' })
  parentMessage?: MessageEntity;

  /** The SDK's `tool_use_id` for the launching `Task` block — the stream-time join key (mirrors the old
   *  `meta.id` on the launching block / `meta.parentToolUseId` on its children). */
  @Column({ type: 'text' })
  tool_use_id!: string;

  /** The subagent type the `Task` tool was invoked with (e.g. `explore`, `implement`); null when the
   *  launching block didn't carry one (legacy backfilled rows). */
  @Column({ type: 'text', nullable: true })
  agent_type!: string | null;

  /** The model the subagent ran on; null when not reported. */
  @Column({ type: 'text', nullable: true })
  model!: string | null;

  // 'running' | 'done' | 'failed' — mirrors the SDK's subagent lifecycle.
  @Column({ type: 'text', default: 'running' })
  status!: string;

  /** Pointer to the subagent's raw session JSONL (full-depth transcript beyond the persisted `messages`
   *  blocks); null until captured. */
  @Column({ type: 'text', nullable: true })
  session_ref!: string | null;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  input_tokens!: number;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  output_tokens!: number;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  cache_read_tokens!: number;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  cache_write_tokens!: number;

  @Column({ type: 'numeric', nullable: true, transformer: numberColumn })
  cost_usd!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  started_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  ended_at!: Date | null;
}
