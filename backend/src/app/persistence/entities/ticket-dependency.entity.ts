import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';
import { TicketEntity } from './ticket.entity';

/**
 * A ticket dependency edge — "`ticket_id` is blocked by `depends_on_ticket_id`". ADVISORY only: it
 * informs the derived `blocked` flag and the board UI; nothing auto-promotes when a blocker resolves.
 *
 * Both endpoints must be in the SAME repo (enforced in the service) — dependencies don't cross repos.
 * `org_id` + `repo_id` are carried denormalized for scoped queries; the pair is unique so the same edge
 * can't be added twice. Cycles (direct AND transitive) are rejected at insert time by a reachability
 * check in the service.
 */
@Entity({ name: 'ticket_dependencies' })
@Index(['org_id', 'repo_id'])
@Index(['depends_on_ticket_id'])
@Unique(['ticket_id', 'depends_on_ticket_id'])
export class TicketDependencyEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The repo both endpoints belong to (FK → repos.id). */
  @Column({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  /** The BLOCKED ticket (FK → tickets.id). */
  @Column({ type: 'uuid' })
  ticket_id!: string;

  @ManyToOne(() => TicketEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket?: TicketEntity;

  /** The BLOCKER ticket (FK → tickets.id). */
  @Column({ type: 'uuid' })
  depends_on_ticket_id!: string;

  @ManyToOne(() => TicketEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'depends_on_ticket_id' })
  dependsOnTicket?: TicketEntity;
}
