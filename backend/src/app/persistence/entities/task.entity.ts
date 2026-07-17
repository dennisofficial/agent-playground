import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { OrganizationEntity } from './organization.entity';
import { ThreadGroupEntity } from './thread-group.entity';

@Entity({ name: 'tasks' })
@Index(['thread_group_id'])
@Index(['thread_group_id', 'ordinal'])
export class TaskEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  thread_group_id!: string;

  @ManyToOne(() => ThreadGroupEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_group_id' })
  threadGroup?: ThreadGroupEntity;

  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  @Column({ type: 'int' })
  ordinal!: number;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  brief!: string | null;

  @Column({ type: 'text', nullable: true })
  active_form!: string | null;

  @Column({ type: 'text', default: 'pending' })
  status!: string;

  @Column({ type: 'jsonb', default: [] })
  blocked_by!: string[];
}
