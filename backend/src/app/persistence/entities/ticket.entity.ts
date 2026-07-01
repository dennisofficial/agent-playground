import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import type { TicketOrigin } from '../../domain/ticket';
import { DecisionRecordEntity } from './decision-record.entity';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';
import { JobEntity } from './job.entity';

/**
 * A TICKET — a unit of captured intent on a repo's board/backlog (see `domain/ticket.ts`). Lightweight
 * and durable: NOT a thread (no sandbox/worktree/PR). Out-of-scope work raised mid-conversation lands
 * here so Atlas can act on it later; promotion turns a ticket INTO a working thread (the link lives on
 * `threads.ticket_id`).
 *
 * Per-repo board: scoped by the denormalized `org_id` + `repo_id` (both carried so listing is a single
 * indexed query, never a join). `number` is the human-friendly per-repo id (#14), allocated from
 * `ticket_counters` (monotonic) and unique within the repo. `status` is a `text` column constrained by
 * the `TicketStatus` allow-list in the app layer (house style — not a Postgres enum).
 */
@Entity({ name: 'tickets' })
@Index(['org_id', 'repo_id'])
@Unique(['repo_id', 'number'])
export class TicketEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The repo whose board this ticket belongs to (FK → repos.id). */
  @Column({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  /** Human-friendly per-repo number (#14), unique within the repo (allocated from `ticket_counters`). */
  @Column({ type: 'int' })
  number!: number;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  body!: string | null;

  // TicketStatus — validated against the allow-list in the app layer.
  @Column({ type: 'text', default: 'backlog' })
  status!: string;

  // TicketPriority | null
  @Column({ type: 'text', nullable: true })
  priority!: string | null;

  // TicketKind | null
  @Column({ type: 'text', nullable: true })
  kind!: string | null;

  /** Drag-order within a board column (ascending). */
  @Column({ type: 'double precision', default: 0 })
  sort_order!: number;

  /** The thread this ticket was captured from (FK → threads.id); SET NULL if that thread is deleted. */
  @Column({ type: 'uuid', nullable: true })
  origin_thread_id!: string | null;

  @ManyToOne(() => JobEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'origin_thread_id' })
  originThread?: JobEntity | null;

  /** The decision record this ticket diverged from (FK → decision_records.id); SET NULL on delete. */
  @Column({ type: 'uuid', nullable: true })
  origin_decision_record_id!: string | null;

  @ManyToOne(() => DecisionRecordEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'origin_decision_record_id' })
  originDecisionRecord?: DecisionRecordEntity | null;

  /**
   * Immutable provenance snapshot (thread title, decision summary) copied at create time, so the ticket
   * stays interpretable after the optional FKs above are nulled by a source delete. See `TicketOrigin`.
   */
  @Column({ type: 'jsonb', nullable: true })
  origin!: TicketOrigin | null;
}
