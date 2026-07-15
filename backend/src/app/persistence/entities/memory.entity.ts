import {
  Column,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';

/**
 * Atlas v2 semantic memory — a distilled fact + its embedding, the ONLY channel for cross-thread
 * coherence (threads never share transcripts). `scope` is the access tier (team:<id> | project:<id>).
 * `embedding` is pgvector `vector(1536)` (text-embedding-3-small); the initial migration enables the
 * extension and adds the HNSW cosine index. Reads/writes use the pgvector text form (`[0.1,0.2,…]`)
 * and rank with `embedding <=> :q`. Soft-deleted. Namespaced `memory` — its OWN pgvector table,
 * reusing the `vector` extension already present in this DB.
 */
@Entity({ name: 'memory' })
@Index(['scope'])
@Index(['org_id', 'scope'])
// Hands-off: the pgvector HNSW index is unexpressible in TypeORM metadata. The DDL lives in the
// migrations; this only tells migration:generate never to DROP it.
@Index('idx_memory_embedding_hnsw', { synchronize: false })
export class MemoryEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  fact!: string;

  // pgvector. TypeORM 0.3.30 has native `vector` support; dimension + HNSW index are set in the
  // migration. select: false — 1536 floats (~19 KB) are never needed outside vector ops; an explicit
  // QB .addSelect() (e.g. via the `embedding <=> :q` distance expression) still works.
  @Column({ type: 'vector', length: 1536, select: false })
  embedding!: string;

  /** The tenant (org id) that owns this fact. Required — memory is strictly tenant-scoped. */
  @Column({ type: 'uuid', nullable: false })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org!: OrganizationEntity;

  /** Access tier: team:<id> | project:<id>. */
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
