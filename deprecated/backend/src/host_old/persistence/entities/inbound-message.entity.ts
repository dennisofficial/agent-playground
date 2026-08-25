import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { JobEntity } from './job.entity';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';

@Entity({ name: 'inbound_messages' })
@Index(['org_id', 'repo_id'])
@Index(['org_id', 'repo_id', 'source', 'dedupe_key'], {
  unique: true,
  where: `"kind" = 'event'`,
})
export class InboundMessageEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  @Column({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  @Column({ type: 'text' })
  kind!: string;

  @Column({ type: 'text' })
  type!: string;

  @Column({ type: 'text' })
  trust!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'uuid', nullable: true })
  job_id!: string | null;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'job_id' })
  thread?: JobEntity | null;

  @Column({ type: 'text', default: 'main' })
  lane!: string;

  @Column({ type: 'text', nullable: true })
  author_id!: string | null;

  @Column({ type: 'text', nullable: true })
  author_name!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  reply_route!: {
    surfaceId: string;
    jobRef: string;
    priority?: 'now' | 'queue' | 'later';
  } | null;

  @Column({ type: 'text', nullable: true })
  source!: string | null;

  @Column({ type: 'text', nullable: true })
  dedupe_key!: string | null;

  @Column({ type: 'text', nullable: true })
  severity!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  delivered_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  attempted_at!: Date | null;
}
