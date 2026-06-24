import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { toSql } from 'pgvector';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { MemoryEntity } from '../persistence/entities';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding';

/**
 * Atlas v2 semantic memory — the pgvector read/write primitives ONLY (a clean-room rewrite of v1's
 * `SemanticMemory` with the board/pipeline/identity-tier machinery DROPPED). It is the only channel
 * for cross-thread coherence: threads never share transcripts. Scopes are plain strings
 * (`team:<id>` | `project:<id>`); `org_id` NULL = the shared/global tier (recalled everywhere).
 *
 * Stored against the `memory` table on Atlas's OWN datasource. Vector ops use the pgvector text
 * literal (`[0.1,0.2,…]`) and rank with `embedding <=> :qv`. Zero v1 imports.
 */

export interface StoredFact {
  id: string;
  fact: string;
  scope: string;
  org_id: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

export interface RecalledFact extends StoredFact {
  /** Cosine similarity to the query (1 = identical). */
  sim: number;
}

// Cosine ≥ this in the same scope = "the same fact" → merge, not a duplicate.
export const DEDUP_THRESHOLD = 0.92;
// Recall floor: facts below this cosine to the query are not relevant enough to inject.
export const MIN_RECALL_SIM = 0.3;

/** Serialize a JS vector to the pgvector SQL literal. Non-null assertion is safe (we always pass a
 * non-null number[] from the embedder). */
const vecSql = (v: number[]): string => toSql(v)!;

function toStored(f: MemoryEntity): StoredFact {
  return {
    id: f.id,
    fact: f.fact,
    scope: f.scope,
    org_id: f.org_id,
    confidence: f.confidence,
    created_at: f.created_at.toISOString(),
    updated_at: f.updated_at.toISOString(),
  };
}

export interface RememberInput {
  fact: string;
  /** Access tier scope, e.g. 'team:T04' | 'project:acme'. */
  scope: string;
  /** The tenant (Slack team id); null for the shared/global tier. */
  orgId: string | null;
  assertedBy?: string;
}

@Injectable()
export class MemoryStore {
  constructor(
    @InjectRepository(MemoryEntity, DB_CONNECTION)
    private readonly facts: Repository<MemoryEntity>,
    @Inject(EMBEDDING_PROVIDER)
    private readonly embedder: EmbeddingProvider,
  ) {}

  /** Embed text to the pgvector SQL literal the queries use (`orgId` selects the tenant's OpenAI key). */
  async embed(text: string, orgId?: string): Promise<string> {
    return vecSql(await this.embedder.embed(text, orgId));
  }

  /**
   * Store a fact at its scope, or merge into a near-duplicate (cosine ≥ DEDUP_THRESHOLD) in that
   * same scope/team. Strict team equality — a tenant fact never merges into the global tier.
   */
  async remember(input: RememberInput): Promise<{ action: 'inserted' | 'updated'; id: string }> {
    const qv = vecSql(await this.embedder.embed(input.fact, input.orgId ?? undefined));

    const qb = this.facts
      .createQueryBuilder('f')
      .addSelect('1 - (f.embedding <=> :qv::vector)', 'sim')
      .where('f.scope = :scope', { scope: input.scope })
      .andWhere('1 - (f.embedding <=> :qv::vector) >= :floor', { floor: DEDUP_THRESHOLD })
      .orderBy('f.embedding <=> :qv::vector', 'ASC')
      .setParameter('qv', qv)
      .limit(1);
    qb.andWhere(input.orgId === null ? 'f.org_id IS NULL' : 'f.org_id = :team', {
      team: input.orgId,
    });
    const { entities } = await qb.getRawAndEntities();
    const dup = entities[0];
    if (dup) {
      await this.facts
        .createQueryBuilder()
        .update(MemoryEntity)
        .set({ fact: input.fact, embedding: () => ':qv::vector', embed_model: this.embedder.model })
        .where('id = :id', { id: dup.id })
        .setParameter('qv', qv)
        .execute();
      return { action: 'updated', id: dup.id };
    }

    const result = await this.facts
      .createQueryBuilder()
      .insert()
      .into(MemoryEntity)
      .values({
        fact: input.fact,
        embedding: () => ':qv::vector',
        scope: input.scope,
        org_id: input.orgId,
        asserted_by: input.assertedBy ?? null,
        confidence: 1.0,
        embed_model: this.embedder.model,
      })
      .setParameter('qv', qv)
      .execute();
    return { action: 'inserted', id: result.identifiers[0].id as string };
  }

  /**
   * Semantic recall over the given scopes, filtered to this team (or the global tier). Facts below
   * `floor` cosine are dropped; the rest come back most-similar-first.
   */
  async recall(
    query: string,
    opts: { scopes: string[]; orgId: string | null; limit?: number; floor?: number },
  ): Promise<RecalledFact[]> {
    if (opts.scopes.length === 0) return [];
    const limit = opts.limit ?? 5;
    const floor = opts.floor ?? MIN_RECALL_SIM;
    const qv = await this.embed(query, opts.orgId ?? undefined);

    const { entities, raw } = await this.facts
      .createQueryBuilder('f')
      .addSelect('1 - (f.embedding <=> :qv::vector)', 'sim')
      .where('f.scope = ANY(:scopes)', { scopes: opts.scopes })
      .andWhere('(f.org_id = :team OR f.org_id IS NULL)', { team: opts.orgId })
      .andWhere('1 - (f.embedding <=> :qv::vector) >= :floor', { floor })
      .orderBy('f.embedding <=> :qv::vector', 'ASC')
      .limit(limit)
      .setParameter('qv', qv)
      .getRawAndEntities();

    return entities.map((e, i) => ({ ...toStored(e), sim: Number(raw[i].sim) }));
  }

  /** Soft-delete a fact by id. */
  async forget(id: string): Promise<void> {
    await this.facts.softDelete(id);
  }
}
