import { TimestampedEntity } from '@lib/database/base.entity';
import {
  Column,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { OrganizationEntity } from './organization.entity';

@Entity({ name: 'memory' })
@Index(['scope'])
@Index(['org_id', 'scope'])
@Index('idx_memory_embedding_hnsw', { synchronize: false })
export class MemoryEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  fact!: string;

  @Column({ type: 'vector', length: 1536, select: false })
  embedding!: string;

  @Column({ type: 'uuid', nullable: false })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org!: OrganizationEntity;

  @Column({ type: 'text' })
  scope!: string;

  @Column({ type: 'text', nullable: true })
  asserted_by!: string | null;

  @Column({ type: 'real', default: 1.0 })
  confidence!: number;

  @Column({ type: 'text', nullable: true })
  embed_model!: string | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deleted_at!: Date | null;
}
