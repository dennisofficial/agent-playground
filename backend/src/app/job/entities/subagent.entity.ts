import { ESubagentStatus } from '@workspace/shared';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Repository,
} from 'typeorm';
import { TimestampedEntity } from '../../../_lib/database/base.entity';
import { Organization } from '../../org/entities/organization.entity';
import { ThreadMessage } from './thread-message.entity';
import { Thread } from './thread.entity';

@Entity({ name: 'subagents' })
@Index(['threadId'])
@Index(['toolUseId'])
@Index(['parentMessageId'])
@Index(['orgId'])
export class Subagent extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  threadId!: string;

  @ManyToOne(() => Thread, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_id' })
  thread?: Thread;

  @Column({ type: 'uuid' })
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  /** The assistant message (tool-use block) that spawned this subagent. */
  @Column({ type: 'uuid' })
  parentMessageId!: string;

  @ManyToOne(() => ThreadMessage, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parent_message_id' })
  parentMessage?: ThreadMessage;

  @Column({ type: 'text' })
  toolUseId!: string;

  @Column({ type: 'text', nullable: true })
  agentType!: string | null;

  @Column({ type: 'text', nullable: true })
  model!: string | null;

  @Column({ type: 'enum', enum: ESubagentStatus, default: ESubagentStatus.RUNNING })
  status!: ESubagentStatus;

  @Column({ type: 'text', nullable: true })
  sessionRef!: string | null;

  // Token tallies fit comfortably in `int` (a JS number natively — no bigint string round-trip).
  @Column({ type: 'int', default: 0 })
  inputTokens!: number;

  @Column({ type: 'int', default: 0 })
  outputTokens!: number;

  @Column({ type: 'int', default: 0 })
  cacheReadTokens!: number;

  @Column({ type: 'int', default: 0 })
  cacheWriteTokens!: number;

  /** Estimated run cost in USD — a display/analytics figure, so `double precision` (native JS number). */
  @Column({ type: 'double precision', nullable: true })
  costUsd!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt!: Date | null;
}

/** Injectable DI token / typed alias for the Subagent repository. */
export class SubagentRepo extends Repository<Subagent> {}
