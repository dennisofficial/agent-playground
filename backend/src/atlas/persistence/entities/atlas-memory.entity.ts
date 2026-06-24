import { Column, DeleteDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * Atlas v2 semantic memory — a distilled fact + its embedding, the ONLY channel for cross-thread
 * coherence (threads never share transcripts). `scope` is the access tier (team:<id> | project:<id>).
 * `embedding` is pgvector `vector(1536)` (text-embedding-3-small); the initial migration enables the
 * extension and adds the HNSW cosine index. Reads/writes use the pgvector text form (`[0.1,0.2,…]`)
 * and rank with `embedding <=> :q`. Soft-deleted. Namespaced `atlas_memory` — its OWN pgvector table,
 * reusing the `vector` extension already present in this DB.
 */
@Entity({ name: 'atlas_memory' })
@Index(['scope'])
@Index(['org_id', 'scope'])
export class AtlasMemory extends TimestampedEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text' })
  fact!: string;

  // pgvector. TypeORM 0.3.30 has native `vector` support; dimension + HNSW index are set in the
  // migration. select: false — 1536 floats (~19 KB) are never needed outside vector ops; an explicit
  // QB .addSelect() (e.g. via the `embedding <=> :q` distance expression) still works.
  @Column({ type: 'vector', length: 1536, select: false })
  embedding!: string;

  /** The tenant (Slack team id). NULL = the shared/global tier (recalled in every workspace). */
  @Column({ type: 'text', nullable: true })
  org_id!: string | null;

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
