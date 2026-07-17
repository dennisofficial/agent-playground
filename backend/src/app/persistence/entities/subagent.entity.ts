import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { numberColumn } from './numeric.transformer';
import { ThreadEntity } from './thread.entity';
import { TranscriptMessageEntity } from './transcript-message.entity';

@Entity({ name: 'subagents' })
@Index(['thread_id'])
@Index(['tool_use_id'])
@Index(['parent_message_id'])
export class SubagentEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  thread_id!: string;

  @ManyToOne(() => ThreadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_id' })
  thread?: ThreadEntity;

  @Column({ type: 'uuid' })
  parent_message_id!: string;

  @ManyToOne(() => TranscriptMessageEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parent_message_id' })
  parentMessage?: TranscriptMessageEntity;

  @Column({ type: 'text' })
  tool_use_id!: string;

  @Column({ type: 'text', nullable: true })
  agent_type!: string | null;

  @Column({ type: 'text', nullable: true })
  model!: string | null;

  @Column({ type: 'text', default: 'running' })
  status!: string;

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
