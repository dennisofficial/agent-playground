import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { toSql } from 'pgvector';
import { Repository } from 'typeorm';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasMemory } from '../persistence/entities';
import { ATLAS_EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding';

/**
 * Atlas v2 semantic memory — the pgvector read/write primitives ONLY (a clean-room rewrite of v1's
 * `SemanticMemory` with the board/pipeline/identity-tier machinery DROPPED). It is the only channel
 * for cross-thread coherence: threads never share transcripts. Scopes are plain strings
 * (`team:<id>` | `project:<id>`); `team_id` NULL = the shared/global tier (recalled everywhere).
 *
 * Stored against the `atlas_memory` table on Atlas's OWN datasource. Vector ops use the pgvector text
 * literal (`[0.1,0.2,…]`) and rank with `embedding <=> :qv`. Zero v1 imports.
 */

export interface StoredFact {
  id: number;
  fact: string;
  scope: string;
  team_id: string | null;
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

function toStored(f: AtlasMemory): StoredFact {
  return {
    id: f.id,
    fact: f.fact,
    scope: f.scope,
    team_id: f.team_id,
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
  teamId: string | null;
  assertedBy?: string;
}

@Injectable()
export class AtlasMemoryStore {
  constructor(
    @InjectRepository(AtlasMemory, ATLAS_CONNECTION)
    private readonly facts: Repository<AtlasMemory>,
    @Inject(ATLAS_EMBEDDING_PROVIDER)
    private readonly embedder: EmbeddingProvider,
  ) {}

  /** Embed text to the pgvector SQL literal the queries use. */
  async embed(text: string): Promise<string> {
    return vecSql(await this.embedder.embed(text));
  }

  /**
   * Store a fact at its scope, or merge into a near-duplicate (cosine ≥ DEDUP_THRESHOLD) in that
   * same scope/team. Strict team equality — a tenant fact never merges into the global tier.
   */
  async remember(input: RememberInput): Promise<{ action: 'inserted' | 'updated'; id: number }> {
    const qv = vecSql(await this.embedder.embed(input.fact));

    const qb = this.facts
      .createQueryBuilder('f')
      .addSelect('1 - (f.embedding <=> :qv::vector)', 'sim')
      .where('f.scope = :scope', { scope: input.scope })
      .andWhere('1 - (f.embedding <=> :qv::vector) >= :floor', { floor: DEDUP_THRESHOLD })
      .orderBy('f.embedding <=> :qv::vector', 'ASC')
      .setParameter('qv', qv)
      .limit(1);
    qb.andWhere(input.teamId === null ? 'f.team_id IS NULL' : 'f.team_id = :team', {
      team: input.teamId,
    });
    const { entities } = await qb.getRawAndEntities();
    const dup = entities[0];
    if (dup) {
      await this.facts
        .createQueryBuilder()
        .update(AtlasMemory)
        .set({ fact: input.fact, embedding: () => ':qv::vector', embed_model: this.embedder.model })
        .where('id = :id', { id: dup.id })
        .setParameter('qv', qv)
        .execute();
      return { action: 'updated', id: dup.id };
    }

    const result = await this.facts
      .createQueryBuilder()
      .insert()
      .into(AtlasMemory)
      .values({
        fact: input.fact,
        embedding: () => ':qv::vector',
        scope: input.scope,
        team_id: input.teamId,
        asserted_by: input.assertedBy ?? null,
        confidence: 1.0,
        embed_model: this.embedder.model,
      })
      .setParameter('qv', qv)
      .execute();
    return { action: 'inserted', id: result.identifiers[0].id as number };
  }

  /**
   * Semantic recall over the given scopes, filtered to this team (or the global tier). Facts below
   * `floor` cosine are dropped; the rest come back most-similar-first.
   */
  async recall(
    query: string,
    opts: { scopes: string[]; teamId: string | null; limit?: number; floor?: number },
  ): Promise<RecalledFact[]> {
    if (opts.scopes.length === 0) return [];
    const limit = opts.limit ?? 5;
    const floor = opts.floor ?? MIN_RECALL_SIM;
    const qv = await this.embed(query);

    const { entities, raw } = await this.facts
      .createQueryBuilder('f')
      .addSelect('1 - (f.embedding <=> :qv::vector)', 'sim')
      .where('f.scope = ANY(:scopes)', { scopes: opts.scopes })
      .andWhere('(f.team_id = :team OR f.team_id IS NULL)', { team: opts.teamId })
      .andWhere('1 - (f.embedding <=> :qv::vector) >= :floor', { floor })
      .orderBy('f.embedding <=> :qv::vector', 'ASC')
      .limit(limit)
      .setParameter('qv', qv)
      .getRawAndEntities();

    return entities.map((e, i) => ({ ...toStored(e), sim: Number(raw[i].sim) }));
  }

  /** Soft-delete a fact by id. */
  async forget(id: number): Promise<void> {
    await this.facts.softDelete(id);
  }
}
