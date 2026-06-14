import { Column, DeleteDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * Semantic-memory fact: a distilled statement about a person/team/the company, plus its embedding.
 * `scope` is the access tier (team:<id> | project:<id> | bot:<id> | pair:<bot>:<human>). Soft-deleted —
 * human facts are never hard-removed. `embedding` is pgvector `vector(1536)` (text-embedding-3-small);
 * the first migration adds the HNSW cosine index. The SemanticMemory adapter reads/writes it as the
 * pgvector text form (`[0.1,0.2,…]`) and ranks with `embedding <=> :q`.
 */
@Entity({ name: 'facts' })
@Index(['scope'])
@Index(['team_id', 'scope'])
export class Fact extends TimestampedEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text' })
  fact!: string;

  // pgvector. TypeORM 0.3.30 has native `vector` support; dimension + HNSW index are set in the migration.
  // select: false — 1536 floats (~19 KB) are never needed outside vector ops; explicit QB .addSelect()
  // (e.g. via the embedding <=> distance expression) still works fine.
  @Column({ type: 'vector', length: 1536, select: false })
  embedding!: string;

  /** The tenant (Slack team id) this fact belongs to. NULL = the SHARED/global tier: recalled in
   * every workspace for its `scope`. Per-tenant recall filters `(team_id = :tid OR team_id IS NULL)`;
   * "promotion" sets a tenant fact's team_id to NULL. */
  @Column({ type: 'text', nullable: true })
  team_id!: string | null;

  @Column({ type: 'text' })
  scope!: string;

  @Column({ type: 'text', nullable: true })
  asserted_by!: string | null;

  @Column({ type: 'text', nullable: true })
  source_surface!: string | null;

  @Column({ type: 'real', default: 1.0 })
  confidence!: number;

  @Column({ type: 'text', nullable: true })
  embed_model!: string | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deleted_at!: Date | null;
}
